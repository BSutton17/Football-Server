// ── Do the solver and the live game key the same way? ([defense]) ──────────
//
//   NODE_ENV=test node scripts/keyAgreement.mjs
//
// The solved table was keyed by authored formation and read by personnel, so every lookup missed
// and the defense never used a solved bucket. This asserts the two key spaces are now the same one,
// by playing real downs and comparing the key the LIVE defense computes against the keys the SOLVER
// will write from the playbook. Cheap, and it runs before an hour of solving rather than after.
import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'
import { lookFromSpots } from '../src/ai/playcall/offenseLook.js'

const book = loadPlaybook()
const solverKeys = new Set()
for (const p of Object.values(book.plays ?? {})) {
  solverKeys.add(lookFromSpots(book.formations?.[p.formationId]?.spots))
}
console.log(`solver will write ${solverKeys.size} looks:`)
console.log('  ' + [...solverKeys].sort().join('\n  '))

const seen = new Map()
let misses = 0, n = 0
for (let i = 0; i < 150; i++) {
  const ctx = createTrainingGame({ seed: 52000 + i })
  try {
    const off = ctx.state.possession
    const r = runPlay(ctx, { down: 1 + (i % 3), distance: 1 + (i % 15), yardLine: 25 + (i % 40), ballX: HASHES[i % HASHES.length] })
    if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
    const id = ctx.brains[1 - off]?.authoredCall?.look?.id
    if (!id) continue
    n++
    seen.set(id, (seen.get(id) ?? 0) + 1)
    if (!solverKeys.has(id)) misses++
  } finally { destroyTrainingGame(ctx) }
}

console.log(`\nlive game computed ${seen.size} distinct looks over ${n} downs:`)
for (const [id, c] of [...seen].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${solverKeys.has(id) ? 'IN TABLE ' : 'NOT FOUND'} ${String(c).padStart(3)}  ${id}`)
}
console.log(misses === 0
  ? `\n  OK: every live key is one the solver writes.`
  : `\n  BROKEN: ${misses}/${n} live keys (${Math.round(100*misses/n)}%) have no solved bucket.`)
