// Runs the heuristic AI against itself and reports what it found.
//
//   node src/training/runBaseline.mjs [situations] [repeats]
//
// Set LINE_DEBUG=0 to silence the pocket tracer, which otherwise buries the report.

import { runBaseline, summariseProblems } from './baseline.js'

const size = Number(process.argv[2] ?? 40)
const repeats = Number(process.argv[3] ?? 5)

console.log(`[baseline] ${size} situations x ${repeats} plays = ${size * repeats} plays, AI vs AI\n`)

const out = runBaseline({
  size,
  repeats,
  onProgress: (done, total, row) => {
    if (done % 10 === 0 || done === total) {
      process.stderr.write(`  ${done}/${total} situations\n`)
    }
    if (row.problems.length) {
      process.stderr.write(`  ⚠ ${row.id} (${row.down}&${row.distance} @${row.yardLine}, hash ${row.ballX.toFixed(1)}): ${row.problems[0].problem}\n`)
    }
  },
})

console.log(`\n── Throughput ─────────────────────────────────────────`)
console.log(`  ${out.totalPlays} plays in ${(out.elapsedMs / 1000).toFixed(1)}s = ${out.playsPerSecond.toFixed(0)} plays/sec`)

console.log(`\n── Integrity ──────────────────────────────────────────`)
if (out.clean) {
  console.log(`  CLEAN — no problems in ${out.totalPlays} plays`)
} else {
  console.log(`  ${out.problems.length} problems across ${out.totalPlays} plays:\n`)
  for (const s of summariseProblems(out.problems)) {
    console.log(`  ${String(s.count).padStart(5)}x  ${s.kind}`)
    console.log(`         e.g. ${s.example.situation}: ${s.example.problem}`)
  }
}

console.log(`\n── Expected yards, by down ────────────────────────────`)
for (const down of [1, 2, 3, 4]) {
  const rows = out.rows.filter(r => r.down === down)
  if (!rows.length) continue
  const m = rows.reduce((a, r) => a + r.meanYards, 0) / rows.length
  const to = rows.reduce((a, r) => a + r.turnoverRate, 0) / rows.length
  const sk = rows.reduce((a, r) => a + r.sackRate, 0) / rows.length
  console.log(`  down ${down}: ${m.toFixed(2)} yds  |  turnovers ${(to * 100).toFixed(0)}%  |  sacks ${(sk * 100).toFixed(0)}%  (${rows.length} situations)`)
}

console.log(`\n── Outcome mix ────────────────────────────────────────`)
const tdRate = out.rows.reduce((a, r) => a + r.touchdownRate, 0) / out.rows.length
const cmp = out.rows.reduce((a, r) => a + r.completionRate, 0) / out.rows.length
const allYards = out.rows.map(r => r.meanYards)
console.log(`  mean yards/play : ${(allYards.reduce((a, b) => a + b, 0) / allYards.length).toFixed(2)}`)
console.log(`  completions     : ${(cmp * 100).toFixed(0)}%`)
console.log(`  touchdowns      : ${(tdRate * 100).toFixed(0)}%`)
console.log(`  slate hash      : ${out.slateHash}`)

process.exit(out.clean ? 0 : 1)
