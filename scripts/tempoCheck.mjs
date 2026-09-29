// ── Does the tempo actually move the clock? ([tempo]) ──────────────────────
//
//   NODE_ENV=test node scripts/tempoCheck.mjs [downs]
//
// The unit tests say chooseTempo returns the right word. This says whether the word reaches the
// field: it plays real downs from scripted game states and reports how much GAME CLOCK each snap
// consumed, and what the offense called. A tempo that does not change either of those is a tempo
// that exists only in a test.

import { createTrainingGame, destroyTrainingGame, playDown } from '../src/training/game.js'
import { startNextPlay, resolveDecision } from '../src/game/eventQueue.js'
import { PHASE } from '../src/game/stateMachine.js'

const DOWNS = Number(process.argv[2] ?? 240)

// Each scenario is a game state the offense should read differently.
// ⚠️ CLOCK READINGS ARE FOR A 5:00 QUARTER, which is a full NFL quarter's worth of football. The
// NFL equivalent is beside each one: the scale is 1:3.
const QUARTER = 300
const SCENARIOS = [
  { name: 'Q4 lead 7,  1:30 (NFL 4:30)', quarter: 4, clock: 90, lead: 7 },
  { name: 'Q4 down 7,  1:30 (NFL 4:30)', quarter: 4, clock: 90, lead: -7 },
  { name: 'Q4 lead 7,  4:30 (NFL 13:30)', quarter: 4, clock: 270, lead: 7 },
]

for (const sc of SCENARIOS) {
  let burned = 0, snaps = 0, runs = 0
  let played = 0
  for (let g = 0; played < DOWNS; g++) {
    const ctx = createTrainingGame({ seed: 31000 + g })
    try {
      for (let i = 0; i < 8 && played < DOWNS; i++) {
        const st = ctx.state
        if (st.decisionPending) resolveDecision(st, ctx.io, 'go_for_it', { quiet: true })
        // Rebuild the scenario every down: the offense reads the state it is handed.
        st.quarter = sc.quarter
        st.clock = sc.clock
        st.quarterSeconds = QUARTER
        st.clockStopped = false
        const off = st.possession
        st.score = off === 0 ? [14 + sc.lead, 14] : [14, 14 + sc.lead]
        // ⚠️ NO TIMEOUTS. They are a separate feature with their own tests, and each one costs
        // five seconds of simulated freeze — which both slows this to a crawl and muddies the
        // measurement, since a timeout stops the very clock being measured.
        st.timeouts = [0, 0]

        const before = st.clock
        const r = playDown(ctx, {})
        if (!r.ok) break
        // How much game clock this snap cost, from the reading before to the reading after.
        const after = ctx.state.clock
        if (after <= before) { burned += before - after; snaps++ }
        if (ctx.state.playDesign?.playType === 'run') runs++
        played++
        if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      }
    } finally { destroyTrainingGame(ctx) }
  }
  const perSnap = snaps ? burned / snaps : 0
  console.log(`  ${sc.name.padEnd(26)} ${perSnap.toFixed(1).padStart(5)}s / snap   run ${String(Math.round(100 * runs / Math.max(1, played))).padStart(3)}%   (${played} downs)`)
}
