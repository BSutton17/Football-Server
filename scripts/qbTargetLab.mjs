// ── Does the quarterback pick the right man? ([qb]) ─────────────────────────
//
//   NODE_ENV=test node scripts/qbTargetLab.mjs [samplesPerPlay] [weights...]
//
// `trainQB.mjs` searched WHEN he throws and found nothing: the three release knobs have no headroom
// that survives a holdout. This searches WHO he throws to, which is a different mechanism and a
// different complaint ("makes a poor decision").
//
// The lever is QB_DEPTH_WEIGHT (reads.js): the ranking is openness alone, so a wide-open man at
// three yards outranks a reasonably open one at eighteen on every down. The weight prefers depth in
// the ORDER without touching the bar he throws against — see depthPreference for why that
// separation matters.
//
// ⚠️ PAIRED, ON THE SAME SEEDS. Every weight sees identical football: the same plays, the same
// coverages, the same hashes, in the same order. So the comparison is play-by-play rather than
// mean-against-mean, and the standard error is of the DIFFERENCE, which is far tighter than the
// spread of either arm. Unpaired, the noise here swamps anything worth finding.
//
// ⚠️ AND THE SPLIT IS STILL THE POINT. Plays and shells are each halved exactly as trainQB halves
// them. The sweep sees the training half; the winner is re-measured on the half it never saw.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'

const SAMPLES = Number(process.argv[2] ?? 2)
const WEIGHTS = process.argv.slice(3).map(Number).filter(n => Number.isFinite(n))
const SWEEP = WEIGHTS.length ? WEIGHTS : [0, 0.15, 0.3, 0.5, 0.8]

const book = loadPlaybook()
const passPlays = Object.entries(book.plays ?? {}).filter(([, p]) => p.playType !== 'run').map(([id]) => id)
const shells = Object.keys(book.shells ?? {})
const half = (list, keep) => list.filter((_, i) => (i % 2 === 0) === keep)
const SPLIT = {
  train: { plays: half(passPlays, true), shells: half(shells, true) },
  test: { plays: half(passPlays, false), shells: half(shells, false) },
}

const PICK_COST = 22                 // the same charge trainQB uses, for comparable numbers
const SITUATIONS = [
  { down: 1, distance: 10, yardLine: 30 },
  { down: 2, distance: 7, yardLine: 45 },
  { down: 3, distance: 8, yardLine: 55 },
  { down: 2, distance: 12, yardLine: 25 },
]

// Returns the per-play values in a fixed order, so two runs line up index by index.
function evaluate(split, samples, seed0) {
  const vals = []
  let sacks = 0, picks = 0, deep = 0
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
        if (r.outcome === 'no_snap' || r.outcome === 'hung') { vals.push(null); continue }
        let v = r.yards
        if (r.outcome === 'sack') sacks++
        if (r.outcome === 'interception') { picks++; v -= PICK_COST }
        if (r.yards >= 16) deep++
        vals.push(v)
      } finally { destroyTrainingGame(ctx) }
    }
  }
  const live = vals.filter(v => v != null)
  return {
    vals,
    n: live.length,
    net: live.reduce((a, b) => a + b, 0) / Math.max(1, live.length),
    sackRate: sacks / Math.max(1, live.length),
    pickRate: picks / Math.max(1, live.length),
    deepRate: deep / Math.max(1, live.length),
  }
}

function withWeight(w, fn) {
  const prev = process.env.QB_DEPTH_WEIGHT
  process.env.QB_DEPTH_WEIGHT = String(w)
  try { return fn() } finally {
    if (prev === undefined) delete process.env.QB_DEPTH_WEIGHT
    else process.env.QB_DEPTH_WEIGHT = prev
  }
}

// Paired difference of b against a, with the standard error of that difference.
function paired(a, b) {
  const d = []
  for (let i = 0; i < a.vals.length; i++) {
    if (a.vals[i] == null || b.vals[i] == null) continue
    d.push(b.vals[i] - a.vals[i])
  }
  const n = d.length
  const mean = d.reduce((x, y) => x + y, 0) / Math.max(1, n)
  const varr = d.reduce((acc, x) => acc + (x - mean) ** 2, 0) / Math.max(1, n - 1)
  const changed = d.filter(x => x !== 0).length
  return { mean, se: Math.sqrt(varr / Math.max(1, n)), n, changed }
}

console.log(`passing plays ${passPlays.length} (train ${SPLIT.train.plays.length} / test ${SPLIT.test.plays.length})`)
console.log(`coverages     ${shells.length} (train ${SPLIT.train.shells.length} / test ${SPLIT.test.shells.length})`)
console.log(`samples/play  ${SAMPLES}\n`)

const TRAIN_SEED = 7000
const base = withWeight(0, () => evaluate(SPLIT.train, SAMPLES, TRAIN_SEED))
console.log(`── TRAIN (${base.n} dropbacks) ──`)
console.log(`  weight 0.00 (today)  ${base.net.toFixed(3)} net  sack ${(100*base.sackRate).toFixed(0)}%  pick ${(100*base.pickRate).toFixed(0)}%  16+yd ${(100*base.deepRate).toFixed(0)}%`)

let best = { w: 0, mean: 0 }
for (const w of SWEEP) {
  if (w === 0) continue
  const r = withWeight(w, () => evaluate(SPLIT.train, SAMPLES, TRAIN_SEED))
  const p = paired(base, r)
  // ⚠️ IF `changed` IS ~0 THE LEVER DOES NOTHING and any verdict below is about nothing at all.
  console.log(`  weight ${w.toFixed(2)}          ${r.net.toFixed(3)} net  sack ${(100*r.sackRate).toFixed(0)}%  pick ${(100*r.pickRate).toFixed(0)}%  16+yd ${(100*r.deepRate).toFixed(0)}%   diff ${p.mean >= 0 ? '+' : ''}${p.mean.toFixed(3)} ± ${p.se.toFixed(3)}  (changed ${(100*p.changed/Math.max(1,p.n)).toFixed(0)}% of plays)`)
  if (p.mean > best.mean) best = { w, mean: p.mean }
}

if (!best.w) {
  console.log('\nNothing beat weight 0 on the training half. No holdout run: there is nothing to confirm.')
  process.exit(0)
}

console.log(`\n── HOLDOUT: weight ${best.w} vs 0, on the half the sweep never saw ──`)
const HOLD_SEED = 9100
const h0 = withWeight(0, () => evaluate(SPLIT.test, SAMPLES * 2, HOLD_SEED))
const h1 = withWeight(best.w, () => evaluate(SPLIT.test, SAMPLES * 2, HOLD_SEED))
const hp = paired(h0, h1)
console.log(`  weight 0.00  ${h0.net.toFixed(3)} net  16+yd ${(100*h0.deepRate).toFixed(0)}%`)
console.log(`  weight ${best.w.toFixed(2)}  ${h1.net.toFixed(3)} net  16+yd ${(100*h1.deepRate).toFixed(0)}%`)
console.log(`  difference   ${hp.mean >= 0 ? '+' : ''}${hp.mean.toFixed(3)} ± ${hp.se.toFixed(3)} yds/dropback over ${hp.n} dropbacks (changed ${(100*hp.changed/Math.max(1,hp.n)).toFixed(0)}%)`)
console.log(hp.mean > 2 * hp.se
  ? '\n  VERDICT: holds up on the holdout.'
  : '\n  VERDICT: does NOT clear twice its own standard error. Treat as noise; leave the weight at 0.')
