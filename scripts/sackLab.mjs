// ── Why is the quarterback being sacked by four? ([protection]) ────────────
//
//   NODE_ENV=test node scripts/sackLab.mjs [samples]
//
// "The quarterback is constantly getting sacked and I'm only rushing 4 ... it might be because
// the qb won't throw."
//
// Those are two different bugs wearing the same coat, and a sack count cannot tell them apart:
//
//   PROTECTION — five linemen lose to four rushers, somebody comes free EARLY, and he is down
//                before the play has had time to develop.
//   NO THROW   — protection holds, nobody ever comes open, he holds it, and the sack is what
//                happens at the end of a play he was never going to be allowed to end.
//
// WHEN the sack lands separates them, so that is what this reports: the sack rate by rusher count,
// and how long he had the ball on the sacks against how long he had it on the throws. A sack at a
// second and a bit is a protection failure. A sack at three seconds is a decision.

import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'
import { loadPlaybook } from '../src/playbook/store.js'
import { countJobs, classifyShell } from '../src/ai/playcall/shellShape.js'
import { skillFor } from '../src/ai/difficulty.js'

const SAMPLES = Number(process.argv[2] ?? 10)
// ⚠️ DIFFICULTY IS THE WHOLE STORY HERE, and the training harness runs HARD by default — so a
// lab that does not set it measures the one tier the player is least likely to be on. Easy asks for
// 0.74 openness and waits 4.2s; hard asks 0.62 and waits 2.6s.
const DIFFICULTY = process.argv[3] ?? 'hard'
const book = loadPlaybook()
const passPlays = Object.entries(book.plays ?? {}).filter(([, p]) => p.playType !== 'run').map(([id]) => id)

// ⚠️ FOUR RUSHERS IS NOT ONE DEFENSE. Sixty-six shells rush four, and they range from a soft
// zone to press man across the board. Averaging them hides exactly the case being complained about:
// a four-man rush with everybody else locked on a receiver.
const byRush = new Map()
for (const [id, s] of Object.entries(book.shells ?? {})) {
  const r = countJobs(s).rush
  const key = r === 4 ? `4 ${classifyShell(s)}` : String(r)
  if (!byRush.has(key)) byRush.set(key, [])
  byRush.get(key).push(id)
}

const SIT = process.argv[4] === 'long' ? { down: 3, distance: 12, yardLine: 30 } : { down: 1, distance: 10, yardLine: 30 }
const secs = (t) => (t / 20).toFixed(2)

console.log(`sacks and hold times, ${passPlays.length} pass plays, 1st & 10\n`)

for (const rush of [...byRush.keys()].sort()) {
  const pool = byRush.get(rush)
  let n = 0, yards = 0
  let sacks = 0, sackTicks = 0
  let others = 0, otherTicks = 0
  let seed = 61000
  for (let i = 0; i < SAMPLES; i++) {
    for (const shellId of pool.slice(0, 10)) {
      seed++
      const ctx = createTrainingGame({ seed, difficulty: DIFFICULTY })
      try {
        const off = ctx.state.possession
        ctx.brains[off].forceAuthoredPlay = passPlays[seed % passPlays.length]
        ctx.brains[1 - off].forceAuthoredShell = shellId
        const r = runPlay(ctx, { ...SIT, ballX: HASHES[seed % HASHES.length] })
        if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
        n++
        yards += r.yards ?? 0
        if (r.outcome === 'sack') { sacks++; sackTicks += r.ticks ?? 0 }
        else { others++; otherTicks += r.ticks ?? 0 }
      } finally { destroyTrainingGame(ctx) }
    }
  }
  if (!n) continue
  console.log(
    `  rush ${String(rush).padEnd(7)} (${String(pool.length).padStart(2)} shells)  sack ${String(Math.round(100 * sacks / n)).padStart(3)}%` +
    `   held on sacks ${sacks ? secs(sackTicks / sacks) : ' -  '}s` +
    `   held otherwise ${others ? secs(otherTicks / others) : ' -  '}s` +
    `   avg ${(yards / n).toFixed(2)} yds  (${n})`
  )
}

const sk = skillFor(DIFFICULTY)
console.log(`\n  the bar he needs to let go (hard): threshold ${sk.throwThreshold}, floor ${sk.throwFloor}, patience ${sk.patience}s`)
console.log('  NFL sack rate is about 6-7% of dropbacks, and a four-man rush should sit UNDER that.')
