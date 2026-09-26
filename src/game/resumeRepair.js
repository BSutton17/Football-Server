// ── Putting the game back together after a pause ([pause repair]) ───────────
//
// A pause freezes the SIMULATION, but not the world around it. Real-time timers keep running,
// sockets drop and reconnect, and a client that resyncs mid-countdown throws away state it can
// never get back. So a game that pauses at the wrong moment can come back stuck: a countdown whose
// unlock tick fired while nobody was listening, a dead ball with no timer left to start the next
// play, a decision menu whose clock ran out unanswered, or a live play whose loop is not ticking.
//
// ⚠️ THIS REPAIRS, IT DOES NOT SECOND-GUESS. Every check below fires only when the state is
// genuinely unable to move on its own — a countdown that is still counting, a menu still ticking,
// a loop already running are all left exactly alone. The point is that a resumed game is never
// stuck, not that it is nudged toward what this file thinks should happen.
//
// It is deliberately cheap and total: it runs once on resume, looks at everything that can strand
// a game, and says what it fixed. Silence means the pause was clean.

import { PHASE } from './stateMachine.js'
import { startGameLoop } from './simulation.js'
import { startNextPlay, resolveDecision } from './eventQueue.js'
import { decisionDefault } from './specialTeams.js'
import { serializeGameState, serializePositions } from './serialization.js'
import { getRoom } from './roomManager.js'

// How long a dead ball may sit with no timer before this starts the next play itself.
const DEAD_BALL_GRACE_MS = 1200

// `serializePositions` reports where everyone is, not what they are, but `player_placed` carries the
// label — and the label is load-bearing on arrival (movement, ratings and the auto-rush all key off
// it). So it is read back off the live player.
function onFieldLabel(state, pos) {
  const map = pos.team === 'o' ? state.offensePlayers : state.defensePlayers
  return map.get(pos.id)?.label ?? null
}

export function repairAfterResume(state, io, roomId) {
  if (!state) return []
  const fixed = []

  // ── A countdown whose unlock has already happened ────────────────────────
  //
  // The countdown's ticks are one-shot timers booked at set_offense. If the last of them — the
  // zero that unlocks the snap — fired during the pause, or a client reconnected and rebuilt its
  // state after it, nobody is left holding the unlock and the offense can never snap. Re-sending
  // the current count costs nothing and is the only way that news can arrive twice.
  if (state.phase === PHASE.COUNTDOWN) {
    const pending = (state.countdownTimers ?? []).length > 0
    const count = pending ? Math.max(0, Math.ceil(state.playClock ?? 0)) : 0
    io.to(roomId).emit('hike_countdown', { count: pending ? count : 0 })
    if (!pending) fixed.push('countdown had already expired — re-sent the snap unlock')
  }

  // ── A dead ball with nothing left to start the next play ─────────────────
  //
  // `beginNextPlay` books a single timer. If it fired while the game was frozen it did nothing,
  // and the whistle never leads anywhere.
  if (state.phase === PHASE.DEAD) {
    const due = state.nextPlayDueAt ?? 0
    const overdue = state.nextPlayTimer == null || (due && Date.now() > due + DEAD_BALL_GRACE_MS)
    if (overdue) {
      startNextPlay(roomId, io)
      fixed.push('the next play had no timer left — started it')
    }
  }

  // ── A decision menu that ran out of clock while nobody could answer ──────
  if (state.decisionPending && (state.decisionTimer ?? 0) <= 0) {
    resolveDecision(state, io, decisionDefault(state))
    fixed.push('the fourth-down menu had already timed out — took the default')
  }

  // ── A live play with no loop under it ────────────────────────────────────
  //
  // `startGameLoop` is idempotent, so this is safe to call whatever the truth is; it only says it
  // repaired something when the phase is one that genuinely needs ticks.
  if (state.phase === PHASE.LIVE) {
    startGameLoop(roomId, io)
  }

  // ── And everybody gets the truth again ───────────────────────────────────
  //
  // Last, so it reflects anything repaired above. A client that dropped and rebuilt during the
  // pause is the most likely thing to be out of step, and it cannot ask for this itself.
  const room = getRoom(roomId)
  room?.players.forEach((socketId, slot) => {
    if (socketId) io.to(socketId).emit('game_state', serializeGameState(state, slot))
  })

  // ⚠️ AND SO DOES THE FORMATION ON THE GRASS, WHICH game_state DOES NOT CARRY.
  //
  // Pre-snap positions reach a client only as `player_placed` events, one per body, as they are
  // placed. A client that dropped and rebuilt during the pause — which is what a paused game on a
  // phone does the moment the socket goes — has none of them, and nothing will ever re-send: the
  // opponent has finished placing their eleven, and the computer only realigns when the picture
  // changes. So the other team is invisible for the rest of the down.
  //
  // Re-emitting them leaks nothing: `player_placed` is already broadcast room-wide for every single
  // placement, so this is the same data arriving a second time, and the client's handler replaces
  // by id rather than appending.
  if (state.phase === PHASE.PRE_SNAP || state.phase === PHASE.COUNTDOWN) {
    for (const pos of serializePositions(state)) {
      io.to(roomId).emit('player_placed', {
        id: pos.id, x: pos.x, y: pos.y, team: pos.team, label: onFieldLabel(state, pos),
      })
    }
  }
  // Deliberately NOT reported in `fixed`. Like the game_state broadcast above it is part of the
  // routine resync, not a repair of something that was broken — and the contract this file keeps is
  // that silence means the pause was clean. A test pins that.

  return fixed
}
