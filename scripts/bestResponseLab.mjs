// ── Is the solved defense actually the best answer? ([defense]) ────────────
//
//   NODE_ENV=test node scripts/bestResponseLab.mjs [samples]
//
// The solved table plays three-or-more deep on a quarter of third-and-shorts, and forced runs
// convert 91% against that. Either the equilibrium is balancing something real, or the solve is
// leaving value on the field. This checks it the only way that settles it: let the OFFENSE call
// its own solved plays, and put three different defensive policies behind the same downs.
//
// The defense is measured on CONVERSION ALLOWED, which is what third down is about. Yards are
// reported beside it because a defense that stops the conversion by surrendering twelve yards on
// the completions has not helped.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'
import { deepCount, countJobs } from '../src/ai/playcall/shellShape.js'

const SAMPLES = Number(process.argv[2] ?? 300)
const book = loadPlaybook()
const shells = Object.entries(book.shells ?? {}).map(([id, s]) => ({ id, deep: deepCount(s), rush: countJobs(s).rush }))

const loaded = shells.filter(s => s.deep <= 1 && s.rush >= 5).map(s => s.id)
const light = shells.filter(s => s.deep >= 3).map(s => s.id)

const POLICIES = [
  { name: 'the solved table (as shipped)', shell: null },
  { name: 'always a loaded box', shell: (i) => loaded[i % loaded.length] },
  { name: 'always three-plus deep', shell: (i) => light[i % light.length] },
]

const SIT = { down: 3, distance: 1, yardLine: 40 }

for (const p of POLICIES) {
  let converted = 0, yards = 0, n = 0, runs = 0
  for (let i = 0; i < SAMPLES; i++) {
    const seed = 88000 + i
    const ctx = createTrainingGame({ seed })
    try {
      const off = ctx.state.possession
      // ⚠️ THE OFFENSE IS NEVER FORCED. It calls out of its own solved distribution, so this
      // measures the defense against the offense it will actually meet rather than against a
      // script chosen to make a point.
      if (p.shell) ctx.brains[1 - off].forceAuthoredShell = p.shell(i)
      const r = runPlay(ctx, { ...SIT, ballX: HASHES[i % HASHES.length] })
      if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
      n++
      yards += r.yards ?? 0
      if (ctx.state.playDesign?.playType === 'run') runs++
      if ((r.yards ?? 0) >= SIT.distance) converted++
    } finally { destroyTrainingGame(ctx) }
  }
  console.log(`${p.name.padEnd(32)} converts ${String(Math.round(100*converted/Math.max(1,n))).padStart(3)}%   avg ${(yards/Math.max(1,n)).toFixed(2)} yds   (offense ran ${Math.round(100*runs/Math.max(1,n))}%, ${n} downs)`)
}
