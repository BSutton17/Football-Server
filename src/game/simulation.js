import { SIM } from '../constants.js'
import { PHASE } from './stateMachine.js'
import { getGame } from './gameState.js'
import { runEngagement }        from './systems/engagement.js'
import { runMovement }          from './systems/movement.js'
import { runPushForce }         from './systems/pushForce.js'
import { runCollisionResponse } from './systems/collisionResponse.js'
import { runClock }             from './systems/clock.js'
import { runPlayClock }         from './systems/playClock.js'
import { runDecisionClock, runConversionClock } from './systems/decisionClock.js'
import { runKickClock }         from './systems/kickClock.js'
import { runEventQueue }        from './systems/eventQueue.js'
import { runBroadcast }         from './systems/broadcast.js'
import { drainStamina }         from './systems/stamina.js'
import { runPassRush }          from './systems/passRush.js'
import { runPressureDetection } from './systems/pressureDetection.js'
import { runSackDetection }     from './systems/sackDetection.js'
import { runTouchdownDetection } from './systems/touchdownDetection.js'
import { runTackleDetection }   from './systems/tackleDetection.js'
import { runCoverageDebug }     from './systems/coverageDebug.js'

// ── Fixed timestep ────────────────────────────────────────────────────────────
//
// dt is always exactly 0.05 s — never the actual wall-clock elapsed time.
// Every system always receives the same value, so the simulation is perfectly
// reproducible regardless of when the OS fires the interval.

const DT = SIM.TICK_MS / 1000   // 0.05 s

// ── Systems executed during LIVE phase ───────────────────────────────────────
//
// Order is load-bearing — do not rearrange:
//   1. runMovement   — advance positions; detect events; enqueue them
//   2. runClock      — tick the game clock; enqueue CLOCK_EXPIRED if needed
//   3. runEventQueue — drain and resolve all events from steps 1 & 2
//   4. runBroadcast  — send final positions to both clients

const LIVE_SYSTEMS = [
  runEngagement,        // flag engaged pairs; compute leverage on each defender
  runPassRush,          // accumulate rusher win meter; flag shed (broke free) rushers
  runMovement,          // steer players; engagement speed cap applied here
  runPushForce,         // bilateral push forces between engaged pairs
  drainStamina,
  runCollisionResponse, // resolve body overlaps after push forces settle
  runPressureDetection, // detect defenders near QB; sets qbPressureCount / qbUnderHeavyPressure
  runSackDetection,     // enqueue SACK when a defender reaches the QB behind the LOS
  runTouchdownDetection, // enqueue TOUCHDOWN when the ball carrier crosses a goal line
  runTackleDetection,   // enqueue TACKLE when a defender overlaps the ball carrier
  runClock,
  runCoverageDebug,     // [debug] log each receiver's openness, color, and justification (pass plays)
  runEventQueue,
  runBroadcast,
]

// ── Per-room loop registry ────────────────────────────────────────────────────
//
// One interval per game room.  The loop starts when both players join (game is
// created) and stops when the game ends or is abandoned.
//
// Most ticks during PRE_SNAP / COUNTDOWN / DEAD are near-free — the switch
// falls through with no work.  Only LIVE ticks run the full pipeline.

const loops = new Map()   // Map<roomId, intervalId>

export function startGameLoop(roomId, io) {
  if (loops.has(roomId)) return   // idempotent

  const id = setInterval(() => tick(roomId, io), SIM.TICK_MS)
  loops.set(roomId, id)
  console.log(`[sim] game loop started: ${roomId} @ ${SIM.TICK_RATE} Hz`)
}

export function stopGameLoop(roomId) {
  const id = loops.get(roomId)
  if (id === undefined) return

  clearInterval(id)
  loops.delete(roomId)
  console.log(`[sim] game loop stopped: ${roomId}`)
}

// ── Tick ──────────────────────────────────────────────────────────────────────

function tick(roomId, io) {
  const state = getGame(roomId)

  if (!state) {
    // Game was deleted externally (abandon / cleanup) — stop the orphaned loop
    stopGameLoop(roomId)
    return
  }

  switch (state.phase) {
    case PHASE.PRE_SNAP:
      // [Special Teams][3] While the 4th-down menu is up everything else pauses — only the decision
      // clock ticks (and may auto-resolve the choice, which advances the phase).
      if (state.decisionPending) {
        runDecisionClock(state, io, DT)
        break
      }
      // [Special Teams][51] The post-touchdown extra-point / 2-pt menu also pauses everything else.
      if (state.conversionPending) {
        runConversionClock(state, io, DT)
        break
      }
      // [Special Teams][6][8][9] A player-controlled kick (punt / FG) owns pre-snap: the kick clock
      // drains the power meter and resolves the kick.
      if (state.specialTeams && state.specialTeams.playerControlled) {
        runKickClock(state, io, DT)
        break
      }
      runPlayClock(state, io, DT)
      // [204] After a play that doesn't stop the clock (in-bounds tackle, sack), the game clock
      // keeps running between plays; it restarts on the snap after a stopping play.
      if (!state.clockStopped) {
        runClock(state, io, DT)
        runEventQueue(state, io, DT)   // process a CLOCK_EXPIRED that lands during the play clock
      }
      break

    case PHASE.COUNTDOWN:
      // Play clock is paused; defense may still adjust coverage. A running clock keeps ticking.
      if (!state.clockStopped) {
        runClock(state, io, DT)
        runEventQueue(state, io, DT)
      }
      break

    case PHASE.LIVE:
      state.tick++
      for (const system of LIVE_SYSTEMS) system(state, io, DT)
      break

    case PHASE.DEAD:
      // Play just ended — event handlers set a timeout to reset to PRE_SNAP
      break

    case PHASE.GAME_OVER:
      stopGameLoop(roomId)
      break
  }
}
