// ── Lining an authored defense up against what it sees ([authored]) ─────────
//
// An authored formation says where the eleven START. A real defense does not stand there: the
// corner walks out to whoever is split wide, a blitzer creeps toward the line, the zones squeeze
// toward the formation. This turns the drawn picture into the one the defense actually shows,
// using only what it is allowed to know.
//
// ⚠️ NOTHING HAPPENS UNTIL THE OFFENSE HAS SET. Every adjustment here reads where the receivers
// are, so making it while they are still being placed means aligning to a formation that does not
// exist yet — and then twitching as the rest arrive. `k.offenseSet` is the engine's own word for
// "the adjust window opens"; this refuses to do anything before it.
//
// ⚠️ THIS IS ALIGNMENT, NOT A NEW CALL. The shell was chosen already and is not revisited. A
// defense that re-decided its coverage every time a receiver moved would be re-deciding on
// information the offense controls, which is how motion becomes a free way to read the defense.
//
// ⚠️ AND IT STILL NEVER SEES THE PLAY CALL. Where receivers stand is public; what they are about
// to run is not. Everything below reads positions and personnel only.

import { slotLabel } from './authored.js'

// How close a pressing defender gets to the line. Deliberately not zero — the offside rule holds
// a defender's centre a full player-radius back, and pressing from on top of the line is a flag.
const PRESS_DEPTH = 1.5

// A blitz is what makes pressing worth it: with a four-man rush the quarterback has time, and a
// corner pressing with nobody getting home is just a corner with his back turned.
//
// ⚠️ FIVE, COUNTED PLAINLY — and NOT "a non-lineman is rushing", which is the clever-looking
// version and is wrong. In a 3-4 the fourth rusher IS a linebacker; that is what a 3-4 is. Run
// over the real playbook that definition flagged twenty ordinary coverages as blitzes.
const BLITZ_RUSHERS = 5

// ⚠️ HOW FAR A NON-LINEMAN RUSHER MAY CREEP, and no further. Showing blitz early is a real tactic;
// walking onto the line from twelve yards deep is not a disguise, it is an announcement.
const RUSHER_CREEP_MAX = 4

// How far a zone may slide toward the offense. A zone that chases the formation completely is not
// a zone any more — it is man coverage with extra steps, and it vacates the area it was drawn to
// hold. This is also what stops anyone running across the field to reach a zone.
// ⚠️ THE FIELD ENDS. A defensive spot is `losY + depth`, and nothing clamped it — so on the
// goal line a safety drawn fifteen yards deep came out at y = 115 and `place_player` refused him,
// while a deep zone's landmark went past the back of the end zone and `assign_coverage` refused
// the WHOLE assignment. A defender with no assignment is one the engine RUSHES, so a red-zone
// shell quietly turned into a blitz with two holes in it. Offensive spots were already clamped by
// `legalSpot`; the defense never was.
//
// The validator's range is -10..110. Half a yard inside it, so rounding cannot push a spot back
// over the line.
export const FIELD_MIN_Y = -9.5
export const FIELD_MAX_Y = 109.5
export const clampFieldY = (y) => Math.max(FIELD_MIN_Y, Math.min(FIELD_MAX_Y, y))
// The sidelines, for the same reason: a zone slide or a man-coverage travel can push a defender
// past them, and `place_player` refuses an x outside 0..53.33.
export const FIELD_MIN_X = 0.5
export const FIELD_MAX_X = 52.8
export const clampFieldX = (x) => Math.max(FIELD_MIN_X, Math.min(FIELD_MAX_X, x))

const MAX_ZONE_SLIDE = 4

// How far an UNDERNEATH zone may travel to start across from the man in it. Bigger than the plain
// squeeze because he is going somewhere specific rather than drifting toward an average, and still
// far short of running across the formation — `enforceNoCrossing` holds the rest of the line.
const MAX_ZONE_ALIGN = 9

// Which zones align on a man. A flat, curl or hook defender starts over somebody; a deep defender
// is responsible for an area behind everyone and aligning him on a receiver opens the space he is
// there to protect.
const UNDERNEATH_ZONES = new Set(['flat', 'curl', 'hook'])

// How far a man defender may travel laterally from where he was drawn. Unbounded, a corner drawn
// at the numbers would sprint across the formation to reach a receiver on the far hash and leave
// the picture unrecognisable.
const MAX_MAN_TRAVEL = 14

// Deeper than this behind the line and a player is in the backfield, not split out.
const BACKFIELD_DEPTH = 2

// ⚠️ HOW FAR OFF A MAN DEFENDER STANDS, so he is near his receiver without being nose to nose.
// Directly across is both unrealistic and worse football: it gives the leverage away and leaves no
// room to play the release. The lean IS the shade, made visible.
const MAN_OFFSET = 1.0

// Zone defenders keep their left-to-right order, with at least this much between them.
const MIN_ZONE_GAP = 2.5

export const SHADES = ['none', 'in', 'out', 'over', 'under']

export function readyToAlign(k) {
  return Boolean(k?.offenseSet)
}

export function isBlitz(shell) {
  const rushers = Object.values(shell?.assignments ?? {}).filter(a => a?.job === 'rush').length
  return rushers >= BLITZ_RUSHERS
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const splitOut = (r, losY) => r.y >= losY - BACKFIELD_DEPTH

// ── Who takes whom ──────────────────────────────────────────────────────────
//
// ⚠️ CORNERS ON RECEIVERS, LINEBACKERS ON THE TIGHT END AND THE BACK — unless there is nobody left,
// in which case somebody still takes the spare rather than leaving him uncovered.
//
// Matching purely by proximity put a corner on the running back while linebackers chased the
// outside receivers, which is the matchup the engine's own `matchMen` exists to prevent. Position
// is the first sort; distance only breaks ties inside it.
const PREFERS = {
  CB: ['WR'],
  S: ['WR', 'TE'],
  LB: ['TE', 'RB'],
}

export function pairMan(manSlots, receivers, ballX) {
  const pairs = new Map()
  const free = [...receivers].sort((a, b) => a.x - b.x)
  const nearestOf = (list, d) => list.reduce(
    (best, r) => (Math.abs(r.x - (ballX + d.dx)) < Math.abs(best.x - (ballX + d.dx)) ? r : best), list[0])
  const take = (d, r) => { if (r) { pairs.set(d.slot, r); free.splice(free.indexOf(r), 1) } }

  // 1. Corners take the widest receiver on their OWN side, outside in.
  //
  //    ⚠️ `dx` is an offset from the ball, so the side test is against ZERO. Comparing it to the
  //    absolute hash made every offset look negative and every corner take the leftmost receiver.
  for (const d of manSlots.filter(s => slotLabel(s.slot) === 'CB').sort((a, b) => a.dx - b.dx)) {
    const wanted = free.filter(r => PREFERS.CB.includes(r.label))
    if (!wanted.length) continue
    take(d, d.dx < 0 ? wanted[0] : wanted[wanted.length - 1])
  }

  // 2. Everyone else takes the position he is meant to have, nearest first.
  for (const d of manSlots.filter(s => !pairs.has(s.slot)).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))) {
    const prefer = PREFERS[slotLabel(d.slot)] ?? []
    const wanted = free.filter(r => prefer.includes(r.label))
    if (wanted.length) take(d, nearestOf(wanted, d))
  }

  // 3. ⚠️ OUT OF OPTIONS. Anyone still unassigned takes whoever is left, whatever the positions —
  //    a bad matchup is recoverable and an uncovered receiver is a touchdown.
  for (const d of manSlots.filter(s => !pairs.has(s.slot)).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))) {
    if (!free.length) break
    take(d, nearestOf(free, d))
  }
  return pairs
}

// ── Shading ─────────────────────────────────────────────────────────────────
//
// Which single thing this defender sells out to take away. Decided PER DEFENDER rather than once
// for the whole call, because the right answer genuinely differs across the formation: a corner on
// an isolated receiver with the sideline helping him is in a different situation from a linebacker
// on a back in the middle of the field.
//
// ⚠️ THE SAFETY RULES OUTRANK THE PREFERENCE, ALWAYS. With nobody over the top, anything but UNDER
// is a way to lose deep, and no situational cleverness makes that a good trade.
export function decideShade(defender, receiver,
  { hasDeepHelp, ballX, forced = null, preferUnderneath = false }) {
  if (!receiver) return 'none'
  if (receiver.label === 'RB') return 'under'   // a back releasing is a short threat
  if (!hasDeepHelp) return 'under'              // nothing behind you: never get beaten deep
  // [halftime] An opponent who has spent a half living underneath gets sat on there. This comes
  // BELOW the safety rules and ABOVE the shell's pinned leverage: a half of evidence outranks a
  // default, and nothing outranks not getting beaten deep.
  if (preferUnderneath) return 'under'
  if (forced === 'in' || forced === 'out') return forced

  const outsideness = Math.abs(receiver.x - ballX)
  if (outsideness > 14) return 'in'             // wide: the sideline is your help outside
  if (outsideness < 6) return 'out'             // tight: the traffic inside is your help
  return 'over'
}

// Which way a shade leans a defender laterally. `over` and `under` are depth ideas rather than
// lateral ones, so they do not move him sideways at all.
export function shadeLean(shade, receiver, ballX) {
  if (shade === 'in') return receiver.x < ballX ? MAN_OFFSET : -MAN_OFFSET
  if (shade === 'out') return receiver.x < ballX ? -MAN_OFFSET : MAN_OFFSET
  return 0
}

// ── No crossing ─────────────────────────────────────────────────────────────
//
// Greedy nearest-receiver pairing for the underneath zones, in the same spirit as `pairMan`: the
// defender closest to a receiver claims him, and nobody is claimed twice. Deep zones and anyone
// not in a zone are skipped, and a back still in the backfield is not a body to line up on.
export function pairUnderneathZones(rows, receivers, losY, ballX) {
  const out = new Map()
  const free = (receivers ?? []).filter(r => splitOut(r, losY))
  if (!free.length) return out

  const claimed = new Set()
  const eligible = rows.filter(d => d.job === 'zone' && UNDERNEATH_ZONES.has(d.zone ?? ''))

  // Closest pairing first, so the defender with the clearest claim gets it rather than whoever
  // happens to come first in the formation.
  const candidates = []
  for (const d of eligible) {
    for (const r of free) {
      const sameSide = d.dx < 0 ? r.x < ballX : r.x >= ballX
      if (!sameSide) continue
      candidates.push({ d, r, dist: Math.abs(r.x - d.x) })
    }
  }
  candidates.sort((a, b) => a.dist - b.dist)

  for (const c of candidates) {
    if (out.has(c.d.slot) || claimed.has(c.r.id)) continue
    if (c.dist > MAX_ZONE_ALIGN) continue     // too far to be his man; he holds his landmark
    out.set(c.d.slot, c.r)
    claimed.add(c.r.id)
  }
  return out
}

// ⚠️ ZONE DEFENDERS KEEP THEIR ORDER. Two zones that swap sides have both abandoned the area they
// were drawn to hold and are running past each other to do it. Unless the formation was AUTHORED
// that way — which is the author's business, and is why the order preserved is the DRAWN one
// rather than any canonical left-to-right — the order after adjustment matches the order before.
// Every row's y, brought inside the field. Applied last, so no adjustment above can push a
// defender back out.
export function clampRowsToField(rows) {
  for (const r of rows) {
    r.x = clampFieldX(r.x)
    const y = clampFieldY(r.y)
    if (y !== r.y) {
      r.y = y
      // Depth is read downstream (press checks, deep-help tests), so it has to agree with where he
      // actually is rather than where the shell drew him.
      if (r.losY != null) r.depth = y - r.losY
    }
    if (r.zoneCenter) r.zoneCenter = { ...r.zoneCenter }
  }
  return rows
}

export function enforceNoCrossing(rows) {
  const zones = rows.filter(r => r.job === 'zone')
  if (zones.length < 2) return rows

  let floor = -Infinity
  for (const z of [...zones].sort((a, b) => a.dx - b.dx)) {
    if (z.x < floor) z.x = floor
    floor = z.x + MIN_ZONE_GAP
  }
  return rows
}

// ── The adjustment ──────────────────────────────────────────────────────────
export function alignAuthored({ formation, shell, receivers, ballX, losY, ready = true, adjust = null }) {
  const spots = formation?.spots ?? []
  const assignments = shell?.assignments ?? {}

  const base = spots.map(s => ({
    slot: s.slot,
    label: slotLabel(s.slot),
    // ⚠️ AN UNASSIGNED DEFENDER COVERS SOMEBODY — he does not rush. A slot the shell forgot used to
    // fall through to 'rush', which is the worst possible default: a free runner the offense never
    // accounted for, and a receiver nobody is on. Covering is the safe failure. Linemen are the
    // exception, because rushing IS their assignment and a shell does not state it.
    job: assignments[s.slot]?.job ?? (slotLabel(s.slot) === 'DL' ? 'rush' : 'man'),
    dx: s.dx,
    depth: s.depth,
    x: ballX + s.dx,
    y: losY + s.depth,
    zone: assignments[s.slot]?.zone ?? null,
    zoneCenter: assignments[s.slot]?.center ?? null,
    shade: 'none',
    pressing: false,
    covers: null,
  }))

  // ⚠️ Not ready is not a failure — it is the normal state while the offense is still setting.
  if (!ready || !receivers?.length) return base

  const blitzing = isBlitz(shell)
  const forced = shell?.forcedLeverage ?? null
  // Somebody deep enough to be help. Without one, nobody may shade anything but UNDER.
  const hasDeepHelp = base.some(d => d.job === 'zone' && d.zone === 'deep' && d.depth >= 10)

  const pairs = pairMan(base.filter(d => d.job === 'man'), receivers, ballX)
  const zonePairs = pairUnderneathZones(base, receivers, losY, ballX)

  const out = base.map(d => {
    if (d.job === 'man') {
      const target = pairs.get(d.slot)
      if (!target) return d
      const shade = decideShade(d, target,
        { hasDeepHelp, ballX, forced, preferUnderneath: !!adjust?.preferUnderneath })
      const x = clamp(target.x + shadeLean(shade, target, ballX),
        d.x - MAX_MAN_TRAVEL, d.x + MAX_MAN_TRAVEL)

      // ⚠️ FORWARD ONLY. The authored depth is a CEILING: a defender may creep up to press and may
      // never drop off deeper than he was drawn. Backing up would let alignment quietly rewrite
      // the coverage — a corner drawn at 5 bailing to 12 is playing a different call entirely.
      //
      // Corners are the ones who press. A linebacker on a back is already near the line, and
      // walking him onto it just vacates the middle he is standing in.
      const mayPress = d.label === 'CB' && (blitzing || shade === 'under')
      const depth = mayPress ? Math.min(d.depth, PRESS_DEPTH) : d.depth
      return { ...d, x, y: losY + depth, depth, shade, pressing: depth < d.depth, covers: target.id }
    }

    if (d.job === 'rush' && d.label !== 'DL') {
      // A non-lineman rusher may show himself, up to a point.
      const depth = Math.max(PRESS_DEPTH, d.depth - RUSHER_CREEP_MAX)
      return { ...d, y: losY + depth, depth, pressing: depth < d.depth }
    }

    if (d.job === 'zone') {
      // Squeeze toward the receivers on his side, so the zone sits over the route distribution
      // rather than over grass — but only a little, which is also what stops anyone running
      // across the field to get there.
      //
      // ⚠️ ONLY THE ONES SPLIT OUT. A back beside the quarterback is on somebody's side of the ball
      // but is not part of the distribution a zone should sit over — counting him dragged a
      // flat-zone corner four yards inside, away from the receiver he was out there for.
      const side = receivers.filter(r =>
        splitOut(r, losY) && (d.dx < 0 ? r.x < ballX : r.x >= ballX))
      if (!side.length) return d

      // ⚠️ AN UNDERNEATH ZONE LINES UP ON A MAN, NOT ON THE AVERAGE OF SEVERAL. Sliding to the
      // MEAN of the receivers on his side parks a flat defender between two of them, covering the
      // grass in between and neither of the people in it. Against trips it was worse: the mean sat
      // well inside the widest receiver, who was then uncovered at the snap.
      //
      // Each underneath zone takes the nearest receiver nobody nearer has already claimed, which
      // is the same greedy pairing man coverage uses. It is still ZONE — he plays his landmark and
      // his area once the ball is snapped, and `enforceNoCrossing` below still guarantees two
      // zones never run past each other to get there. This only decides where he STARTS.
      //
      // Deep zones are deliberately excluded: a defender responsible for a third does not align on
      // a man, and shadowing one is how the third behind him comes open.
      const paired = zonePairs.get(d.slot)
      const targetX = paired ? paired.x : side.reduce((a, r) => a + r.x, 0) / side.length
      const reach = paired ? MAX_ZONE_ALIGN : MAX_ZONE_SLIDE
      const slide = clamp(targetX - d.x, -reach, reach)

      // A corner in a shallow zone may also come forward onto the receiver aligned in it.
      const nearest = side.reduce((a, r) => (Math.abs(r.x - d.x) < Math.abs(a.x - d.x) ? r : a), side[0])
      const mayPress = d.label === 'CB' && d.zone === 'flat' && Math.abs(nearest.x - d.x) < 8
      const depth = mayPress ? Math.min(d.depth, PRESS_DEPTH + 2) : d.depth

      return {
        ...d,
        x: d.x + slide,
        y: losY + depth,
        depth,
        pressing: depth < d.depth,
        zoneCenter: d.zoneCenter ? { dx: d.zoneCenter.dx + slide, depth: d.zoneCenter.depth } : null,
      }
    }

    return d
  })

  // Last of all, inside the field — see clampRowsToField. Nothing after this may move anyone.
  for (const r of out) r.losY = losY
  return clampRowsToField(enforceNoCrossing(out))
}
