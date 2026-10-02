// ── One arm of the "should the AI quarterback see the real openness" A/B ────
//
//   NODE_ENV=test node scripts/opennessArm.mjs <plays> [down] [dist] [yard]
//   NODE_ENV=test AI_SEES_OPENNESS=0 node scripts/opennessArm.mjs ...      (the other arm)
//
// Prints seed,yards,converted,outcome — one line per PASS play. Pair the two arms by seed with
// scripts/pairArms.mjs: the seed fixes the play call, the coverage and every roll, so the only thing
// that differs is which read the quarterback picked his receiver on.
//
// ⚠️ TWO PROCESSES, AND PASS PLAYS ONLY. Two arms in one process cannot differ (and an earlier
// version of exactly this mistake returned results identical to the decimal, which is the tell).
// Runs are included in neither arm: they dilute a passing change toward zero and buy nothing, since
// the call is made pre-snap and is identical in both arms anyway.
import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'

const N = Number(process.argv[2] ?? 200)
const down = Number(process.argv[3] ?? 2)
const distance = Number(process.argv[4] ?? 8)
const yardLine = Number(process.argv[5] ?? 40)
// ⚠️ A HOLDOUT NEEDS DIFFERENT SEEDS. A knob chosen by sweeping one seed set and then reported on
// that same set is reporting its own search, and a winner picked that way has already reversed sign at
// four times the sample in this codebase.
const BASE = Number(process.env.SEED_BASE ?? 64000)
// ⚠️ MODE MATTERS AND IS NOT THE DEFAULT. The game is PLAYED in manual, and manual takes a
// different path through tryThrow (its own re-rank, board time instead of live time). A result measured
// only in automatic says nothing certain about the mode anybody uses. ARM_MODE=manual switches it.
const MODE = process.env.ARM_MODE ?? 'automatic'
// Which play type to force. 'pass' is the default because the QB changes are what this was built for;
// FORCE_TYPE=run gives the other half, which is what a question about the SOLVED MIX needs -- the mix is
// a choice between the two, so it can only be judged on both payoffs measured the same way.
const FORCE = process.env.FORCE_TYPE ?? 'pass'

for (let i = 0; i < N; i++) {
  const seed = BASE + i
  const ctx = createTrainingGame({ seed, mode: MODE })
  try {
    const r = runPlay(ctx, { down, distance, yardLine, ballX: HASHES[i % 3], forcePlayType: FORCE })
    if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
    console.log(`${seed},${r.yards ?? 0},${(r.yards ?? 0) >= distance ? 1 : 0},${r.outcome}`)
  } finally { destroyTrainingGame(ctx) }
}
