// ── The training loop ([training]) ──────────────────────────────────────────
//
// Evolve a defensive coordinator. Each generation: every genome calls the coverage across the same
// slate of situations against the scripted offense, and is scored on how much better than par it
// did. The heuristic AI is the fixed opponent AND the yardstick — no self-play, because two
// populations chasing each other improve against each other without improving at football.
//
// Run it with: node src/training/runTrain.mjs [generations]

import { createPopulation } from '../neat/population.js'
import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { createNetworkBrain } from './networkBrain.js'
import { buildSlate } from './slate.js'
import { scoreSlate, finalFitness, FITNESS_VERSION } from './fitness.js'
import { OBSERVATION_SIZE, OBSERVATION_VERSION, observationSpecHash } from './observation.js'
import { ACTION_SIZE, ACTION_VERSION, actionSpecHash } from './action.js'
import { syntheticRoster } from '../ai/roster.js'
import { runBaseline } from './baseline.js'
import { createPool, defaultWorkerCount } from './pool.js'
import { TRAINING_DIFFICULTY } from './game.js'

export const TRAINING_VERSION = 'v1'

// Passes over the fixed holdout when scoring a generation's best genome. See the note at the call.
const HOLDOUT_REPEATS = 3

// Everything that has to match for two runs to be comparable — and therefore for a checkpoint to
// be resumable. A mismatch REFUSES and names the field rather than silently carrying on, because a
// resume that quietly changed the exam produces numbers that look fine and mean nothing.
export function identity({ seed, populationSize, slateSize, slateSeed }) {
  return {
    training: TRAINING_VERSION,
    observation: OBSERVATION_VERSION,
    observationHash: observationSpecHash(),
    action: ACTION_VERSION,
    actionHash: actionSpecHash(),
    fitness: FITNESS_VERSION,
    // The tier the opponent played at. A run against the easy offense and a run against the hard
    // one are not comparable and a checkpoint must not cross between them — easy hands the
    // quarterback a noisy read of the field, which is a different exam entirely.
    difficulty: TRAINING_DIFFICULTY,
    inputs: OBSERVATION_SIZE,
    outputs: ACTION_SIZE,
    seed, populationSize, slateSize, slateSeed,
  }
}

export function assertCompatible(saved, current) {
  for (const key of Object.keys(current)) {
    if (saved[key] !== current[key]) {
      throw new Error(
        `checkpoint is not compatible: ${key} was ${JSON.stringify(saved[key])}, ` +
        `now ${JSON.stringify(current[key])}. Resuming would change the exam.`
      )
    }
  }
}

// Plays one genome through the whole slate as the DEFENSE.
export function evaluateGenome(genome, slate, expected, { repeats = 1 } = {}) {
  const plays = []
  const roster = syntheticRoster('net')

  for (const situation of slate.situations) {
    for (let r = 0; r < repeats; r++) {
      const seed = (situation.seed + r * 0x9e37) >>> 0
      // The NETWORK defends, so it takes the seat that is NOT on offense. Situations are written
      // with possession 0, so the network sits in seat 1.
      const ctx = createTrainingGame({
        seed,
        controllers: {
          1: null,   // replaced below, once the socket exists
        },
      })
      try {
        // Swap seat 1's brain for the network's. The controller is already built; only the CALL
        // is overridden, so everything legality-related is inherited.
        const netBrain = createNetworkBrain({
          socket: ctx.seats[1], slot: 1, roster, genome, seed,
        })
        ctx.brains[1] = netBrain
        ctx.seats[1].emit = (event, payload) => {
          try { netBrain.onEvent(event, payload) } catch { /* a broken genome must not stop the run */ }
        }

        const play = runPlay(ctx, { ...situation, seed, possession: 0 })
        plays.push({ ...play, situationId: situation.id })
      } finally {
        destroyTrainingGame(ctx)
      }
    }
  }

  const result = scoreSlate(plays, expected)
  return { fitness: finalFitness(result), result, plays }
}

// The whole run.
export async function train({
  generations = 100,
  populationSize = 150,
  slateSize = 40,
  seed = 1,
  slateSeed = 12345,
  baselineRepeats = 4,
  onGeneration = null,
  expected = null,
  // [training] Evaluation fans out across worker threads. 0 runs everything in this process, which
  // is what the tests use — the results are IDENTICAL either way, because every play is seeded
  // from its situation and cannot depend on which thread ran it.
  workers = defaultWorkerCount(),
} = {}) {
  const started = Date.now()

  // PAR, from the heuristic playing itself. Everything after this is read against it, so it is
  // measured once up front rather than re-derived per generation.
  // ⚠️ PAR IS PER GENERATION, because the SLATE is per generation.
  //
  // This used to measure par once, on generation 0, and reuse it for the whole run. Situation ids
  // carry their generation (`g{gen}-s{i}`), so from generation 1 onward not a single par lookup
  // matched and `scoreSlate` silently scored everything against zero. `scoreSlate` now refuses a
  // total mismatch outright; this is the other half of the fix, which is to hand it par that
  // actually corresponds to the slate being played.
  //
  // Note on cost: par does NOT change the ranking WITHIN a generation — every genome faces the
  // same slate, so subtracting the same per-situation constant from all of them leaves the order
  // untouched. What it buys is a meaningful SCALE (a score of 0 means "exactly as good as the
  // heuristic") and, crucially, a working harness-breaking guard: with real par, a play that fails
  // to run scores the same as an average play rather than better than one.
  const parFor = (generation) => runBaseline({
    size: slateSize, repeats: baselineRepeats, seed: slateSeed, generation,
  }).expected

  // The integrity GATE, run once. It is not where par comes from any more — par is measured per
  // generation below — but a broken game must still stop the run before it starts.
  let baseline = null
  if (!expected) {
    baseline = runBaseline({ size: slateSize, repeats: baselineRepeats, seed: slateSeed })
    if (!baseline.clean) {
      throw new Error(
        `refusing to train: the baseline found ${baseline.problems.length} integrity problems. ` +
        `Training against a broken game teaches the AI to exploit the break.`
      )
    }
  }

  const pop = createPopulation({
    inputs: OBSERVATION_SIZE,
    outputs: ACTION_SIZE,
    seed,
    config: { populationSize },
  })

  const id = identity({ seed, populationSize, slateSize, slateSeed })
  const history = []

  // ⚠️ THE HOLDOUT. The training slate ROTATES every generation so a genome cannot overfit to one
  // exact set of plays — but that makes fitness scores from different generations incomparable,
  // because they are scores on different exams. Picking an all-time champion by raw fitness across
  // rotating slates therefore crowns whoever drew the easiest one.
  //
  // So champions are compared on a FIXED slate that is never trained on. One extra genome
  // evaluation per generation, and it is the difference between "best so far" meaning something
  // and meaning nothing.
  const pool = workers > 0 ? createPool(workers) : null
  const genomes = (p) => p.genomes

  const holdoutSeed = (slateSeed ^ 0x5eed) >>> 0
  const holdout = buildSlate({ size: slateSize, generation: -1, seed: holdoutSeed })
  // generation: -1 to MATCH the holdout slate above. Without it this measured generation 0 and the
  // holdout column was raw yards allowed for the entire run.
  const holdoutPar = runBaseline({
    size: slateSize, repeats: baselineRepeats, seed: holdoutSeed, generation: -1,
  }).expected
  let best = null

  for (let gen = 0; gen < generations; gen++) {
    // The slate ROTATES per generation so a genome cannot overfit to one exact set of plays, but
    // within the generation every genome faces the identical one.
    const slate = buildSlate({ size: slateSize, generation: gen, seed: slateSeed })
    // Par for THIS generation's situations. A caller that supplied `expected` owns the match.
    const par = expected ?? parFor(gen)

    const genStart = Date.now()
    let plays = 0

    // The generation is scored in parallel when a pool is up, serially otherwise. `pop.step` takes
    // a synchronous evaluator, so the parallel work is awaited FIRST and the fitnesses are simply
    // read back — which also keeps the population code free of any knowledge of threads.
    let scores = null
    if (pool) scores = await pool.evaluate(genomes(pop), slate, par)

    // ⚠️ The fitness DISTRIBUTION, captured while the population is still evaluated. It cannot be
    // recovered afterwards: pop.step() ends with breed(), so any snapshot taken later holds the
    // NEXT generation's unevaluated offspring, whose fitness is 0 because nobody has scored them.
    // Reading zeros out of a checkpoint and concluding the population was broken is a trap — this
    // is the honest place to measure, and selection pressure is exactly what it measures.
    let spread = null
    const record = pop.step(gs => {
      gs.forEach((g, i) => {
        if (scores) {
          g.fitness = scores[i]?.fitness ?? 0
          plays += scores[i]?.plays ?? 0
        } else {
          const r = evaluateGenome(g, slate, par)
          g.fitness = r.fitness
          plays += r.plays.length
        }
      })
      const f = gs.map(g => g.fitness).sort((a, b) => a - b)
      const at = (q) => f[Math.min(f.length - 1, Math.floor(q * f.length))]
      spread = {
        min: f[0], p25: at(0.25), median: at(0.5), p75: at(0.75), max: f[f.length - 1],
        zeros: f.filter(v => v === 0).length,
        // The number that decides whether selection can do anything. Offspring are allocated in
        // proportion to fitness, so what matters is the RATIO across the population, not the gap:
        // a spread of 17.0-18.2 breeds almost uniformly however large those numbers look.
        ratio: f[f.length - 1] > 0 ? at(0.25) / f[f.length - 1] : 0,
      }
    })

    // Score THIS GENERATION'S best on the fixed holdout, and keep the all-time champion by that
    // score. Using pop.champion here instead re-scores the same genome every generation — the
    // holdout column comes out identical from gen 0 to gen N and says nothing at all.
    const contender = record.bestGenome
    // ⚠️ REPEATED, because this choice is the one that actually ships. A single pass over the
    // holdout swung 15.1 to 18.9 between generations on an unchanged setup — noise of the same
    // size as the improvement being looked for, which means an all-time champion picked on one
    // pass is often just the luckiest draw. Three passes cost one genome's worth of extra work
    // against 150 already being evaluated, and buy a champion that is actually the best one.
    const onHoldout = evaluateGenome(contender, holdout, holdoutPar, { repeats: HOLDOUT_REPEATS }).fitness
    if (!best || onHoldout > best.holdout) {
      best = { genome: contender, holdout: onHoldout, generation: gen }
    }

    const elapsed = Date.now() - genStart
    const { bestGenome, ...slim } = record
    const entry = {
      ...slim,
      spread,
      slateHash: slate.hash,
      plays,
      ms: elapsed,
      playsPerSecond: plays / (elapsed / 1000),
      holdout: onHoldout,
      bestHoldout: best.holdout,
    }
    history.push(entry)
    // ⚠️ `best` is handed over EXPLICITLY, because it is not in `pop`.
    //
    // pop.snapshot().champion is the all-time best by TRAINING fitness, and training slates rotate
    // every generation — which this file already documents as unsound, since it crowns whoever drew
    // the easiest slate. The real champion is `best`, chosen on the FIXED holdout, and it lives
    // only here. A checkpoint that saved the snapshot alone therefore preserved the wrong genome:
    // a run killed at generation 116 left a champion scoring 15.00 on the holdout when the run had
    // reported a best of 16.17. Everything the run was for, lost to a process teardown.
    onGeneration?.(entry, pop, best)
  }

  await pool?.destroy()

  return {
    identity: id,
    baseline,
    history,
    workers,
    holdoutHash: holdout.hash,
    // The champion by HOLDOUT score, which is the only cross-generation comparison that is sound.
    champion: best?.genome ?? pop.champion,
    championGeneration: best?.generation ?? pop.championGeneration,
    championHoldout: best?.holdout ?? null,
    snapshot: pop.snapshot(),
    elapsedMs: Date.now() - started,
  }
}
