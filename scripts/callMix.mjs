// ── What the offense ACTUALLY calls, by down and distance ([playcall]) ──────
//
//   NODE_ENV=test node scripts/callMix.mjs [downs]
//
// The solved table and `runShare` both state a run/pass split per situation. This reports the split
// the game really produces, which is the only number worth arguing about — a model that says 15%
// and a game that runs 40% is a wiring problem, not a balance one.
import { createTrainingGame, destroyTrainingGame, playDown } from '../src/training/game.js'
import { startNextPlay, resolveDecision } from '../src/game/eventQueue.js'
import { PHASE } from '../src/game/stateMachine.js'

const DOWNS = Number(process.argv[2] ?? 1500)
const bucket = (down, dist) =>
  `${down === 3 || down === 4 ? 'late' : 'down' + down} & ${dist <= 2 ? 'short' : dist <= 6 ? 'medium' : dist <= 12 ? 'long' : 'verylong'}`

const seen = new Map()
let played = 0
for (let g = 0; played < DOWNS && g < DOWNS; g++) {
  const ctx = createTrainingGame({ seed: 7000 + g })
  try {
    for (let i = 0; i < 12 && played < DOWNS; i++) {
      if (ctx.state.decisionPending) resolveDecision(ctx.state, ctx.io, 'go_for_it', { quiet: true })
      const key = bucket(ctx.state.down, ctx.state.distance)
      const r = playDown(ctx, {})
      if (!r.ok) break
      // The call as the engine recorded it, not as the result looked.
      const type = ctx.state.playDesign?.playType ?? 'pass'
      const row = seen.get(key) ?? { run: 0, n: 0 }
      row.n++; if (type === 'run') row.run++
      seen.set(key, row)
      played++
      if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    }
  } finally { destroyTrainingGame(ctx) }
}

console.log(`\n── What was actually called, over ${played} downs ──`)
for (const [key, row] of [...seen.entries()].sort()) {
  console.log(`  ${key.padEnd(18)} run ${String(Math.round(100 * row.run / row.n)).padStart(3)}%   (${row.n} snaps)`)
}
