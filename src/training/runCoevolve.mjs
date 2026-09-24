// ── Co-evolution: both AIs, at once ([coevolve]) ────────────────────────────
//
//   npm run training:coevolve [generations] [population] [situations]
//   FRESH=1 ...    ignore any saved run and start over
//
// Two populations stepping together, scored on SERIES outcomes rather than per-play yardage. Every
// series teaches an offense genome and a defense genome at the same time.
//
// Built to run unattended: it checkpoints every generation, resumes from where it stopped, and
// reports both sides against the frozen heuristic so a rising score cannot be mistaken for
// progress when it is really the opponent getting worse.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  shapes, buildJobs, runJob, collectFitness, playPairing, createPopulation, buildSlate,
} from './coevolve.js'
import { createPool, defaultWorkerCount } from './pool.js'

const GENERATIONS = Number(process.argv[2] ?? 400)
const POP = Number(process.argv[3] ?? 80)
const SITUATIONS = Number(process.argv[4] ?? 24)
const OPPONENTS = Number(process.env.OPPONENTS ?? 4)   // distinct foes each genome faces
const ANCHORS = Number(process.env.ANCHORS ?? 1)       // series against the heuristic, per genome
const CHECKPOINT_EVERY = Number(process.env.REPORT_EVERY ?? 10)

const dir = process.env.OUT_DIR ?? 'training-output/coevolve-current'
mkdirSync(dir, { recursive: true })
const statePath = join(dir, 'state.json')
const logPath = join(dir, 'progress.log')

// The process writes its own log — never pipe this through grep/tee. A dead downstream stage fills
// the stdout pipe and every console.log then BLOCKS, which looks exactly like a healthy process
// doing nothing.
const NOISE = /^\[(game|ai|line|solo|socket)/
const realLog = console.log.bind(console)
console.log = (...args) => {
  const line = args.join(' ')
  if (NOISE.test(line)) return
  realLog(line)
  try { appendFileSync(logPath, line + String.fromCharCode(10)) } catch { /* never stop a run */ }
}

function saveJson(path, data) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, path)          // atomic: a truncated file would break the resume it exists for
}

const shape = shapes()
let offPop = createPopulation({ ...shape.offense, seed: 1, config: { populationSize: POP } })
let defPop = createPopulation({ ...shape.defense, seed: 2, config: { populationSize: POP } })
let startGen = 0
const history = []
let bestOff = null, bestDef = null

if (!process.env.FRESH && existsSync(statePath)) {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    if (saved.generation != null) {
      // createPopulation takes no snapshot argument — a population is built and then RESTORED,
      // which is how the determinism test resumes and reproduces a run exactly.
      offPop.restore(saved.offense)
      defPop.restore(saved.defense)
      startGen = saved.generation + 1
      history.push(...(saved.history ?? []))
      bestOff = saved.bestOff ?? null
      bestDef = saved.bestDef ?? null
      console.log(`[coevolve] RESUMING at generation ${startGen}`)
    }
  } catch (err) {
    console.log(`[coevolve] saved state unreadable (${err.message}); starting fresh`)
  }
}

const pool = createPool(defaultWorkerCount())

// The permanent yardstick: series nothing trains on, always against the hand-written AI.
const BENCH = buildSlate({ size: 12, generation: 99001, seed: 515151 })
function benchmark(genome, side) {
  let total = 0
  for (const s of BENCH.situations) {
    const r = side === 'offense' ? playPairing(genome, null, s) : playPairing(null, genome, s)
    total += side === 'offense' ? r.score : -r.score
  }
  return total / BENCH.situations.length
}

console.log(`[coevolve] ${GENERATIONS} generations | population ${POP} each side`)
console.log(`[coevolve] ${OPPONENTS} opponents + ${ANCHORS} heuristic anchor(s) per genome, ${SITUATIONS} situations`)
console.log(`[coevolve] ${pool.size} workers | output ${dir}/\n`)

const started = Date.now()

for (let gen = startGen; gen < GENERATIONS; gen++) {
  const t0 = Date.now()
  // Situations rotate per generation so neither side can memorise one set of spots.
  const slate = buildSlate({ size: SITUATIONS, generation: gen, seed: 4242 })

  const jobs = buildJobs({
    offense: offPop.genomes, defense: defPop.genomes,
    situations: slate.situations, opponents: OPPONENTS, anchors: ANCHORS,
  })

  const raw = await pool.evaluateSeries(jobs)
  const results = raw.map(r => r?.job).filter(Boolean)
  const fit = collectFitness(results, POP)

  // ⚠️ BOTH populations step on the SAME evaluation. Stepping one and re-evaluating for the other
  // would mean the second side was scored against an opponent that had already moved.
  const offRec = offPop.step(gs => gs.forEach((g, i) => { g.fitness = fit.offense[i] ?? 0 }))
  const defRec = defPop.step(gs => gs.forEach((g, i) => { g.fitness = fit.defense[i] ?? 0 }))

  // Against the frozen heuristic — the only absolute reading when both sides are moving.
  const offBench = benchmark(offRec.bestGenome, 'offense')
  const defBench = benchmark(defRec.bestGenome, 'defense')
  if (!bestOff || offBench > bestOff.bench) bestOff = { bench: offBench, generation: gen, genome: offRec.bestGenome }
  if (!bestDef || defBench > bestDef.bench) bestDef = { bench: defBench, generation: gen, genome: defRec.bestGenome }

  const ms = Date.now() - t0
  history.push({ generation: gen, offBench, defBench, offSpecies: offRec.species, defSpecies: defRec.species, ms })

  // ⚠️ CHAMPIONS EVERY GENERATION, full state every CHECKPOINT_EVERY.
  //
  // The champions are what a stopped run is worth — two genomes, a couple of hundred KB — so they
  // are written every generation and stopping early costs nothing. The resumable state carries both
  // whole populations (~20MB) and is far too heavy to write that often, so it lags a little; a
  // resume may lose a few generations of population, never the best brains found.
  try {
    saveJson(join(dir, 'champions.json'), {
      offense: { bench: bestOff.bench, generation: bestOff.generation, genome: bestOff.genome },
      defense: { bench: bestDef.bench, generation: bestDef.generation, genome: bestDef.genome },
      generationsRun: gen + 1,
      partial: gen < GENERATIONS - 1,
    })
  } catch { /* a checkpoint failure must never stop a run */ }

  if (gen % CHECKPOINT_EVERY === 0 || gen === GENERATIONS - 1) {
    console.log(
      `  gen ${String(gen).padStart(4)} | OFF vs heuristic ${offBench.toFixed(2).padStart(6)} (best ${bestOff.bench.toFixed(2)})` +
      ` | DEF vs heuristic ${defBench.toFixed(2).padStart(6)} (best ${bestDef.bench.toFixed(2)})` +
      ` | ${offRec.species}/${defRec.species} species | ${(ms / 1000).toFixed(1)}s`
    )
    try {
      saveJson(statePath, {
        generation: gen, history,
        offense: offPop.snapshot(), defense: defPop.snapshot(),
        bestOff, bestDef,
      })
    } catch (err) {
      console.log(`  ...checkpoint FAILED at gen ${gen}: ${err.message}`)
    }
  }
}

await pool.destroy()
const mins = (Date.now() - started) / 60000
console.log(`\n── Done: ${GENERATIONS - startGen} generations in ${mins.toFixed(1)} min ──`)
console.log(`  best OFFENSE : generation ${bestOff?.generation}, ${bestOff?.bench.toFixed(2)} against the heuristic`)
console.log(`  best DEFENSE : generation ${bestDef?.generation}, ${bestDef?.bench.toFixed(2)} against the heuristic`)
console.log(`  champions in ${dir}/champions.json`)
