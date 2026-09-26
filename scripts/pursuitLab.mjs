// ── Pursuit / tackling telemetry ([pursuit]) ─────────────────────────────────
//
//   node scripts/pursuitLab.mjs [downs] [--run]
//
// "Tackling and pursuit angles are terrible" is a thing you can see and not a thing you can fix,
// because the actual failure could be any of half a dozen: the wrong aim point, the right aim point
// arrived at too late, everybody converging on one spot so a single cut beats all of them, or nobody
// using the sideline. So this samples EVERY defender on EVERY tick a carrier is loose and reports
// which of those is happening, the way coverageLab does for coverage.
//
// The headline numbers:
//   angle err   — degrees between where the defender is actually running and the perfect intercept.
//                 High means bad angles. This is the direct measure of the complaint.
//   tail        — share of pursuer-ticks spent BEHIND the carrier and not gaining. A pure tail chase.
//   leverage    — share of ticks the nearest defender is between the carrier and the goal line.
//   stacked     — pursuer-ticks where two defenders aim within STACK_YARDS of the same point, so one
//                 cut beats both.

//
// ⚠️ RUN IT WITH `PURSUIT_TRACE=1`, or the angle numbers are meaningless. With the trace on, the aim
// each defender was ACTUALLY given is stamped on him inside pursueCarrier and read back here. With it
// off the lab recomputes an aim from outside, which cannot tell a pursuing defender from a lineman
// driving his gap or a safety sliding at depth — and scores all of them as huge pursuit errors. The
// first reading of this said 45° and sent me looking for a steering bug that does not exist.
//
// ── WHAT THIS HAS ALREADY ESTABLISHED (2026-09-26, ~600 downs each) ────────────────────────
//
// THE PURSUIT ANGLES ARE NOT THE PROBLEM. Defenders run at the aim they are given to within 3°. The
// aim differs from a perfect intercept by ~12°, and that is blocker avoidance (flowing around a
// blocker in the path), not a bad angle. Two attempts to improve it both made the defense WORSE:
//
//   • Pursuit LANES (one man on the ball, one forcing the edge, one on the cutback, the rest fanned).
//     It did what it was designed to do — stacked aim points fell 63% → 30% — and cost 0.46 yds/play.
//     Spreading men laterally away from the ball means fewer bodies arrive, and tackling here is
//     proximity-based, so bodies at the ball is what stops runs. Reverted.
//   • PERFECT anticipation for everyone (PURSUIT_LEAD_WORST 0.35 → 1.0): 4.21 → 4.42 yds/play. Also
//     worse. The awareness handicap is not costing the defense anything.
//
// WHAT WAS ACTUALLY WRONG WAS THE TACKLING. Breaks ran 0.30 per play against roughly one successful
// tackle a play — about a quarter of all contact shrugged off. Fixed in tackleDetection.js.
//
// STILL OPEN, both real and both measured here: half of pursuers still aim within 2.5 yd of another
// pursuer, and when the carrier angles for a sideline there is nobody between him and it 45% of the
// time. Neither has been made to pay off yet. Whatever the next attempt is, judge it on yds/play
// first — both of the above looked like clear improvements by every other number.

import { createTrainingGame, destroyTrainingGame, playDown } from '../src/training/game.js'
import { startNextPlay, resolveDecision } from '../src/game/eventQueue.js'
import { getPursuitTarget, findBallCarrier } from '../src/game/systems/movement.js'
import { speedFromRating, ratingOf, getRatings, pursuitReactionTime, pursuitLeadQuality } from '../src/data/ratings.js'
import { FIELD } from '../src/constants.js'
import { PHASE } from '../src/game/stateMachine.js'

const DOWNS = Number(process.argv[2] ?? 300)
const FORCE_RUN = process.argv.includes('--run')
const STACK_YARDS = 2.5
const NEAR_YARDS = 18        // beyond this a defender is not yet in pursuit
const CONTACT = 1.5         // PLAYER.CONTACT_RADIUS — hands on the carrier
const brokenSeen = new WeakMap()   // carrier → breaks already counted
const DEG = 180 / Math.PI

const acc = {
  ticks: 0, carrierTicks: 0,
  ownSum: 0, ownN: 0,            // heading vs the aim the ENGINE chose
  idealSum: 0, idealN: 0,        // heading vs the perfect intercept
  aimSum: 0, aimN: 0,            // the engine's aim vs the perfect intercept
  tail: 0, stacked: 0, leverageTicks: 0, cutoffTicks: 0, sidelineChances: 0, sidelineCutoffs: 0,
  plays: 0, yards: 0, long: 0,
  breaks: 0, maxBroken: 0, contactTicks: 0,
  ownByBand: { close: [0, 0], mid: [0, 0], far: [0, 0] },
}

function topSpeed(p) {
  const r = getRatings(p)
  return speedFromRating(ratingOf(r, 'speed') ?? 75)
}

const ang = (ax, ay, bx, by) => {
  const al = Math.hypot(ax, ay), bl = Math.hypot(bx, by)
  if (al < 1e-6 || bl < 1e-6) return null
  return Math.acos(Math.max(-1, Math.min(1, (ax * bx + ay * by) / (al * bl)))) * DEG
}

function sampleTick(state) {
  const carrier = findBallCarrier(state)
  if (!carrier) return                            // pocket passing: the rush is not pursuit
  const dir = state.direction ?? 1
  if (Math.hypot(carrier.vx ?? 0, carrier.vy ?? 0) < 1) return
  acc.carrierTicks++

  // ⚠️ ENGAGED DEFENDERS ARE NOT PURSUING. A lineman locked up with a blocker is moving where the
  // block fight puts him, not where he chose to go; counting him as a failed pursuit angle was most
  // of a 45° average and is not a pursuit problem at all.
  const pursuers = []
  for (const d of state.defensePlayers.values()) {
    if (d.engagedWithId) continue
    const dist = Math.hypot(d.x - carrier.x, d.y - carrier.y)
    if (dist > NEAR_YARDS) continue
    pursuers.push({ d, dist })
  }
  if (!pursuers.length) return
  pursuers.sort((a, b) => a.dist - b.dist)

  const nearest = pursuers[0].d
  if ((nearest.y - carrier.y) * dir > 0) acc.leverageTicks++
  if (pursuers.some(({ d }) => (d.y - carrier.y) * dir > 0)) acc.cutoffTicks++

  // Is anyone protecting the sideline the carrier is running at? A carrier angling for a boundary
  // should have someone between him and it; if not, the sideline is doing no work.
  const towardSide = Math.sign(carrier.vx ?? 0)
  const nearSide = towardSide > 0 ? carrier.x > FIELD.WIDTH * 0.6 : towardSide < 0 ? carrier.x < FIELD.WIDTH * 0.4 : 0
  if (towardSide && nearSide) {
    acc.sidelineChances++
    if (pursuers.some(({ d }) => Math.sign(d.x - carrier.x) === towardSide && (d.y - carrier.y) * dir > -1)) acc.sidelineCutoffs++
  }

  // [tackling] How often a defender gets his hands on the carrier, and how often that contact fails
  // to bring him down. `brokenTackles` is the engine's own counter, so breaks are exact.
  if (pursuers.some(({ dist }) => dist <= CONTACT)) acc.contactTicks++
  // Counted OUTSIDE the state: onTick is handed the live game and must not write to it, or the
  // measurement changes what it measures.
  const broke = carrier.brokenTackles ?? 0
  const seen = brokenSeen.get(carrier) ?? 0
  if (broke > seen) acc.breaks += broke - seen
  brokenSeen.set(carrier, broke)
  if (broke > acc.maxBroken) acc.maxBroken = broke

  const aims = []
  for (const { d, dist } of pursuers) {
    const spd = topSpeed(d)
    const ideal = getPursuitTarget(d, carrier, spd, 1)
    // What the engine itself is aiming at: the reaction beat, then awareness-scaled anticipation.
    const aware = ratingOf(d, 'awareness') ?? 55
    const quality = (d.pursuitReaction ?? 0) >= pursuitReactionTime(aware) ? pursuitLeadQuality(aware) : 0
    // ⚠️ ONLY MEN THE ENGINE ACTUALLY PUT IN PURSUIT THIS TICK COUNT. `lastPursuitAim` is stamped
    // inside pursueCarrier (PURSUIT_TRACE=1), so a lineman driving his gap, a safety sliding at
    // depth, or a corner still in coverage is skipped instead of being scored as a 40° pursuit
    // error. Recomputing the aim from outside cannot tell those apart — which is what made the
    // first reading of this look like a steering bug.
    const own = d.lastPursuitAim
    if (!own) continue
    aims.push(own)

    const vErrOwn = ang(d.vx ?? 0, d.vy ?? 0, own.x - d.x, own.y - d.y)
    if (vErrOwn != null) {
      acc.ownSum += vErrOwn; acc.ownN++
      const band = dist < 6 ? 'close' : dist < 12 ? 'mid' : 'far'
      acc.ownByBand[band][0] += vErrOwn; acc.ownByBand[band][1]++
    }
    const vErrIdeal = ang(d.vx ?? 0, d.vy ?? 0, ideal.x - d.x, ideal.y - d.y)
    if (vErrIdeal != null) { acc.idealSum += vErrIdeal; acc.idealN++ }
    const aimErr = ang(own.x - d.x, own.y - d.y, ideal.x - d.x, ideal.y - d.y)
    if (aimErr != null) { acc.aimSum += aimErr; acc.aimN++ }

    const behind = ((carrier.y - d.y) * dir) > 0.5
    const closing = ((d.vx ?? 0) * (carrier.x - d.x) + (d.vy ?? 0) * (carrier.y - d.y)) / (dist || 1)
    const carrierAway = ((carrier.vx ?? 0) * (carrier.x - d.x) + (carrier.vy ?? 0) * (carrier.y - d.y)) / (dist || 1)
    if (behind && closing - carrierAway < 0.2) acc.tail++
    acc.ticks++
  }

  // Two pursuers aiming at the same patch of grass: one cut beats both of them.
  for (let i = 0; i < aims.length; i++) {
    for (let j = i + 1; j < aims.length; j++) {
      if (Math.hypot(aims[i].x - aims[j].x, aims[i].y - aims[j].y) < STACK_YARDS) { acc.stacked++; break }
    }
  }
}

// ⚠️ DRIVEN AS REAL SERIES, NOT AS RESET SNAPSHOTS. Forcing a situation onto a used game state and
// snapping again does not work: `applySituation` resets the PLAY, not the game, so a score leaves the
// extra-point menu up and every later snap is refused — and clearing the menu by hand instead
// produced plays that never ended (28 of 30 hung at the tick cap). Playing consecutive downs through
// the same boundary the real game uses is both correct and more representative of where snaps land.
const GAME = 6000
const DOWNS_PER_GAME = 12
const outcomes = {}

let played = 0
for (let g = 0; played < DOWNS && g < DOWNS; g++) {
  const ctx = createTrainingGame({ seed: GAME + g })
  try {
    for (let i = 0; i < DOWNS_PER_GAME && played < DOWNS; i++) {
      if (ctx.state.decisionPending) resolveDecision(ctx.state, ctx.io, 'go_for_it', { quiet: true })
      const r = playDown(ctx, { onTick: sampleTick, ...(FORCE_RUN ? { forcePlayType: 'run' } : {}) })
      outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1
      if (!r.ok) break
      played++
      acc.plays++
      acc.yards += r.yards
      if (r.yards >= 15) acc.long++
      if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    }
  } finally { destroyTrainingGame(ctx) }
}

const pct = (n, d) => d ? `${(100 * n / d).toFixed(1)}%` : 'n/a'
const avg = (sum, n) => n ? (sum / n).toFixed(1) : 'n/a'
console.log(`
── Pursuit over ${acc.plays} downs (${FORCE_RUN ? 'runs forced' : 'natural calls'}) ──`)
console.log(`  ${(acc.yards / Math.max(1, acc.plays)).toFixed(2)} yds/play, ${pct(acc.long, acc.plays)} of 15+ yards`)
console.log(`  pursuer-ticks        ${acc.ticks} over ${acc.carrierTicks} carrier ticks (${(acc.ticks / Math.max(1, acc.carrierTicks)).toFixed(1)} unengaged pursuers/tick)`)
console.log(`  heading vs own aim   ${avg(acc.ownSum, acc.ownN)}°  (close ${avg(...acc.ownByBand.close)}°, mid ${avg(...acc.ownByBand.mid)}°, far ${avg(...acc.ownByBand.far)}°)`)
console.log(`  heading vs ideal     ${avg(acc.idealSum, acc.idealN)}°`)
console.log(`  own aim vs ideal     ${avg(acc.aimSum, acc.aimN)}°   ← how much the model gives away on purpose`)
console.log(`  tail chase           ${pct(acc.tail, acc.ticks)} of pursuer-ticks`)
console.log(`  someone has leverage ${pct(acc.cutoffTicks, acc.carrierTicks)}  (nearest man ${pct(acc.leverageTicks, acc.carrierTicks)})`)
console.log(`  stacked aim points   ${pct(acc.stacked, acc.ticks)} of pursuer-ticks`)
console.log(`  sideline protected   ${pct(acc.sidelineCutoffs, acc.sidelineChances)} of ${acc.sidelineChances} chances`)
console.log(`  broken tackles       ${acc.breaks} over ${acc.plays} downs (${(acc.breaks / Math.max(1, acc.plays)).toFixed(2)}/play, most in one play ${acc.maxBroken})`)
console.log(`  ticks in contact     ${acc.contactTicks} (${pct(acc.contactTicks, acc.carrierTicks)} of carrier ticks)`)
console.log(`  outcomes`, outcomes)
