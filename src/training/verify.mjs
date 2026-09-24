// IS THE CHAMPION ACTUALLY ANY GOOD? ([training])
//
//   npm run training:verify
//
// The run reports a number about itself, on a slate it was selected against. That number is exactly
// the thing not to trust. Three checks it cannot fake:
//
//   1. A FRESH SLATE it has never touched, and that no champion was ever selected on. Selection
//      pressure against a fixed holdout for a hundred generations quietly turns that holdout into a
//      second training set.
//   2. MULTIPLE PASSES. A single pass carries the full per-play variance — measured at +/-0.7, the
//      same size as the effect being claimed — so a one-pass win can be pure draw.
//   3. INTEGRITY. A genome that wins by breaking the simulation scores beautifully and is worthless.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { buildSlate } from './slate.js'
import { runBaseline } from './baseline.js'
import { scoreSlate, finalFitness } from './fitness.js'
import { evaluateGenome } from './train.js'
import { createPopulation } from '../neat/population.js'
import { OBSERVATION_SIZE } from './observation.js'
import { ACTION_SIZE } from './action.js'

const REPEATS = 3
const SIZE = Number(process.argv[2] ?? 30)

function champion() {
  const runs = readdirSync('training-output').filter(d => d.startsWith('run-'))
    .map(d => ({ d: join('training-output', d), at: statSync(join('training-output', d)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  for (const r of runs) {
    const p = join(r.d, 'champion.json')
    if (!existsSync(p)) continue
    const j = JSON.parse(readFileSync(p, 'utf8'))
    if (j.champion) return { genome: j.champion, gen: j.championGeneration, partial: !!j.partial, path: p }
  }
  return null
}

const champ = champion()
if (!champ) { console.log('No champion found. Run: npm run training:run'); process.exit(0) }

// The heuristic over the same slate, scored the same way — the thing to beat.
function heuristicOn(slate, par) {
  const plays = []
  for (const s of slate.situations) {
    for (let r = 0; r < REPEATS; r++) {
      const seed = (s.seed + r * 0x9e37) >>> 0
      const ctx = createTrainingGame({ seed })
      try { plays.push({ ...runPlay(ctx, { ...s, seed, possession: 0 }), situationId: s.id }) }
      finally { destroyTrainingGame(ctx) }
    }
  }
  return finalFitness(scoreSlate(plays, par))
}

const pop = createPopulation({ inputs: OBSERVATION_SIZE, outputs: ACTION_SIZE, seed: 99, config: { populationSize: 4 } })

// Two slates: the one champions were selected on, and one nothing has ever seen.
const SLATES = [
  { name: 'HOLDOUT (selected on)', gen: -1, seed: (12345 ^ 0x5eed) >>> 0 },
  { name: 'FRESH (never seen)',    gen: 4242, seed: 999331 },
]

console.log(`\n  champion: ${champ.path}`)
console.log(`  generation ${champ.gen}${champ.partial ? '  (PARTIAL — run did not finish)' : ''}`)
console.log(`  ${SIZE} situations x ${REPEATS} passes each\n`)

let invalidTotal = 0, playsTotal = 0
for (const s of SLATES) {
  const slate = buildSlate({ size: SIZE, generation: s.gen, seed: s.seed })
  const par = runBaseline({ size: SIZE, repeats: REPEATS, seed: s.seed, generation: s.gen }).expected

  const c = evaluateGenome(champ.genome, slate, par, { repeats: REPEATS })
  const r = evaluateGenome(pop.genomes[0], slate, par, { repeats: REPEATS })
  const h = heuristicOn(slate, par)

  invalidTotal += c.result.invalid
  playsTotal += c.result.parts.length

  console.log(`  ── ${s.name} ──`)
  console.log(`     CHAMPION  ${c.fitness.toFixed(2)}`)
  console.log(`     heuristic ${h.toFixed(2)}   (champion is ${(c.fitness - h >= 0 ? '+' : '')}${(c.fitness - h).toFixed(2)})`)
  console.log(`     random    ${r.fitness.toFixed(2)}   (champion is ${(c.fitness - r.fitness >= 0 ? '+' : '')}${(c.fitness - r.fitness).toFixed(2)})`)
  console.log(`     par       15.00\n`)
}

console.log(`  ── integrity ──`)
console.log(`     plays that failed to run under the champion: ${invalidTotal} of ${playsTotal}`)
console.log(invalidTotal === 0
  ? `     CLEAN — it is not winning by breaking the game.\n`
  : `     ⚠ ${invalidTotal} broken plays. A genome that cannot run a play scores the same as an\n` +
    `       average one, so this is worth explaining before shipping.\n`)
