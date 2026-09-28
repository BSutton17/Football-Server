// ── Does holding the ball longer pay? ([qb]) ───────────────────────────────
//
//   NODE_ENV=test node scripts/qbHoldValue.mjs [samplesPerPlay]
//
// "He sometimes throws the ball too quickly." Before changing when he lets it go, it is worth
// knowing whether letting it go later is better — because the three knobs that decide it have no
// headroom in them (trainQB.mjs found a gain, confirmQB.mjs showed it was noise at four times the
// sample, with the sign reversed).
//
// So this bins every dropback by how long he held it and reports what each bin was worth. If the
// quick throws are the bad ones there is something to fix; if they are the good ones, then he is
// throwing quickly because quickly is right, and the complaint is about something else.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'

const SAMPLES = Number(process.argv[2] ?? 12)
const PICK_COST = 22
const TICK = 0.05

const book = loadPlaybook()
const plays = Object.entries(book.plays ?? {}).filter(([, p]) => p.playType !== 'run').map(([id]) => id)
const shells = Object.keys(book.shells ?? {})
const SITUATIONS = [
  { down: 1, distance: 10, yardLine: 30 },
  { down: 2, distance: 7, yardLine: 45 },
  { down: 3, distance: 8, yardLine: 55 },
  { down: 2, distance: 12, yardLine: 25 },
]

// Held-time bins, in seconds.
const BINS = [
  { to: 1.5, label: '< 1.5s' },
  { to: 2.5, label: '1.5-2.5s' },
  { to: 3.5, label: '2.5-3.5s' },
  { to: Infinity, label: '3.5s +' },
]
const rows = BINS.map(b => ({ ...b, vals: [], sacks: 0, picks: 0 }))

let seed = 4242
for (const playId of plays) {
  for (let s = 0; s < SAMPLES; s++) {
    seed++
    const ctx = createTrainingGame({ seed })
    try {
      const off = ctx.state.possession
      ctx.brains[off].forceAuthoredPlay = playId
      ctx.brains[1 - off].forceAuthoredShell = shells[seed % shells.length]
      const r = runPlay(ctx, { ...SITUATIONS[seed % SITUATIONS.length], ballX: HASHES[seed % HASHES.length] })
      if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
      const held = (r.ticks ?? 0) * TICK
      const row = rows.find(b => held < b.to)
      if (!row) continue
      let v = r.yards
      if (r.outcome === 'sack') row.sacks++
      if (r.outcome === 'interception') { row.picks++; v -= PICK_COST }
      row.vals.push(v)
    } finally { destroyTrainingGame(ctx) }
  }
}

console.log(`\n── What a dropback was worth, by how long he held it (${plays.length} plays x ${SAMPLES}) ──\n`)
console.log('  held        n     net yds   +/-     sack   pick')
for (const r of rows) {
  const n = r.vals.length
  if (!n) { console.log(`  ${r.label.padEnd(11)} ${String(n).padStart(4)}       -`); continue }
  const mean = r.vals.reduce((a, b) => a + b, 0) / n
  const varr = r.vals.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, n - 1)
  const se = Math.sqrt(varr / n)
  console.log(`  ${r.label.padEnd(11)} ${String(n).padStart(4)}   ${mean.toFixed(2).padStart(7)}   ${se.toFixed(2).padStart(5)}   ${(100 * r.sacks / n).toFixed(0).padStart(3)}%   ${(100 * r.picks / n).toFixed(0).padStart(3)}%`)
}
console.log('\n⚠️ Read the standard errors before concluding anything. A bin that is better by less than')
console.log('   twice its own error is not better.')
