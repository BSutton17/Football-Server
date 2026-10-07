// ── The delay-of-game health check ([health]) ────────────────────────────────
//
// ⚠️ A DELAY OF GAME IS THE ONE SYMPTOM EVERY SOFTLOCK SHARES. Reported as the game "still sometimes
// freezing and softlocking", with the tell that when it happens the computer cannot set its offense
// and a delay of game is called. Whatever strands the game — a stale picture inside the AI, a refused
// set it believes was accepted, a kick interstitial nobody cleared, a seat that has gone — the offense
// stops being able to snap, and the play clock is the first thing that notices.
//
// So the penalty is used as the trigger: the moment either team takes one, this asks three questions
// and answers each with a repair where one exists.
//
//   1. Is the SERVER in a state to run this game?  The room exists, both seats are occupied by a live
//      socket or a registered computer seat, and possession names one of them.
//   2. Is the GAME healthy?  It is a scrimmage line-up (PRE_SNAP, play clock running), with both
//      rosters present and nothing left over from a play that has already finished — no menu still
//      open, no kick still on the field.
//   3. Can it actually be PLAYED?  The offense must be able to set. A human offense taking a delay is
//      just a slow human, but the computer never means to — its tempo stops at three seconds — so a
//      computer seat that took one has, by definition, lost track of the game. It is rebuilt from the
//      server's word and told to set at once.
//
// Everyone is then re-sent the situation and every body on the field, because a client that drifted
// cannot ask for that itself.
//
// ⚠️ IT REPAIRS, IT DOES NOT SECOND-GUESS. Every repair below fires only on a state that cannot move
// on its own, the same rule resumeRepair.js follows. A healthy game passes through untouched apart
// from the re-sync, and says nothing.

import { PHASE } from './stateMachine.js'
import { getRoom } from './roomManager.js'
import { endSpecialTeams } from './specialTeams.js'
import { serializeGameState, serializePositions } from './serialization.js'
import { isStopped, stoppageReason, endStoppage, STOPPAGE } from './pause.js'
import { getAiSeat } from '../ai/seats.js'
import { isAiSocketId } from '../ai/virtualSocket.js'

function labelOf(state, pos) {
  const map = pos.team === 'o' ? state.offensePlayers : state.defensePlayers
  return map?.get(pos.id)?.label ?? null
}

// A real socket counts as present when Socket.io still knows it. Without a registry to ask (tests,
// the headless harness) the seat is taken on trust rather than reported missing.
function seatState(io, socketId) {
  if (!socketId) return 'empty'
  if (isAiSocketId(socketId)) return getAiSeat(socketId) ? 'ai' : 'ai-missing'
  const registry = io?.sockets?.sockets
  if (!registry?.get) return 'human'
  return registry.get(socketId) ? 'human' : 'human-disconnected'
}

// Runs the check, applies the repairs, and returns what it found. `offenseSlot` is the team that was
// penalised — the one that failed to snap.
export function checkGameHealth(state, io, { offenseSlot = state?.possession } = {}) {
  const problems = []
  const fixed = []
  if (!state) return { healthy: false, problems: ['no game state'], fixed }

  const roomId = state.roomId
  const room = getRoom(roomId)

  // ── 1. The server ──────────────────────────────────────────────────────────
  if (!room) problems.push('room missing')
  const seats = [0, 1].map(slot => seatState(io, room?.players?.[slot]))
  seats.forEach((s, slot) => {
    if (s === 'empty' || s === 'ai-missing' || s === 'human-disconnected') problems.push(`seat ${slot} ${s}`)
  })
  if (state.possession !== 0 && state.possession !== 1) problems.push(`possession is ${state.possession}`)

  // ── 2. The game ────────────────────────────────────────────────────────────
  if (state.phase !== PHASE.PRE_SNAP) problems.push(`phase is ${state.phase}, not pre_snap`)
  if (!state.offensePlayers || !state.defensePlayers) problems.push('a roster map is missing')

  // A kick left on the field. Kickoffs are cleared by beginNextPlay and a punt or field goal runs on
  // its own clock rather than this one, so a play clock that ran out with one still here means it
  // outlived its play. The computer reads ANY kick as "special teams owns this play" and will not
  // line up a scrimmage formation while it is there, which is precisely "the AI can't set".
  if (state.specialTeams && !state.specialTeams.playerControlled) {
    problems.push(`stale ${state.specialTeams.kickType ?? 'kick'} interstitial`)
    endSpecialTeams(state)
    fixed.push('cleared the stale kick')
  }

  // A manual freeze has no meaning before the snap and nothing in pre-snap lifts it, while every
  // set_offense is refused as long as it stands. A deliberate pause or a running timeout is left be.
  if (isStopped(state) && stoppageReason(state) === STOPPAGE.MANUAL_HOLD) {
    problems.push('a manual freeze survived into pre-snap')
    endStoppage(state)
    fixed.push('lifted the manual freeze')
  }

  // ── 3. Can it be played: the offense must be able to set ───────────────────
  const offenseSocketId = room?.players?.[offenseSlot]
  const offenseSeat = seats[offenseSlot]
  if (offenseSeat === 'ai') {
    problems.push('the computer offense did not set')
    const brain = getAiSeat(offenseSocketId)?.brain?.current
    if (typeof brain?.recover === 'function') {
      try {
        brain.recover({
          gameState: serializeGameState(state, offenseSlot),
          placements: serializePositions(state).map(pos => ({ ...pos, label: labelOf(state, pos) })),
        })
        fixed.push('rebuilt the computer offense and told it to set')
      } catch (err) {
        problems.push(`recovering the computer offense threw: ${err?.message ?? err}`)
      }
    } else {
      problems.push('the computer offense has no way to recover')
    }
  }

  // The computer DEFENSE is re-synced as well: it answers the offense's formation, and if its picture
  // has drifted too it would line up against a formation that is not there.
  const defenseSlot = 1 - offenseSlot
  if (seats[defenseSlot] === 'ai') {
    const brain = getAiSeat(room?.players?.[defenseSlot])?.brain?.current
    try {
      brain?.recover?.({
        gameState: serializeGameState(state, defenseSlot),
        placements: serializePositions(state).map(pos => ({ ...pos, label: labelOf(state, pos) })),
      })
    } catch (err) {
      problems.push(`recovering the computer defense threw: ${err?.message ?? err}`)
    }
  }

  // ── Everybody gets the truth again ─────────────────────────────────────────
  room?.players?.forEach((socketId, slot) => {
    if (socketId) io.to(socketId).emit('game_state', serializeGameState(state, slot))
  })
  for (const pos of serializePositions(state)) {
    io.to(roomId).emit('player_placed', { id: pos.id, x: pos.x, y: pos.y, team: pos.team, label: labelOf(state, pos) })
  }

  // A human offense running out the clock is ordinary; only say something when something was wrong.
  const healthy = problems.length === 0
  if (!healthy) {
    console.warn(`[health] ${roomId} after a delay of game on slot ${offenseSlot}: ` +
      `${problems.join('; ')}${fixed.length ? ` — fixed: ${fixed.join('; ')}` : ''}`)
  }
  state.lastHealthCheck = { at: Date.now(), healthy, problems, fixed }
  return { healthy, problems, fixed }
}
