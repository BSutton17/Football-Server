// ── Both sides at once ([coevolve]) ─────────────────────────────────────────
//
// Two populations stepping together. Every series scores an offense genome AND a defense genome, so
// one play teaches both — where the old ping-pong spent a whole round training one side while the
// other sat frozen, producing no learning for half the compute.
//
// ⚠️ THE THREE THINGS THAT MAKE SIMULTANEOUS TRAINING SAFE. Without them this is the cycling
// failure that ping-pong already demonstrated, and harder to spot because there are no round
// boundaries to compare across.
//
//   1. EACH GENOME FACES SEVERAL OPPONENTS. Against one opponent drawn from a moving population,
//      fitness is noise — it measures who drew the weak draw.
//   2. THE HEURISTIC IS ALWAYS IN THE MIX. A fixed slice of every genome's series is played against
//      the hand-written AI, which never moves. That is what makes drifting below baseline
//      structurally impossible; it is the fix that stopped ping-pong cycling.
//   3. BOTH SIDES ARE REPORTED AGAINST THE FROZEN HEURISTIC EVERY GENERATION. With both populations
//      moving, a rising score genuinely cannot be told apart from "the opponent got worse". The
//      benchmark is the only absolute reading in the run.

import { createPopulation } from '../neat/population.js'
import { createTrainingGame, destroyTrainingGame, TRAINING_DIFFICULTY } from './game.js'
import { createDeepDefenseBrain, DEEP_OBSERVATION_SIZE, DEEP_ACTION_SIZE } from './deepBrainDefense.js'
import { createDeepOffenseBrain, DEEP_OFF_OBSERVATION_SIZE, DEEP_OFF_ACTION_SIZE } from './deepBrainOffense.js'
import { syntheticRoster } from '../ai/roster.js'
import { runSeries, scoreSeries } from './series.js'
import { buildSlate } from './slate.js'

export const COEVOLVE_VERSION = 'v1'

// NEAT's fitness sharing divides by species size, which needs non-negative numbers. Series scores
// run roughly -20..+30, so this shifts them clear of zero. A fixed offset leaves the ORDERING
// untouched, which is all selection uses.
const FITNESS_OFFSET = 25

function seatBrain(ctx, slot, side, genome, seed) {
  if (!genome) return null                 // null means the heuristic plays this side
  const roster = syntheticRoster(side === 'offense' ? 'off' : 'net')
  const make = side === 'offense' ? createDeepOffenseBrain : createDeepDefenseBrain
  const brain = make({ socket: ctx.seats[slot], slot, roster, genome, seed })
  ctx.brains[slot] = brain
  ctx.seats[slot].onEventHandler = brain
  ctx.seats[slot].emit = (e, p) => {
    try { brain.onEvent(e, p) } catch { /* a broken genome must not stop the run */ }
  }
  return brain
}

// Plays ONE series between a specific offense and a specific defense. Returns the offense's score;
// the defense's is its negative.
export function playPairing(offenseGenome, defenseGenome, situation) {
  const ctx = createTrainingGame({ seed: situation.seed, difficulty: TRAINING_DIFFICULTY })
  try {
    seatBrain(ctx, 0, 'offense', offenseGenome, situation.seed)
    seatBrain(ctx, 1, 'defense', defenseGenome, situation.seed)
    const result = runSeries(ctx, { ...situation, possession: 0 })
    return { score: scoreSeries(result), outcome: result.outcome, ok: result.ok }
  } finally {
    destroyTrainingGame(ctx)
  }
}

// Who plays whom this generation.
//
// Deterministic rather than random: every offense faces opponents spread evenly through the defense
// population, so no genome is scored against an unrepresentative sample. A random draw would make
// part of every fitness a measure of luck.
export function buildPairings(n, opponents) {
  const stride = Math.max(1, Math.floor(n / opponents))
  const rows = []
  for (let i = 0; i < n; i++) {
    const foes = []
    for (let k = 0; k < opponents; k++) foes.push((i + 1 + k * stride) % n)
    rows.push(foes)
  }
  return rows
}

// One generation: evaluate every pairing, then step BOTH populations.
export function buildJobs({ offense, defense, situations, opponents, anchors }) {
  const n = offense.length
  const pairings = buildPairings(n, opponents)
  const jobs = []

  for (let i = 0; i < n; i++) {
    // ⚠️ THE JOB CARRIES ITS OWN GENOMES. A worker has its own module state and can see nothing the
    // parent set up, so a job that referenced populations by index would evaluate whatever happened
    // to be in that worker's memory. At ~96KB a genome and six per job this is ~70MB of structured
    // clone per generation, which is milliseconds — cheap beside the plays it buys.
    jobs.push({
      offIndex: i,
      offGenome: offense[i],
      foes: pairings[i].map(j => ({ index: j, genome: defense[j] })),
      // The defense at the SAME index plays its anchor series here, so every genome on both sides
      // gets its baseline against the hand-written AI.
      anchorDefIndex: i,
      anchorDefGenome: defense[i],
      anchors,
      situations: Array.from({ length: opponents + anchors + 1 },
        (_, k) => situations[(i * (opponents + anchors) + k) % situations.length]),
    })
  }
  return jobs
}

export function shapes() {
  return {
    offense: { inputs: DEEP_OFF_OBSERVATION_SIZE, outputs: DEEP_OFF_ACTION_SIZE },
    defense: { inputs: DEEP_OBSERVATION_SIZE, outputs: DEEP_ACTION_SIZE },
  }
}

// Scores one job in-process: an offense genome against its assigned defenses, plus the anchor
// series on both sides. Runs in a worker in a parallel run, and directly in a serial one.
export function runJob(job) {
  const offScores = []
  const defScores = []          // [{ index, score }]
  let attempted = 0, broken = 0

  // ⚠️ A BROKEN SERIES IS EXCLUDED, NOT SCORED ZERO.
  //
  // Scoring it zero looks neutral and is not. Series scores are signed, so for whichever side is
  // currently losing — a defense conceding drives scores negative — a zero is an IMPROVEMENT, and
  // breaking the harness becomes the cheapest way to raise a fitness. An earlier fitness function
  // had exactly this hole and made an unrunnable play strictly better than a play that conceded a
  // single yard.
  //
  // Dropping it from the mean makes breaking worth nothing at all, and a genome that breaks most of
  // its series ends up with no scores and takes the floor (see collectFitness).
  const take = (r, into) => {
    attempted++
    if (!r.ok) { broken++; return }
    into(r.score)
  }

  job.foes.forEach((foe, k) => {
    take(playPairing(job.offGenome, foe.genome, job.situations[k]), (score) => {
      offScores.push(score)
      defScores.push({ index: foe.index, score: -score })
    })
  })

  // Anchors against the heuristic — `null` on either side means the hand-written AI plays it.
  for (let a = 0; a < job.anchors; a++) {
    const situation = job.situations[job.foes.length + a]
    take(playPairing(job.offGenome, null, situation), (score) => offScores.push(score))
    take(playPairing(null, job.anchorDefGenome, situation), (score) => {
      defScores.push({ index: job.anchorDefIndex, score: -score })
    })
  }

  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null
  return {
    offIndex: job.offIndex,
    offScore: mean(offScores),
    defScores,
    attempted,
    broken,
  }
}

// Turns raw job results into the two fitness arrays.
export function collectFitness(results, n) {
  const off = new Array(n).fill(null).map(() => [])
  const def = new Array(n).fill(null).map(() => [])
  for (const r of results) {
    if (!r) continue
    if (r.offScore != null) off[r.offIndex].push(r.offScore)
    for (const d of r.defScores) def[d.index].push(d.score)
  }
  const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : -FITNESS_OFFSET
  return {
    offense: off.map(a => Math.max(0, mean(a) + FITNESS_OFFSET)),
    defense: def.map(a => Math.max(0, mean(a) + FITNESS_OFFSET)),
  }
}

export { FITNESS_OFFSET, createPopulation, buildSlate }
