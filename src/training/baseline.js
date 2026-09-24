// ── The baseline ([training]) ────────────────────────────────────────────────
//
// Runs the heuristic AI against itself across a slate and records what happens. Two jobs, and the
// second one is the reason to build it first:
//
//   1. EXPECTED YARDS. A fitness score of "4.2 yards allowed" means nothing until you know what
//      par is for that situation. This produces par. Every later number is read against it.
//
//   2. A SOAK TEST. Thousands of unattended plays check the integrity rules on every snap — a line
//      off the ball, a twelfth man, a defender with no assignment, a play that never ends. These
//      are precisely the bugs a person cannot find by playing, and the worst one this AI has had
//      (a formation pinned to the middle of the field while the ball sat on a hash) would have
//      been caught on the first play of the first run.
//
// Run it with: node src/training/runBaseline.mjs [plays-per-situation]

import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { buildSlate } from './slate.js'
import { TRAINING_DIFFICULTY } from './game.js'

export const BASELINE_VERSION = 'v1'

// Plays one situation `repeats` times on different seeds, so a single lucky sack does not become
// the expected value for that spot.
// `difficulty` defaults to the training tier, NOT to easy — par has to be measured against the same
// opponent the genomes will face, or every genome is scored against an exam nobody sat.
export function measureSituation(situation, { repeats = 5, mode = 'automatic', difficulty = TRAINING_DIFFICULTY } = {}) {
  const results = []
  const problems = []

  for (let r = 0; r < repeats; r++) {
    const seed = (situation.seed + r * 0x9e37) >>> 0
    const ctx = createTrainingGame({ seed, mode, difficulty })
    try {
      const play = runPlay(ctx, { ...situation, seed })
      results.push(play)
      for (const p of play.problems) problems.push({ situation: situation.id, seed, problem: p })
    } finally {
      destroyTrainingGame(ctx)
    }
  }

  const yards = results.map(r => r.yards)
  return {
    id: situation.id,
    down: situation.down,
    distance: situation.distance,
    yardLine: situation.yardLine,
    ballX: situation.ballX,
    plays: results.length,
    meanYards: mean(yards),
    medianYards: median(yards),
    turnoverRate: rate(results, r => r.turnover),
    touchdownRate: rate(results, r => r.outcome === 'touchdown'),
    sackRate: rate(results, r => r.sacked),
    // Of the PASS PLAYS only — a completion rate diluted by run calls says nothing about passing.
    passPlays: results.filter(r => r.playType === 'pass' || r.playType === 'rpo').length,
    throwRate: rate(results, r => r.threw),
    completionRate: passRate(results, r => r.completed),
    runRate: rate(results, r => r.playType === 'run'),
    meanTicks: mean(results.map(r => r.ticks)),
    problems,
  }
}

// The whole run.
export function runBaseline({ size = 40, repeats = 5, generation = 0, seed = 12345, difficulty = TRAINING_DIFFICULTY, onProgress = null } = {}) {
  const slate = buildSlate({ size, generation, seed })
  const started = Date.now()
  const rows = []
  const problems = []

  for (const [i, situation] of slate.situations.entries()) {
    const row = measureSituation(situation, { repeats, difficulty })
    rows.push(row)
    problems.push(...row.problems)
    onProgress?.(i + 1, slate.situations.length, row)
  }

  const totalPlays = rows.reduce((a, r) => a + r.plays, 0)
  const elapsedMs = Date.now() - started

  return {
    version: BASELINE_VERSION,
    slateHash: slate.hash,
    generation,
    seed,
    totalPlays,
    elapsedMs,
    playsPerSecond: totalPlays / (elapsedMs / 1000),
    // PAR: expected yards per situation, which is what a fitness score is read against.
    expected: Object.fromEntries(rows.map(r => [r.id, r.meanYards])),
    rows,
    problems,
    // The headline: is the game we are about to train against actually sound?
    clean: problems.length === 0,
  }
}

// ── Reading the result ────────────────────────────────────────────────────────

// Groups problems by kind so a thousand instances of one bug read as one bug.
export function summariseProblems(problems) {
  const byKind = new Map()
  for (const p of problems) {
    // Strip the numbers so "centred on 26.7, ball is on 40.0" and "…on 13.3" are one entry.
    const kind = p.problem.replace(/-?\d+(\.\d+)?/g, 'N')
    if (!byKind.has(kind)) byKind.set(kind, { kind, count: 0, example: p })
    byKind.get(kind).count++
  }
  return [...byKind.values()].sort((a, b) => b.count - a.count)
}

function mean(xs) { return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0 }
function median(xs) {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2
}
function rate(xs, pred) { return xs.length ? xs.filter(pred).length / xs.length : 0 }
// Over pass plays only.
function passRate(xs, pred) {
  const passes = xs.filter(r => r.playType === 'pass' || r.playType === 'rpo')
  return passes.length ? passes.filter(pred).length / passes.length : 0
}
