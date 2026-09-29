// ── What does the defense actually call? ([defense]) ────────────────────────
//
//   NODE_ENV=test node scripts/defenseCallLab.mjs [samples]
//
// "It called cover 4 on third and short. That leaves no one in the box."
//
// This plays real downs in scripted situations and reports the shells the computer's defense
// actually chose, bucketed by how many defenders it puts deep and how many it sends. A defense that
// answers third and one the same way it answers third and eighteen shows up here immediately.
//
// Counted from the CALL, not from the outcome: what it chose is the complaint, and outcomes are
// noisy enough to hide it.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'

const SAMPLES = Number(process.argv[2] ?? 120)
const book = loadPlaybook()

// How many defenders a shell drops deep, and how many it rushes.
function shape(shellId) {
  const s = book.shells?.[shellId]
  let deep = 0, rush = 0
  for (const a of Object.values(s?.assignments ?? {})) {
    if (a?.job === 'rush') rush++
    else if (a?.job === 'zone' && (a.zone === 'deep' || (a.center?.depth ?? 0) >= 12)) deep++
  }
  return { deep, rush }
}

const SITUATIONS = [
  { name: '3rd & 1  at own 40', down: 3, distance: 1, yardLine: 40 },
  { name: '3rd & 2  at midfield', down: 3, distance: 2, yardLine: 50 },
  { name: '3rd & 15 at own 25', down: 3, distance: 15, yardLine: 25 },
  { name: '1st & 10 at own 30', down: 1, distance: 10, yardLine: 30 },
]

for (const sit of SITUATIONS) {
  const counts = new Map()
  let deepHeavy = 0, blitzed = 0, n = 0
  for (let i = 0; i < SAMPLES; i++) {
    const ctx = createTrainingGame({ seed: 41000 + i })
    try {
      const off = ctx.state.possession
      // The DEFENSE is the one being measured; let the offense call whatever it likes.
      const r = runPlay(ctx, { down: sit.down, distance: sit.distance, yardLine: sit.yardLine, ballX: HASHES[i % HASHES.length] })
      if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
      const call = ctx.brains[1 - off]?.authoredCall
      const id = call?.shell?.id
      if (!id) continue
      n++
      counts.set(id, (counts.get(id) ?? 0) + 1)
      const { deep, rush } = shape(id)
      if (deep >= 3) deepHeavy++
      if (rush >= 5) blitzed++
    } finally { destroyTrainingGame(ctx) }
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4)
  console.log(`\n${sit.name}   (${n} calls)`)
  console.log(`   3+ deep: ${String(Math.round(100 * deepHeavy / Math.max(1, n))).padStart(3)}%    5+ rushing: ${String(Math.round(100 * blitzed / Math.max(1, n))).padStart(3)}%`)
  top.forEach(([id, c]) => {
    const { deep, rush } = shape(id)
    console.log(`     ${String(Math.round(100 * c / Math.max(1, n))).padStart(3)}%  ${id.padEnd(26)} (${deep} deep, ${rush} rush)`)
  })
}
