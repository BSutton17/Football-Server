// ── The situation slate ([training]) ─────────────────────────────────────────
//
// The fixed set of pre-snap situations every genome is judged on. Three properties matter, and all
// three are easy to get wrong:
//
//   FIXED — every genome in a generation plays the IDENTICAL slate. Otherwise you are comparing
//     one network's luck against another's, and the fitness ordering is noise. (Common random
//     numbers: the same situations, in the same order, from the same seeds.)
//
//   REPRESENTATIVE — the slate is the entire world as far as the AI is concerned. Anything absent
//     from it is something the AI will never learn to handle. A slate of nothing but first-and-ten
//     from the 25 produces an AI that is helpless on third-and-long.
//
//   SPREAD ACROSS THE HASHES — the ball is spotted left, middle and right, and a slate that only
//     used the middle would have missed the worst bug this AI has had: a formation pinned to the
//     centre of the field while the real ball sat thirteen yards away. Situations are deliberately
//     generated across all three.
//
// A slate ROTATES per generation (different seeds, same shape) so a genome cannot overfit to one
// exact set of plays — but within a generation it is frozen.

import { FIELD } from '../constants.js'
import { makeRng } from '../game/utils/rng.js'

export const SLATE_VERSION = 'v1'

// The hashes the ball is actually spotted on, and the middle.
export const HASH_SPOTS = [
  FIELD.WIDTH * 0.25,
  FIELD.WIDTH * 0.5,
  FIELD.WIDTH * 0.75,
]

// The situations worth being good at, as (down, distance) pairs with a weight. Weights are roughly
// how often each comes up in a real game — there is no point spending a tenth of the slate on
// fourth-and-one when it decides a handful of plays a season.
const DOWN_DISTANCE = [
  { down: 1, distance: 10, weight: 30 },   // the most common down in football, by a mile
  { down: 1, distance: 15, weight: 3 },    // after a penalty
  { down: 2, distance: 3, weight: 8 },
  { down: 2, distance: 7, weight: 10 },
  { down: 2, distance: 12, weight: 7 },
  { down: 3, distance: 2, weight: 8 },     // the money down, short
  { down: 3, distance: 6, weight: 10 },
  { down: 3, distance: 11, weight: 9 },    // …and long
  { down: 4, distance: 1, weight: 3 },
  { down: 4, distance: 5, weight: 2 },
]

// Where on the field, as (yardLine, weight). yardLine is offense-relative: 0 is their own goal
// line, 100 the opponent's.
const FIELD_POSITION = [
  { yardLine: 5, weight: 4 },     // backed up against your own goal
  { yardLine: 20, weight: 10 },
  { yardLine: 35, weight: 14 },
  { yardLine: 50, weight: 14 },
  { yardLine: 65, weight: 12 },
  { yardLine: 80, weight: 10 },   // in field-goal range
  { yardLine: 92, weight: 6 },    // red zone — the field is short and the throws are tight
  { yardLine: 97, weight: 3 },    // goal line
]

// Game states worth distinguishing. Score and clock change what a CALL should be — prevent is only
// correct when leading late, the hurry-up only when behind late.
const GAME_STATES = [
  { quarter: 1, clock: 600, score: [0, 0], weight: 20, label: 'neutral' },
  { quarter: 2, clock: 90, score: [7, 10], weight: 6, label: 'two-minute, behind' },
  { quarter: 4, clock: 400, score: [21, 17], weight: 8, label: 'late, narrow lead' },
  { quarter: 4, clock: 45, score: [24, 20], weight: 5, label: 'late, protecting a lead' },
  { quarter: 4, clock: 100, score: [14, 21], weight: 6, label: 'late, chasing' },
  { quarter: 3, clock: 500, score: [3, 3], weight: 10, label: 'even' },
]

function pickWeighted(list, rng) {
  const total = list.reduce((a, x) => a + x.weight, 0)
  let r = rng() * total
  for (const item of list) { r -= item.weight; if (r <= 0) return item }
  return list[list.length - 1]
}

// Builds a slate. `generation` rotates it; `size` is how many situations each genome plays.
//
// Every situation carries its own SEED, and that seed governs the whole play — both AIs' decisions
// and every roll the engine makes. So two genomes facing situation 7 face genuinely the same play,
// and the only difference between their results is the decision being measured.
export function buildSlate({ size = 40, generation = 0, seed = 12345 } = {}) {
  const rng = makeRng((seed ^ (generation * 0x9e3779b1)) >>> 0)
  const situations = []

  for (let i = 0; i < size; i++) {
    const dd = pickWeighted(DOWN_DISTANCE, rng)
    const fp = pickWeighted(FIELD_POSITION, rng)
    const gs = pickWeighted(GAME_STATES, rng)

    // Distance can't be longer than the field left in front of you.
    const distance = Math.min(dd.distance, Math.max(1, 100 - fp.yardLine))

    situations.push({
      id: `g${generation}-s${i}`,
      down: dd.down,
      distance,
      yardLine: fp.yardLine,
      // Cycled rather than randomly drawn, so every slate covers all three hashes evenly.
      ballX: HASH_SPOTS[i % HASH_SPOTS.length],
      quarter: gs.quarter,
      clock: gs.clock,
      score: gs.score,
      label: gs.label,
      possession: 0,
      // ⚠️ SOME DOWNS ARE RUNS, WHETHER THE OFFENSE LIKES IT OR NOT.
      //
      // The slate used to leave play type entirely to the offense, and every trained offense
      // converged on passing 100% of the time (the heuristic runs 13%). So a defense trained
      // against a pool of them saw a run on roughly 3% of snaps and never learned to stop one —
      // you could run the ball on it at will, which is exactly what playing it revealed.
      //
      // This is a curriculum guarantee, not a hint: a fixed share of the slate is a designed run,
      // so the defense must answer both. Cycled rather than randomly drawn so every slate carries
      // the same mix, and par is measured on the identical forcing.
      forcePlayType: (i % 3 === 2) ? 'run' : null,
      seed: (rng() * 0xffffffff) >>> 0,
    })
  }

  return {
    version: SLATE_VERSION,
    generation,
    seed,
    size,
    situations,
    hash: hashSlate(situations),
  }
}

// A fingerprint of the slate's CONTENT. Two runs that report different fitness are only comparable
// if this matches — it is what a checkpoint pins so a resume cannot silently change the exam.
export function hashSlate(situations) {
  let h = 2166136261
  const s = situations.map(x =>
    `${x.down}|${x.distance}|${x.yardLine}|${x.ballX.toFixed(2)}|${x.quarter}|${x.clock}|${x.score.join(',')}|${x.seed}`
  ).join('#')
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

// A tiny slate for tests and smoke runs — every down, both ends of the field, all three hashes.
export function smallSlate() {
  return buildSlate({ size: 9, generation: 0, seed: 7 })
}
