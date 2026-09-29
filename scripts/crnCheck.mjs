// ── Common random numbers: does pairing shrink the noise? ([solve]) ────────
//
//   NODE_ENV=test node scripts/crnCheck.mjs [reps] [samples]
//
// The solver seeded each cell with `pi*7919 + si*104729 + s*31`, so every SHELL saw different
// football. Regret matching compares shells against each other, and that comparison was carrying
// the full variance of two independent samples instead of a paired one.
//
// This estimates the same difference -- one run play against a loaded box vs against three deep on
// third and one -- many times over, and reports how much the ESTIMATE itself moves. Lower is
// better: it is the noise the solve is fitting.

import { loadPlaybook } from '../src/playbook/store.js'
import { deepCount, countJobs } from '../src/ai/playcall/shellShape.js'
import { createTrainingGame, destroyTrainingGame } from '../src/training/game.js'
import { playDown } from '../src/training/game.js'
import { playValue } from '../src/ai/playcall/solve.js'

const REPS = Number(process.argv[2] ?? 24)
const SAMPLES = Number(process.argv[3] ?? 8)
const book = loadPlaybook()
const POSSESSION = 38
const SIT = { down: 3, distance: 1, yardLine: 40 }

const runPlayId = Object.entries(book.plays).find(([, p]) => p.playType === 'run')[0]
const shellA = Object.entries(book.shells).find(([, s]) => deepCount(s) <= 1 && countJobs(s).rush >= 5)[0]
const shellB = Object.entries(book.shells).find(([, s]) => deepCount(s) >= 3)[0]

function sample(playId, shellId, seed) {
  const ctx = createTrainingGame({ seed })
  try {
    const st = ctx.state
    st.down = SIT.down; st.distance = SIT.distance; st.yardLine = SIT.yardLine
    const off = st.possession
    ctx.brains[off].forceAuthoredPlay = playId
    ctx.brains[1 - off].forceAuthoredShell = shellId
    const r = playDown(ctx, {})
    if (!r.ok) return null
    return playValue({
      yards: r.yards ?? 0, turnover: !!r.turnover, touchdown: r.outcome === 'touchdown',
      firstDown: (r.yards ?? 0) >= SIT.distance, down: SIT.down,
    }, { possessionValue: POSSESSION })
  } catch { return null } finally { destroyTrainingGame(ctx) }
}

function meanOf(playId, shellId, seeds) {
  let sum = 0, n = 0
  for (const sd of seeds) { const v = sample(playId, shellId, sd); if (v != null) { sum += v; n++ } }
  return n ? sum / n : 0
}

const sd = (xs) => {
  const m = xs.reduce((a, b) => a + b, 0) / xs.length
  return Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
}

const unpaired = [], paired = []
for (let rep = 0; rep < REPS; rep++) {
  const base = 500000 + rep * 9973
  // OLD: the shell index shifts the seed, so the two shells see different games.
  const aSeeds = Array.from({ length: SAMPLES }, (_, s) => (base + 0 * 104729 + s * 31) >>> 0)
  const bSeeds = Array.from({ length: SAMPLES }, (_, s) => (base + 1 * 104729 + s * 31) >>> 0)
  unpaired.push(meanOf(runPlayId, shellA, aSeeds) - meanOf(runPlayId, shellB, bSeeds))
  // NEW: identical seeds, so the only difference between the two arms is the shell.
  const shared = Array.from({ length: SAMPLES }, (_, s) => (base + s * 31) >>> 0)
  paired.push(meanOf(runPlayId, shellA, shared) - meanOf(runPlayId, shellB, shared))
}

console.log(`play ${runPlayId}   loaded=${shellA}   deep=${shellB}   ${REPS} reps x ${SAMPLES} samples`)
console.log(`  unpaired (today):        mean diff ${(unpaired.reduce((a,b)=>a+b,0)/REPS).toFixed(2)}  sd of the estimate ${sd(unpaired).toFixed(2)}`)
console.log(`  paired (common seeds):   mean diff ${(paired.reduce((a,b)=>a+b,0)/REPS).toFixed(2)}  sd of the estimate ${sd(paired).toFixed(2)}`)
console.log(`  noise reduction: ${(sd(unpaired) / Math.max(1e-9, sd(paired))).toFixed(2)}x`)
