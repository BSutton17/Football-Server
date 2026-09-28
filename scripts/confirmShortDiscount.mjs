// ── Is the early-down short-throw discount actually better? ([qb]) ────────
//
//   NODE_ENV=test node scripts/confirmShortDiscount.mjs <samplesPerPlay> <earlyFloor>
//
// ⚠️ THE SEARCH'S OWN HOLDOUT NUMBER IS NOT ENOUGH. `trainQB.mjs` reports a delta over a few hundred
// dropbacks, and a few hundred dropbacks of football has a standard error bigger than any sensible
// tuning gain — so a result that "survived the holdout" can still be a coin landing the same way
// twice. This runs the two configurations head to head on the HOLDOUT plays and coverages only,
// over enough dropbacks for the difference to mean something, and reports the spread so the answer
// can be "no".
//
// Same seeds for both sides: the two quarterbacks face identical football, so the difference is the
// only thing that differs.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'

const SAMPLES = Number(process.argv[2] ?? 20)
// 1.0 disables the early-down discount entirely, which is the behaviour before the change.
const TRIAL = { earlyFloor: Number(process.argv[3] ?? 0.70) }
const BASELINE = { earlyFloor: 1.0 }
const PICK_COST = 22

const book = loadPlaybook()
const passPlays = Object.entries(book.plays ?? {}).filter(([, p]) => p.playType !== 'run').map(([id]) => id)
const shells = Object.keys(book.shells ?? {})
const half = (list, keep) => list.filter((_, i) => (i % 2 === 0) === keep)
// The HOLDOUT half only — the same split trainQB.mjs uses.
const PLAYS = half(passPlays, false)
const SHELLS = half(shells, false)

const SITUATIONS = [
  { down: 1, distance: 10, yardLine: 30 },
  { down: 2, distance: 7, yardLine: 45 },
  { down: 3, distance: 8, yardLine: 55 },
  { down: 2, distance: 12, yardLine: 25 },
]

function withKnobs(k, fn) {
  process.env.QB_EARLY_FLOOR = String(k.earlyFloor)
  try { return fn() } finally { delete process.env.QB_EARLY_FLOOR }
}

// Every play's yardage, kept individually so the spread can be reported rather than just the mean.
function run(samples, seed0) {
  const values = []
  let sacks = 0, picks = 0, quick = 0
  let seed = seed0
  for (const playId of PLAYS) {
    for (let s = 0; s < samples; s++) {
      seed++
      const ctx = createTrainingGame({ seed })
      try {
        const off = ctx.state.possession
        ctx.brains[off].forceAuthoredPlay = playId
        ctx.brains[1 - off].forceAuthoredShell = SHELLS[seed % SHELLS.length]
        const r = runPlay(ctx, { ...SITUATIONS[seed % SITUATIONS.length], ballX: HASHES[seed % HASHES.length] })
        if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
        let v = r.yards
        if (r.outcome === 'sack') sacks++
        if (r.outcome === 'interception') { picks++; v -= PICK_COST }
        if (r.ticks <= 30) quick++
        values.push(v)
      } finally { destroyTrainingGame(ctx) }
    }
  }
  const n = values.length
  const mean = values.reduce((a, b) => a + b, 0) / n
  const variance = values.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)
  return { n, mean, se: Math.sqrt(variance / n), sacks: sacks / n, picks: picks / n, quick: quick / n }
}

console.log(`holdout: ${PLAYS.length} plays x ${SHELLS.length} coverages, ${SAMPLES} samples each\n`)
const a = withKnobs(BASELINE, () => run(SAMPLES, 90000))
const b = withKnobs(TRIAL, () => run(SAMPLES, 90000))
const delta = b.mean - a.mean
// Two independent means; the difference's standard error is the root of the summed squares.
const seDelta = Math.sqrt(a.se ** 2 + b.se ** 2)

const line = (name, r) =>
  `  ${name.padEnd(9)} ${r.mean.toFixed(3)} +/- ${r.se.toFixed(3)}  over ${r.n}  (sack ${(100 * r.sacks).toFixed(0)}% pick ${(100 * r.picks).toFixed(0)}% quick ${(100 * r.quick).toFixed(0)}%)`
console.log(line('off', a))
console.log(line(`floor ${TRIAL.earlyFloor}`, b))
console.log(`\n  delta ${(delta >= 0 ? '+' : '') + delta.toFixed(3)} +/- ${seDelta.toFixed(3)} yds/dropback`)
console.log(Math.abs(delta) > 2 * seDelta
  ? (delta > 0 ? '\nREAL: the gain is outside twice the standard error. Adopt it.' : '\nREAL, AND WORSE. Do not adopt.')
  : '\nNOISE: the difference is inside twice the standard error. Leave the numbers alone.')
