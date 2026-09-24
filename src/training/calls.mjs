// WHAT DOES THE CHAMPION ACTUALLY CALL? ([training])
//
//   npm run training:calls
//
// The question a fitness score cannot answer. A defense that found one dominant button and presses
// it every down scores well and is worthless to play against — that is exactly what the first
// trained champion did, calling man_blitz_6 on 100% of situations.
//
// So: run the champion over a slate it has never seen and tally what it calls, sliced by situation.
// A spread of calls that MOVES with down and distance is situational football. One call everywhere
// is a button.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { buildSlate } from './slate.js'
import { createNetworkBrain } from './networkBrain.js'
import { syntheticRoster } from '../ai/roster.js'
import { callDefense } from '../ai/defense.js'

const SIZE = Number(process.argv[2] ?? 40)
const GEN = 777                     // a slate no training run uses
const slate = buildSlate({ size: SIZE, generation: GEN, seed: 12345 })

function newestCheckpoint() {
  if (!existsSync('training-output')) return null
  const runs = readdirSync('training-output').filter(d => d.startsWith('run-'))
    .map(d => ({ d: join('training-output', d), at: statSync(join('training-output', d)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const r of runs) {
    for (const f of ['champion.json', 'checkpoint.json']) {
      const p = join(r.d, f)
      if (!existsSync(p)) continue
      const j = JSON.parse(readFileSync(p, 'utf8'))
      const genome = j.champion?.nodes ? j.champion : j.snapshot?.champion
      if (genome) return { genome, from: p, generation: j.championGeneration ?? j.generation }
    }
  }
  return null
}

const found = newestCheckpoint()
if (!found) {
  console.log('No champion found yet. Start a run with: npm run training:run')
  process.exit(0)
}

// Tally what gets called, and slice it by situation so "situational" is checkable rather than
// asserted. `bucket` is the kind of spot a coordinator would actually call differently.
const bucket = (s) => {
  if (s.down >= 3 && s.distance >= 7) return '3rd/4th & long'
  if (s.down >= 3) return '3rd/4th & short'
  if (s.distance >= 10) return 'early & long'
  return 'early & short'
}

const overall = {}
const bySpot = {}
for (const s of slate.situations) {
  const ctx = createTrainingGame({ seed: s.seed })
  try {
    const nb = createNetworkBrain({
      socket: ctx.seats[1], slot: 1, roster: syntheticRoster('net'), genome: found.genome, seed: s.seed,
    })
    ctx.brains[1] = nb
    ctx.seats[1].emit = (e, p) => { try { nb.onEvent(e, p) } catch { /* a broken genome must not stop the tally */ } }
    runPlay(ctx, { ...s, seed: s.seed, possession: 0 })
    const id = nb.lastCall?.shellId ?? 'none'
    const b = bucket(s)
    overall[id] = (overall[id] ?? 0) + 1
    bySpot[b] ??= {}
    bySpot[b][id] = (bySpot[b][id] ?? 0) + 1
  } finally { destroyTrainingGame(ctx) }
}

// The heuristic over the same slate, as the comparison for "how varied should this look".
const heur = {}
for (const s of slate.situations) {
  const ctx = createTrainingGame({ seed: s.seed })
  try {
    const k = ctx.brains[1].knowledge
    k.down = s.down; k.distance = s.distance; k.yardLine = s.yardLine; k.ballX = s.ballX
    k.difficulty = 'hard'
    const c = callDefense(k, Math.random, s.ballX)
    heur[c.shellId] = (heur[c.shellId] ?? 0) + 1
  } finally { destroyTrainingGame(ctx) }
}

const show = (t, n) => Object.entries(t).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${Math.round(100 * v / n)}%`).join(', ')

console.log(`\n  champion from ${found.from}${found.generation != null ? ` (generation ${found.generation})` : ''}`)
console.log(`  ${SIZE} situations it has never seen\n`)
console.log(`  CHAMPION  : ${show(overall, SIZE)}`)
console.log(`  heuristic : ${show(heur, SIZE)}`)

console.log(`\n  by situation:`)
for (const [spot, t] of Object.entries(bySpot)) {
  const n = Object.values(t).reduce((a, b) => a + b, 0)
  console.log(`    ${spot.padEnd(16)} (${String(n).padStart(2)}) : ${show(t, n)}`)
}

const distinct = Object.keys(overall).length
const top = Math.max(...Object.values(overall)) / SIZE
console.log(`\n  distinct calls : ${distinct}`)
console.log(`  most-used call : ${Math.round(top * 100)}% of snaps`)
console.log(top > 0.85
  ? `  -> ONE BUTTON. It found a dominant call, not a way to read situations.`
  : distinct >= 3
    ? `  -> genuinely varied; check whether the mix MOVES between the buckets above.`
    : `  -> narrow. Better than one call, but not really reading the situation.`)
console.log('')
