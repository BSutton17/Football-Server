import { SIM } from '../constants.js'
import { PHASE } from './stateMachine.js'
import { getGame } from './gameState.js'
import { isStopped, tickStoppage, endStoppage, stoppageReason, STOPPAGE } from './pause.js'
import { runEngagement }        from './systems/engagement.js'
import { runMovement }          from './systems/movement.js'
import { runPushForce }         from './systems/pushForce.js'
import { runCollisionResponse } from './systems/collisionResponse.js'
import { runClock }             from './systems/clock.js'
import { runPlayClock }         from './systems/playClock.js'
import { chewStep, clearChewClock } from './chewClock.js'
import { runDecisionClock, runConversionClock } from './systems/decisionClock.js'
import { runKickClock }         from './systems/kickClock.js'
import { runEventQueue }        from './systems/eventQueue.js'
import { runBroadcast }         from './systems/broadcast.js'
import { samplePlay } from '../analytics/playLog.js'
import { drainStamina }         from './systems/stamina.js'
import { runPassRush }          from './systems/passRush.js'
import { runPancake }           from './systems/pancake.js'
import { runPressureDetection } from './systems/pressureDetection.js'
import { runSackDetection }     from './systems/sackDetection.js'
import { runTouchdownDetection } from './systems/touchdownDetection.js'
import { runTackleDetection }   from './systems/tackleDetection.js'
import { runCoverageDebug }     from './systems/coverageDebug.js'
import { runThrowawayWindow }   from './systems/throwawayWindow.js'
import { runRpo }               from './systems/rpo.js'
import { runManualHold, revealPassOutcome, takePendingOutcome, pressGo } from './manual.js'
import { enqueue, startNextPlay } from './eventQueue.js'

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
  // [rpo] FIRST: the read window can close on this tick, which hands the ball to the back. Doing it
  // before movement means the whole tick agrees on who is carrying the ball, rather than the
  // handoff landing a frame after everyone has already moved as if it were still a pass.
  runRpo,
  runEngagement,        // flag engaged pairs; compute leverage on each defender
  runPassRush,          // accumulate rusher win meter; flag shed (broke free) rushers
  runPancake,           // [pancake] dominant blocks put a defender down; ticks the freeze timers
  runMovement,          // steer players; engagement speed cap applied here
  runPushForce,         // bilateral push forces between engaged pairs
  drainStamina,
  runCollisionResponse, // resolve body overlaps after push forces settle
  runPressureDetection, // detect defenders near QB; sets qbPressureCount / qbUnderHeavyPressure
  runSackDetection,     // enqueue SACK when a defender reaches the QB behind the LOS
  runTouchdownDetection, // enqueue TOUCHDOWN when the ball carrier crosses a goal line
  runTackleDetection,   // enqueue TACKLE when a defender overlaps the ball carrier
  runClock,
  // [187] Counts LIVE play time so the throwaway offer is measured in game time, not wall time —
  // which matters in manual mode, where the play only advances while GO is held.
  runThrowawayWindow,
  runCoverageDebug,     // [debug] log each receiver's openness, color, and justification (pass plays)
  runEventQueue,
  runBroadcast,
  // [manual] LAST on purpose: when this freezes the play, runBroadcast has already sent this tick's
  // positions, so the frame the clients hold on screen is exactly the frame the freeze captured.
  runManualHold,
  // [analytics] LAST, so the sample is the frame the clients were just sent.
  runAnalyticsSample,
]

// ── Per-room loop registry ────────────────────────────────────────────────────
//
// One interval per game room.  The loop starts when both players join (game is
// created) and stops when the game ends or is abandoned.
//
// Most ticks during PRE_SNAP / COUNTDOWN / DEAD are near-free — the switch
// falls through with no work.  Only LIVE ticks run the full pipeline.

// [analytics] One system rather than a call scattered through the engine. It also closes the
// record when the play ends, which is the one thing a per-tick sampler cannot see on its own --
// by the next tick the phase is DEAD and the pipeline no longer runs.
function runAnalyticsSample(state) {
  samplePlay(state)
}

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

// Exported so tests can drive the loop one deterministic step at a time. Production code should
// always go through startGameLoop / stopGameLoop rather than calling this directly.
// ── [watchdog] Nothing is allowed to wait for ever ──────────────────────────
//
// ⚠️ THE GAME CAN REACH A STATE WITH NOTHING SCHEDULED, AND THEN IT IS OVER. Reported twice: "I'll
// click set defense or offense and the game will just freeze and I'm stuck ... pausing and unpausesing
// and refreshing does not work its a softlock." The first fix addressed the half-time hold, which was
// one such state and not the one being hit.
//
// The general shape, and the reason a watchdog is the right answer rather than a third guess:
//
//   • COUNTDOWN is driven by timers scheduled UP FRONT, all cancelled together by bumping
//     `countdownToken`. `set_defense` during a countdown does exactly that and then emits a single
//     `hike_countdown { count: 0 }` in their place. That one emit is now the only thing in existence
//     that can start the play — there is no timer left, no clock running, and no retry. If the offense
//     does not act on it (the computer is mid-stoppage and drops the event, its handler throws and is
//     swallowed, it has already marked itself snapped) the game sits in COUNTDOWN for ever.
//   • DEAD is the same shape: the next play is booked on a `setTimeout`, and a path that reaches DEAD
//     without booking one has nothing to advance it.
//
// Both are invisible from the outside. Every button is phase-gated and returns silently, so the player
// sees a pressed button and a frozen field — which is exactly how it was reported, and why it could not
// be diagnosed from the description.
//
// ⚠️ THIS DOES NOT FIX THE CAUSE, AND IS NOT MEANT TO. It makes the whole CLASS survivable: whatever
// strands the game, it un-strands within a few seconds and says so in the log, with the phase and how
// long it sat there. The next occurrence names itself instead of being a mystery.

// Longer than any real countdown (at most ~16s of ticks) plus a healthy margin.
const COUNTDOWN_STUCK_MS = 25_000
// The ordinary dead-ball gap is 2s and a period transition 5s; the half-time hold books its own long
// fallback, which this must not pre-empt — so it only acts when NOTHING is booked at all.
const DEAD_STUCK_MS = 15_000
// A manual freeze is a beat for the offense to read the field, not a state to live in. Generous enough
// that a human taking their time is never interrupted.
const MANUAL_HOLD_STUCK_MS = 20_000

function runPhaseWatchdog(roomId, state, io) {
  // ⚠️ AN OPEN-ENDED STOPPAGE IS THE SOFTLOCK THAT ACTUALLY HAPPENS, so it is checked first and it
  // is checked on its OWN clock rather than the phase's -- a manual freeze does not change phase, so
  // `phaseSince` says nothing about how long the board has been still.
  //
  // MANUAL_HOLD and PLAYER_PAUSE are the two with no timer behind them. A manual freeze is lifted by
  // the offense pressing GO, and if the offense is the computer and it decides it has nothing to do --
  // on a run, or once the ball has gone -- nobody ever presses. The game then has no clock, no timer
  // and no path back, and every button is phase-gated into a silent refusal.
  //
  // A player pause is deliberate and is left alone: un-pausing somebody who walked away would be its
  // own bug. A MANUAL freeze is not deliberate in that sense -- it is a mechanic, and one that is
  // supposed to last a beat.
  if (isStopped(state)) {
    const reason = stoppageReason(state)
    if (reason === STOPPAGE.MANUAL_HOLD) {
      state.stoppageSince = state.stoppageSince ?? Date.now()
      const held = Date.now() - state.stoppageSince
      if (held > MANUAL_HOLD_STUCK_MS) {
        console.warn(`[watchdog] ${roomId} the board has been frozen for ${Math.round(held / 1000)}s ` +
          'with nobody pressing GO — resuming it. Something froze the play and never restarted it.')
        state.stoppageSince = null
        pressGo(state, io)
        // If the freeze was not liftable by a press (no manual state, autoRun) clear it outright
        // rather than leave the game dead.
        if (isStopped(state) && stoppageReason(state) === STOPPAGE.MANUAL_HOLD) {
          endStoppage(state)
          io.to(roomId).emit('manual_resumed')
        }
      }
    } else {
      state.stoppageSince = null
    }
    return
  }
  state.stoppageSince = null

  const since = state.phaseSince
  if (!since) return
  const stuckFor = Date.now() - since

  if (state.phase === PHASE.COUNTDOWN && stuckFor > COUNTDOWN_STUCK_MS) {
    // Re-issue the thing that was lost. Harmless if the offense simply has not snapped yet of its own
    // accord — a human offense reads it as "the countdown is over", which it is.
    console.warn(`[watchdog] ${roomId} stuck in COUNTDOWN for ${Math.round(stuckFor / 1000)}s — ` +
      're-issuing the hike. Something cancelled the countdown and nothing restarted the play.')
    state.phaseSince = Date.now()          // one nudge per window, not one per tick
    io.to(roomId).emit('hike_countdown', { count: 0 })
    return
  }

  if (state.phase === PHASE.DEAD && state.nextPlayTimer == null && stuckFor > DEAD_STUCK_MS) {
    console.warn(`[watchdog] ${roomId} stuck in DEAD for ${Math.round(stuckFor / 1000)}s with no next ` +
      'play booked — starting one.')
    state.phaseSince = Date.now()
    startNextPlay(roomId, io)
  }
}

export function tick(roomId, io) {
  const state = getGame(roomId)

  if (!state) {
    // Game was deleted externally (abandon / cleanup) — stop the orphaned loop
    stopGameLoop(roomId)
    return
  }

  // [69] A stoppage (timeout, and later injuries / challenges / halftime) freezes EVERYTHING: no
  // clock advances and the live sim is held, so the exact state is preserved until it resumes. A
  // timed stoppage counts down here and auto-resumes when it elapses.
  // [watchdog] ⚠️ CHECKED BEFORE THE STOPPAGE RETURN, WHICH IS WHY THE FIRST VERSION OF THIS NEVER
  // FIRED. It sat below, so the one family of softlocks that matters -- an OPEN-ENDED stoppage nobody
  // lifts -- froze the tick and the watchdog with it. Reported as "the saftey net isn't working", and it
  // was: a dead game is exactly the state in which nothing downstream of here runs.
  runPhaseWatchdog(roomId, state, io)

  if (isStopped(state)) {
    // [chew clock] Anything that freezes the game cancels an in-flight fast-forward. A timeout in
    // particular is the OPPOSITE intent — the player just paid to stop the clock, so resuming into a
    // chew would burn the seconds they spent a timeout to keep.
    clearChewClock(state)
    if (!tickStoppage(state, DT)) {
      const reason = stoppageReason(state)
      endStoppage(state)
      // [70] After a timeout the game clock stays stopped until the next snap; the play clock was
      // reset + re-armed when the timeout was called, so pre-snap simply continues from here.
      if (reason === STOPPAGE.TIMEOUT) io.to(roomId).emit('timeout_ended')

      // [manual] The pass-reveal chain. A manual-mode pass is decided at the instant of release but
      // withheld: PASS_SUSPENSE runs the "It is…" beat, then the result is announced. A catch or an
      // interception leaves the ball live, so it takes a further RESULT_HOLD beat before everyone
      // starts moving again; an incompletion has already ended the play and resolves right away.
      if (reason === STOPPAGE.PASS_SUSPENSE) {
        const now = revealPassOutcome(state, io)
        if (now) enqueue(roomId, now.event, now.payload)
      } else if (reason === STOPPAGE.RESULT_HOLD) {
        const next = takePendingOutcome(state)
        if (next) enqueue(roomId, next.event, next.payload)
      }
    }
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
      // [chew clock] Both pre-snap clocks advance by the SAME step, so fast-forwarding cannot
      // invent or skip game time — see chewClock.js. Ordinarily this is just DT.
      {
        const step = chewStep(state, DT)
        runPlayClock(state, io, step)
        // [204] After a play that doesn't stop the clock (in-bounds tackle, sack), the game clock
        // keeps running between plays; it restarts on the snap after a stopping play.
        if (!state.clockStopped) {
          runClock(state, io, step)
          runEventQueue(state, io, DT)   // process a CLOCK_EXPIRED that lands during the play clock
        }
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
      // [manual] A pass committed during a freeze is resolved against the EXACT frame the offense
      // was reading: drain it before any system moves anybody. Resolving it parks the outcome and
      // re-freezes for the "It is…" beat, so the tick stops here rather than running the sim on.
      if (state.manual?.resolveThrowFirst) {
        state.manual.resolveThrowFirst = false
        runEventQueue(state, io, DT)
        if (isStopped(state)) break
      }
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
