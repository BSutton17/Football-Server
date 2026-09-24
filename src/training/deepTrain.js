// ── Training either side against a frozen opponent ([deep][pingpong]) ───────
//
// One side evolves while the other stands still. That freezing is the whole point: with both
// populations moving, a genome's fitness depends on an opponent that is itself changing, the score
// becomes non-stationary, and a rising number cannot be told apart from "the opponent got worse".
// Freeze one side and fitness means something again.
//
// Alternating rounds of this IS co-evolution — just with a long freeze interval. Simultaneous
// co-evolution is the same algorithm with the interval set to one generation, and it needs
// thousands of generations plus an external benchmark before it says anything.

import { createPopulation } from '../neat/population.js'
import { createTrainingGame, destroyTrainingGame, runPlay, TRAINING_DIFFICULTY } from './game.js'
import { createDeepDefenseBrain, DEEP_OBSERVATION_SIZE, DEEP_ACTION_SIZE } from './deepBrainDefense.js'
import { createDeepOffenseBrain, DEEP_OFF_OBSERVATION_SIZE, DEEP_OFF_ACTION_SIZE } from './deepBrainOffense.js'
import { syntheticRoster } from '../ai/roster.js'
import { buildSlate } from './slate.js'
import { runBaseline } from './baseline.js'
import { scoreSlate, finalFitness } from './fitness.js'

export const SIDES = ['defense', 'offense']

// The genome shape each side uses. They differ, so a defensive champion and an offensive one are
// not interchangeable and a checkpoint records which it is.
export function shapeFor(side) {
  return side === 'offense'
    ? { inputs: DEEP_OFF_OBSERVATION_SIZE, outputs: DEEP_OFF_ACTION_SIZE }
    : { inputs: DEEP_OBSERVATION_SIZE, outputs: DEEP_ACTION_SIZE }
}

// Seats a brain. A null genome means the heuristic plays that side, which is what round one's
// opponent is and what the permanent benchmark always is.
function seat(ctx, slot, side, genome, seed) {
  if (!genome) return                     // leave the heuristic controller in place
  const roster = syntheticRoster(side === 'offense' ? 'off' : 'net')
  const make = side === 'offense' ? createDeepOffenseBrain : createDeepDefenseBrain
  const brain = make({ socket: ctx.seats[slot], slot, roster, genome, seed })
  ctx.brains[slot] = brain
  ctx.seats[slot].emit = (e, p) => {
    try { brain.onEvent(e, p) } catch { /* a broken genome must not stop the run */ }
  }
  return brain
}

// Plays one genome through a slate on `side`, against a POOL of frozen opponents.
//
// ⚠️ A POOL, NOT THE LATEST. Training only against the most recent opponent is iterated best
// response, and it cycles: measured here, the round-4 offense scored 20.8 against the round-3
// defense it trained on and 11.3 against the round-1 defense — a 9.5-point gap — while dropping to
// 2.17 BELOW the hand-written heuristic in absolute terms. Each round beat its own opponent and the
// thing being built got worse.
//
// Facing a spread of past opponents is the standard remedy (it is what makes fictitious play
// converge, and what a "league" does). `null` in the pool means the HEURISTIC, and keeping it there
// permanently is the part that matters most: a champion can then never drift below the hand-written
// baseline, because staying good against it is part of the objective rather than an afterthought.
export function evaluateDeep(genome, { side, slate, expected, opponents = null, opponent = null, repeats = 1 }) {
  const plays = []
  const mySlot = side === 'offense' ? 0 : 1      // situations are written with possession 0
  const oppSide = side === 'offense' ? 'defense' : 'offense'
  const pool = opponents ?? [opponent]

  for (const [i, situation] of slate.situations.entries()) {
    for (let r = 0; r < repeats; r++) {
      const seed = (situation.seed + r * 0x9e37) >>> 0
      // Rotate deterministically by situation. Every genome in a generation therefore faces the
      // IDENTICAL mix — drawing opponents at random per genome would make fitness partly a measure
      // of who got the easy draw.
      const foe = pool[(i + r) % pool.length]
      const ctx = createTrainingGame({ seed, difficulty: TRAINING_DIFFICULTY })
      try {
        seat(ctx, mySlot, side, genome, seed)
        seat(ctx, 1 - mySlot, oppSide, foe, seed)
        plays.push({ ...runPlay(ctx, { ...situation, seed, possession: 0 }), situationId: situation.id })
      } finally {
        destroyTrainingGame(ctx)
      }
    }
  }

  const result = scoreSlate(plays, expected, { side })
  return { fitness: finalFitness(result), result, plays }
}

// Scores the HEURISTIC on `side` over a slate — the permanent, unmoving benchmark. Every round is
// reported against this as well as against its own opponent, because "beat the thing I was trained
// on" and "got better at football" are different claims.
export function heuristicOn(side, slate, expected, { opponents = [null], repeats = 1 } = {}) {
  return evaluateDeep(null, { side, slate, expected, opponents, repeats }).fitness
}

// ── One round ─────────────────────────────────────────────────────────────────
//
// Trains `side` until it stops improving on the holdout, or until `maxGenerations`.
export async function trainRound({
  side,
  opponents = null,        // the pool this round trains against; null in it means the heuristic
  generations = 60,
  plateau = 20,              // generations without a new best before the round ends
  populationSize = 120,
  slateSize = 24,
  seed = 1,
  slateSeed = 12345,
  baselineRepeats = 2,
  pool = null,
  onGeneration = null,
} = {}) {
  const shape = shapeFor(side)
  const pop = createPopulation({ ...shape, seed, config: { populationSize } })

  const holdoutSeed = (slateSeed ^ 0x5eed) >>> 0
  const holdout = buildSlate({ size: slateSize, generation: -1, seed: holdoutSeed })
  const holdoutPar = runBaseline({
    size: slateSize, repeats: baselineRepeats, seed: holdoutSeed, generation: -1,
  }).expected

  const history = []
  let best = null
  let sinceBest = 0

  for (let gen = 0; gen < generations; gen++) {
    const slate = buildSlate({ size: slateSize, generation: gen, seed: slateSeed })
    // Par matches the slate's generation — see the note in train.js. A mismatch silently scores
    // everything against zero and scoreSlate now throws rather than let that happen again.
    const par = runBaseline({
      size: slateSize, repeats: baselineRepeats, seed: slateSeed, generation: gen,
    }).expected

    const started = Date.now()
    let scores = null
    if (pool) scores = await pool.evaluateDeep(pop.genomes, { side, slate, expected: par, opponents })

    const record = pop.step(gs => gs.forEach((g, i) => {
      g.fitness = scores
        ? (scores[i]?.fitness ?? 0)
        : evaluateDeep(g, { side, slate, expected: par, opponents }).fitness
    }))

    const onHoldout = evaluateDeep(record.bestGenome, {
      side, slate: holdout, expected: holdoutPar, opponents, repeats: 2,
    }).fitness

    if (!best || onHoldout > best.holdout) {
      best = { genome: record.bestGenome, holdout: onHoldout, generation: gen }
      sinceBest = 0
    } else {
      sinceBest++
    }

    const { bestGenome, ...slim } = record
    const entry = { ...slim, holdout: onHoldout, bestHoldout: best.holdout, sinceBest, ms: Date.now() - started }
    history.push(entry)
    onGeneration?.(entry, pop, best)

    // Plateau: the whole reason a round ends. Running on past this is spending compute to confirm
    // a number that has already stopped moving.
    if (sinceBest >= plateau) break
  }

  return { side, champion: best?.genome ?? pop.champion, holdout: best?.holdout ?? null,
           championGeneration: best?.generation ?? null, generationsRun: history.length, history }
}
