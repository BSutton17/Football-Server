// Trains a defensive coordinator and reports what happened.
//
//   LINE_DEBUG=0 node src/training/runTrain.mjs [generations] [population] [slate]
//
// Defaults to the 100-generation run, then prints a measured estimate for 1000 — which is the
// number to decide the long run on, rather than arithmetic from a micro-benchmark.

import { writeFileSync, mkdirSync } from 'node:fs'
import { train } from './train.js'
import { defaultWorkerCount } from './pool.js'
import { TRAINING_DIFFICULTY } from './game.js'

const generations = Number(process.argv[2] ?? 100)
const populationSize = Number(process.argv[3] ?? 150)
const slateSize = Number(process.argv[4] ?? 40)
const workers = defaultWorkerCount()

// A thousand generations is hours of work that a closed terminal, a Windows update or an OOM would
// otherwise take with it. Checkpoint as we go, not only at the end.
// Also the reporting cadence. Overridable so a short run can be smoke-tested end to end.
const CHECKPOINT_EVERY = Number(process.env.REPORT_EVERY ?? 25)
mkdirSync('training-output', { recursive: true })
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const runDir = `training-output/run-${stamp}`
mkdirSync(runDir, { recursive: true })

console.log(`[train] ${generations} generations, population ${populationSize}, slate ${slateSize}`)
console.log(`[train] ${workers} workers, opponent tier '${TRAINING_DIFFICULTY}'`)
console.log(`[train] checkpointing every ${CHECKPOINT_EVERY} generations to ${runDir}/`)
console.log(`[train] measuring par from the heuristic first…\n`)

const started = Date.now()
let reportedEstimate = false
const history = []

const out = await train({
  generations,
  populationSize,
  slateSize,
  onGeneration: (g, pop, best) => {
    history.push(g)

    // Always-current, written every generation. The checkpoint below is every 25 and carries the
    // whole population; this is a few hundred bytes and exists purely so `npm run training:status`
    // can answer truthfully at any moment instead of reporting the last checkpoint.
    try {
      const done = g.generation + 1
      const elapsedMs = Date.now() - started
      writeFileSync(`${runDir}/progress.json`, JSON.stringify({
        generations, populationSize, slateSize, workers,
        difficulty: TRAINING_DIFFICULTY,
        generation: g.generation, done,
        startedAt: started, elapsedMs,
        etaMs: elapsedMs / done * (generations - done),
        holdout: g.holdout, bestHoldout: g.bestHoldout,
        train: g.best, mean: g.mean, species: g.species,
        // Compact per-generation holdout trace: enough to draw the curve, small enough to rewrite
        // every generation without it mattering.
        curve: history.map(r => Number(r.holdout.toFixed(3))),
      }))
    } catch { /* a status file is a convenience; never let it kill a run */ }
    const bar = '█'.repeat(Math.max(0, Math.round(g.bestHoldout)))
    console.log(
      `  gen ${String(g.generation).padStart(4)} ` +
      `| train ${g.best.toFixed(2).padStart(6)} mean ${g.mean.toFixed(2).padStart(6)} ` +
      `| HOLDOUT ${g.holdout.toFixed(2).padStart(6)} best ${g.bestHoldout.toFixed(2).padStart(6)} ` +
      `| ${g.species} species | ${(g.ms / 1000).toFixed(1)}s ${bar}`
    )

    // The measured projection, printed EARLY rather than at the end. The point of an estimate is to
    // be actionable while the run is still young enough that stopping it is a real option.
    if (!reportedEstimate && g.generation === 9) {
      reportedEstimate = true
      const per = (Date.now() - started) / 10 / 1000
      const total = (per * generations) / 60
      console.log(
        `
  MEASURED over 10 generations: ${per.toFixed(1)}s/gen ` +
        `-> ${generations} generations = ${total.toFixed(0)} min (${(total / 60).toFixed(1)} h)
`
      )
    }

    if ((g.generation + 1) % CHECKPOINT_EVERY === 0) {
      try {
        writeFileSync(`${runDir}/checkpoint.json`, JSON.stringify({
          generation: g.generation, history, snapshot: pop.snapshot(),
          // The HOLDOUT champion, which is not in the snapshot — see the note at onGeneration in
          // train.js. Without this a checkpoint preserves the training-fitness champion, which is
          // a different and worse-chosen genome.
          champion: best?.genome ?? null,
          championGeneration: best?.generation ?? null,
          championHoldout: best?.holdout ?? null,
        }))
        // …and a standalone champion file at every checkpoint, so a run that is killed part-way
        // still leaves something usable rather than only a 60MB checkpoint to dig through.
        if (best?.genome) {
          writeFileSync(`${runDir}/champion.json`, JSON.stringify({
            championGeneration: best.generation,
            championHoldout: best.holdout,
            champion: best.genome,
            partial: true,            // cleared by the final write when the run completes
            generationsRun: g.generation + 1,
          }, null, 2))
        }
      } catch (err) {
        console.log(`PROGRESS gen ${g.generation} | CHECKPOINT FAILED: ${err.message}`)
      }

      // One line per block, carrying what actually decides whether to keep going. The per-block
      // HOLDOUT MEAN is the number to read: training fitness is scored on a slate that rotates
      // every generation, so it is not comparable across them — the holdout is the fixed exam.
      const block = history.slice(-CHECKPOINT_EVERY)
      const first = history.slice(0, CHECKPOINT_EVERY)
      const avg = (rows) => rows.reduce((a, r) => a + r.holdout, 0) / rows.length
      const blockMean = avg(block)
      const since = blockMean - avg(first)
      // Trend WITHIN this block, so a plateau shows up as it happens rather than in hindsight.
      const half = Math.floor(block.length / 2)
      const drift = avg(block.slice(half)) - avg(block.slice(0, half))
      const elapsedMin = (Date.now() - started) / 60000
      const remainMin = elapsedMin / (g.generation + 1) * (generations - g.generation - 1)

      console.log(
        `PROGRESS gen ${String(g.generation + 1).padStart(4)}/${generations}` +
        ` | holdout mean ${blockMean.toFixed(2)} (best ever ${g.bestHoldout.toFixed(2)}, gen ${history.reduce((b, r, i) => r.bestHoldout > (history[b]?.bestHoldout ?? -Infinity) ? i : b, 0)})` +
        ` | vs first block ${since >= 0 ? '+' : ''}${since.toFixed(2)}` +
        ` | drift ${drift >= 0 ? '+' : ''}${drift.toFixed(2)} ${Math.abs(drift) < 0.15 ? '(FLAT)' : drift > 0 ? '(rising)' : '(falling)'}` +
        ` | ${g.species} species | ${elapsedMin.toFixed(0)}m elapsed, ~${remainMin.toFixed(0)}m left`
      )
    }
  },
})

const elapsed = Date.now() - started
const perGeneration = out.history.reduce((a, g) => a + g.ms, 0) / out.history.length
const totalPlays = out.history.reduce((a, g) => a + g.plays, 0)

console.log(`\n── Result ─────────────────────────────────────────────`)
console.log(`  champion      : generation ${out.championGeneration}`)
console.log(`  holdout score : ${out.championHoldout?.toFixed(3)}`)
console.log(`  nodes/conns   : ${out.champion.nodes.length} / ${out.champion.connections.filter(c => c.enabled).length}`)
console.log(`  hidden grown  : ${out.champion.nodes.filter(n => n.kind === 'hidden').length}`)

console.log(`\n── Did it learn? ──────────────────────────────────────`)
const early = out.history.slice(0, Math.max(1, Math.floor(out.history.length * 0.1)))
const late = out.history.slice(-Math.max(1, Math.floor(out.history.length * 0.1)))
const avg = (rows, key) => rows.reduce((a, r) => a + r[key], 0) / rows.length
console.log(`  holdout, first 10% : ${avg(early, 'holdout').toFixed(3)}`)
console.log(`  holdout, last 10%  : ${avg(late, 'holdout').toFixed(3)}`)
const delta = avg(late, 'holdout') - avg(early, 'holdout')
console.log(`  change             : ${delta >= 0 ? '+' : ''}${delta.toFixed(3)} ${delta > 0.5 ? '(learning)' : delta < -0.5 ? '(getting worse)' : '(flat — inconclusive)'}`)

console.log(`\n── Time ───────────────────────────────────────────────`)
console.log(`  total        : ${(elapsed / 1000 / 60).toFixed(1)} min for ${generations} generations`)
console.log(`  per gen      : ${(perGeneration / 1000).toFixed(1)}s`)
console.log(`  plays        : ${totalPlays} (${(totalPlays / (elapsed / 1000)).toFixed(0)}/sec)`)
console.log(`  workers      : ${out.workers}`)
console.log(`
  MEASURED RATE, as actually run (parallel across ${out.workers} workers):`)
const thousand = perGeneration * 1000 / 1000 / 60
console.log(`    1000 generations = ${thousand.toFixed(0)} minutes (${(thousand / 60).toFixed(1)} hours)`)

// Save the champion and the history so a long run is not lost to a closed terminal.
try {
  const path = `${runDir}/champion.json`
  writeFileSync(path, JSON.stringify({
    identity: out.identity,
    championGeneration: out.championGeneration,
    championHoldout: out.championHoldout,
    holdoutHash: out.holdoutHash,
    champion: out.champion,
    history: out.history,
  }, null, 2))
  console.log(`\n  saved: ${path}`)
} catch (err) {
  console.log(`\n  (could not save: ${err.message})`)
}
