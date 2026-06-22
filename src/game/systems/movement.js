import { FIELD } from '../../constants.js'
import { getLosY } from '../gameState.js'
import { getFatigueMult } from './stamina.js'
import { steer, advance } from '../utils/movement.js'
import { getRouteTarget } from '../utils/routeEngine.js'
import { findRunningLane, visionInterval } from '../utils/rbVision.js'
import { getRatings, ratingOf, accelFromRating, speedFromRating, cutRetentionFromAccel, pursuitReactionTime, pursuitLeadQuality } from '../../data/ratings.js'
import { runDebugOn, logRbVision, logPlayer, logBlock, logEngagements, logRunAssignment, lineDebugOn, logLine } from '../utils/runDebug.js'
import { ENGAGED_SPEED_MULT } from './engagement.js'
import { isRusher } from './passRush.js'

// [293] Accept the player so per-player acceleration/speed ratings drive movement (falls back to
// the position baseline for players without their own ratings).
function getAccel(player) {
  return accelFromRating(ratingOf(player, 'acceleration'))
}

function getMaxSpeed(player) {
  return speedFromRating(ratingOf(player, 'speed'))
}

function getEngageMult(player) {
  return player.isEngaged ? ENGAGED_SPEED_MULT : 1.0
}

// ── Pass-block system ─────────────────────────────────────────────────────────

const LINEMAN_LABELS      = new Set(['OL', 'C', 'G', 'T'])
const PASS_SET_DEPTH      = 2.5  // yards behind LOS the CENTER sets — interior of the pocket
const BLOCKER_SCAN_RADIUS = 8    // yards from anchor to detect incoming rushers
const MAX_LATERAL_DRIFT   = 3.5  // yards either side of anchor a lineman will mirror a rusher ([pocket])

// Pocket shape ([pass-pro feedback]): the outside linemen kick-slide DEEPER than the interior so
// the line forms a horseshoe (cup) instead of a flat wall — a tackle ~4 yds wide of center sets
// deeper than the center, and edge rushers have to loop around that deepest point. ([pocket]
// raised from 0.7 so tackles drop back into a real cup instead of sitting nearly flat.)
const PASS_SET_WIDEN      = 1.0  // extra set depth per yard of lateral distance from center
// As its rusher works upfield the blocker kicks back to stay between the man and the QB, but never
// deeper than the back of the pocket (just in front of the QB's ~6-yd launch point).
const POCKET_DEPTH_MAX    = 8    // yards behind LOS a pass blocker will retreat to


function isLineman(label) {
  return LINEMAN_LABELS.has(label)
}

// The coordinated run-block unit: the offensive line plus an in-line tight end. They share the
// pre-snap blocking assignment so every front defender is accounted for ([run feedback]).
const RUN_BLOCKER_LABELS = new Set(['OL', 'C', 'G', 'T', 'TE'])

function isRunBlocker(label) {
  return RUN_BLOCKER_LABELS.has(label)
}

// Lazy anchor init — runs once per play (player objects are cleared between plays).
// anchorY is PASS_SET_DEPTH yards behind the LOS so the lineman drifts back on snap.
function initPassBlockAnchor(blocker, losY, dir) {
  if (blocker.passBlockAnchorX == null) {
    blocker.passBlockAnchorX = blocker.x
    // Outside linemen set deeper than interior → the pocket cups instead of being a flat wall.
    const widen = Math.abs(blocker.x - FIELD.WIDTH / 2) * PASS_SET_WIDEN
    blocker.passBlockAnchorY = losY - dir * (PASS_SET_DEPTH + widen)
  }
}

// Finds the rusher this lineman is responsible for: the nearest one in its gap
// window, but only if no teammate lineman's anchor is closer. Linemen react to
// defenders within MAX_LATERAL_DRIFT yards of their anchor x, and the exclusive
// check keeps two blockers from collapsing onto the same rusher and stacking up —
// the unassigned lineman holds its anchor and protects its area instead.
function findGapRusher(blocker, state, losY) {
  const ax = blocker.passBlockAnchorX
  let nearest = null, nearestDist = BLOCKER_SCAN_RADIUS

  for (const d of state.defensePlayers.values()) {
    const dx = d.x - ax
    if (Math.abs(dx) > MAX_LATERAL_DRIFT) continue
    // Measure to the lineman's LINE-UP spot (its gap at the LOS), not its deep set point — a
    // deep-setting tackle's anchor would otherwise fall outside the scan radius of a LOS rusher.
    const dist = Math.sqrt(dx * dx + (d.y - losY) ** 2)
    if (dist < nearestDist) { nearestDist = dist; nearest = d }
  }

  if (nearest && !isNearestLinemanTo(blocker, nearest, state, losY)) return null
  return nearest
}

// True when no other lineman's anchor sits closer to the rusher than this blocker's —
// i.e. this blocker owns the matchup. Uses anchors so the assignment is stable.
function isNearestLinemanTo(blocker, rusher, state, losY) {
  // Compare every lineman at its LINE-UP depth (losY) so the matchup is decided by gap alignment,
  // not by how deep each one happens to set — otherwise the deepest-setting tackle looks "far".
  const ax = blocker.passBlockAnchorX
  const myDist = Math.hypot(ax - rusher.x, losY - rusher.y)

  for (const o of state.offensePlayers.values()) {
    if (o.id === blocker.id || !isLineman(o.label)) continue
    const ox = o.passBlockAnchorX ?? o.x
    if (Math.hypot(ox - rusher.x, losY - rusher.y) < myDist) return false
  }
  return true
}

// Returns the position a pass-blocking lineman should steer toward. The lineman LATCHES
// onto a rusher at the snap and stays with it for the whole play — it mirrors the
// rusher's lane (following it laterally however far it works, not just inside a narrow
// window) while holding pocket depth, so it never releases and lets a looping rusher
// run free. The push-force / shed model still decides who actually wins the rep. A
// lineman with no one to block holds the pocket at its anchor.
// [pocket] How far (yds) a free lineman will slide to help double-team a rusher that is beating
// its own blocker, and how threatening that rusher must be before help commits.
const DOUBLE_TEAM_RANGE     = 4.0
const DOUBLE_TEAM_MIN_METER = 0.35   // rusher's win-meter (or negative leverage) that calls for help

// A free lineman (no rusher in its own gap) looks for the nearest engaged rusher that is winning
// its rep and slides over to double-team it, rather than standing idle at its anchor.
function findDoubleTeamRusher(blocker, state) {
  const ax = blocker.passBlockAnchorX ?? blocker.x
  let best = null, bestDist = DOUBLE_TEAM_RANGE
  for (const d of state.defensePlayers.values()) {
    if (!isRusher(state, d) || !d.isEngaged || d.shedBlock) continue
    const winning = (d.rushWinMeter ?? 0) >= DOUBLE_TEAM_MIN_METER || (d.leverageScore ?? 0) < 0
    if (!winning) continue
    const dist = Math.hypot(d.x - ax, d.y - blocker.y)
    if (dist < bestDist) { bestDist = dist; best = d }
  }
  return best
}

function getPassBlockTarget(blocker, state, losY, dir) {
  initPassBlockAnchor(blocker, losY, dir)
  const ax = blocker.passBlockAnchorX
  const ay = blocker.passBlockAnchorY

  // Stay with the rusher picked up earlier; only look for a new one if unassigned or the
  // assigned rusher has left the field. The initial pickup still respects the gap window
  // (so a wide-aligned rusher goes to the right lineman), but once latched we follow it.
  let rusher = blocker.blockTargetId ? state.defensePlayers.get(blocker.blockTargetId) : null
  if (!rusher) {
    rusher = findGapRusher(blocker, state, losY)
    blocker.blockTargetId = rusher?.id ?? null
  }
  if (!rusher) {
    // No man in this lineman's gap — slide over to help double-team a rusher that's winning,
    // otherwise hold the pocket at the anchor ([pocket] double teams).
    const help = findDoubleTeamRusher(blocker, state)
    if (help) {
      const side = Math.sign(ax - help.x) || 1   // stack on the side the free blocker is coming from
      const behind = Math.max((losY - ay) * dir, Math.min(POCKET_DEPTH_MAX, (losY - help.y) * dir))
      return { x: help.x + side * 0.8, y: losY - dir * behind }
    }
    return { x: ax, y: ay }   // no rush threat anywhere near — hold the pocket
  }

  // Mirror the rusher's lane AND kick back to stay between it and the QB ([pass-pro feedback]):
  // track how far the rusher has penetrated toward the QB — never shallower than the set anchor,
  // never deeper than the back of the pocket. "Behind the LOS" (toward the QB) is (losY - y)·dir.
  // So a tackle slides wide AND retreats with an edge rusher, walling the corner of the pocket,
  // rather than sitting flat and getting looped; a defender going the other way is ignored.
  const anchorBehind = (losY - ay) * dir
  const rusherBehind = (losY - rusher.y) * dir
  const behind = Math.max(anchorBehind, Math.min(POCKET_DEPTH_MAX, rusherBehind))
  return { x: rusher.x, y: losY - dir * behind }
}

// ── Run-block system ──────────────────────────────────────────────────────────

const RUN_SECOND_LEVEL_DEPTH   = 8   // yards past LOS a lineman releases to when the gap is clear
const SECOND_LEVEL_MIN_DEPTH   = 3   // yards past LOS — defenders shallower than this are first-level DL
const SECOND_LEVEL_SCAN_RADIUS = 15  // yards from a climbing blocker to search for a linebacker

// Drive blocking ([priority 2]): a run blocker doesn't chase a defender to its spot — it
// works to put its body between the defender and the run lane and DISPLACE the defender off it.
const BLOCK_DRIVE_LATERAL   = 0.0   // no sideways drift — the blocker stays nose-to-nose and drives straight back
const BLOCK_DRIVE_DOWNFIELD = 4.0   // yd downfield along the run line — aim well past the man so the OL keeps driving, not shading

// Gap ownership + anchoring + coordinated coverage ([P2/P3/P6] + every man accounted for).
const BLOCK_ANCHOR_RANGE   = 2.5   // yd of lateral drift a lineman is allowed from its snap anchor
const FRONT_DEFENDER_DEPTH = 3     // yd past LOS — defenders this shallow are the front the OL must block
const BLOCK_REACH          = 3.5   // yd from its anchor a lineman can still own / pick up a man

// A down defender at the line of scrimmage that the OL must account for.
function isFrontDefender(d, losY, dir) {
  return (d.y - losY) * dir <= FRONT_DEFENDER_DEPTH
}

// Coordinated run-block assignment ([run feedback] — every man accounted for). The OL + in-line
// TE share one assignment, made at the snap and HELD all play (man blocking). The priority is
// coverage first: every front defender gets exactly one blocker before any blocker is allowed to
// double-team or climb. The assignment doesn't churn — a blocker only releases its man when that
// man sheds the block or leaves the front — so reassignment can never momentarily spring a
// defender free. Leftover blockers (more blockers than the front) climb to the second level or
// double-team in getRunBlockTarget — the "extra man works to the linebacker."
function assignRunBlockers(state, losY, dir) {
  const blockers = []
  for (const o of state.offensePlayers.values()) {
    if (!isRunBlocker(o.label)) continue
    if (o.blockAnchorX == null) o.blockAnchorX = o.x   // [P3] latch alignment at the snap
    blockers.push(o)
  }
  // The front to account for: down defenders / anyone crowding the LOS who hasn't shed. A man who
  // has beaten his block is free (no longer blockable here) — don't waste a blocker holding him.
  const front    = [...state.defensePlayers.values()].filter(d => isFrontDefender(d, losY, dir) && !d.shedBlock)
  const frontIds = new Set(front.map(d => d.id))

  const usedBlockers = new Set()
  const coveredDef   = new Set()

  // 0. ENGAGEMENT FIRST — each engaged front defender is blocked by the lineman it's actually in
  //    contact with. We key off the DEFENDER's engagedWithId (set by runEngagement from the very
  //    same pairing the push force uses), not the blocker's — those two sides can disagree, and the
  //    push follows the defender's side. Matching it means the lineman physically driving a man is
  //    the one assigned to it, so it's never told to climb off its own block (which sprang the free
  //    rusher). If one lineman is the primary on two defenders, the first keeps it and the other
  //    defender falls through to be covered below.
  const blockerById = new Map(blockers.map(b => [b.id, b]))
  for (const d of front) {
    const b = d.engagedWithId ? blockerById.get(d.engagedWithId) : null
    if (b && !usedBlockers.has(b.id)) {
      b.blockAssignmentId = d.id
      usedBlockers.add(b.id); coveredDef.add(d.id)
    }
  }

  // 1. Keep an un-engaged blocker on its prior assignment while that man is still a front threat
  //    (latched — no churn). If its man was already claimed by whoever is engaged with him, free
  //    this blocker to help / climb.
  for (const b of blockers) {
    if (usedBlockers.has(b.id)) continue
    const id = b.blockAssignmentId
    if (id && frontIds.has(id) && !coveredDef.has(id)) {
      usedBlockers.add(b.id); coveredDef.add(id)
    } else {
      b.blockAssignmentId = null
    }
  }

  // 2. EVERYONE BLOCKED FIRST: give every still-uncovered front defender the nearest free blocker,
  //    most dangerous (interior, nearest the center) first. With blockers ≥ front this leaves no
  //    defender unaccounted for before anyone helps or climbs.
  const center    = FIELD.WIDTH / 2
  const uncovered = front
    .filter(d => !coveredDef.has(d.id))
    .sort((a, b) => Math.abs(a.x - center) - Math.abs(b.x - center))
  for (const d of uncovered) {
    let best = null, bd = Infinity
    for (const b of blockers) {
      if (usedBlockers.has(b.id)) continue
      const dist = Math.hypot(b.x - d.x, b.y - d.y)
      if (dist < bd) { bd = dist; best = b }
    }
    if (best) { best.blockAssignmentId = d.id; usedBlockers.add(best.id); coveredDef.add(d.id) }
  }

  // ── Debug: surface the full blocking picture so a free rusher is obvious ([run feedback]) ──
  if (runDebugOn()) {
    // Who is actually engaged with whom (read from the defenders' side — reliably set).
    const engagedTo = new Map()   // blockerId -> [defenderId,…]
    for (const d of state.defensePlayers.values()) {
      if (!d.engagedWithId) continue
      if (!engagedTo.has(d.engagedWithId)) engagedTo.set(d.engagedWithId, [])
      engagedTo.get(d.engagedWithId).push(d.id)
    }
    const lines = blockers.map(b => {
      const a   = b.blockAssignmentId
      const eng = engagedTo.get(b.id) ?? []
      let note
      if (a) note = eng.includes(a) ? 'on-man' : eng.length ? `engaged ${eng.join('/')} — NOT its man ${a}` : 'NOT-ENGAGED'
      else   note = b.climbTargetId ? `climbing ${b.climbTargetId}` : (eng.length ? `engaged ${eng.join('/')}` : 'free')
      return `${b.id}(${b.label}) → ${a ?? 'FREE'}  [${note}]`
    })
    const uncovered = front.filter(d => !coveredDef.has(d.id)).map(d => `${d.id}(${d.label}@${n2(d.x)},${n2(d.y)})`)
    const looseDl   = [...state.defensePlayers.values()]
      .filter(d => d.label === 'DL' && !frontIds.has(d.id))
      .map(d => `${d.id}@(${n2(d.x)},${n2(d.y)})`)

    // Throttle: only log when the picture (assignments + engagements + free rushers) changes.
    const sig = blockers.map(b => `${b.id}:${b.blockAssignmentId ?? ''}:${(engagedTo.get(b.id) ?? []).join('+')}`).join('|')
              + '#' + uncovered.join(',') + '#' + looseDl.join(',')
    if (sig !== state._runAssignSig) {
      state._runAssignSig = sig
      logRunAssignment({ tick: state.tick, lines, uncovered, looseDl })
    }
  }
}

// One-decimal formatter for debug positions.
function n2(v) { return typeof v === 'number' ? v.toFixed(1) : '?' }

// Finds the nearest second-level LINEBACKER for a climbing blocker. Climbers go after
// linebackers, never safeties ([priority 2]). Defenders shallower than SECOND_LEVEL_MIN_DEPTH
// are still first-level and skipped.
function findSecondLevelLinebacker(blocker, state, losY, dir) {
  let nearest = null, nearestDist = SECOND_LEVEL_SCAN_RADIUS
  for (const d of state.defensePlayers.values()) {
    if (d.label !== 'LB') continue
    const depthPastLos = (d.y - losY) * dir
    if (depthPastLos < SECOND_LEVEL_MIN_DEPTH) continue
    const dist = Math.sqrt((d.x - blocker.x) ** 2 + (d.y - blocker.y) ** 2)
    if (dist < nearestDist) { nearestDist = dist; nearest = d }
  }
  return nearest
}

// Nearest front defender within reach of this blocker's anchor — a man a free blocker can
// help double-team without abandoning its gap.
function findNearbyFrontDefender(blocker, state, losY, dir) {
  let nearest = null, nearestDist = BLOCK_REACH
  for (const d of state.defensePlayers.values()) {
    if (!isFrontDefender(d, losY, dir)) continue
    const dx = Math.abs(d.x - blocker.blockAnchorX)
    if (dx < nearestDist) { nearestDist = dx; nearest = d }
  }
  return nearest
}

// The called run angle defines a LINE from the center of the formation extending downfield to
// infinity (the white run arrow). Run blockers "part the sea" along this line — clearing
// everything on it — rather than aiming at a single hole point.
function runLine(state, losY, dir) {
  const angle = ((state.playDesign?.runAngle ?? 0) * Math.PI) / 180
  return { ox: FIELD.WIDTH / 2, oy: losY, dx: Math.sin(angle), dy: Math.cos(angle) * dir }
}

// Drive target: shove the defender perpendicular-AWAY from the run line (to whichever side it's
// already on) and downfield along the line, so the run-angle lane is swept clear — create
// space, not tackles.
function runDriveTarget(def, line) {
  const relX = def.x - line.ox, relY = def.y - line.oy
  const perpX = -line.dy, perpY = line.dx                     // left-perpendicular to the line
  const side  = Math.sign(relX * perpX + relY * perpY) || 1   // which side of the line the defender is on
  return {
    x: def.x + perpX * side * BLOCK_DRIVE_LATERAL + line.dx * BLOCK_DRIVE_DOWNFIELD,
    y: def.y + perpY * side * BLOCK_DRIVE_LATERAL + line.dy * BLOCK_DRIVE_DOWNFIELD,
  }
}

// Same drive, but the blocker's x is clamped to its anchor ± BLOCK_ANCHOR_RANGE so it works its
// defender without chasing laterally out of the line ([priority 3]).
function anchoredDrive(blocker, def, line) {
  const t = runDriveTarget(def, line)
  const lo = blocker.blockAnchorX - BLOCK_ANCHOR_RANGE
  const hi = blocker.blockAnchorX + BLOCK_ANCHOR_RANGE
  t.x = Math.max(lo, Math.min(hi, t.x))
  return t
}

// Returns the position a run-blocking lineman should steer toward.
//   Gap defender present, primary blocker: drive the defender away from the hole.
//   Gap defender present, secondary of a double team WITH the block already secured: climb
//     to the nearest linebacker. Otherwise stay and help drive (don't abandon it).
//   Gap clear: climb to the nearest linebacker, else release upfield to the second level.
// Logs a blocker's assignment/target the first time it's set and whenever it changes —
// surfaces chasing / target-switching in the run debug stream.
function traceBlock(state, blocker, targetId, gap = null) {
  if (!runDebugOn()) return
  const first   = blocker._blockTargetId === undefined
  const changed = !first && blocker._blockTargetId !== targetId
  if (first || changed) logBlock({ tick: state.tick, blocker, gap, targetId, changed })
  blocker._blockTargetId = targetId
}

function getRunBlockTarget(blocker, state, losY, dir) {
  if (blocker.blockAnchorX == null) blocker.blockAnchorX = blocker.x   // [P3] latch the alignment at snap

  const line = runLine(state, losY, dir)

  // Already climbing to the second level — commit to that linebacker (don't drop back to the
  // gap and oscillate). Fall through only if the linebacker is gone.
  if (blocker.climbTargetId) {
    const lb = state.defensePlayers.get(blocker.climbTargetId)
    if (lb) {
      traceBlock(state, blocker, lb.id, Math.round(blocker.blockAnchorX))
      return anchoredDrive(blocker, lb, line)
    }
    blocker.climbTargetId = null
  }

  // assignRunBlockers (run earlier this tick) set blockAssignmentId so every front defender is
  // covered. Drive the assigned man, anchored to the gap.
  const assigned = blocker.blockAssignmentId ? state.defensePlayers.get(blocker.blockAssignmentId) : null

  let targetId = null
  let target

  if (assigned) {
    targetId = assigned.id
    target   = anchoredDrive(blocker, assigned, line)
  } else {
    // The front is covered and this blocker is free: climb to a linebacker, else double-team a
    // NEARBY front defender (gap integrity — never chase a far man), else hold the anchor.
    const lb = findSecondLevelLinebacker(blocker, state, losY, dir)
    if (lb) {
      blocker.climbTargetId = lb.id
      targetId = lb.id
      target   = anchoredDrive(blocker, lb, line)
    } else {
      const help = findNearbyFrontDefender(blocker, state, losY, dir)
      if (help) {
        targetId = help.id
        target   = anchoredDrive(blocker, help, line)
      } else {
        target = { x: blocker.blockAnchorX, y: losY + dir * RUN_SECOND_LEVEL_DEPTH }
      }
    }
  }

  traceBlock(state, blocker, targetId, Math.round(blocker.blockAnchorX))
  return target
}

// ── Skill-position run blocking ([run fix]) ──────────────────────────────────
//
// On a run play every non-carrier skill player (WR/TE/extra RB) blocks rather than running
// its route. It walls off the nearest defender within scan range — driving into them to
// shield the ball carrier's lane — and, with no one to hit, presses upfield to the next
// level to spring a longer run.
const SKILL_BLOCK_SCAN = 12   // yards a downfield blocker scans for a defender to wall off

function getSkillRunBlockTarget(blocker, state, losY, dir) {
  let nearest = null
  let nearestDist = SKILL_BLOCK_SCAN
  for (const d of state.defensePlayers.values()) {
    const dist = Math.hypot(d.x - blocker.x, d.y - blocker.y)
    if (dist < nearestDist) { nearestDist = dist; nearest = d }
  }
  // Drive the nearest defender off the run line (part the sea), or climb upfield to find work.
  traceBlock(state, blocker, nearest?.id ?? null)
  if (nearest) return runDriveTarget(nearest, runLine(state, losY, dir))
  return { x: blocker.x, y: losY + dir * (RUN_SECOND_LEVEL_DEPTH + 6) }
}

// ── Blocker protection (RBs / TEs assigned route='block') — blitz pickup ─────────

// Yards from the QB within which an unblocked rusher is the kept-in blocker's responsibility.
const PROTECTION_SCAN_RADIUS = 12

// The rushers the rest of the protection has already accounted for — every other blocker's latched
// man, plus the gap rusher each un-latched lineman is about to pick up (so the back doesn't double a
// blocked lineman on the first tick while the real blitzer comes free).
function claimedRushers(blocker, state, losY) {
  const claimed = new Set()
  for (const o of state.offensePlayers.values()) {
    if (o.id === blocker.id) continue
    if (o.blockTargetId) { claimed.add(o.blockTargetId); continue }
    if (isLineman(o.label)) {
      const r = findGapRusher(o, state, losY)
      if (r) claimed.add(r.id)
    }
  }
  return claimed
}

// Returns the position a protection blocker (kept-in RB / TE) should steer toward. This is the
// blitz-pickup logic ([blitz feedback]): the blocker latches onto the most urgent UNBLOCKED rusher
// — the blitzer the line didn't account for — and meets it, instead of drifting to whatever
// defender is nearest the QB (which is usually a DL the line already has). Holds in front of the QB
// when every rusher is already blocked.
function getBlockerTarget(blocker, state, losY, dir) {
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }

  const holdTarget = { x: blocker.x, y: losY - dir * 2 }
  if (!qb) return holdTarget

  // Stay with a blitzer already picked up (latched for the play).
  let rusher = blocker.blockTargetId ? state.defensePlayers.get(blocker.blockTargetId) : null
  if (rusher && rusher.shedBlock) rusher = null   // it beat us clean — re-scan for the next threat

  if (!rusher) {
    const claimed = claimedRushers(blocker, state, losY)
    let best = null, bestDist = PROTECTION_SCAN_RADIUS
    for (const d of state.defensePlayers.values()) {
      if (!isRusher(state, d) || claimed.has(d.id)) continue
      const dist = Math.hypot(d.x - qb.x, d.y - qb.y)
      if (dist < bestDist) { bestDist = dist; best = d }
    }
    rusher = best
    blocker.blockTargetId = best?.id ?? null
  }

  if (!rusher) return holdTarget   // no free rusher — hold in front of the QB

  // [pass-pro] Step squarely into the rusher's path — a point ~1 yd on the QB side of the rusher,
  // along the rusher→QB line — so the back/TE meets it head-on (not chasing from behind). Getting
  // body-to-body triggers the engagement, and the pass-rush ramp then holds the rusher up.
  const dx = qb.x - rusher.x, dy = qb.y - rusher.y
  const len = Math.hypot(dx, dy) || 1
  const STEP = 1.0
  return { x: rusher.x + (dx / len) * STEP, y: rusher.y + (dy / len) * STEP }
}

// ── Ball-carrier movement ([157]) ───────────────────────────────────────────────
//
// One shared model for every player who has the ball in open field: the designed
// runner, a scrambling QB, and a receiver after the catch. They all read the field
// through the RB vision raycast ([154]–[156]) and accelerate toward the most open lane
// using identical acceleration / pathfinding logic. The caller passes the player's own
// accel and top speed (from its ratings).
//
// Critically, this steers through the player's existing p.vx / p.vy and never resets
// them: a receiver who catches at full stride keeps that momentum and stays at top
// speed, rather than decelerating to re-accelerate as a "new" runner. The handoff from
// route-running (or QB drop) to carrying the ball is seamless because velocity is
// continuous on the player object — only the steering target changes.
//
// biasAngle (radians) nudges lane choice toward a preferred direction: a designed run
// uses the called gap angle; an improvised carrier (scramble / after-catch) runs
// straight upfield (0).
// Cuts cost speed ([159]). When a newly chosen lane breaks sharply from the carrier's
// current heading, it has to plant and redirect — and can't carry full speed through the
// cut. We model the carrier's currently-achievable speed as p.runSpeedCap, which a cut
// knocks down and which then rebuilds toward top speed at the ACCELERATION rate. Steering
// against this cap (rather than bleeding vx/vy, which the steer snap would instantly
// erase) is what makes acceleration actually govern both the loss and the recovery.
//
// Only turns sharper than CUT_TURN_THRESHOLD cost anything; the penalty scales from there
// up to the full accel-based retention loss on a dead reverse.
const CUT_TURN_THRESHOLD = Math.cos(Math.PI / 4)   // 45° — gentler course corrections are free

// Hit-the-hole burst ([run fix]): a designed runner is forced down the called run angle for
// this long after the snap before its vision kicks in and it can pick its own lane.
const RUN_COMMIT_TIME = 0.35   // seconds
const RUN_COMMIT_LOOK = 8      // yards ahead the committed runner aims while bursting

// Seed the lane heading for an improvised carrier's FIRST vision read ([183]/[186]). A receiver
// who catches in stride is already running downfield — keep that heading so the transition to
// ball carrier is seamless (no snap-to-straight redirect). But a back-pedaling scramble QB (or a
// receiver still working back on a comeback) is moving the wrong way; it turns straight upfield
// (north-south) instead of carrying its backward momentum. Forward = vy·dir > 0.
function seedCarrierHeading(p, dir) {
  const speed = Math.hypot(p.vx, p.vy)
  if (speed > 0.5 && (p.vy ?? 0) * dir > 0) return { x: p.vx / speed, y: p.vy / speed }
  return { x: 0, y: dir }
}

// sets (optional) overrides which players the carrier reads as defenders to avoid and which as
// blockers — defaults to the offense-carrier view (avoid the defense, weave through own offense).
// An interception return flips them: the returner avoids the offense and is escorted by its
// defensive teammates.
function moveBallCarrier(p, state, dir, dt, accel, topSpd, biasAngle = 0, forceCommit = false, sets = null) {
  const opponents = sets?.opponents ?? state.defensePlayers
  const teammates = sets?.teammates ?? state.offensePlayers
  const maxCarrySpeed = topSpd * 1.1

  // Seed the achievable-speed cap from the carrier's current speed the first tick it has
  // the ball: an RB taking a handoff at half speed ([159]) ramps up from there; a receiver
  // who catches at full stride ([157]) is already capped at top speed and keeps it.
  if (p.runSpeedCap == null) p.runSpeedCap = Math.hypot(p.vx, p.vy)

  // Hit-the-hole burst: at the start of a designed run the back commits to the called
  // direction and presses downhill before reading the field, instead of dancing for an
  // open lane out of the gate. While forced, it ignores vision and aims straight down the
  // run angle; the first vision read happens the instant the burst ends.
  if (forceCommit) {
    p.runLane = { dirX: Math.sin(biasAngle), dirY: Math.cos(biasAngle) * dir, clear: RUN_COMMIT_LOOK }
    p.runSpeedCap = Math.min(maxCarrySpeed, p.runSpeedCap + accel * dt)
    const look = Math.max(3, p.runLane.clear)
    steer(p, p.x + p.runLane.dirX * look, p.y + p.runLane.dirY * look, p.runSpeedCap, dt, accel)
    return
  }

  // Re-read the field for the most open lane on an interval set by the carrier's vision
  // rating ([155]): an elite back re-evaluates ~every 0.2s, a poor one only every ~3s —
  // committing to a stale lane in between and missing developing creases.
  const interval = visionInterval(ratingOf(p, 'vision'))
  p.visionTimer  = (p.visionTimer ?? interval) + dt
  if (!p.runLane || p.visionTimer >= interval) {
    const defenders = [...opponents.values()]
    const blockers  = [...teammates.values()].filter(o => o.id !== p.id)
    // Commit to the current lane (or, on the first read, the carrier's current forward heading)
    // so cuts are decisive and the back doesn't weave between near-equal creases ([priority 7]).
    const currentDir = p.runLane
      ? { x: p.runLane.dirX, y: p.runLane.dirY }
      : seedCarrierHeading(p, dir)
    const newLane   = findRunningLane(p, defenders, blockers, dir, biasAngle, currentDir)

    // A sharp change of direction plants and bleeds speed; acceleration sets how much survives.
    let cut = false
    const speed = Math.hypot(p.vx, p.vy)
    if (speed > 0.5) {
      const cosTurn = (p.vx * newLane.dirX + p.vy * newLane.dirY) / speed   // 1 = straight on, −1 = reverse
      if (cosTurn < CUT_TURN_THRESHOLD) {
        const accelRating = ratingOf(p, 'acceleration')
        const sharpness   = Math.min(1, (CUT_TURN_THRESHOLD - cosTurn) / (CUT_TURN_THRESHOLD + 1))
        const retention   = 1 - (1 - cutRetentionFromAccel(accelRating)) * sharpness
        p.runSpeedCap = Math.min(p.runSpeedCap, speed * retention)
        cut = true
      }
    }
    p.runLane     = newLane
    p.visionTimer = 0

    if (runDebugOn()) logRbVision({ tick: state.tick, carrier: p, lane: newLane, cut })
  }

  // Rebuild the cap toward top speed at the acceleration rate (yd/s² · dt), so a faster
  // accelerator recovers from the cut — and ramps off the half-speed start — quicker.
  p.runSpeedCap = Math.min(maxCarrySpeed, p.runSpeedCap + accel * dt)

  const look = Math.max(3, p.runLane.clear)   // aim into the open space ahead
  steer(p, p.x + p.runLane.dirX * look, p.y + p.runLane.dirY * look, p.runSpeedCap, dt, accel)
}

// ── Offense movement ──────────────────────────────────────────────────────────

function moveOffense(state, dt) {
  const dir      = state.direction
  const losY     = getLosY(state)
  const playType = state.playDesign?.playType ?? 'pass'
  const carrier  = findBallCarrier(state)

  // Assign the front before anyone moves so every down defender is accounted for.
  if (playType === 'run') assignRunBlockers(state, losY, dir)

  for (const p of state.offensePlayers.values()) {
    const label = p.label ?? ''

    // Press jam ([press]): a stunned player is frozen until the stun wears off.
    if ((p.stunTimer ?? 0) > 0) { p.stunTimer -= dt; p.vx = 0; p.vy = 0; continue }

    const fm      = getFatigueMult(state, p.id)
    const accel   = getAccel(p) * fm
    const topSpd  = getMaxSpeed(p) * fm * getEngageMult(p)

    // Whoever is carrying the ball — designed runner, scrambling QB, or receiver after
    // the catch — runs through the shared ball-carrier model. Checked first so it wins
    // over the player's route / QB-drop / block branch, and so the velocity built up on
    // a route carries straight into the run (no acceleration reset on the catch).
    if (carrier && p.id === carrier.id) {
      // A designed run aims for the called gap; an improvised carrier runs straight upfield.
      const designedRun = playType === 'run' && label === 'RB'
      const biasAngle = designedRun
        ? ((state.playDesign?.runAngle ?? 0) * Math.PI) / 180
        : 0
      // Force the called direction for the first RUN_COMMIT_TIME of a designed run.
      let forceCommit = false
      if (designedRun) {
        p.runElapsed = (p.runElapsed ?? 0) + dt
        forceCommit  = p.runElapsed <= RUN_COMMIT_TIME
      }
      moveBallCarrier(p, state, dir, dt, accel, topSpd, biasAngle, forceCommit)
      advance(p, dt)
      continue
    }

    if (label === 'QB') {
      steer(p, p.x, losY - dir * 8, topSpd * 0.75, dt, accel)

    } else if (playType === 'run' && isRunBlocker(label)) {
      // Run play: the OL + in-line TE drive their COORDINATED assignment (every front defender
      // accounted for) or, once the front is covered, climb to the second level / double-team.
      const target = getRunBlockTarget(p, state, losY, dir)
      steer(p, target.x, target.y, topSpd * 0.75, dt, accel)

    } else if (isLineman(label)) {
      // Pass play: pass protection.
      const target = getPassBlockTarget(p, state, losY, dir)
      steer(p, target.x, target.y, topSpd * 0.6, dt, accel)

    } else if (playType === 'run' && RECEIVER_LABELS.has(label)) {
      // [run fix] On a run, perimeter receivers (WR / extra RB) block instead of running routes —
      // they wall off the nearest defender and otherwise push upfield to spring the ball carrier.
      const target = getSkillRunBlockTarget(p, state, losY, dir)
      steer(p, target.x, target.y, topSpd * 0.9, dt, accel)

    } else if (p.route === 'block') {
      const target = getBlockerTarget(p, state, losY, dir)
      steer(p, target.x, target.y, topSpd * 0.85, dt, accel)

    } else if (p.route) {
      const rt = getRouteTarget(p, losY, dir, dt)
      if (rt) steer(p, rt.x, rt.y, topSpd, dt, accel)

    } else {
      steer(p, p.x, losY + dir * 8, topSpd * 0.7, dt, accel)
    }

    advance(p, dt)
  }
}

// ── Receiver spacing ──────────────────────────────────────────────────────────

// Minimum personal space each receiver tries to maintain from teammates.
// Applied after route steering so it nudges without overriding the route direction.
const SPACED_LABELS    = new Set(['WR', 'TE', 'RB'])
const SPACING_RADIUS   = 3.5   // yards
const SEPARATION_FORCE = 12    // repulsion strength (yards/sec²)

function applySeparation(players, dt) {
  const skill = [...players.values()].filter(p => SPACED_LABELS.has(p.label ?? ''))

  for (let i = 0; i < skill.length; i++) {
    for (let j = i + 1; j < skill.length; j++) {
      const a  = skill[i]
      const b  = skill[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = dx * dx + dy * dy

      if (d2 < SPACING_RADIUS * SPACING_RADIUS && d2 > 0.0001) {
        const dist     = Math.sqrt(d2)
        const strength = SEPARATION_FORCE * (SPACING_RADIUS - dist) / SPACING_RADIUS
        const fx = (dx / dist) * strength * dt
        const fy = (dy / dist) * strength * dt
        a.vx += fx;  a.vy += fy
        b.vx -= fx;  b.vy -= fy
      }
    }
  }
}

// ── Lineman spacing ─────────────────────────────────────────────────────────
//
// Collision response only resolves offense-vs-defense overlaps, so linemen have
// nothing keeping them off each other — without this they stack up when two slide
// toward the same area. A short-range repulsion keeps a clean, spaced pocket.

const LINE_SPACING_RADIUS   = 1.6   // yards center-to-center linemen try to keep
const LINE_SEPARATION_FORCE = 14    // repulsion strength (yards/sec²)

function applyLineSpacing(players, dt) {
  const line = [...players.values()].filter(p => isLineman(p.label ?? ''))

  for (let i = 0; i < line.length; i++) {
    for (let j = i + 1; j < line.length; j++) {
      const a  = line[i]
      const b  = line[j]
      const dx = a.x - b.x
      const dy = a.y - b.y
      const d2 = dx * dx + dy * dy

      if (d2 < LINE_SPACING_RADIUS * LINE_SPACING_RADIUS && d2 > 0.0001) {
        const dist     = Math.sqrt(d2)
        const strength = LINE_SEPARATION_FORCE * (LINE_SPACING_RADIUS - dist) / LINE_SPACING_RADIUS
        const fx = (dx / dist) * strength * dt
        const fy = (dy / dist) * strength * dt
        a.vx += fx;  a.vy += fy
        b.vx -= fx;  b.vy -= fy
      }
    }
  }
}

// ── Contain and blitz constants ──────────────────────────────────────────────

// Yards to QB's y-depth at which a contain rusher turns inside the pocket.
const CONTAIN_CLOSE_THRESHOLD = 3

// Yards outside the QB that an edge rusher arcs through on its way upfield. Keeps
// the rush wide (outside the tackle) instead of crashing the middle; the rusher
// only cuts back toward the QB once it has reached QB depth and turned the corner.
const CONTAIN_LANE_WIDTH = 4.5

// Target an edge rusher steers toward: a lane CONTAIN_LANE_WIDTH outside the QB on
// the rusher's side until it reaches QB depth, then the QB itself to close the sack.
function edgeRushTarget(p, qb) {
  const side    = p.x < FIELD.WIDTH / 2 ? -1 : 1   // left edge rushes left, right edge right
  const atDepth = Math.abs(p.y - qb.y) < CONTAIN_CLOSE_THRESHOLD
  const x       = atDepth ? qb.x : qb.x + side * CONTAIN_LANE_WIDTH
  return { x, y: qb.y }
}

// ── Pursuit angles ([145]) ────────────────────────────────────────────────────
//
// Defenders chasing a moving ball carrier should aim at where the carrier WILL be,
// not where it is — running straight at the current spot produces a lagging tail
// chase that a fast carrier outruns. getPursuitTarget solves for the earliest point
// the pursuer can reach at the same time as the carrier (a classic intercept) and
// returns it as the steering target, yielding a realistic cut-off angle.

// Seconds of lead the cap allows. Generous enough that the intercept time itself shapes the
// angle ([priority 5]) — a fast defender's small intercept time gives a flat, shallow cut-off,
// a slow defender's large time gives a deep angle — while still bounding an absurd downfield aim.
const PURSUIT_MAX_LEAD = 3.5

// Flow-around avoidance ([priority 6]): a pursuing defender shouldn't grind face-first into a
// blocker — it arcs around it. If a blocker (not the one it's already engaged with) sits in
// the defender's path to its target, nudge the steering point laterally to go around it.
const AVOID_RANGE     = 5.0   // yd ahead a blocker in the path triggers avoidance
const AVOID_HALFWIDTH = 1.6   // yd off the path line a blocker must be within to block it
const AVOID_OFFSET    = 2.5   // yd of lateral nudge applied (scaled by how close the blocker is)

function avoidBlockerInPath(defender, target, blockers) {
  const tx = target.x - defender.x
  const ty = target.y - defender.y
  const tl = Math.hypot(tx, ty)
  if (tl < 0.001) return target

  const ux = tx / tl, uy = ty / tl     // unit vector toward the target
  const px = -uy, py = ux              // left-perpendicular

  let near = null
  for (const b of blockers) {
    if (b.id === defender.engagedWithId) continue   // already fighting this one — don't slip it
    const bx = b.x - defender.x
    const by = b.y - defender.y
    const along = bx * ux + by * uy
    if (along <= 0.2 || along > AVOID_RANGE) continue
    const side = bx * px + by * py
    if (Math.abs(side) > AVOID_HALFWIDTH) continue
    if (!near || along < near.along) near = { along, side }
  }
  if (!near) return target

  // Veer to the side away from the blocker (head-on ties break left); stronger when closer.
  const dir      = near.side > 0.05 ? -1 : 1
  const strength = AVOID_OFFSET * (1 - near.along / AVOID_RANGE)
  return { x: target.x + px * dir * strength, y: target.y + py * dir * strength }
}

// Smallest non-negative root of a·t² + b·t + c = 0, or null if there is none.
function smallestPositiveRoot(a, b, c) {
  const EPS = 1e-6
  if (Math.abs(a) < EPS) {
    if (Math.abs(b) < EPS) return null
    const t = -c / b
    return t > EPS ? t : null
  }
  const disc = b * b - 4 * a * c
  if (disc < 0) return null
  const sq = Math.sqrt(disc)
  const t1 = (-b - sq) / (2 * a)
  const t2 = (-b + sq) / (2 * a)
  const candidates = [t1, t2].filter(t => t > EPS)
  return candidates.length ? Math.min(...candidates) : null
}

// Returns the intercept point a pursuer should steer toward to cut off `target`.
// Defenders never run directly at the carrier ([priority 5]): they always aim at where it
// WILL be. The intercept time itself sets the angle — fast defenders meet it shallow (a flat
// cut-off), slow defenders aim deep. When no clean intercept exists (the carrier is pulling
// away) the pursuer still takes the deepest practical angle toward the carrier's path rather
// than chasing its current spot.
//
// leadQuality (0–1) scales how much of that lead the pursuer anticipates ([160]): 1 = the
// perfect cut-off angle, lower values under-lead, 0 = a flat-footed chase of the current spot
// (the reaction beat before a defender commits). Awareness sets this.
export function getPursuitTarget(pursuer, target, pursuerSpeed, leadQuality = 1) {
  const rx  = target.x - pursuer.x
  const ry  = target.y - pursuer.y
  const tvx = target.vx ?? 0
  const tvy = target.vy ?? 0

  // |R + Vt·t| = s·t  →  (|Vt|² − s²)t² + 2(R·Vt)t + |R|² = 0
  const a = tvx * tvx + tvy * tvy - pursuerSpeed * pursuerSpeed
  const b = 2 * (rx * tvx + ry * tvy)
  const c = rx * rx + ry * ry

  // Intercept time drives the angle; no intercept → take the maximum (deepest) lead.
  const t    = smallestPositiveRoot(a, b, c)
  const lead = (t == null ? PURSUIT_MAX_LEAD : Math.min(t, PURSUIT_MAX_LEAD)) * leadQuality
  return {
    x: Math.max(0, Math.min(FIELD.WIDTH, target.x + tvx * lead)),
    y: target.y + tvy * lead,
  }
}

// The loose ball carrier defenders should rally to: an explicit carrier once one is
// set, otherwise the designated runner on a run play. Returns null during pocket
// passing (the QB holding the ball is handled by the rush, not by pursuit) so man
// and zone coverage stay intact until the ball is actually loose.
export function findBallCarrier(state) {
  // An explicit carrier may live on either side: the offense normally, or an intercepting
  // defender returning the ball ([189]/[190]).
  if (state.ballCarrierId) {
    return state.offensePlayers.get(state.ballCarrierId)
        ?? state.defensePlayers.get(state.ballCarrierId)
        ?? null
  }

  if (state.playDesign?.playType === 'run') {
    for (const p of state.offensePlayers.values()) {
      if (p.label === 'RB') return p
    }
  }
  return null
}

// ── QB spy ([151]) ────────────────────────────────────────────────────────────
//
// A spy shadows the quarterback instead of dropping into coverage: it mirrors the QB
// horizontally from a shallow depth, staying disciplined while the QB sits in the
// pocket. The moment the QB leaves the pocket — breaking contain wide of the tackles
// or stepping up toward the line to scramble — the spy commits and attacks.

const SPY_DEPTH            = 2.5   // yards behind the LOS the spy shadows from
const SPY_POCKET_HALFWIDTH = 7     // yards from center the QB can roam before it's "out of the pocket"
const SPY_POCKET_FRONT     = 3     // yards behind the LOS the QB must stay to count as "in the pocket"

// True once the QB has left the pocket — scrambled wide of the tackles, or stepped up
// to/through the line of scrimmage.
export function isQbScrambling(qb, center, losY, dir) {
  if (!qb) return false
  const brokeContain = Math.abs(qb.x - center) > SPY_POCKET_HALFWIDTH
  const steppedUp    = (losY - qb.y) * dir < SPY_POCKET_FRONT
  return brokeContain || steppedUp
}

// ── Zone coverage ([146]–[148]) ───────────────────────────────────────────────
//
// A zone defender owns a circular area around a landmark. With the area clear it
// patrols (sinks) toward the landmark; when a receiver enters it breaks on the most
// dangerous threat — but its steering target never leaves the zone, so it carries a
// receiver through the area without abandoning it (coverage integrity).
//
// Ratings shape the read ([148]):
//   awareness → detection range: elite defenders recognize threats entering sooner.
//   coverage  → anticipation lead: elite defenders break on the ball more cleanly.

const ZONE_RADIUS          = 7      // yards — the area a zone defender patrols and defends
const ZONE_AWARENESS_RANGE = 4      // extra detection yards beyond the zone at 99 awareness
const ZONE_LEAD_BASE       = 0.15   // seconds of threat velocity a zone defender anticipates
const ZONE_COVERAGE_LEAD   = 0.25   // extra anticipation seconds at 99 coverage skill
const ZONE_PATROL_SPEED    = 0.6    // fraction of top speed sinking back to the landmark
const ZONE_REACT_SPEED     = 0.95   // fraction of top speed breaking on a threat

const RECEIVER_LABELS = new Set(['WR', 'TE', 'RB'])

// Finds the most dangerous receiver in a zone defender's detection range: the one
// that has penetrated closest to the landmark. Detection range extends past the zone
// for high-awareness defenders so they read threats before they arrive ([147]/[148]).
export function findZoneThreat(zoneCenter, offensePlayers, awareness = 55) {
  const detectRadius = ZONE_RADIUS + (awareness / 99) * ZONE_AWARENESS_RANGE
  let best = null
  let bestDist = detectRadius

  for (const p of offensePlayers.values()) {
    if (!RECEIVER_LABELS.has(p.label ?? '')) continue
    const d = Math.hypot(p.x - zoneCenter.x, p.y - zoneCenter.y)
    if (d < bestDist) { bestDist = d; best = p }
  }
  return best
}

// Steering target for a zone defender. Patrols the landmark when the area is clear;
// otherwise leads the threat (lead scales with coverage skill) but clamps the target
// to the zone radius so the defender never vacates its area ([146]/[147]).
// Returns { x, y, reacting } — `reacting` lets the caller drive harder on a threat.
export function getZoneTarget(zoneCenter, threat, coverage = 55) {
  if (!threat) return { x: zoneCenter.x, y: zoneCenter.y, reacting: false }

  const lead = ZONE_LEAD_BASE + (coverage / 99) * ZONE_COVERAGE_LEAD
  const tx   = threat.x + (threat.vx ?? 0) * lead
  const ty   = threat.y + (threat.vy ?? 0) * lead

  const ox   = tx - zoneCenter.x
  const oy   = ty - zoneCenter.y
  const dist = Math.hypot(ox, oy)

  if (dist <= ZONE_RADIUS) return { x: tx, y: ty, reacting: true }

  // Threat is beyond the boundary — break to the edge toward it, but hold the zone.
  return {
    x: zoneCenter.x + (ox / dist) * ZONE_RADIUS,
    y: zoneCenter.y + (oy / dist) * ZONE_RADIUS,
    reacting: true,
  }
}

// ── Deep-zone reach ───────────────────────────────────────────────────────────

const HELP_MIN_HELPER_DEPTH = 9     // yards past the LOS a zone landmark must be to count as "deep"

// When a deep defender carries a route it stays over the top: it holds its depth and
// shifts horizontally to stay above the receiver, letting it run to the defender rather
// than driving down into the catch point (which would leave the deep area wide open).
const SAFETY_OVER_TOP_CUSHION = 2   // yards the defender stays on top of (deeper than) the route
const SAFETY_CARRY_LEAD       = 0.7 // seconds of the receiver's velocity a carrying safety leads —
                                    // it runs to where the receiver is GOING, not where it is

// ── Safety rotation ([150]) ───────────────────────────────────────────────────
//
// With more than one deep defender free, independent help lets two safeties jump
// the same beaten receiver and leave another open — a busted coverage. Rotation
// looks at the whole field once per tick and divides the deep breakdowns: the
// most-beaten threats are handed to the nearest available safety, one safety per
// threat and one threat per safety. As routes develop and different receivers win,
// the assignment shifts, producing realistic rotation and overlap.

// Absolute y of a zone landmark (its center is stored offense-relative).
function zoneLandmarkY(cov, dir) {
  return dir === 1
    ? cov.zoneCenterY + FIELD.END_ZONE_DEPTH
    : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - cov.zoneCenterY
}

// A deep zone defender's first job is to never let anyone behind it. Rather than reading
// a threat into its zone and then dropping back to its landmark, it CARRIES any vertical
// route (go, seam, post, deep cross …) pressing into its deep area, staying over the top
// for as long as the route keeps pushing downfield. Multiple deep defenders divide the
// verticals between them so the deep shell stays intact and nothing runs free.
const DEEP_THREAT_DEPTH  = 12     // yards past the LOS before ANY downfield route is a deep concern
const DEEP_THREAT_VY_MIN = 1.5    // yards/sec downfield to still count as "pressing deep"

// A recognizable vertical (go/seam/post/corner/deep cross/wheel) is a deep concern as soon as it
// clears its stem and is still climbing — the deep defender reads the vertical release and starts
// working over the top EARLY, instead of waiting until the route is already 12 yards deep.
const VERTICAL_ROUTES          = new Set(['go', 'seam', 'post', 'corner', 'deep_cross', 'wheel'])
const VERTICAL_RECOGNIZE_DEPTH = 6   // yards past the LOS a known vertical is picked up

// "Cheat over the instant a corner is beaten" ([safety feedback]): once the receiver has climbed
// past its nearest CB (the corner is trailing) while still pushing downfield, the safety must
// rotate immediately — without waiting for the route to reach the deep-threat depth.
const CB_BEATEN_MIN_DEPTH = 3    // yards past the LOS before a "beaten corner" read counts
const CB_BEATEN_MARGIN    = 1.0  // yards the receiver must be downfield of the corner to have beaten it
const COVER_OVER_TOP_HORIZ = 3.0 // yards laterally within which an underneath defender counts as covering a vertical

// True when some NON-deep defender (a man corner / underneath LB, not the deep help) is already on
// top of this receiver — even, or no more than a yard behind, and within COVER_OVER_TOP_HORIZ
// laterally. If so the vertical is accounted for and a deep safety should stay home in its zone for
// the OTHER deep routes, rather than rotate over to a vertical its corner already has ([zone feedback]).
function coveredOverTop(r, defenders, deepIds, dir) {
  for (const d of defenders) {
    if (deepIds.has(d.id) || d.label === 'S') continue
    if (Math.abs(d.x - r.x) > COVER_OVER_TOP_HORIZ) continue
    if ((d.y - r.y) * dir >= -CB_BEATEN_MARGIN) return true   // on top / even / within a yard
  }
  return false
}

// Returns Map<defenderId, receiver>: the deep vertical each deep zone defender should
// carry over the top. Deepest threats are assigned first to the nearest defender, one
// route per defender. Defenders with nothing to carry fall through to normal zone play.
export function computeSafetyRotation(state, losY, dir) {
  // Deep zone defenders — deep-third corners, deep-half / middle-field safeties.
  const deep = []
  for (const d of state.defensePlayers.values()) {
    const cov = state.defenseCoverage.get(d.id)
    if (cov?.type !== 'zone' || cov.zoneCenterX == null || cov.zoneCenterY == null) continue
    if ((zoneLandmarkY(cov, dir) - losY) * dir < HELP_MIN_HELPER_DEPTH) continue   // not deep

    deep.push(d)
  }
  if (deep.length === 0) return new Map()

  // Routes that can run past the coverage. A route counts as a deep threat either because it is
  // already pressing deep (any route 12+ yds downfield and still climbing) OR because it is a
  // recognizable vertical that has cleared its stem — the latter is read early so the deep shell
  // reacts in time. A settled route (curl/comeback with no downfield speed) is not a vertical.
  const corners  = [...state.defensePlayers.values()].filter(d => d.label === 'CB')
  const deepIds  = new Set(deep.map(d => d.id))

  const threats = []
  for (const r of state.offensePlayers.values()) {
    if (!RECEIVER_LABELS.has(r.label ?? '')) continue
    const depth    = (r.y - losY) * dir
    const climbing = (r.vy ?? 0) * dir
    const pressingDeep  = depth >= DEEP_THREAT_DEPTH && climbing >= DEEP_THREAT_VY_MIN
    const earlyVertical = VERTICAL_ROUTES.has(r.route ?? '') && depth >= VERTICAL_RECOGNIZE_DEPTH && climbing >= 0.5

    // Beaten the corner: the nearest CB is now trailing (shallower downfield) while the receiver
    // keeps climbing. Triggers the rotation early — the instant the corner is passed.
    let beatenCb = false
    if (climbing >= 0.5 && depth >= CB_BEATEN_MIN_DEPTH && corners.length > 0) {
      let nearCb = null, best = Infinity
      for (const cb of corners) {
        const dd = Math.hypot(cb.x - r.x, cb.y - r.y)
        if (dd < best) { best = dd; nearCb = cb }
      }
      if (nearCb && (r.y - nearCb.y) * dir >= CB_BEATEN_MARGIN) beatenCb = true
    }

    if (!pressingDeep && !earlyVertical && !beatenCb) continue
    // Don't abandon the deep zone for a vertical a corner already has on top ([zone feedback]) —
    // only rotate to verticals that have beaten their cover or have nobody over the top.
    if (coveredOverTop(r, state.defensePlayers.values(), deepIds, dir)) continue
    threats.push({ r, depth })
  }
  if (threats.length === 0) return new Map()

  // A deep zone defender's first responsibility is that NOTHING gets behind it — a deep route
  // outside its zone is still its problem ([deep-zone feedback]). So verticals are assigned with
  // NO distance cap: the deepest threat is claimed first by the nearest free deep defender, which
  // then cheats all the way over the top of it. A single-high safety therefore slides to the lone
  // deep route instead of sitting in the middle. One route per defender, one defender per route.
  const candidates = []
  for (const d of deep) {
    for (const t of threats) {
      const dist = Math.hypot(d.x - t.r.x, d.y - t.r.y)
      candidates.push({ sId: d.id, r: t.r, depth: t.depth, dist })
    }
  }
  candidates.sort((a, b) => (b.depth - a.depth) || (a.dist - b.dist))

  const assignment = new Map()
  const used = new Set()
  for (const c of candidates) {
    if (assignment.has(c.sId) || used.has(c.r.id)) continue
    assignment.set(c.sId, c.r)
    used.add(c.r.id)
  }
  return assignment
}

// ── Man coverage ──────────────────────────────────────────────────────────────
//
// A man defender mirrors and trails its receiver from the side it aligned to (its
// leverage). It reacts to the receiver's actual motion — it does NOT teleport across
// the receiver to undercut a break. Alignment is respected: a defender with outside
// leverage trails an inside-breaking route (it must recover from behind) and vice
// versa; a defender that has run even/ahead is beaten on a comeback (momentum-limited
// steering means it overruns). Awareness speeds reaction and recovery, never the
// physically impossible.

const MAN_LEAD_TIME     = 0.2    // seconds of receiver velocity to mirror (reaction, not precognition)
const MAN_INSIDE_OFFSET = 0.75   // yards of leverage cushion on the defender's aligned side
const MAN_TRAIL_DEPTH   = 0.5    // yards underneath the receiver (toward the LOS)
const MAN_AWARENESS_TURN = 1.5   // extra rad/s of recovery quickness at 99 awareness in man coverage

// Off-man discipline ([coverage feedback]): a defender playing with a cushion must NOT drive down at
// a vertically releasing receiver — it backpedals/runs to stay on top and lets the receiver close
// the cushion, then trails. These tune that "stay on top and run" behavior.
const MAN_ONTOP_CUSHION = 1.5    // yards on top a bailing defender keeps over a vertical receiver
const MAN_RUN_LEAD      = 0.35   // seconds of the receiver's velocity a bailing defender matches

// ── Route-break prediction ([144]) ────────────────────────────────────────────
//
// A man defender that reads a receiver's stem can start breaking on the cut before
// the receiver actually makes it. This is reserved for elite recognition: only a
// defender with awareness >= PREDICTION_MIN_AWARENESS anticipates ahead of the cut
// at all. Within that elite band the read window grows toward 99 awareness (reads
// earlier) and shrinks against a sharp route runner (higher routeRunning disguises
// the break, so it's read later). Sub-elite defenders simply mirror the receiver
// and react once the cut actually happens.

const PREDICTION_MIN_AWARENESS = 95   // below this, no anticipating ahead of the cut
const BREAK_READ_BASE       = 1.5   // yards before the break a 95-awareness defender keys it
const ELITE_READ_RANGE      = 3.0   // additional yards of early read from 95 → 99 awareness
const ROUTE_DECEPTION_SCALE = 2.0   // yards of read lost to an elite (99) route runner
const ANTICIPATION_DEPTH    = 1.5   // yards the target jumps toward the break at full reaction

// Reads the receiver's upcoming route break (its next waypoint) and returns how
// hard, and in which direction, the defender should start anticipating it.
// Returns null when there is no readable break (sub-elite awareness, no route,
// final segment, or the receiver is still outside this defender's read window).
export function anticipateRouteBreak(receiver, awareness = 55) {
  if (awareness < PREDICTION_MIN_AWARENESS) return null   // only elite recognition reads ahead

  const wps = receiver.routeWaypoints
  if (!wps) return null

  const idx  = receiver.routeWaypointIdx ?? 0
  const cur  = wps[idx]        // the point the receiver is running to before cutting
  const next = wps[idx + 1]    // where the route breaks to
  if (!cur || !next) return null   // on the final segment — nothing left to anticipate

  const distToBreak = Math.hypot(cur.x - receiver.x, cur.y - receiver.y)

  // Position within the elite band: 0 at 95 awareness, 1 at 99.
  const eliteScale = Math.min(1, (awareness - PREDICTION_MIN_AWARENESS) / (99 - PREDICTION_MIN_AWARENESS))
  const rr         = ratingOf(receiver, 'routeRunning') ?? 55
  const readDist   = BREAK_READ_BASE
    + eliteScale * ELITE_READ_RANGE
    - (rr / 99) * ROUTE_DECEPTION_SCALE

  if (readDist <= 0 || distToBreak > readDist) return null   // can't read it yet

  // Reaction ramps 0 → 1 as the receiver closes on the break point.
  const react  = Math.max(0, Math.min(1, 1 - distToBreak / readDist))
  const segLen = Math.hypot(next.x - cur.x, next.y - cur.y) || 1

  return { react, dirX: (next.x - cur.x) / segLen, dirY: (next.y - cur.y) / segLen }
}

// leverageSign: which side of the receiver the defender aligned to (+1 = the defender
// is to the receiver's right, -1 = its left). 0 falls back to inside (toward midfield).
export function getManTarget(receiver, dir, awareness = 55, leverageSign = 0) {
  // Mirror — track the receiver, leading only by its CURRENT velocity (reaction).
  const leadX = receiver.x + (receiver.vx ?? 0) * MAN_LEAD_TIME
  const leadY = receiver.y + (receiver.vy ?? 0) * MAN_LEAD_TIME

  // Hold leverage on the side the defender aligned to (fallback: inside / toward midfield).
  const side = leverageSign !== 0 ? leverageSign : (receiver.x > FIELD.WIDTH / 2 ? -1 : 1)

  let x = leadX + side * MAN_INSIDE_OFFSET
  let y = leadY - dir * MAN_TRAIL_DEPTH

  // Prediction only helps on breaks the defender is leveraged to defend: a cut toward
  // its leverage side that keeps developing downfield. It can NOT pre-jump a break away
  // from its leverage (outside leverage vs an inside post → must trail) or anticipate a
  // comeback (must react late and overrun if it has run ahead). Awareness speeds the
  // legitimate reaction; it never manufactures an impossible undercut.
  const pred = anticipateRouteBreak(receiver, awareness)
  if (pred && pred.dirX * side >= 0 && pred.dirY * dir >= 0) {
    x += pred.react * pred.dirX * ANTICIPATION_DEPTH
    y += pred.react * pred.dirY * ANTICIPATION_DEPTH
  }

  return { x, y }
}

// ── Momentum-limited coverage steering ([143]) ────────────────────────────────
//
// steer() can snap a player's velocity to any direction in one tick — fine for the
// scripted line play, but it lets a covering defender make impossible instant
// reversals when a receiver cuts. steerCoverage caps both the turn rate and the
// speed change per tick so defenders mirror cuts through realistic trailing arcs;
// a sharp cut naturally creates a step of separation that prediction helps recover.

const COVERAGE_TURN_BASE  = 4.0   // rad/s a sluggish defender can swing their hips
const COVERAGE_TURN_RANGE = 5.0   // additional rad/s for an elite (99 acceleration) defender

function coverageTurnRate(player) {
  return COVERAGE_TURN_BASE + (ratingOf(player, 'acceleration') / 99) * COVERAGE_TURN_RANGE
}

// Man defenders recover from breaks a little quicker the more aware they are — this is
// awareness's payoff now that it can't pre-jump routes: faster reaction, not precognition.
function manTurnRate(player, awareness) {
  return coverageTurnRate(player) + (awareness / 99) * MAN_AWARENESS_TURN
}

function steerCoverage(p, tx, ty, maxSpeed, dt, accel, turnRate) {
  const dx   = tx - p.x
  const dy   = ty - p.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  if (dist < 0.05) {
    const damp = Math.max(0, 1 - accel * dt)
    p.vx *= damp
    p.vy *= damp
    return
  }

  const desiredSpeed = Math.min(maxSpeed, dist * 4)
  const curSpeed     = Math.sqrt(p.vx * p.vx + p.vy * p.vy)

  // From a near standstill there is no momentum to preserve — accelerate straight at the target.
  if (curSpeed < 0.2) {
    const spd = Math.min(desiredSpeed, accel * dt)
    p.vx = (dx / dist) * spd
    p.vy = (dy / dist) * spd
    return
  }

  // Rotate the current heading toward the target, capped at the max turn rate.
  const curAngle = Math.atan2(p.vy, p.vx)
  const desAngle = Math.atan2(dy, dx)
  let   dAngle   = desAngle - curAngle
  while (dAngle >  Math.PI) dAngle -= 2 * Math.PI
  while (dAngle < -Math.PI) dAngle += 2 * Math.PI

  const maxTurn  = turnRate * dt
  const newAngle = curAngle + Math.max(-maxTurn, Math.min(maxTurn, dAngle))

  // Change speed toward the desired speed, capped by acceleration.
  const dSpeed   = Math.max(-accel * dt, Math.min(accel * dt, desiredSpeed - curSpeed))
  const newSpeed = Math.max(0, curSpeed + dSpeed)

  p.vx = Math.cos(newAngle) * newSpeed
  p.vy = Math.sin(newAngle) * newSpeed
}

// Blitzing defenders push through blocks more aggressively than standard rushers.
// This higher multiplier (vs ENGAGED_SPEED_MULT = 0.5) keeps them dangerous when engaged.
const BLITZ_ENGAGED_MULT = 0.75

// Returns the IDs of the outermost rushing defenders (excludes zone and man coverage).
// The two edge rushers are responsible for contain — they hold their outside lanes
// first to prevent QB scrambles, closing inside only once at QB depth.
function findEdgeRusherIds(defensePlayers, coverage) {
  let leftmost = null, rightmost = null
  for (const p of defensePlayers.values()) {
    const type = coverage.get(p.id)?.type
    if (type === 'zone' || type === 'man') continue
    if (!leftmost  || p.x < leftmost.x)  leftmost  = p
    if (!rightmost || p.x > rightmost.x) rightmost = p
  }
  const ids = new Set()
  if (leftmost)  ids.add(leftmost.id)
  if (rightmost) ids.add(rightmost.id)
  return ids
}

// ── Run-defense discipline ([run fix]) ───────────────────────────────────────
//
// On a run, second- and third-level defenders don't all crash the ball the instant it's
// handed off — that blows running lanes wide open. Each defender holds its responsibility
// for a beat after the snap (by role) before committing to pursuit:
//   • line   (DL)        — no delay; fight through and chase.
//   • box    (inside LB / box S) — shuffle laterally, hold depth ~1s, then pursue.
//   • edge   (outside LB)        — set the edge (outside leverage) ~0.8s, then pursue.
//   • corner (CB)        — stay in coverage on the WR ~1s, then pursue.
//   • deep   (deep S)    — hold the top ~2s, then give horizontal help (no downhill crash).
const RUN_DEEP_DEPTH    = 10    // yd past the LOS — a safety deeper than this plays "deep help"
const RUN_EDGE_WIDTH    = 7     // yd from center — an LB wider than this is an edge defender
const RUN_EDGE_CUSHION  = 2.5   // yd of outside leverage an edge defender keeps on the carrier
const RUN_PURSUIT_DELAY = { line: 0, box: 1.0, edge: 0.8, corner: 1.0, deep: 2.0 }

// Gap discipline ([priority 4]): a front defender owns the gap it lines up in and FLOWS with
// the play rather than all collapsing onto the ball. Its lane landmark slides toward the
// play side by GAP_FLOW of the ball's lateral displacement — the front shifts together and
// stays spread, so cutback lanes stay defended. Interior linemen attack their gap into the
// backfield instead of chasing the ball down the line.
const GAP_FLOW     = 0.6   // fraction of the ball's lateral shift a defender's gap flows with
const DL_PENETRATE = 1.0   // yd into the backfield a lineman attacks its gap
const RUN_SECOND_LEVEL_TRIGGER = 4   // yd past the LOS the carrier must reach before a deep safety attacks ([P8])

// Classifies a defender's run-fit role from its label and alignment (latched once per play).
function classifyRunDefender(p, losY, dir, center) {
  const label = p.label
  if (label === 'DL') return 'line'
  if (label === 'CB') return 'corner'
  const depth = (p.y - losY) * dir   // yards downfield of the LOS into the defense's territory
  if (label === 'S')  return depth > RUN_DEEP_DEPTH ? 'deep' : 'box'
  if (label === 'LB') return Math.abs(p.x - center) > RUN_EDGE_WIDTH ? 'edge' : 'box'
  return 'box'
}

// ── Defense movement ──────────────────────────────────────────────────────────

function moveDefense(state, dt) {
  const dir  = state.direction
  const losY = getLosY(state)

  // Zone center y values are stored offense-relative — convert to absolute here
  const toAbsY = (relY) => dir === 1
    ? relY + FIELD.END_ZONE_DEPTH
    : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - relY

  // Locate QB for blitz, spy, and contain targeting
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }

  // Edge rushers hold their outside lane first (contain); interior rushers go straight
  const edgeRusherIds = findEdgeRusherIds(state.defensePlayers, state.defenseCoverage)

  // Once the ball is loose (a run, or an explicit carrier), every defender rallies
  // to it on a pursuit angle rather than holding their coverage assignment.
  const carrier = findBallCarrier(state)

  // A SCRAMBLING QB still behind the LOS reads like a pass to the defense ([scramble feedback]):
  // the back seven hold their coverage and the rush keeps working — nobody peels off to chase him
  // until he actually crosses the line. The instant he does, he's a live runner and the defense
  // rallies. (The offense uses the true carrier with no gate, so its blockers react immediately.)
  const qbScrambleBehindLos = carrier && carrier.label === 'QB' && state.qbScrambling
    && (losY - carrier.y) * dir >= 0
  const defenseCarrier = qbScrambleBehindLos ? null : carrier

  // Blockers a pursuing defender must flow around ([priority 6]) — every offensive player
  // except the ball carrier itself.
  const pursuitBlockers = carrier
    ? [...state.offensePlayers.values()].filter(o => o.id !== carrier.id)
    : []

  // Deep-zone vertical carry: divide the vertical routes among the deep zone defenders so
  // each carries one over the top and nothing gets behind (computed from the whole field).
  const safetyRotation = computeSafetyRotation(state, losY, dir)

  for (const p of state.defensePlayers.values()) {
    // Press jam ([press]): a corner/safety beaten off the press is frozen until the stun wears off.
    if ((p.stunTimer ?? 0) > 0) { p.stunTimer -= dt; p.vx = 0; p.vy = 0; continue }

    // A rusher that has shed its block sprints straight at the QB at full speed,
    // ignoring contain and the engagement speed cap — it has already won the rep.
    if (p.shedBlock && qb) {
      const fm    = getFatigueMult(state, p.id)
      const accel = getAccel(p) * fm
      const spd   = getMaxSpeed(p) * fm
      steer(p, qb.x, qb.y, spd, dt, accel)
      advance(p, dt)
      continue
    }

    // Ball-carrier pursuit — take an intercept angle to cut the runner off ([145]/[160]).
    // The defense (here) and the original offense after an interception ([191]) use the very
    // same realistic pursuit-angle logic (pursueCarrier); only the blocker set differs.
    const pursueIntercept = (p, target, spd, accel) =>
      pursueCarrier(p, target, spd, accel, dt, pursuitBlockers)

    if (defenseCarrier) {
      const carrier = defenseCarrier   // the carrier the defense is allowed to react to
      const fm    = getFatigueMult(state, p.id)
      const accel = getAccel(p) * fm
      const spd   = getMaxSpeed(p) * fm * getEngageMult(p)

      // On a run, defenders hold their run-fit responsibility before collapsing ([run fix]);
      // after a catch the whole defense rallies to the ball immediately.
      if (state.playDesign?.playType === 'run') {
        const center = FIELD.WIDTH / 2
        p.defElapsed = (p.defElapsed ?? 0) + dt
        if (p.runDefRole == null) {
          p.runDefRole = classifyRunDefender(p, losY, dir, center)
          p.gapX = p.x   // [priority 4] own this gap; flow with the play, never abandon it instantly
        }
        const role      = p.runDefRole
        const committed = p.defElapsed >= (RUN_PURSUIT_DELAY[role] ?? 0.5)

        // The defender's gap landmark flows toward the play side with the ball, keeping the
        // front spread so defenders don't all pile onto the same hole.
        const gapTargetX = p.gapX + (carrier.x - center) * GAP_FLOW

        // Interior linemen attack their gap into the backfield (and flow down the line) —
        // they form the wall the back reads, rather than chasing the ball. BUT once a blocker is
        // winning the leverage fight (leverageScore > 0 = offense), the lineman is being controlled
        // and can't keep churning forward — its drive yields in proportion to how badly it's beaten,
        // so a won run block actually roots it backward instead of stalemating at the LOS ([run fix]).
        if (role === 'line') {
          const control  = p.isEngaged ? Math.max(0, Math.min(1, p.leverageScore ?? 0)) : 0
          const driveSpd = spd * (1 - control)
          steer(p, gapTargetX, losY - dir * DL_PENETRATE, driveSpd, dt, accel)
          advance(p, dt)
          continue
        }

        // Deep safety: stay deep and give horizontal help over the top until the carrier
        // reaches the second level, then trigger downhill pursuit ([P8]).
        if (role === 'deep') {
          const carrierDepth = (carrier.y - losY) * dir
          if (carrierDepth >= RUN_SECOND_LEVEL_TRIGGER) {
            pursueIntercept(p, carrier, spd, accel)
          } else {
            steer(p, carrier.x, p.y, spd * 0.8, dt, accel)   // slide horizontally, hold depth
          }
          advance(p, dt)
          continue
        }

        // Box / edge / corner that have read and fit (past their delay) attack on a pursuit angle.
        if (committed) {
          pursueIntercept(p, carrier, spd, accel)
          advance(p, dt)
          continue
        }

        // Still reading — discipline depends on role.
        if (role === 'box') {
          // Scrape: flow to the assigned gap holding depth, arcing OVER THE TOP of blockers in
          // the way rather than getting absorbed in the wash ([P7]).
          const aim = avoidBlockerInPath(p, { x: gapTargetX, y: p.y }, pursuitBlockers)
          steer(p, aim.x, aim.y, spd * 0.6, dt, accel)
          advance(p, dt)
          continue
        }
        if (role === 'edge') {
          const side = Math.sign(p.x - center) || 1
          steer(p, carrier.x + side * RUN_EDGE_CUSHION, carrier.y, spd * 0.75, dt, accel)  // set the edge
          advance(p, dt)
          continue
        }
        // corner: fall through to its coverage assignment (cover the WR until it commits).
      } else {
        pursueIntercept(p, carrier, spd, accel)
        advance(p, dt)
        continue
      }
    }

    const cov    = state.defenseCoverage.get(p.id)
    const type   = cov?.type ?? null
    const fm     = getFatigueMult(state, p.id)
    const accel  = getAccel(p) * fm
    const topSpd = getMaxSpeed(p) * fm * getEngageMult(p)

    switch (type) {
      case 'blitz': {
        // Blitzers push through blocks harder — higher engaged speed than normal
        const blitzTopSpd = getMaxSpeed(p) * fm * (p.isEngaged ? BLITZ_ENGAGED_MULT : 1.0)
        if (qb && edgeRusherIds.has(p.id)) {
          // Edge blitz: rush the edge outside the tackle, then turn the corner at QB depth
          const t = edgeRushTarget(p, qb)
          steer(p, t.x, t.y, blitzTopSpd * 1.1, dt, accel)
        } else {
          const target = qb ?? { x: FIELD.WIDTH / 2, y: losY + dir * 5 }
          steer(p, target.x, target.y, blitzTopSpd * 1.1, dt, accel)
        }
        break
      }

      case 'spy': {
        // Once the QB leaves the pocket the spy commits and attacks on a pursuit angle —
        // and stays committed (it doesn't relax if the QB ducks back). Until then it
        // shadows the QB: mirrors its x from a shallow depth, ready to trigger.
        if (p.spyCommitted || isQbScrambling(qb, FIELD.WIDTH / 2, losY, dir)) {
          p.spyCommitted = true
          if (qb) {
            const spd = getMaxSpeed(p) * fm
            const t   = getPursuitTarget(p, qb, spd)
            steer(p, t.x, t.y, spd, dt, accel)
          }
        } else {
          steer(p, qb ? qb.x : p.x, losY - dir * SPY_DEPTH, topSpd * 0.6, dt, accel)
        }
        break
      }

      case 'man': {
        const receiver = cov.targetId ? state.offensePlayers.get(cov.targetId) : null
        if (receiver) {
          const awareness = ratingOf(p, 'awareness') ?? 55

          // Lock in the leverage side at the first tick of this matchup. The defender
          // holds this alignment — it can't teleport across the receiver to undercut
          // a break — and only recovers its leverage by physically working back.
          if (p.coverLeverageId !== receiver.id) {
            p.coverLeverageId = receiver.id
            p.coverLeverage   = Math.sign(p.x - receiver.x) || 1
          }

          const t = getManTarget(receiver, dir, awareness, p.coverLeverage)

          // Off-man / on-top discipline ([coverage feedback]): when the defender has a cushion (it's
          // on top of the receiver) and the receiver is releasing VERTICALLY, don't drive down to
          // the receiver's current spot — that surrenders the cushion and gets beaten deep. Instead
          // run with him and stay on top: never come shallower than the defender's own depth, and
          // gain depth to keep a cushion over a fast vertical. Once the receiver closes the cushion
          // (even/underneath), this no longer applies and it trails normally.
          const cushion     = (p.y - receiver.y) * dir
          const recVertical = (receiver.vy ?? 0) * dir
          if (cushion > MAN_TRAIL_DEPTH && recVertical > 1) {
            const onTopY = receiver.y + (receiver.vy ?? 0) * MAN_RUN_LEAD + dir * MAN_ONTOP_CUSHION
            t.y = dir === 1 ? Math.max(p.y, onTopY) : Math.min(p.y, onTopY)
          }

          steerCoverage(p, t.x, t.y, topSpd, dt, accel, manTurnRate(p, awareness))
        }
        break
      }

      case 'zone': {
        if (cov.zoneCenterX != null && cov.zoneCenterY != null) {
          const center = { x: cov.zoneCenterX, y: toAbsY(cov.zoneCenterY) }

          // Top priority for a deep defender ([150]): carry the vertical it's assigned and
          // stay OVER THE TOP — never let it get behind. It holds its depth and shifts
          // horizontally to stay above the route (letting the receiver run to it) rather
          // than dropping back to its landmark and giving up the deep ball. This takes
          // precedence over patrolling the zone. It only comes down to make a tackle once
          // the ball is loose (the pursuit branch above).
          const carry = safetyRotation.get(p.id)
          if (carry) {
            // Run to where the receiver is GOING, not where it is ([safety feedback]): lead its
            // whole trajectory and stay a cushion OVER THE TOP, so the path is an intercept angle to
            // the deep ball rather than a flat horizontal slide at the receiver's current spot.
            const projX = carry.x + (carry.vx ?? 0) * SAFETY_CARRY_LEAD
            const projY = carry.y + (carry.vy ?? 0) * SAFETY_CARRY_LEAD
            const overTopX = projX
            const overTopY = dir === 1
              ? Math.max(center.y, projY + SAFETY_OVER_TOP_CUSHION)
              : Math.min(center.y, projY - SAFETY_OVER_TOP_CUSHION)
            const carrySpd = getMaxSpeed(p) * fm
            steerCoverage(p, overTopX, overTopY, carrySpd, dt, accel, coverageTurnRate(p))
            break
          }

          // Otherwise play the zone: patrol the landmark, react to threats entering the area.
          const awareness = ratingOf(p, 'awareness') ?? 55
          const coverage  = ratingOf(p, 'coverage') ?? 55
          const rawThreat = findZoneThreat(center, state.offensePlayers, awareness)
          // Hold the zone until a route DECLARES with its cut ([zone feedback]): a zone defender
          // shouldn't break on a receiver still running its stem through the area — only once the
          // route has made a cut (cleared a waypoint) or settled in the zone. A receiver running a
          // pure vertical never "cuts", so the underneath zone correctly stays home and lets the
          // deep shell carry it.
          const declared = rawThreat && ((rawThreat.routeWaypointIdx ?? 0) >= 1 || rawThreat.routePhase === 'settled')
          const threat    = declared ? rawThreat : null
          const t         = getZoneTarget(center, threat, coverage)
          const zoneSpd   = topSpd * (t.reacting ? ZONE_REACT_SPEED : ZONE_PATROL_SPEED)

          // Underneath zones work AROUND a receiver/blocker that's shoving them off their spot
          // so they can get back to their zone, rather than being bulldozed out of it. Deep
          // zones stay over the top and don't try to fight back through traffic.
          const aim = cov.zoneType === 'deep'
            ? t
            : avoidBlockerInPath(p, t, [...state.offensePlayers.values()])
          steerCoverage(p, aim.x, aim.y, zoneSpd, dt, accel, coverageTurnRate(p))
        }
        break
      }

      default: {
        // DL with no coverage auto-rush the QB; edge DL arc outside, interior rush straight
        if (p.label === 'DL' && qb) {
          if (edgeRusherIds.has(p.id)) {
            const t = edgeRushTarget(p, qb)
            steer(p, t.x, t.y, topSpd * 0.9, dt, accel)
          } else {
            steer(p, qb.x, qb.y, topSpd * 0.9, dt, accel)
          }
        } else {
          steer(p, p.x, losY + dir * 5, topSpd * 0.5, dt, accel)
        }
        break
      }
    }

    advance(p, dt)
  }
}

// ── Interception return ([189]/[190]) ─────────────────────────────────────────
//
// After a pick the roles invert: the intercepting defender (state.ballCarrierId, in
// defensePlayers) returns the ball through the SAME ball-carrier vision model a runner uses,
// running back against state.direction toward the original offense's goal. Its defensive
// teammates escort it; the original offense becomes the pursuit and tackles on intercept
// angles. Coordinates and state.direction are left untouched so both clients keep rendering in
// the original frame — the return simply travels "backfield" on screen, which is exactly right.

// Shared ball-carrier pursuit ([145]/[160]/[191]): aim at where the carrier WILL be (a realistic
// cut-off angle), arcing around blockers in the path. Awareness gates the chase — a reaction beat
// of flat-footed chasing the current spot, then a lead whose quality scales with awareness. Used
// both by the defense and by the original offense switched into pursuit after an interception.
function pursueCarrier(p, target, spd, accel, dt, blockers) {
  const awareness = ratingOf(p, 'awareness') ?? 55
  p.pursuitReaction = (p.pursuitReaction ?? 0) + dt
  const quality = p.pursuitReaction >= pursuitReactionTime(awareness) ? pursuitLeadQuality(awareness) : 0
  const aim = avoidBlockerInPath(p, getPursuitTarget(p, target, spd, quality), blockers)
  steer(p, aim.x, aim.y, spd, dt, accel)
}

function moveInterceptionReturn(state, dt) {
  const returnDir = -state.direction   // the returner advances toward the original offense's goal
  const returner  = state.defensePlayers.get(state.ballCarrierId)
  if (!returner) return

  // The returner: shared ball-carrier model, reading the offense as defenders to avoid and its
  // own defense as blockers, running north-south down the return lane (biasAngle 0).
  {
    const fm     = getFatigueMult(state, returner.id)
    const accel  = getAccel(returner) * fm
    const topSpd = getMaxSpeed(returner) * fm * getEngageMult(returner)
    moveBallCarrier(returner, state, returnDir, dt, accel, topSpd, 0, false, {
      opponents: state.offensePlayers,
      teammates: state.defensePlayers,
    })
    advance(returner, dt)
  }

  // Defensive teammates escort: press downfield in the return direction to lead/clear.
  for (const p of state.defensePlayers.values()) {
    if (p.id === returner.id) continue
    const fm     = getFatigueMult(state, p.id)
    const accel  = getAccel(p) * fm
    const topSpd = getMaxSpeed(p) * fm
    steer(p, p.x, p.y + returnDir * 8, topSpd * 0.7, dt, accel)
    advance(p, dt)
  }

  // The original offense is now the pursuit — chase the returner on an intercept angle.
  const blockers = [...state.defensePlayers.values()].filter(d => d.id !== returner.id)
  for (const p of state.offensePlayers.values()) {
    const fm    = getFatigueMult(state, p.id)
    const accel = getAccel(p) * fm
    const spd   = getMaxSpeed(p) * fm * getEngageMult(p)
    pursueCarrier(p, returner, spd, accel, dt, blockers)
    advance(p, dt)
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

export function runMovement(state, _io, dt) {
  if (state.interceptionReturn) {
    moveInterceptionReturn(state, dt)
    return
  }

  moveOffense(state, dt)
  applySeparation(state.offensePlayers, dt)
  applyLineSpacing(state.offensePlayers, dt)
  moveDefense(state, dt)
  if (lineDebugOn()) logLine(state)   // [pocket] OL/DL movement + protection trace
}

// ── Run-play player tracing ([run debug]) ────────────────────────────────────
//
// Logs every player's position/velocity/assignment/engaged target each tick, run plays
// only. Assignment is derived from label, the play, and (for defense) the latched run-fit
// role or coverage type.
function offenseAssignment(p, carrier, playType) {
  if (carrier && p.id === carrier.id) return 'carry'
  const label = p.label ?? ''
  if (label === 'QB') return 'qb'
  if (isLineman(label)) return 'run-block'
  if (RECEIVER_LABELS.has(label)) return 'run-block'
  return p.route ?? 'idle'
}

function defenseAssignment(p, state) {
  if (p.runDefRole) return `fit:${p.runDefRole}`
  return state.defenseCoverage.get(p.id)?.type ?? 'rush'
}

// Displacement from the snap spot — the point-of-attack movement metric ([P9]).
function snapDisplacement(p) {
  if (p._snapX == null) { p._snapX = p.x; p._snapY = p.y }
  return Math.hypot(p.x - p._snapX, p.y - p._snapY)
}

function logRunPlayers(state) {
  if (state.playDesign?.playType !== 'run') return
  const carrier  = findBallCarrier(state)
  const playType = state.playDesign?.playType
  for (const p of state.offensePlayers.values()) {
    logPlayer({ tick: state.tick, p, assignment: offenseAssignment(p, carrier, playType), disp: snapDisplacement(p) })
  }
  for (const p of state.defensePlayers.values()) {
    logPlayer({ tick: state.tick, p, assignment: defenseAssignment(p, state), disp: snapDisplacement(p) })
  }
}
