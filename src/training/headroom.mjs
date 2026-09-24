// HOW MUCH DOES THE DEFENSIVE CALL ACTUALLY MATTER? ([training])
//
//   npm run training:headroom
//
// This is the question training cannot answer about itself. NEAT is learning to pick a coverage
// shell from the situation — but if every shell performs about the same against this offense, then
// there is nothing to learn and a flat holdout is the correct answer rather than a bug.
//
// So: hold the shell FIXED and play the whole slate with it. Do that for every shell in the
// playbook, and for the heuristic's situational mix. The spread between the best fixed shell and
// the worst is the ceiling on what any play-caller can win by choosing well.
//
//   spread of ~1 point  -> the call barely matters; training is not the lever
//   spread of many      -> the call matters and a caller that reads the situation can exploit it

import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { buildSlate } from './slate.js'
import { runBaseline } from './baseline.js'
import { scoreSlate, finalFitness } from './fitness.js'
import { SHELLS, extraRushers } from '../ai/playbook/coverages.js'
import { choosePersonnel } from '../ai/defense.js'

// `npm run training:headroom [size] [generation] [seed]`
// Pass `holdout` as the generation to measure on the EXACT slate train.js scores champions against,
// which is the only way to compare a champion's number with these.
const SIZE = Number(process.argv[2] ?? 24)
const onHoldout = process.argv[3] === 'holdout'
const GEN = onHoldout ? -1 : Number(process.argv[3] ?? 500)
const SEED = onHoldout ? ((12345 ^ 0x5eed) >>> 0) : Number(process.argv[4] ?? 12345)
const slate = buildSlate({ size: SIZE, generation: GEN, seed: SEED })
const par = runBaseline({ size: SIZE, repeats: 3, seed: SEED, generation: GEN }).expected

// Plays the slate with the defensive call forced to one shell, every single down.
function withFixedShell(shellId) {
  const plays = []
  for (const situation of slate.situations) {
    const ctx = createTrainingGame({ seed: situation.seed })
    try {
      if (shellId) {
        // Same integration point NEAT uses: replace the CALL and inherit everything else — the
        // legality mask, the alignment, the hash, the motion response.
        const brain = ctx.brains[1]
        brain.overrideDefensiveCall = (k) => ({
          shellId,
          shellName: SHELLS[shellId]?.name ?? shellId,
          personnel: choosePersonnel(k, k.ballX),
          extraRushers: extraRushers(shellId),
          why: 'fixed',
        })
      }
      plays.push({ ...runPlay(ctx, { ...situation, seed: situation.seed, possession: 0 }), situationId: situation.id })
    } finally { destroyTrainingGame(ctx) }
  }
  return finalFitness(scoreSlate(plays, par))
}

const ids = Object.keys(SHELLS)
const rows = []
for (const id of ids) rows.push({ id, fitness: withFixedShell(id) })
const heuristic = withFixedShell(null)

rows.sort((a, b) => b.fitness - a.fitness)

console.log(`\n── Every shell, played on all ${SIZE} situations (15.00 = exactly par) ──`)
for (const r of rows) {
  const bar = '#'.repeat(Math.max(0, Math.round((r.fitness - 10) * 2)))
  console.log(`  ${r.id.padEnd(14)} ${r.fitness.toFixed(2).padStart(6)}  ${bar}`)
}
console.log(`  ${'[heuristic mix]'.padEnd(14)} ${heuristic.toFixed(2).padStart(6)}`)

const best = rows[0].fitness
const worst = rows[rows.length - 1].fitness
console.log(`\n  best fixed shell   : ${rows[0].id} at ${best.toFixed(2)}`)
console.log(`  worst fixed shell  : ${rows[rows.length - 1].id} at ${worst.toFixed(2)}`)
console.log(`  SPREAD             : ${(best - worst).toFixed(2)}`)
console.log(`  heuristic vs best  : ${(heuristic - best).toFixed(2)}`)
console.log(`\n  The spread is the ceiling on what choosing well can win. A situational caller can`)
console.log(`  only beat the best FIXED shell by exploiting situation-to-situation variation on`)
console.log(`  top of that, so it is an optimistic bound, not a target.\n`)
