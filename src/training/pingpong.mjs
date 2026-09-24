// ── Ping-pong training ([pingpong]) ─────────────────────────────────────────
//
//   npm run training:pingpong [rounds] [maxGensPerRound] [population] [slate]
//   FRESH=1 npm run training:pingpong        # ignore any saved run and start over
//
// Round 1 trains the DEFENSE against the heuristic offense. Round 2 freezes that defense and trains
// the OFFENSE against it. Round 3 freezes the offense and trains the defense again, and so on —
// each side always facing the previous round's champion.
//
// A round ends when the champion has not improved for PLATEAU generations, or at MAX_GENS,
// whichever comes first. Plateau is the usual stopper; the cap only exists so one round cannot
// swallow a whole night.
//
// Why alternating rather than training both at once: with one side frozen, fitness is stationary
// and every round makes a claim that can be checked. Simultaneous co-evolution is the same
// algorithm with the freeze interval set to one generation — more powerful in principle, but it
// needs thousands of generations and an external benchmark before it says anything at all.
//
// ⚠️ TWO THINGS GUARD AGAINST THE FAILURE MODE.
//
// Iterated best response can CYCLE: defense plays quarters, offense learns to beat quarters,
// defense plays two-deep, offense learns to beat that, defense plays quarters again. Every round
// "improves" against its own opponent while nothing improves at football.
//
//   1. Every champion is ARCHIVED, and each new one is scored against EVERY previous opponent —
//      not just the one it trained on. Beating round 4 while losing to round 2 is a cycle.
//   2. Every champion is also scored against the ORIGINAL HEURISTIC, which never moves. That is the
//      only absolute reading in the whole run: "+X against the heuristic" means the same thing in
//      round 1 and round 19.
//
// ⚠️ BUILT TO RUN UNATTENDED. It checkpoints the in-progress champion EVERY generation, so a power
// cut loses at most one generation; it resumes from the last completed round on restart; and a
// round that throws is logged and skipped rather than taking the whole run down with it.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { trainRound, evaluateDeep, heuristicOn } from './deepTrain.js'
import { buildSlate } from './slate.js'
import { runBaseline } from './baseline.js'
import { createPool, defaultWorkerCount } from './pool.js'

const ROUNDS = Number(process.argv[2] ?? 20)
const MAX_GENS = Number(process.argv[3] ?? 200)
const POP = Number(process.argv[4] ?? 120)
const SLATE = Number(process.argv[5] ?? 24)
const PLATEAU = Number(process.env.PLATEAU ?? 40)
// A budget for the WHOLE run, across every round. Rounds end on plateau or the per-round cap; this
// is the outer limit on the night, so the run stops at a known cost rather than at a known round
// count. Generations already spent in completed rounds count against it, so a resume picks up the
// remaining budget rather than starting the clock again.
const TOTAL_GENS = Number(process.env.TOTAL_GENS ?? 2000)

// ⚠️ THE SLATE MUST GROW WITH THE POOL.
//
// Opponents are rotated per situation, so a fixed slate splits between them: 24 situations against
// a pool of four is SIX plays per opponent. Measured, the collapse tracked that exactly —
//   pool 1 (24/opponent) +6.10 | pool 2 (12) +5.60, +3.95 | pool 3 (8) +5.06, +2.95 | pool 4 (6) -0.39
// — and the cycle warning returned at pool 4. Six plays cannot separate a good genome from a lucky
// one, so selection goes near-random and specialisation creeps back.
//
// Keeping the per-opponent sample CONSTANT is the fix. The pool is capped so the cost of doing that
// stays bounded: past champions beyond the cap are sampled rather than all used, which is what a
// league does and keeps diversity without an unbounded slate.
const PER_OPPONENT = Number(process.env.PER_OPPONENT ?? 12)
const MAX_POOL = Number(process.env.MAX_POOL ?? 4)

// A FIXED directory, not a timestamped one, so a restart can find the run it is resuming.
// ⚠️ Overridable, and it has to be. A smoke test run in the live directory OVERWRITES the real
// archive — champions from a 400-generation overnight run were replaced by 3-generation toy genomes
// exactly that way. Any throwaway run gets its own directory: OUT_DIR=/tmp/pp-test.
const dir = process.env.OUT_DIR ?? 'training-output/pingpong-current'
mkdirSync(dir, { recursive: true })
const archivePath = join(dir, 'archive.json')

// Writing a file is not atomic — a power cut mid-write leaves a truncated JSON that kills the
// resume. Write to a temp name and rename, which is atomic on every filesystem that matters.
function saveJson(path, data) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 2))
  renameSync(tmp, path)
}

let archive = []        // every champion, in order: { round, side, genome, holdout, vsHeuristic }
let startRound = 1
let spent = 0           // generations used so far, across all rounds

if (!process.env.FRESH && existsSync(archivePath)) {
  try {
    const saved = JSON.parse(readFileSync(archivePath, 'utf8'))
    if (Array.isArray(saved.archive) && saved.archive.length) {
      archive = saved.archive
      startRound = archive[archive.length - 1].round + 1
      spent = saved.spent ?? archive.reduce((a, r) => a + (r.generationsRun ?? 0), 0)
      console.log(`[pingpong] RESUMING — ${archive.length} completed rounds found, continuing at round ${startRound}`)
    }
  } catch (err) {
    console.log(`[pingpong] archive unreadable (${err.message}); starting fresh`)
  }
}

// The permanent yardstick: a slate nothing trains on, used only for reporting.
const BENCH_SEED = 777001
const bench = buildSlate({ size: SLATE, generation: 9001, seed: BENCH_SEED })
const benchPar = runBaseline({ size: SLATE, repeats: 2, seed: BENCH_SEED, generation: 9001 }).expected

// ⚠️ THE PROCESS WRITES ITS OWN LOG. NEVER PIPE THIS THROUGH grep/tee.
//
// The overnight run was launched as `node ... | grep | tee > file`. A downstream stage died, and
// with nothing draining the pipe node's stdout buffer filled — at which point every console.log
// BLOCKS. The process stayed alive and kept checkpointing, so a "is the process running?" check
// said healthy, while the run advanced FOUR generations in FOUR HOURS. It had been doing 23s each.
//
// Writing the file here removes the pipe entirely: a file write cannot deadlock, and stdout can go
// straight to nul. It also means the log survives however the process is launched.
const logPath = join(dir, 'progress.log')
// The engine's own per-play chatter is intercepted here too, and must NOT reach the file — a night
// of `[game] ... TACKLE` lines is millions of rows. Only this script's own reporting is kept.
const NOISE = /^\[(game|ai|line|solo|socket)/
const realLog = console.log.bind(console)
console.log = (...args) => {
  const line = args.join(' ')
  if (NOISE.test(line)) return
  realLog(line)
  try { appendFileSync(logPath, line + String.fromCharCode(10)) } catch { /* logging must never stop a run */ }
}

const pool = createPool(defaultWorkerCount())

console.log(`[pingpong] rounds ${startRound}..${ROUNDS} | plateau ${PLATEAU} | cap ${MAX_GENS} gens/round`)
console.log(`[pingpong] total budget ${TOTAL_GENS} generations (${spent} already spent)`)
console.log(`[pingpong] population ${POP}, slate ${SLATE}, ${pool.size} workers`)
console.log(`[pingpong] output ${dir}/  (resumable; FRESH=1 to start over)\n`)

const started = Date.now()

for (let round = startRound; round <= ROUNDS; round++) {
  // The remaining budget caps this round. A round with fewer than a plateau's worth of generations
  // left cannot establish anything, so the run ends here rather than producing a champion that
  // simply ran out of time and might be mistaken for a converged one.
  const left = TOTAL_GENS - spent
  if (left < PLATEAU) {
    console.log(`── Budget spent: ${spent}/${TOTAL_GENS} generations, ${left} left (under one plateau). Stopping. ──
`)
    break
  }
  const roundCap = Math.min(MAX_GENS, left)

  const side = round % 2 === 1 ? 'defense' : 'offense'
  const oppSide = side === 'defense' ? 'offense' : 'defense'

  // ⚠️ THE POOL, not the latest opponent. Training against only the newest champion cycles — round 4
  // measured 20.8 against the round-3 defense it trained on, 11.3 against the round-1 defense, and
  // 2.17 BELOW the hand-written heuristic. The heuristic (null) stays in the pool permanently, so
  // staying good against it is part of the objective and a champion cannot drift below baseline.
  const pastOpponents = archive.filter(a => a.side === oppSide)

  // The heuristic ALWAYS stays in — that is what stops a champion drifting below baseline. Then the
  // most recent champion, because the newest counter is the one most worth answering. The remaining
  // slots are spread across the rest of history so old strategies are not forgotten.
  const chosen = []
  if (pastOpponents.length) {
    chosen.push(pastOpponents[pastOpponents.length - 1])
    const older = pastOpponents.slice(0, -1)
    const room = MAX_POOL - 1 - chosen.length
    if (older.length <= room) chosen.push(...older)
    else {
      // Evenly spaced through history rather than random, so a resume reproduces the same pool.
      const step = older.length / room
      for (let i = 0; i < room; i++) chosen.push(older[Math.floor(i * step)])
    }
  }
  const opponents = [null, ...chosen.map(a => a.genome)]
  const roundSlate = Math.max(SLATE, PER_OPPONENT * opponents.length)
  const poolDesc = chosen.length
    ? `heuristic + ${chosen.map(a => `r${a.round}`).join(', ')}`
    : `the heuristic ${oppSide}`

  console.log(`── Round ${round}: training ${side.toUpperCase()} vs ${poolDesc} | slate ${roundSlate} (${PER_OPPONENT}/opponent) ──`)

  const progressPath = join(dir, `round-${round}-${side}-inprogress.json`)
  let out = null

  try {
    out = await trainRound({
      side, opponents, generations: roundCap, plateau: PLATEAU,
      populationSize: POP, slateSize: roundSlate, pool,
      onGeneration: (g, _pop, best) => {
        // ⚠️ EVERY generation, not every N. This is the file that survives a power cut, and the
        // whole point is that at most one generation of work is ever at risk.
        try {
          saveJson(progressPath, {
            round, side, generation: g.generation, holdout: best?.holdout ?? null,
            championGeneration: best?.generation ?? null, champion: best?.genome ?? null,
          })
        } catch { /* a checkpoint failure must never stop the run */ }

        if (g.generation % 10 === 0 || g.sinceBest === 0) {
          console.log(`   gen ${String(g.generation).padStart(3)} | best ${g.best.toFixed(2)} mean ${g.mean.toFixed(2)}` +
                      ` | HOLDOUT ${g.holdout.toFixed(2)} best ${g.bestHoldout.toFixed(2)}` +
                      ` | ${g.species} sp | flat ${g.sinceBest}/${PLATEAU} | ${(g.ms / 1000).toFixed(1)}s`)
        }
      },
    })
  } catch (err) {
    // A round that dies must not take the night with it. Fall back to whatever the per-generation
    // checkpoint last saved; if there is nothing, skip the round and carry on.
    console.log(`   ⚠ round ${round} FAILED: ${err?.message ?? err}`)
    if (existsSync(progressPath)) {
      try {
        const saved = JSON.parse(readFileSync(progressPath, 'utf8'))
        if (saved.champion) {
          out = { side, champion: saved.champion, holdout: saved.holdout,
                  championGeneration: saved.championGeneration, generationsRun: saved.generation + 1, history: [] }
          console.log(`   recovered the in-progress champion from generation ${saved.championGeneration}`)
        }
      } catch { /* unreadable checkpoint — nothing to recover */ }
    }
    if (!out) { console.log(`   skipping round ${round}\n`); continue }
  }

  // ── What did this round actually achieve? ──
  let vsHeuristic = null, heuristicHere = null
  try {
    vsHeuristic = evaluateDeep(out.champion, { side, slate: bench, expected: benchPar, opponents: [null], repeats: 2 }).fitness
    heuristicHere = heuristicOn(side, bench, benchPar, { opponents: [null], repeats: 2 })
  } catch (err) {
    console.log(`   ⚠ benchmark failed: ${err?.message ?? err}`)
  }

  spent += out.generationsRun ?? 0
  archive.push({ round, side, genome: out.champion, holdout: out.holdout, vsHeuristic, generationsRun: out.generationsRun })

  console.log(`   stopped after ${out.generationsRun} generations (champion from gen ${out.championGeneration})`)
  console.log(`   vs its own opponent : ${out.holdout?.toFixed(2) ?? '-'}`)
  if (vsHeuristic != null) {
    console.log(`   vs the HEURISTIC    : ${vsHeuristic.toFixed(2)}   (the heuristic itself scores ${heuristicHere.toFixed(2)})`)
  }

  // Cycle check: this champion against every opponent of the other side we have ever produced.
  const past = archive.filter(a => a.side === oppSide)
  if (past.length > 1) {
    try {
      const rows = past.map(p => {
        const f = evaluateDeep(out.champion, { side, slate: bench, expected: benchPar, opponents: [p.genome], repeats: 1 }).fitness
        return { round: p.round, f }
      })
      console.log(`   vs every past ${oppSide}: ${rows.map(r => `r${r.round}:${r.f.toFixed(1)}`).join('  ')}`)
      const newest = rows[rows.length - 1].f
      const worstOld = Math.min(...rows.slice(0, -1).map(r => r.f))
      if (newest - worstOld > 3) {
        console.log(`   ⚠ CYCLE WARNING — beats the newest by ${(newest - worstOld).toFixed(1)} more than an older one.`)
      }
    } catch (err) {
      console.log(`   ⚠ cycle check failed: ${err?.message ?? err}`)
    }
  }

  try {
    saveJson(join(dir, `round-${round}-${side}.json`), {
      round, side, championGeneration: out.championGeneration, holdout: out.holdout,
      vsHeuristic, generationsRun: out.generationsRun, champion: out.champion,
    })
    saveJson(archivePath, { updated: new Date().toISOString(), rounds: archive.length, spent, archive })
  } catch (err) {
    console.log(`   ⚠ could not save round ${round}: ${err?.message ?? err}`)
  }
  console.log(`   elapsed ${((Date.now() - started) / 60000).toFixed(0)} min\n`)
}

await pool.destroy()
console.log(`── Done: ${archive.length} rounds, ${spent} generations, ${((Date.now() - started) / 60000).toFixed(1)} min. ${dir}/ ──`)
