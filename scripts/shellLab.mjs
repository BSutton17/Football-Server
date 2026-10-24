// ── How good is each defensive call, held fixed? ([defense]) ─────────────────
//
//   NODE_ENV=test node scripts/shellLab.mjs <plays per shell> <shellId> [shellId …] [--hard|--easy]
//
// "Zone coverage and especially zone blitz is too weak and can really only be played on 3rd and
// long." "Blitzing up the middle does almost nothing."
//
// Forces ONE authored shell for a whole slate of downs (controller.forceAuthoredShell) against the
// computer's own offense and reports what the offense got: yards a play, success rate, completion
// rate, sacks, picks, and how long the plays lasted. Every shell sees the SAME seeds and the SAME
// situations, so the offense's call is identical down for down and the comparison is paired —
// ⚠️ comparing unpaired averages of this game reversed the sign of a real effect once already.
//
// Success is the standard one: 40% of the distance on 1st down, 60% on 2nd, all of it on 3rd.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'

const args = process.argv.slice(2)
const N = Number(args.find(a => /^\d+$/.test(a)) ?? 120)
const shells = args.filter(a => !/^\d+$/.test(a) && !a.startsWith('--'))
const difficulty = args.includes('--hard') ? 'hard' : args.includes('--easy') ? 'easy' : 'medium'
if (!shells.length) {
  console.error('usage: node scripts/shellLab.mjs <plays> <shellId> [shellId …]')
  process.exit(1)
}

// A spread of ordinary downs — not only third and long.
const SLATE = [
  { down: 1, distance: 10, yardLine: 25 },
  { down: 2, distance: 7, yardLine: 40 },
  { down: 3, distance: 3, yardLine: 50 },
  { down: 1, distance: 10, yardLine: 60 },
  { down: 2, distance: 4, yardLine: 35 },
  { down: 3, distance: 8, yardLine: 45 },
]
const successful = (s, yards) => yards >= s.distance * (s.down === 1 ? 0.4 : s.down === 2 ? 0.6 : 1)

const pad = (v, n) => String(v).padStart(n)
console.log(`${N} plays per shell, ${difficulty}, paired seeds\n`)
console.log('shell'.padEnd(22) + pad('yds/play', 9) + pad('success', 9) + pad('pass%', 7) + pad('comp%', 7) + pad('sack%', 7) + pad('int%', 6) + pad('ticks', 7))

for (const shellId of shells) {
  const t = { n: 0, yards: 0, success: 0, passes: 0, threw: 0, comp: 0, sacks: 0, ints: 0, ticks: 0 }
  for (let i = 0; i < N; i++) {
    const s = { ...SLATE[i % SLATE.length], ballX: HASHES[i % 3], possession: 0 }
    const ctx = createTrainingGame({ seed: 52000 + i, difficulty })
    try {
      ctx.brains[1].forceAuthoredShell = shellId
      // ANALYTICS=1 (with ANALYTICS_DIR) records every play's ticks for analysis. The recorder only
      // writes solo rooms, and a training room is not flagged as one.
      if (process.env.ANALYTICS === '1') ctx.state.solo ??= {}
      const r = runPlay(ctx, s)
      if (!r.ok) continue
      t.n++
      t.yards += r.yards
      t.ticks += r.ticks ?? 0
      if (successful(s, r.yards)) t.success++
      if (r.playType === 'pass' || r.playType === 'rpo') t.passes++
      if (r.threw) t.threw++
      if (r.completed) t.comp++
      if (r.sacked) t.sacks++
      if (r.outcome === 'interception') t.ints++
    } finally { destroyTrainingGame(ctx) }
  }
  const pct = (a, b) => b ? (100 * a / b).toFixed(0) : '-'
  console.log(shellId.padEnd(22) + pad((t.yards / t.n).toFixed(2), 9) + pad(pct(t.success, t.n), 9) +
    pad(pct(t.passes, t.n), 7) + pad(pct(t.comp, t.threw), 7) + pad(pct(t.sacks, t.passes), 7) +
    pad(pct(t.ints, t.threw), 6) + pad((t.ticks / t.n).toFixed(0), 7))
}
