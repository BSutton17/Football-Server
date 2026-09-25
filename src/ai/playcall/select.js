// ── Choosing what to call ([authored]) ──────────────────────────────────────
//
// The offense picks a play; the defense, having seen the formation and personnel, picks a shell.
// Both pick from a DISTRIBUTION rather than taking the best option, because the best option called
// every time is the option the other side sits on.
//
// ⚠️ THE DEFENSE CHOOSES SECOND, AND THAT IS THE WHOLE SHAPE OF THIS. It sees the formation before
// it commits, so the only thing hidden is WHICH PLAY out of that formation. A formation's
// unpredictability is therefore entirely the spread of plays behind it — which is why the selector
// is keyed on formation for the defense and on situation for both.
//
// ⚠️ A SOLVED TABLE IS USED WHERE ONE EXISTS, AND A PRIOR WHERE ONE DOES NOT. Waiting for a full
// solve before the AI can call anything would leave it unable to play at all; falling back to a
// situational prior means it is sensible immediately and gets better as buckets are solved. The
// two are never blended — a half-solved bucket that quietly leaned on a prior would be impossible
// to reason about later.

import { situationKey, runLean, depthLean } from './situation.js'
import { withMixingFloor } from './nash.js'

// How sharply the prior converts weights into a distribution. Low enough that the second and third
// choices are called often — a "distribution" that always picks its favourite is a pure strategy
// wearing a disguise.
const PRIOR_TEMPERATURE = 0.8

// Deliberately small. It exists so no call is ever literally impossible, which is what stops a
// human from ruling one out after a handful of snaps.
const FLOOR = 0.04

function normalize(weights) {
  const total = weights.reduce((a, b) => a + b, 0)
  return total > 0 ? weights.map(w => w / total) : weights.map(() => 1 / weights.length)
}

function sample(items, probs, rng = Math.random) {
  let r = rng()
  for (let i = 0; i < items.length; i++) {
    r -= probs[i]
    if (r <= 0) return items[i]
  }
  return items[items.length - 1]
}

// ── How deep a play wants to be ─────────────────────────────────────────────
//
// Read off the routes rather than stored, because a play's depth is a property of what it asks
// people to run. A concept whose routes are all six yards is a short play whatever it is called.
//
// ⚠️ THE MEAN, NOT THE DEEPEST. Measuring by the deepest route called almost everything a deep
// shot: a mesh concept with a single go route to clear out the middle counts the same as four
// verticals, and on the real playbook that made 71% of a bunch formation's plays "deep". The
// clear-out is not where the ball is going. Averaging asks what the play is mostly doing.
export function playDepth(play) {
  const depths = []
  for (const a of Object.values(play?.assignments ?? {})) {
    if (a?.kind !== 'route') continue
    let deepest = 0
    for (const pt of a.points ?? []) deepest = Math.max(deepest, pt.dd ?? 0)
    depths.push(deepest)
  }
  if (!depths.length) return 0
  return depths.reduce((a, b) => a + b, 0) / depths.length
}

const DEEP_YARDS = 15

// ── The prior ───────────────────────────────────────────────────────────────
//
// What to call before anything has been simulated. Weights every available play by how well it
// fits the situation: runs up in short yardage, deep shots down near the goal line.
export function priorWeights(plays, situation) {
  const run = runLean(situation)
  const depth = depthLean(situation)
  return plays.map(p => {
    let w = 1
    if (p.playType === 'run') w *= run
    else if (playDepth(p) >= DEEP_YARDS) w *= depth
    return Math.pow(Math.max(w, 1e-6), 1 / PRIOR_TEMPERATURE)
  })
}

// ── The offense ─────────────────────────────────────────────────────────────
//
// `solved` is optional: a map of situation key -> { playId -> probability }. Where a bucket has
// been solved, its distribution is used exactly; where it has not, the prior stands in.
export function chooseOffensivePlay(plays, situation, { solved = null, rng = Math.random } = {}) {
  if (!plays?.length) return null
  const key = situationKey(situation)
  const table = solved?.[key]

  const probs = table
    // ⚠️ Only the plays the table knows about. A play authored after a solve has no entry, and
    // treating a missing entry as zero would silently retire it; treating it as average would let
    // it dilute a solved distribution. It falls to the prior instead, below.
    ? normalize(plays.map(p => table[p.id] ?? 0))
    : normalize(priorWeights(plays, situation))

  const usable = probs.some(p => p > 0) ? probs : normalize(priorWeights(plays, situation))
  return sample(plays, withMixingFloor(usable, { floor: FLOOR }), rng)
}

// ── The defense ─────────────────────────────────────────────────────────────
//
// ⚠️ KEYED ON THE FORMATION IT CAN SEE, not on the play it cannot. Personnel comes with the
// formation — three receivers and a back IS the formation — so one signal carries both.
export function chooseDefensiveShell(shells, situation, offenseLook, { solved = null, rng = Math.random } = {}) {
  if (!shells?.length) return null
  const key = `${situationKey(situation)}|${offenseLook ?? 'unknown'}`
  const table = solved?.[key]

  if (table) {
    const probs = normalize(shells.map(s => table[s.id] ?? 0))
    if (probs.some(p => p > 0)) return sample(shells, withMixingFloor(probs, { floor: FLOOR }), rng)
  }

  // ⚠️ THE PRIOR MATCHES PERSONNEL, WHICH IS THE ONE THING A DEFENSE MUST GET RIGHT WITHOUT
  // EVIDENCE. Answering four receivers with a base defense is not an interesting gamble, it is
  // simply wrong, and a coin-flip prior would do it a quarter of the time.
  const wr = offenseLook?.wr ?? 3
  const weights = shells.map(s => {
    const backs = s.personnel ? (s.personnel.CB ?? 0) + (s.personnel.S ?? 0) : 4
    // The closer the defensive back count is to what the formation asks for, the better the fit.
    const want = wr >= 4 ? 6 : wr === 3 ? 5 : 4
    return 1 / (1 + Math.abs(backs - want))
  })
  return sample(shells, withMixingFloor(normalize(weights), { floor: FLOOR }), rng)
}

// What the defense is allowed to know about the offense's look: the formation, and the personnel
// that comes with it. Never the play.
export function offenseLookOf(formation) {
  const counts = { WR: 0, TE: 0, RB: 0 }
  for (const s of formation?.spots ?? []) {
    const label = String(s.slot).replace(/[0-9]+$/, '')
    if (label in counts) counts[label]++
  }
  return { id: formation?.id ?? null, wr: counts.WR, te: counts.TE, rb: counts.RB }
}
