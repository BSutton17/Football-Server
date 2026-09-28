// ── Training the quarterback's release ([qb]) ───────────────────────────────
//
//   NODE_ENV=test node scripts/trainQB.mjs [samplesPerPlay]
//
// "He sometimes throws the ball too quickly and other times makes a poor decision." Three numbers
// decide that (difficulty.js): the openness he WANTS (throwThreshold), the openness he will settle
// for (throwFloor), and how long he waits between them (patience). They were hand-picked. This
// searches them.
//
// ⚠️ THE SPLIT IS THE WHOLE POINT. Tuning three knobs against a fixed set of plays and coverages
// will fit those plays and coverages — the number goes up and the quarterback gets worse at
// everything else, which is the one failure mode that looks exactly like success. So the passing
// plays AND the shells are each cut in half: the search only ever sees the TRAINING half, and the
// value reported at the end is measured on the half it never saw. A gain that does not survive the
// holdout is not a gain, and this script says so in as many words.
//
// The metric is net yards per dropback, which is the honest one: it already contains the sacks he
// took holding the ball and it charges him for the interceptions he forced.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'

const SAMPLES = Number(process.argv[2] ?? 2)
const book = loadPlaybook()

const passPlays = Object.entries(book.plays ?? {})
  .filter(([, p]) => p.playType !== 'run')
  .map(([id]) => id)
const shells = Object.keys(book.shells ?? {})

// A deterministic split, so a re-run trains and tests on the same halves.
const half = (list, keep) => list.filter((_, i) => (i % 2 === 0) === keep)
const SPLIT = {
  train: { plays: half(passPlays, true), shells: half(shells, true) },
  test: { plays: half(passPlays, false), shells: half(shells, false) },
}

// What an interception costs. A possession measures ~17-26 yards in this engine, so giving one away
// is far more than a bad play — the metric has to say so, or the search learns to force throws.
const PICK_COST = 22

const SITUATIONS = [
  { down: 1, distance: 10, yardLine: 30 },
  { down: 2, distance: 7, yardLine: 45 },
  { down: 3, distance: 8, yardLine: 55 },
  { down: 2, distance: 12, yardLine: 25 },
]

function evaluate(split, samples, seed0) {
  let yards = 0, plays = 0, sacks = 0, picks = 0, quick = 0
  let seed = seed0
  for (const playId of split.plays) {
    for (let s = 0; s < samples; s++) {
      seed++
      const shellId = split.shells[seed % split.shells.length]
      const sit = SITUATIONS[seed % SITUATIONS.length]
      const ctx = createTrainingGame({ seed })
      try {
        const off = ctx.state.possession
        ctx.brains[off].forceAuthoredPlay = playId
        ctx.brains[1 - off].forceAuthoredShell = shellId
        const r = runPlay(ctx, { ...sit, ballX: HASHES[seed % HASHES.length] })
        if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
        plays++
        yards += r.yards
        if (r.outcome === 'sack') sacks++
        if (r.outcome === 'interception') { picks++; yards -= PICK_COST }
        if (r.ticks <= 30) quick++          // let go inside 1.5s — reported, not optimised
      } finally { destroyTrainingGame(ctx) }
    }
  }
  return {
    net: plays ? yards / plays : 0,
    plays,
    sackRate: plays ? sacks / plays : 0,
    pickRate: plays ? picks / plays : 0,
    quickRate: plays ? quick / plays : 0,
  }
}

function withKnobs(k, fn) {
  const prev = [process.env.QB_THRESHOLD, process.env.QB_FLOOR, process.env.QB_PATIENCE]
  process.env.QB_THRESHOLD = String(k.threshold)
  process.env.QB_FLOOR = String(k.floor)
  process.env.QB_PATIENCE = String(k.patience)
  try {
    return fn()
  } finally {
    const [a, b, c] = prev
    if (a === undefined) delete process.env.QB_THRESHOLD; else process.env.QB_THRESHOLD = a
    if (b === undefined) delete process.env.QB_FLOOR; else process.env.QB_FLOOR = b
    if (c === undefined) delete process.env.QB_PATIENCE; else process.env.QB_PATIENCE = c
  }
}

const GRID = {
  threshold: [0.50, 0.56, 0.62, 0.68, 0.74],
  floor: [0.20, 0.26, 0.32, 0.38, 0.44],
  patience: [1.8, 2.2, 2.6, 3.0, 3.6],
}

const BASELINE = { threshold: 0.62, floor: 0.32, patience: 2.6 }

console.log(`passing plays ${passPlays.length} (train ${SPLIT.train.plays.length} / test ${SPLIT.test.plays.length})`)
console.log(`coverages     ${shells.length} (train ${SPLIT.train.shells.length} / test ${SPLIT.test.shells.length})`)
console.log(`samples/play  ${SAMPLES}  ->  ~${SPLIT.train.plays.length * SAMPLES} dropbacks per evaluation\n`)

let best = { ...BASELINE }
const TRAIN_SEED = 2000
let bestScore = withKnobs(best, () => evaluate(SPLIT.train, SAMPLES, TRAIN_SEED)).net
console.log(`start  thr ${best.threshold} floor ${best.floor} pat ${best.patience}  ->  ${bestScore.toFixed(3)} net yds/dropback`)

// Coordinate descent, twice round. With three knobs on a coarse grid this lands where an exhaustive
// search would, for a fraction of the simulation.
for (let round = 0; round < 2; round++) {
  for (const knob of ['threshold', 'floor', 'patience']) {
    for (const v of GRID[knob]) {
      if (v === best[knob]) continue
      const trial = { ...best, [knob]: v }
      if (trial.floor > trial.threshold) continue    // settling for more than you want is nonsense
      // ⚠️ THE SAME SEEDS FOR EVERY TRIAL. Different seeds mean the search is comparing knobs
      // against different football, and it will happily pick the luckiest one.
      const r = withKnobs(trial, () => evaluate(SPLIT.train, SAMPLES, TRAIN_SEED))
      const mark = r.net > bestScore ? ' *' : ''
      console.log(`  ${knob.padEnd(9)} ${String(v).padEnd(5)} -> ${r.net.toFixed(3)}  (sack ${(100 * r.sackRate).toFixed(0)}% pick ${(100 * r.pickRate).toFixed(0)}%)${mark}`)
      if (r.net > bestScore) { bestScore = r.net; best = trial }
    }
  }
}

console.log(`\nbest on TRAIN: thr ${best.threshold} floor ${best.floor} pat ${best.patience}  ${bestScore.toFixed(3)}`)

// ⚠️ And now the only number that counts.
const heldBase = withKnobs(BASELINE, () => evaluate(SPLIT.test, SAMPLES, 5000))
const heldBest = withKnobs(best, () => evaluate(SPLIT.test, SAMPLES, 5000))
const delta = heldBest.net - heldBase.net
console.log('\n── HOLDOUT: plays and coverages the search never saw ──')
console.log(`  before  ${heldBase.net.toFixed(3)} net  (sack ${(100 * heldBase.sackRate).toFixed(0)}% pick ${(100 * heldBase.pickRate).toFixed(0)}% quick ${(100 * heldBase.quickRate).toFixed(0)}%)`)
console.log(`  after   ${heldBest.net.toFixed(3)} net  (sack ${(100 * heldBest.sackRate).toFixed(0)}% pick ${(100 * heldBest.pickRate).toFixed(0)}% quick ${(100 * heldBest.quickRate).toFixed(0)}%)`)
console.log(`  delta   ${(delta >= 0 ? '+' : '') + delta.toFixed(3)} yds/dropback over ${heldBest.plays} dropbacks`)
console.log(delta > 0
  ? `\nKEEP: set throwThreshold ${best.threshold}, throwFloor ${best.floor}, patience ${best.patience} in difficulty.js`
  : '\nDISCARD: the gain did not survive the holdout. Leave difficulty.js alone.')
