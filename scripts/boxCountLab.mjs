// ── Does an empty box actually cost anything? ([defense]) ──────────────────
//
//   NODE_ENV=test node scripts/boxCountLab.mjs [samplesPerCell]
//
// The solved table calls three-deep on a third of third-and-shorts, which is the defense the
// player complained about. Before deciding the SOLVER is wrong, check whether the ENGINE punishes
// it: if a run converts just as often against three deep as against a loaded box, the solver is
// correctly indifferent and the fault is in the physics, not the play call.
//
// Forces RUN plays on third and one against shells grouped by how many defenders they post deep,
// and reports the conversion rate -- which is what third and one is about, not the yardage.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'
import { deepCount, countJobs } from '../src/ai/playcall/shellShape.js'

const SAMPLES = Number(process.argv[2] ?? 60)
const book = loadPlaybook()

const runs = Object.entries(book.plays ?? {}).filter(([, p]) => p.playType === 'run').map(([id]) => id)
const shells = Object.entries(book.shells ?? {}).map(([id, s]) => ({ id, deep: deepCount(s), rush: countJobs(s).rush }))

// In the box = not posted deep. Eight in the box against three deep is the whole argument.
const GROUPS = [
  { name: 'loaded box  (0-1 deep, 5+ rush)', pick: s => s.deep <= 1 && s.rush >= 5 },
  { name: 'ordinary    (2 deep, 4 rush)',    pick: s => s.deep === 2 && s.rush === 4 },
  { name: 'light box   (3+ deep)',           pick: s => s.deep >= 3 },
]

const SIT = { down: 3, distance: 1, yardLine: 40 }

for (const g of GROUPS) {
  const pool = shells.filter(g.pick)
  if (!pool.length) { console.log(`${g.name}: no shells`); continue }
  let converted = 0, yards = 0, n = 0
  let seed = 77000
  for (let i = 0; i < SAMPLES; i++) {
    for (const shell of pool.slice(0, 12)) {
      seed++
      const playId = runs[seed % runs.length]
      const ctx = createTrainingGame({ seed })
      try {
        const off = ctx.state.possession
        ctx.brains[off].forceAuthoredPlay = playId
        ctx.brains[1 - off].forceAuthoredShell = shell.id
        const r = runPlay(ctx, { ...SIT, ballX: HASHES[seed % HASHES.length] })
        if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
        n++
        yards += r.yards ?? 0
        if ((r.yards ?? 0) >= SIT.distance) converted++
      } finally { destroyTrainingGame(ctx) }
    }
  }
  console.log(`${g.name.padEnd(34)} ${pool.length.toString().padStart(2)} shells | converts ${String(Math.round(100*converted/Math.max(1,n))).padStart(3)}%  avg ${(yards/Math.max(1,n)).toFixed(2)} yds  (${n})`)
}
