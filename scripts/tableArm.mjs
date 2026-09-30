// ── One arm of a paired table comparison ([defense]) ───────────────────────
//
//   NODE_ENV=test SOLVE_TABLE_PATH=<table> node scripts/tableArm.mjs <plays> <down> <dist> <yard>
//
// Prints one CSV line per play: seed,yards,converted. Run it twice with different tables and pair
// the lines by index — the seed decides everything except the defensive call, so the difference is
// the table's doing.
//
// ⚠️ TWO PROCESSES, NOT TWO IN-PROCESS ARMS. `TABLE_PATH` is resolved at module load, so flipping
// the env var inside one run changes nothing. And ⚠️ UNPAIRED MEANS NOTHING: comparing separate
// averages of a stochastic game reversed the sign of a real effect earlier in this work.
import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'

const N = Number(process.argv[2] ?? 200)
const down = Number(process.argv[3] ?? 3)
const distance = Number(process.argv[4] ?? 1)
const yardLine = Number(process.argv[5] ?? 40)

for (let i = 0; i < N; i++) {
  const seed = 91000 + i
  const ctx = createTrainingGame({ seed, difficulty: 'medium' })
  try {
    const r = runPlay(ctx, { down, distance, yardLine, ballX: HASHES[i % 3] })
    if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
    console.log(`${seed},${r.yards ?? 0},${(r.yards ?? 0) >= distance ? 1 : 0}`)
  } finally { destroyTrainingGame(ctx) }
}
