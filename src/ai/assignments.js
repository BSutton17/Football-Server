// ── Expanding a coverage call into eleven assignments ([offline]) ────────────
//
// A shell is a shape (coverages.js). This turns it into the concrete thing the engine understands:
// every defender placed somewhere, with a coverage assignment attached.
//
// This is also where the design's HARD CONSTRAINTS live. They are written as a mask — a matchup is
// either legal or it is not — rather than as a scoring preference, because "a corner should
// probably not cover a tight end" is not the rule. The rule is that it must not happen:
//
//   • a CB is never manned on a TE, and an LB is never manned on a CB's man (a receiver);
//   • no receiver is ever left uncovered — a lone receiver on one side always draws a defender;
//   • the box is never empty against heavy personnel;
//   • exactly eleven defenders, each with exactly one job.
//
// The last one matters more than it looks. The engine treats a defender with NO assignment as a
// pass rusher (see isRusher in movement.js), so a defender this function forgets does not stand
// still — he sprints at the quarterback. Every silent hole in coverage this game has ever had
// traces back to that, so `expandShell` finishes by giving anyone left over an explicit job.

import { SHELLS, JOB, ZONE, SHADE, landmark, FIELD_WIDTH } from './playbook/coverages.js'
import { FIELD_MID } from './knowledge.js'

// ── Matchup legality ──────────────────────────────────────────────────────────
//
// Who may be manned on whom. Read it as "this defender position can handle this receiver
// position". A safety can take anyone — that is what a safety is for. A corner takes receivers,
// not tight ends and not backs out of the backfield. A linebacker takes tight ends and backs, and
// never a wide receiver.
const MAN_LEGAL = {
  CB: new Set(['WR']),
  S: new Set(['WR', 'TE', 'RB']),
  LB: new Set(['TE', 'RB']),
}

export function canCover(defenderLabel, receiverLabel) {
  return MAN_LEGAL[defenderLabel]?.has(receiverLabel) ?? false
}

// A slot receiver is a WR lined up inside another WR. Corners still take them; the distinction is
// kept because shading differs and NEAT will want it as an input later.
export function isSlot(receiver, receivers, ballX = FIELD_MID) {
  if (receiver.label !== 'WR') return false
  const sameSide = receivers.filter(r => (r.x < ballX) === (receiver.x < ballX))
  return sameSide.some(r => r.id !== receiver.id && Math.abs(r.x - ballX) > Math.abs(receiver.x - ballX))
}

// ── Matching men to receivers ─────────────────────────────────────────────────
//
// Greedy, most-dangerous-first, and legality-masked. "Most dangerous" is the receiver furthest
// outside — he has the most field to work with and the fewest defenders near him, which is the
// same reason the design says a lone receiver must never be left alone.
//
// Returns { pairs, uncovered, unused }. `uncovered` being non-empty is a bug in the CALL, not in
// this function: it means the shell asked for fewer man defenders than there are receivers, and
// the caller has to answer for it (assignCoverage does, below).
export function matchMen(defenders, receivers, ballX = FIELD_MID) {
  const pairs = new Map()     // defenderId -> receiverId
  const takenR = new Set()
  const takenD = new Set()

  const byDanger = [...receivers].sort((a, b) =>
    Math.abs(b.x - ballX) - Math.abs(a.x - ballX))

  for (const r of byDanger) {
    let best = null, bestDist = Infinity
    for (let i = 0; i < defenders.length; i++) {
      const d = defenders[i]
      if (takenD.has(d.id)) continue
      if (!canCover(d.label, r.label)) continue
      // Defenders are usually UNPLACED when this runs — the matchup is being decided in order to
      // work out where to line them up, so there is no x to measure against yet. Falling back to
      // list order rather than NaN matters: `NaN < Infinity` is false, so a distance-only version
      // silently matched nobody and every receiver came back uncovered.
      const dist = Number.isFinite(d.x) ? Math.abs(d.x - r.x) : i
      if (dist < bestDist) { bestDist = dist; best = d }
    }
    if (best) {
      pairs.set(best.id, r.id)
      takenD.add(best.id); takenR.add(r.id)
    }
  }

  return {
    pairs,
    uncovered: receivers.filter(r => !takenR.has(r.id)),
    unused: defenders.filter(d => !takenD.has(d.id)),
  }
}

// ── Shading ───────────────────────────────────────────────────────────────────
//
// Which single thing a man defender sells out to take away. The engine offers four, and each is
// right in a different situation:
//
//   over  — help is over the top, so squeeze everything underneath. Only ever correct when there
//           IS help; playing over the top with no safety is how a double move scores.
//   under — no deep help, so stay on top of the route and concede the short catch.
//   in    — he is outside the numbers with the sideline helping; take away the inside break.
//   out   — he is inside; the sideline is far away, so take away the out.
export function shadeFor(defender, receiver, { hasDeepHelp, ballX = FIELD_MID }) {
  const outsideness = Math.abs(receiver.x - ballX)

  if (receiver.label === 'RB') return SHADE.UNDER    // a back releasing is a short threat
  if (!hasDeepHelp) return SHADE.UNDER               // nothing behind you: never get beaten deep
  if (outsideness > 14) return SHADE.IN              // wide: the sideline is your help outside
  if (outsideness < 6) return SHADE.OUT              // tight: the traffic inside is your help
  return SHADE.OVER
}

// ── Alignment ─────────────────────────────────────────────────────────────────
//
// Where a defender stands before the snap. Man defenders line up on their receiver; zone defenders
// line up ON THEIR LANDMARK, which is what makes a zone shell read as a shape pre-snap instead of
// a scramble after it.
const MAN_DEPTH_TIGHT = 5      // press-ish, for a back or a tight end
const MAN_DEPTH_WIDE = 7       // off coverage on an outside receiver
const RUSH_DEPTH = 1.5         // a blitzer shows late, just off the line
const SPY_DEPTH = 4

export function alignmentFor(assignment, { losY, receivers }) {
  switch (assignment.type) {
    case 'man': {
      const r = receivers.get(assignment.targetId)
      if (!r) return { x: assignment.x ?? FIELD_MID, y: losY + MAN_DEPTH_WIDE }
      const depth = r.label === 'WR' ? MAN_DEPTH_WIDE : MAN_DEPTH_TIGHT
      // Line up a yard to the side the shade says you are taking away, so the leverage is real
      // pre-snap rather than something he has to win after the snap.
      const lean = assignment.manCommit === SHADE.IN ? -1
        : assignment.manCommit === SHADE.OUT ? 1
          : 0
      return { x: clampX(r.x + lean), y: losY + depth }
    }
    case 'zone':
      return { x: assignment.zoneCenterX, y: assignment.zoneCenterY }
    case 'blitz':
      return { x: assignment.x ?? FIELD_MID, y: losY + RUSH_DEPTH }
    case 'spy':
      return { x: assignment.x ?? FIELD_MID, y: losY + SPY_DEPTH }
    default:
      return { x: assignment.x ?? FIELD_MID, y: losY + MAN_DEPTH_WIDE }
  }
}

// ── The expansion ─────────────────────────────────────────────────────────────

// Turns a shell plus the actual personnel into eleven assignments.
//
//   shellId    — a key of SHELLS
//   defenders  — [{ id, label }] the seven coverage players this seat has on the field
//   receivers  — [{ id, label, x, y }] the offense's skill players, as seen
//   losY, ballX — the situation
//
// Returns { assignments, warnings }. `assignments` is keyed by defender id and each entry is
// exactly the payload shape `assign_coverage` takes, plus the spot to line up on.
export function expandShell(shellId, { defenders, receivers, losY, ballX = FIELD_MID }) {
  const shell = SHELLS[shellId]
  if (!shell) return { assignments: new Map(), warnings: [`unknown shell ${shellId}`] }

  const warnings = []
  const byId = new Map(receivers.map(r => [r.id, r]))
  const strongSide = strongSideOf(receivers, ballX)
  const pool = [...defenders]
  const assignments = new Map()

  // Does this call leave anyone over the top? Shading depends on it, so it is resolved before any
  // man is assigned rather than guessed at per defender.
  const hasDeepHelp = shell.jobs.some(j => j.job === JOB.DEEP)

  const take = (positions) => {
    // `positions` is a PREFERENCE ORDER, not a set. A Cover 2 deep half lists ['S', 'CB'] meaning
    // "a safety, or a corner if you must" — matching on membership alone handed the deep halves to
    // corners (they come first in the pool) and then left the flats with nobody, which is how the
    // shell came out with four corners deep and two empty underneath zones.
    for (const want of positions) {
      const idx = pool.findIndex(d => d.label === want)
      if (idx !== -1) return pool.splice(idx, 1)[0]
    }
    return null
  }

  for (const job of shell.jobs) {
    const count = job.count ?? 1

    for (let i = 0; i < count; i++) {
      if (pool.length === 0) break

      if (job.job === JOB.MAN) {
        // Man is assigned as a BLOCK, not one at a time: the matching has to see every available
        // defender and every receiver at once, or a corner takes the slot and leaves a linebacker
        // chasing an outside receiver — exactly the matchup the constraints forbid.
        const wanted = Math.min(count - i, pool.length)
        const manPool = pool.filter(d => job.positions.includes(d.label)).slice(0, wanted)
        const open = receivers.filter(r => ![...assignments.values()].some(a => a.targetId === r.id))
        const { pairs } = matchMen(manPool, open, ballX)

        for (const [defId, recId] of pairs) {
          const d = pool.splice(pool.findIndex(p => p.id === defId), 1)[0]
          const r = byId.get(recId)
          assignments.set(d.id, {
            playerId: d.id,
            type: 'man',
            targetId: recId,
            manCommit: shadeFor(d, r, { hasDeepHelp, ballX }),
          })
        }
        break   // the block consumed this job entirely
      }

      const d = take(job.positions)
      if (!d) { warnings.push(`no ${job.positions.join('/')} available for ${job.job}`); continue }

      if (job.job === JOB.RUSH) {
        assignments.set(d.id, { playerId: d.id, type: 'blitz', x: blitzLane(i, ballX) })
      } else if (job.job === JOB.SPY) {
        assignments.set(d.id, { playerId: d.id, type: 'spy', x: ballX })
      } else {
        const spot = landmark(job, { losY, ballX, strongSide })
        assignments.set(d.id, {
          playerId: d.id,
          type: 'zone',
          zoneType: job.job === JOB.DEEP ? ZONE.DEEP : (job.zone ?? ZONE.HOOK),
          zoneCenterX: spot.x,
          zoneCenterY: spot.y,
        })
      }
    }
  }

  // ── The two repairs that make a call legal ──────────────────────────────────

  // 1. NOBODY UNCOVERED. A receiver with no man on him and no zone over him is the situation the
  //    design names outright. Any defender still without a job is spent here first.
  const covered = new Set([...assignments.values()].map(a => a.targetId).filter(Boolean))
  const loose = receivers.filter(r => !covered.has(r.id) && isIsolated(r, receivers, ballX))
  for (const r of loose) {
    if (pool.length === 0) break
    const idx = pool.findIndex(d => canCover(d.label, r.label))
    if (idx === -1) continue
    const d = pool.splice(idx, 1)[0]
    assignments.set(d.id, {
      playerId: d.id, type: 'man', targetId: r.id,
      manCommit: shadeFor(d, r, { hasDeepHelp, ballX }),
    })
    warnings.push(`repaired: ${r.id} was isolated and uncovered`)
  }

  // 2. NOBODY LEFT OVER. The engine rushes any defender it has no assignment for, so a forgotten
  //    defender is not a neutral mistake — it is an unplanned blitzer and a hole where he was
  //    standing. Whatever is left gets an explicit underneath zone on the ball.
  for (const d of pool) {
    assignments.set(d.id, {
      playerId: d.id, type: 'zone', zoneType: ZONE.HOOK,
      zoneCenterX: ballX, zoneCenterY: losY + 6,
    })
    warnings.push(`filled: ${d.id} had no job in ${shellId}`)
  }

  return { assignments, warnings }
}

// A receiver nobody else is near — the lone man on the back side. Isolated receivers are the ones
// a defense cannot afford to leave, because there is no traffic to slow the throw.
const ISOLATION_RADIUS = 8
function isIsolated(r, receivers, ballX) {
  const sameSide = receivers.filter(o => o.id !== r.id && (o.x < ballX) === (r.x < ballX))
  return sameSide.every(o => Math.abs(o.x - r.x) > ISOLATION_RADIUS)
}

// Which side the offense is heavy to. +1 means more receivers to the right of the ball.
export function strongSideOf(receivers, ballX = FIELD_MID) {
  let l = 0, r = 0
  for (const p of receivers) (p.x < ballX ? l++ : r++)
  return r >= l ? 1 : -1
}

// Where an extra rusher comes from. Alternating sides so two blitzers do not stack the same gap.
function blitzLane(i, ballX) {
  const offsets = [4, -4, 7, -7]
  return clampX(ballX + (offsets[i % offsets.length]))
}

function clampX(x) {
  return Math.max(1.5, Math.min(FIELD_WIDTH - 1.5, x))
}
