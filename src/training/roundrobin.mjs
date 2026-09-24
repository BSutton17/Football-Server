// ── Which champion is actually best? ([pingpong]) ───────────────────────────
//
//   npm run training:roundrobin [situations]
//
// Every archived defense against every archived offense, plus the heuristic on both sides, all on
// ONE common slate that nothing trained on. That is the only way to rank champions produced by a
// ping-pong run.
//
// ⚠️ WHY THE PER-ROUND NUMBERS CANNOT RANK THEM. Each round reports a score against its own pool
// and against the heuristic. Neither ranks anything:
//
//   • "vs its own opponent" uses a different opponent every round, so the numbers are not comparable.
//   • "vs the HEURISTIC" is one fixed opponent — a narrow slice. Measured in this very run, the
//     round-6 and round-8 offenses scored WORST against the heuristic (-0.39, +0.54) and were the
//     HARDEST for the defense to stop (14.8, 14.4 against round 2's 22.9). The benchmark said they
//     were weak; the ladder said they were the strongest. The ladder was right.
//
// A round robin has no such blind spot: every champion faces the identical field.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { playPairing } from './coevolve.js'
import { buildSlate } from './slate.js'

const SIZE = Number(process.argv[2] ?? 20)
const DIR = process.env.OUT_DIR ?? 'training-output/coevolve-current'

const archivePath = [join(DIR, 'champions.json'), join(DIR, 'archive.json')].find(existsSync)
if (!archivePath) {
  console.log(`No champions in ${DIR}. Run: npm run training:coevolve`)
  process.exit(0)
}
const saved = JSON.parse(readFileSync(archivePath, 'utf8'))
// A co-evolution run saves two champions; a ping-pong archive saved a list. Accept either so old
// runs stay comparable with new ones.
const archive = saved.archive ?? [
  { round: saved.offense?.generation ?? 0, side: 'offense', genome: saved.offense?.genome },
  { round: saved.defense?.generation ?? 0, side: 'defense', genome: saved.defense?.genome },
].filter(x => x.genome)

// Series nothing trained or was selected on.
const slate = buildSlate({ size: SIZE, generation: 31337, seed: 616161 })

// null represents the heuristic, which plays in the field on both sides as the fixed reference.
const defenses = [{ round: 0, label: 'heuristic', genome: null },
  ...archive.filter(a => a.side === 'defense').map(a => ({ round: a.round, label: `r${a.round}`, genome: a.genome }))]
const offenses = [{ round: 0, label: 'heuristic', genome: null },
  ...archive.filter(a => a.side === 'offense').map(a => ({ round: a.round, label: `r${a.round}`, genome: a.genome }))]

console.log(`
  ${defenses.length} defenses x ${offenses.length} offenses over ${SIZE} unseen series`)
console.log(`  Cells are the DEFENSE's mean SERIES score. Positive is a good defense; 0 is even.
`)

// The DEFENSE's mean series score. Series scoring is zero sum, so the offense's is the negative
// and one number describes the matchup.
function play(defense, offense) {
  let total = 0
  for (const s of slate.situations) total += -playPairing(offense.genome, defense.genome, s).score
  return total / slate.situations.length
}

const grid = []
for (const d of defenses) {
  const row = { d, cells: [] }
  for (const o of offenses) row.cells.push({ o, score: play(d, o) })
  row.mean = row.cells.reduce((a, c) => a + c.score, 0) / row.cells.length
  grid.push(row)
  process.stderr.write(`  ...${d.label} done\n`)
}

const head = offenses.map(o => o.label.padStart(7)).join('')
console.log(`  DEF \\ OFF ${head}      MEAN`)
for (const row of grid) {
  const cells = row.cells.map(c => c.score.toFixed(1).padStart(7)).join('')
  console.log(`  ${row.d.label.padEnd(9)} ${cells}  ${row.mean.toFixed(2).padStart(8)}`)
}

// Best defense = highest mean across every offense. Best offense = LOWEST mean of the defense's
// score against it, because the cell is the defense's number.
const byDefense = [...grid].sort((a, b) => b.mean - a.mean)
const offenseMeans = offenses.map((o, i) => ({
  o, mean: grid.reduce((a, r) => a + r.cells[i].score, 0) / grid.length,
})).sort((a, b) => a.mean - b.mean)

console.log(`\n  BEST DEFENSE : ${byDefense[0].d.label} (mean ${byDefense[0].mean.toFixed(2)} against the whole field)`)
console.log(`  BEST OFFENSE : ${offenseMeans[0].o.label} (holds the field to ${offenseMeans[0].mean.toFixed(2)})`)

const heurD = grid.find(r => r.d.label === 'heuristic')
const heurO = offenseMeans.find(r => r.o.label === 'heuristic')
console.log(`\n  the heuristic defense ranks ${byDefense.findIndex(r => r.d.label === 'heuristic') + 1} of ${defenses.length} (mean ${heurD.mean.toFixed(2)})`)
console.log(`  the heuristic offense ranks ${offenseMeans.findIndex(r => r.o.label === 'heuristic') + 1} of ${offenses.length} (holds to ${heurO.mean.toFixed(2)})`)
console.log(`\n  A champion that cannot beat the heuristic across the whole field is not worth shipping,`)
console.log(`  whatever its own round reported.\n`)
