// How is the training run doing? ([training])
//
//   npm run training:status
//
// Reads the newest run's progress file, which runTrain.mjs rewrites every generation — so this is
// current to the last generation, not to the last checkpoint. Safe to run as often as you like; it
// only reads, and it never touches the run.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = 'training-output'

function newestRun() {
  if (!existsSync(ROOT)) return null
  const runs = readdirSync(ROOT)
    .filter(d => d.startsWith('run-'))
    .map(d => ({ dir: join(ROOT, d), at: statSync(join(ROOT, d)).mtimeMs }))
    .sort((a, b) => b.at - a.at)
  return runs[0]?.dir ?? null
}

const dir = process.argv[2] ?? newestRun()
if (!dir) {
  console.log('No training runs found. Start one with: npm run training:run')
  process.exit(0)
}

const progressPath = join(dir, 'progress.json')
if (!existsSync(progressPath)) {
  console.log(`${dir} has no progress.json yet.`)
  console.log('The baseline runs before generation 0 — give it a minute and try again.')
  process.exit(0)
}

const p = JSON.parse(readFileSync(progressPath, 'utf8'))
const mins = (ms) => `${(ms / 60000).toFixed(0)}m`
const pct = Math.round((p.done / p.generations) * 100)

// Is it still going? progress.json stops being rewritten the moment the run stops, so the age of
// the file is the honest answer — a finished or crashed run goes stale within a generation or two.
const ageMs = Date.now() - statSync(progressPath).mtimeMs
const perGen = p.elapsedMs / p.done
const stalled = ageMs > Math.max(120_000, perGen * 3)
// The champion file alone does NOT mean the run finished. It is now written at EVERY
// checkpoint (marked `partial: true`) so a killed run leaves something usable, which means
// a run 100 generations into 120 already has one on disk. Reading mere existence as
// "finished" reported a LIVE run as complete, with its progress bar frozen part-way.
const championPath = join(dir, 'champion.json')
let champion = false
let partialChampion = false
if (existsSync(championPath)) {
  try {
    const saved = JSON.parse(readFileSync(championPath, 'utf8'))
    champion = saved.partial !== true
    partialChampion = !champion
  } catch { champion = false }
}

console.log(`\n  ${dir}`)
console.log(`  ${p.generations} generations, population ${p.populationSize}, slate ${p.slateSize}, ` +
            `${p.workers} workers, opponent tier '${p.difficulty}'`)

const filled = Math.round(pct / 4)
console.log(`\n  [${'#'.repeat(filled)}${'.'.repeat(25 - filled)}] ${p.done}/${p.generations}  (${pct}%)`)

if (champion) {
  console.log(`\n  FINISHED — champion saved to ${join(dir, 'champion.json')}`)
} else if (stalled) {
  console.log(`\n  ⚠ STALLED OR STOPPED — no update for ${mins(ageMs)} ` +
              `(a generation takes about ${(perGen / 1000).toFixed(0)}s)`)
} else {
  console.log(`\n  running — ${(perGen / 1000).toFixed(0)}s/gen, ` +
              `${mins(p.elapsedMs)} elapsed, about ${mins(p.etaMs)} left`)
}

// ── Is it learning? ──────────────────────────────────────────────────────────
//
// Read the HOLDOUT, not the training score. The training slate rotates every generation so genomes
// cannot memorise it, which also means training fitness from two generations are scores on two
// different exams and cannot be compared. The holdout is a fixed slate that is never trained on,
// and it is the only sound cross-generation comparison in the run.
const curve = p.curve ?? []
const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length
const block = Math.max(1, Math.min(25, Math.floor(curve.length / 4)))

if (partialChampion) {
  console.log(`  a partial champion is already on disk — safe to use if you stop early`)
}
console.log(`\n  holdout, best ever : ${p.bestHoldout.toFixed(2)}`)
if (curve.length >= 4) {
  const firstMean = avg(curve.slice(0, block))
  const lastMean  = avg(curve.slice(-block))
  const delta = lastMean - firstMean
  console.log(`  first ${block} gens     : ${firstMean.toFixed(2)}`)
  console.log(`  last  ${block} gens     : ${lastMean.toFixed(2)}`)
  console.log(`  change             : ${delta >= 0 ? '+' : ''}${delta.toFixed(2)} ` +
    (delta > 0.5 ? '(learning)' : delta < -0.5 ? '(getting worse)' : '(flat so far)'))
} else {
  console.log(`  (too early to say — ${curve.length} generations in)`)
}
console.log(`  species            : ${p.species}`)
console.log('')
