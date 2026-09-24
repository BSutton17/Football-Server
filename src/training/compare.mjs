// What does an UNTRAINED defense score on the holdout?
//
// The run reports the champion at ~19.1 and I have no idea whether that is good, because nothing
// has ever measured the reference. fitness = raw + 15, so 19.1 means "3.6 better than par" — but
// par is the heuristic's own average, and if an ordinary heuristic defense ALSO scores ~19 on this
// slate then 19.1 is simply what any legal defense scores and the network has learned nothing.
//
// Three references, same slate, same scoring path as training:
//   HEURISTIC  — the shipping defense, which is what the champion has to beat to be worth having.
//   RANDOM     — a fresh untrained genome, i.e. generation 0.
//   CHAMPION   — whatever the live run has saved.

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

// Exactly the holdout train.js builds: buildSlate({ size, generation: -1, seed: slateSeed ^ 0x5eed })
const SLATE_SEED = 12345
const SIZE = 40
const holdSeed = (SLATE_SEED ^ 0x5eed) >>> 0
const holdout = buildSlate({ size: SIZE, generation: -1, seed: holdSeed })
// generation: -1 to MATCH the holdout slate. Omitting it measures generation 0, whose ids do
// not overlap at all — the bug this whole script exists to have caught.
const par = runBaseline({ size: SIZE, repeats: 4, seed: holdSeed, generation: -1 }).expected

// The heuristic defense over the same slate, scored the same way. `repeats` matters: par is a
// 4-pass mean, so a 1-pass measurement of the same defense carries the full per-play variance and
// is not a fair reference for it.
function heuristicOnHoldout(repeats) {
  const plays = []
  const detail = []
  for (const situation of holdout.situations) {
    const ys = []
    for (let r = 0; r < repeats; r++) {
      const seed = (situation.seed + r * 0x9e37) >>> 0
      const ctx = createTrainingGame({ seed })
      try {
        const play = runPlay(ctx, { ...situation, seed, possession: 0 })
        plays.push({ ...play, situationId: situation.id })
        ys.push(play.yards)
      } finally { destroyTrainingGame(ctx) }
    }
    detail.push({ id: situation.id, par: par[situation.id], got: ys.reduce((a, b) => a + b, 0) / ys.length })
  }
  return { fitness: finalFitness(scoreSlate(plays, par)), detail }
}

const one = heuristicOnHoldout(1)
const four = heuristicOnHoldout(4)
const heur = four.fitness
console.log(`  heuristic, 1 pass  : ${one.fitness.toFixed(2)}`)
console.log(`  heuristic, 4 passes: ${four.fitness.toFixed(2)}`)
const bias = four.detail.reduce((a, d) => a + (d.got - d.par), 0) / four.detail.length
console.log(`  mean (yards allowed - par) over 40 situations, 4 passes: ${bias.toFixed(2)}`)

const pop = createPopulation({ inputs: OBSERVATION_SIZE, outputs: ACTION_SIZE, seed: 99, config: { populationSize: 4 } })
const rand = evaluateGenome(pop.genomes[0], holdout, par).fitness

const runs = existsSync('training-output')
  ? readdirSync('training-output').filter(d => d.startsWith('run-'))
      .map(d => ({ d: join('training-output', d), at: statSync(join('training-output', d)).mtimeMs }))
      .sort((a, b) => b.at - a.at)
  : []
let champ = null
for (const r of runs) {
  const ck = join(r.d, 'checkpoint.json')
  if (!existsSync(ck)) continue
  const snap = JSON.parse(readFileSync(ck, 'utf8')).snapshot
  if (snap?.champion) { champ = evaluateGenome(snap.champion, holdout, par).fitness; break }
}

console.log('\n── Holdout fitness, same slate and scoring as training ──')
console.log(`  HEURISTIC defense (the thing to beat) : ${heur.toFixed(2)}`)
console.log(`  RANDOM untrained genome               : ${rand.toFixed(2)}`)
if (champ != null) console.log(`  CHAMPION from the live run            : ${champ.toFixed(2)}`)
console.log('\n  (fitness = mean(yards better than par + bonuses) + 15, so 15.00 = exactly par)')
