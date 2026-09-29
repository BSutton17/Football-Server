// ── Is the solved table better than the prior it replaces? ([defense]) ─────
//
//   NODE_ENV=test node scripts/tableVsPrior.mjs [samples]
//   NODE_ENV=test SOLVE_TABLE_PATH=/nope node scripts/tableVsPrior.mjs [samples]   # prior only
//
// ⚠️ RUN IT BOTH WAYS AND COMPARE. A solved table is not automatically an improvement: it is an
// equilibrium computed from noisy cell estimates, and where the samples are thin it can be worse
// than the situational prior it overrides. The offense always calls its own plays.
//
// ⚠️ AND THE LOCAL SOLVE WINS OVER THE SHIPPED ONE (table.js), so swapping solved.json proves
// nothing while training-output/solve/table.json exists. SOLVE_TABLE_PATH is the only honest
// way to turn the table off.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { TABLE_PATH, solvedTable } from '../src/ai/playcall/table.js'

const SAMPLES = Number(process.argv[2] ?? 200)
const t = solvedTable()
console.log(`table: ${Object.keys(t.defense).length} defensive entries  (${TABLE_PATH})\n`)

const SITUATIONS = [
  { name: '3rd & 1  at own 40', down: 3, distance: 1, yardLine: 40 },
  { name: '3rd & 15 at own 25', down: 3, distance: 15, yardLine: 25 },
  { name: '1st & 10 at own 30', down: 1, distance: 10, yardLine: 30 },
  { name: '2nd & 6  at midfield', down: 2, distance: 6, yardLine: 50 },
]

for (const sit of SITUATIONS) {
  let converted = 0, yards = 0, n = 0
  for (let i = 0; i < SAMPLES; i++) {
    const ctx = createTrainingGame({ seed: 91000 + i })
    try {
      const r = runPlay(ctx, { down: sit.down, distance: sit.distance, yardLine: sit.yardLine, ballX: HASHES[i % HASHES.length] })
      if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
      n++
      yards += r.yards ?? 0
      if ((r.yards ?? 0) >= sit.distance) converted++
    } finally { destroyTrainingGame(ctx) }
  }
  console.log(`  ${sit.name.padEnd(22)} converts ${String(Math.round(100*converted/Math.max(1,n))).padStart(3)}%   avg ${(yards/Math.max(1,n)).toFixed(2)} yds allowed   (${n})`)
}
