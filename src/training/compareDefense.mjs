// ── Is a new defense actually better than the one we ship? ──────────────────
//
//   node src/training/compareDefense.mjs [situations]
//
// Plays the INSTALLED hard-mode brain and the newest champion as defense against the same
// offenses, on the same unseen slate, under the same series scoring.
//
// ⚠️ WHY THIS EXISTS. A brain's own file records the score it was installed on — the installed one
// says `roundRobinMean: 17`. That number came from the per-play yards-vs-par harness on a
// different slate, and the series harness that replaced it produces numbers on a completely
// different scale. Comparing a champion's new score against a stored old one is meaningless; both
// brains have to play the same games.
import { readFileSync } from 'node:fs'
import { playPairing } from './coevolve.js'
import { buildSlate } from './slate.js'

const SIZE = Number(process.argv[2] ?? 30)
// The identical slate roundrobin.mjs uses, so these numbers sit beside its table.
const slate = buildSlate({ size: SIZE, generation: 31337, seed: 616161 })

const installed = JSON.parse(readFileSync('src/ai/brains/hard-defense.json', 'utf8')).genome
const champs = JSON.parse(readFileSync('training-output/coevolve-current/champions.json', 'utf8'))
const fresh = champs.defense.genome
const freshOff = champs.offense.genome

// The cell is the DEFENSE's mean series score: positive means the defense won the series.
function defenseScore(defGenome, offGenome) {
  let total = 0, n = 0, broken = 0
  for (const s of slate.situations) {
    const r = playPairing(offGenome, defGenome, s)
    if (!r.ok) { broken++; continue }
    total += -r.score; n++
  }
  return { mean: n ? total / n : NaN, n, broken }
}

const defenses = [
  ['heuristic', null],
  ['installed', installed],
  [`new r${champs.defense.generation}`, fresh],
]
const offenses = [['heuristic', null], [`r${champs.offense.generation}`, freshOff]]

console.log(`\n  ${SIZE} unseen series | cells are the DEFENSE's mean series score (higher is a better defense)\n`)
console.log(`  DEFENSE      ${offenses.map(([l]) => l.padStart(12)).join('')}        MEAN`)

const rows = []
for (const [dl, dg] of defenses) {
  const cells = offenses.map(([, og]) => defenseScore(dg, og))
  const mean = cells.reduce((a, c) => a + c.mean, 0) / cells.length
  rows.push({ dl, mean, cells })
  console.log(`  ${dl.padEnd(12)} ${cells.map(c => c.mean.toFixed(2).padStart(12)).join('')} ${mean.toFixed(2).padStart(11)}`)
  const broken = cells.reduce((a, c) => a + c.broken, 0)
  if (broken) console.log(`    (⚠️ ${broken} broken series excluded)`)
}

const best = [...rows].sort((a, b) => b.mean - a.mean)[0]
const inst = rows.find(r => r.dl === 'installed')
const nu = rows.find(r => r.dl.startsWith('new'))
console.log(`\n  BEST: ${best.dl} (${best.mean.toFixed(2)})`)
console.log(`  new - installed = ${(nu.mean - inst.mean).toFixed(2)}`)
console.log(nu.mean > inst.mean
  ? `  → the new champion is the better defense; swapping is an upgrade.\n`
  : `  → the INSTALLED brain is still better; do not swap.\n`)
