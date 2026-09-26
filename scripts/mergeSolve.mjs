// ── Putting the shards back together ([authored]) ───────────────────────────
//
//   node scripts/mergeSolve.mjs training-output/shard-*  -o training-output/solve
//
// Each shard solved a different set of situation buckets into its own directory, because they
// checkpoint to `state.json` by name and would otherwise overwrite one another. This concatenates
// their subgames and rebuilds the table the selector reads.
//
// ⚠️ IT REFUSES TO MERGE OVERLAPPING SHARDS. Two shards that solved the same (situation, formation)
// mean the slicing was wrong — a duplicated subgame would quietly get double the weight in its
// situation, which is invisible in the output and wrong everywhere it is used.

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, readdirSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { buildTable } from '../src/ai/playcall/solve.js'
import { loadPlaybook } from '../src/playbook/store.js'

const args = process.argv.slice(2)
const outFlag = args.indexOf('-o')
const outDir = outFlag === -1 ? 'training-output/solve' : args[outFlag + 1]
const inputs = (outFlag === -1 ? args : args.slice(0, outFlag)).filter(Boolean)

if (!inputs.length) {
  console.error('usage: node scripts/mergeSolve.mjs <shardDir...> [-o outDir]')
  process.exit(1)
}

// A directory of shards, or the shard directories themselves.
const dirs = []
for (const raw of inputs) {
  const p = resolve(raw)
  if (!existsSync(p)) { console.error(`missing: ${raw}`); continue }
  if (existsSync(join(p, 'state.json'))) { dirs.push(p); continue }
  if (statSync(p).isDirectory()) {
    for (const child of readdirSync(p)) {
      const c = join(p, child)
      if (existsSync(join(c, 'state.json'))) dirs.push(c)
    }
  }
}
if (!dirs.length) { console.error('no shard directories with a state.json'); process.exit(1) }

const merged = []
const seen = new Map()
let possessionValue = null

for (const dir of dirs) {
  const state = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))
  const subgames = state.subgames ?? []
  possessionValue ??= state.possessionValue
  for (const sg of subgames) {
    const key = `${sg.situation}|${sg.formation}`
    if (seen.has(key)) {
      console.error(`DUPLICATE ${key}: in both ${seen.get(key)} and ${dir}`)
      console.error('The shards overlap, so the slicing was wrong. Refusing to merge.')
      process.exit(1)
    }
    seen.set(key, dir)
    merged.push(sg)
  }
  const buckets = new Set(subgames.map(s => s.situation)).size
  console.log(`  ${dir.split(/[\\/]/).pop().padEnd(22)} ${String(subgames.length).padStart(4)} subgames, ${buckets} buckets`)
}

mkdirSync(outDir, { recursive: true })
const save = (name, data) => {
  const path = join(outDir, name)
  writeFileSync(`${path}.tmp`, JSON.stringify(data))
  renameSync(`${path}.tmp`, path)      // atomic: a truncated table is worse than none
}

save('state.json', { subgames: merged, possessionValue })
// The run/pass split comes from the situation, so the merge needs the playbook to tell the two
// kinds apart — see withRunShare in solve.js.
const book = loadPlaybook()
const table = buildTable(merged, { playType: (id) => (book.plays?.[id]?.playType === 'run' ? 'run' : 'pass') })
save('table.json', table)

const buckets = new Set(merged.map(s => s.situation))
const confident = merged.filter(s => s.confident).length
console.log(`\n── Merged ${merged.length} subgames across ${buckets.size} buckets ──`)
console.log(`  ${confident} confident (${merged.length - confident} thin)`)
console.log(`  ${Object.keys(table.offense).length} situations solved for the offense`)
console.log(`  ${Object.keys(table.defense).length} situation+formation pairs for the defense`)
console.log(`  written to ${outDir}`)
