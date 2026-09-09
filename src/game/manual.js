// ── Manual (electric-football) mode ([manual]) ────────────────────────────────
//
// In traditional electric football nothing moves on its own — you hold a switch and the whole board
// comes alive; let go and it all stops dead. Manual mode reproduces that: after the defensive
// window the offense holds GO instead of tapping HIKE. Players (and the game clock) advance only
// while it is held. Release and the entire play freezes so the offense can read the field, then
// either throw or hold GO again. This repeats until the QB is sacked or the ball leaves his hand.
//
// Design notes worth keeping in mind:
//
//   • Freezing is done with the shared stoppage framework (pause.js), NOT by zeroing velocities.
//     That matters for correctness, not just tidiness: the openness engine reads each receiver's
//     velocity heading to judge whether he has beaten his man, and treats a route breaking BACK
//     toward the ball (comeback / curl / return) differently from one running INTO a defender. A
//     frozen comeback therefore still reads open even though the paused picture shows a corner
//     draped all over him — exactly the case a naive freeze would get wrong.
//
//   • Throws are legal ONLY while frozen. You cannot throw into moving traffic, so the read the
//     offense acts on is always the read it was shown.
//
//   • Once the ball is thrown (or the QB commits to a scramble) the hold loop is over and the rest
//     of the play runs itself. This is what keeps an interception return sane — nobody has to work
//     out whose GO button drives the defender who just picked it off.
//
// This module is pure state plus its own emits; the rules it serves live in gameHandlers (input)
// and simulation.js (the freeze chain).

import { MANUAL, GAME_MODE } from '../constants.js'
import { beginStoppage, endStoppage, isStopped, stoppageReason, STOPPAGE } from './pause.js'

// True when this game is being played in manual mode at all.
export function isManualGame(state) {
  return state?.mode === GAME_MODE.MANUAL
}

// True when the CURRENT play is driven by the GO button. Run plays keep the original behaviour even
// in a manual room — you tap HIKE and the play runs to the whistle — so only pass plays arm the
// hold loop ([manual]: "run plays play as normal").
export function isManualPlay(state) {
  return isManualGame(state) && state.playDesign?.playType === 'pass'
}

// True while a manual play is frozen with the GO button up — the only window in which a throw is
// legal, and the state the client renders its "paused" treatment from.
export function isManualFrozen(state) {
  return isStopped(state) && stoppageReason(state) === STOPPAGE.MANUAL_HOLD
}

// A manual freeze belongs to one play and must never outlive it. Nothing can normally end a play
// mid-freeze (with the tick held, no clock runs and no tackle or sack can fire), but a disconnect
// or an abandoned room can strand one — and a stoppage carried into the next play would silently
// wedge the whole game. Every snap therefore clears any manual freeze still standing.
function clearManualStoppage(state) {
  const reason = stoppageReason(state)
  if (reason === STOPPAGE.MANUAL_HOLD || reason === STOPPAGE.PASS_SUSPENSE || reason === STOPPAGE.RESULT_HOLD) {
    endStoppage(state)
  }
}

// Arms the hold loop. Called from the snap: pressing GO IS the snap, so the play opens mid-press
// with the anti-jitter minimum already running.
export function beginManualPlay(state) {
  clearManualStoppage(state)
  if (!isManualPlay(state)) { state.manual = null; return null }
  state.manual = {
    holding:  true,   // GO is down right now — players are moving
    heldFor:  0,      // seconds this press has run, for the minimum-hold rule
    released: false,  // a release arrived; freeze as soon as the minimum hold is satisfied
    autoRun:  false,  // the hold loop is over (ball thrown / QB scrambling) — the play runs itself
    pending:  null,   // a resolved-but-unrevealed pass outcome, held behind the "It is…" beat
    resolveThrowFirst: false,  // drain the throw before anything moves — see armThrowResolution
  }
  return state.manual
}

// GO pressed. Unfreezes the play and starts a fresh minimum-hold window.
// Returns true if this press actually resumed play (so the caller knows to tell the clients).
export function pressGo(state, io) {
  const m = state.manual
  if (!m || m.autoRun) return false
  if (m.holding) return false            // already moving — a repeat press is a no-op
  if (!isManualFrozen(state)) return false

  endStoppage(state)
  m.holding  = true
  m.heldFor  = 0
  m.released = false

  io?.to(state.roomId).emit('manual_resumed')
  return true
}

// GO released. This does NOT necessarily stop play: real electric football bans "jittering" the
// switch, so every press commits to MIN_HOLD_SECONDS of movement. A release inside that window is
// recorded and honoured the moment the minimum elapses (see runManualHold), which makes a tap cost
// exactly as much as a short hold and leaves rapid tapping with nothing to gain.
// Returns true if play froze immediately.
export function releaseGo(state, io) {
  const m = state.manual
  if (!m || m.autoRun || !m.holding) return false

  m.released = true
  if (m.heldFor >= MANUAL.MIN_HOLD_SECONDS) {
    freeze(state, io)
    return true
  }
  return false   // still inside the minimum hold — runManualHold will freeze it when that elapses
}

// Ends the hold loop for the rest of the play: the ball has been thrown, or the QB has committed to
// a scramble. From here the play runs itself to the whistle. Any active freeze is lifted so the sim
// can actually proceed.
export function endManualControl(state, io) {
  const m = state.manual
  if (!m) return
  m.autoRun = true
  m.holding = false
  if (isManualFrozen(state)) {
    endStoppage(state)
    io?.to(state.roomId).emit('manual_resumed')
  }
}

// A throw was committed while the play was frozen. The offense picked its target from a still
// picture, so the pass must be resolved against THAT picture and not a tick's worth of motion
// later — otherwise the receiver drifts ~0.4 yd between the read and the maths behind it, and on a
// tight window that is the difference between a completion and a break-up. The tick honours this by
// draining the queue before any system runs (see simulation.js).
export function armThrowResolution(state) {
  if (state.manual) state.manual.resolveThrowFirst = true
}

// Freezes the play with the GO button up. Open-ended — only a press (or the play ending) resumes it.
function freeze(state, io) {
  const m = state.manual
  m.holding  = false
  m.released = false
  m.heldFor  = 0
  beginStoppage(state, STOPPAGE.MANUAL_HOLD, null)
  io?.to(state.roomId).emit('manual_frozen')
}

// ── LIVE system ───────────────────────────────────────────────────────────────
//
// Runs LAST in the tick, deliberately: by the time it freezes the play, runBroadcast has already
// sent this tick's positions. The frame the clients are looking at while frozen is therefore the
// exact frame the freeze captured, openness colors included — no stale read, and no need for a
// separate catch-up broadcast.
export function runManualHold(state, io, dt) {
  const m = state.manual
  if (!m || m.autoRun || !m.holding) return

  m.heldFor += dt

  // The minimum hold has elapsed; if a release is already waiting, honour it now.
  if (m.released && m.heldFor >= MANUAL.MIN_HOLD_SECONDS) freeze(state, io)
}

// ── Pass reveal ───────────────────────────────────────────────────────────────
//
// A manual-mode pass is resolved at the instant of release (the same instant the offense was
// looking at), but the ANSWER is withheld behind an "It is…" banner for a couple of seconds. The
// resolved event is parked here and replayed once the suspense elapses.

const REVEAL_LABELS = {
  complete:    'Caught!',
  intercepted: 'Intercepted!',
  drop:        'Dropped!',
  broken_up:   'Broken up!',
  incomplete:  'Incomplete!',
}

export function revealLabel(outcome, reason) {
  if (outcome === 'complete' || outcome === 'intercepted') return REVEAL_LABELS[outcome]
  return REVEAL_LABELS[reason] ?? REVEAL_LABELS.incomplete
}

// Parks a resolved pass outcome and starts the suspense beat. `event`/`payload` are replayed onto
// the event queue once the reveal (and, for a live-ball result, the hold after it) has run.
// `settles` marks an outcome the play continues from — a catch or a pick — which gets the extra
// beat before everyone starts moving again. An incompletion ends the play, so it needs none.
export function beginPassSuspense(state, io, { event, payload, outcome, reason, settles }) {
  const m = state.manual
  const seconds = MANUAL.SUSPENSE_MIN_SECONDS +
    Math.random() * (MANUAL.SUSPENSE_MAX_SECONDS - MANUAL.SUSPENSE_MIN_SECONDS)

  if (m) m.pending = { event, payload, outcome, reason, settles }
  beginStoppage(state, STOPPAGE.PASS_SUSPENSE, seconds)
  io?.to(state.roomId).emit('manual_pass_pending', { seconds: Number(seconds.toFixed(2)) })
  return seconds
}

// Called when the suspense beat elapses. Announces the result, then either holds a moment before
// the live ball resumes (catch / interception) or lets the dead-ball outcome resolve immediately.
// Returns the parked event to replay now, or null when it should wait for the result hold.
export function revealPassOutcome(state, io) {
  const m = state.manual
  const p = m?.pending
  if (!p) return null

  io?.to(state.roomId).emit('manual_pass_reveal', { label: revealLabel(p.outcome, p.reason) })

  if (p.settles) {
    beginStoppage(state, STOPPAGE.RESULT_HOLD, MANUAL.RESULT_HOLD_SECONDS)
    return null
  }

  m.pending = null
  return { event: p.event, payload: p.payload }
}

// Called when the post-result hold elapses — hands back the parked event so play can resume.
export function takePendingOutcome(state) {
  const m = state.manual
  const p = m?.pending
  if (!p) return null
  m.pending = null
  return { event: p.event, payload: p.payload }
}
