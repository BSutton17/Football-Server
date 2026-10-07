import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats, getAiSeat, bridgeIo } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { startNextPlay, applyDelayOfGame } from '../game/eventQueue.js'
import { beginSpecialTeams, KICK } from '../game/specialTeams.js'
import { beginStoppage, endStoppage, STOPPAGE } from '../game/pause.js'
import { PHASE } from '../game/stateMachine.js'
import { checkGameHealth } from '../game/healthCheck.js'
import { serializeGameState } from '../game/serialization.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// ⚠️ THE DELAY-OF-GAME HEALTH CHECK. Reported as the game "still sometimes freezing and softlocking",
// with the tell that the computer could not set its offense and a delay of game was called. Each case
// below strands the computer offense a different way, and in each the penalty must be the end of it:
// the check rebuilds the seat and the offense sets.

const ROOM = '9720'

function human(io, id = 'humanH') {
  const handlers = new Map()
  const s = {
    id, data: {}, emits: [],
    on(e, fn) { handlers.set(e, fn) },
    emit(e, p) { s.emits.push({ event: e, payload: p }) },
    join() {}, to() { return { emit() {} } },
    fire(e, p) { handlers.get(e)?.(p); return handlers.has(e) },
  }
  registerRoomHandlers(io, s); registerTeamSelectHandlers(io, s); registerGameHandlers(io, s)
  io.register?.(s)
  return s
}

function cleanup() {
  clearAiSeats(ROOM)
  for (const t of getTokensByRoomId(ROOM)) invalidateSession(t)
  if (getRoom(ROOM)) { leaveRoomBySlot(ROOM, 0); leaveRoomBySlot(ROOM, 1) }
  stopGameLoop(ROOM); deleteGame(ROOM); clearTeamSelect(ROOM)
}

let g
beforeEach(() => {
  cleanup()
  const io = createFakeIo()
  const you = human(io)
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 4242 })
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId) })
  g = { io: bridgeIo(io), you, brain: getAiSeat(solo.aiSocketId).brain.current }
})
afterEach(cleanup)

// The computer has the ball, at a fresh line-up.
function computerOnOffense() {
  const state = getGame(ROOM)
  state.possession = 1
  state.phase = PHASE.DEAD
  startNextPlay(ROOM, g.io, { quiet: true })
  // `quiet` sends nothing, so hand the computer the situation a real line-up would have.
  g.brain.onEvent('game_state', serializeGameState(getGame(ROOM), 1))
  return getGame(ROOM)
}

describe('a delay of game on the computer offense', () => {
  it('⚠️ THE COMPUTER THINKS IT ALREADY SET — rebuilt, and it sets', () => {
    const state = computerOnOffense()
    expect(state.phase).toBe(PHASE.PRE_SNAP)
    // Stranded: it believes the set went through, so it will never send one.
    g.brain.done.formation = true
    g.brain.done.set = true

    applyDelayOfGame(state, g.io)

    expect(state.phase).toBe(PHASE.COUNTDOWN)
    expect(state.lastHealthCheck.fixed).toContain('rebuilt the computer offense and told it to set')
  })

  it('⚠️ A KICK LEFT ON THE FIELD — cleared, and the computer sets', () => {
    const state = computerOnOffense()
    // A kickoff interstitial nobody cleared. The computer reads any kick as "special teams owns this
    // play" and never lines up — while a human offense would not notice it at all.
    beginSpecialTeams(state, KICK.KICKOFF, { kickingSlot: 0 })
    g.brain.onEvent('game_state', { ...g.brain.knowledge, specialTeams: { kickType: 'kickoff' } })
    g.brain.done.set = false

    applyDelayOfGame(state, g.io)

    expect(state.specialTeams).toBeNull()
    expect(state.phase).toBe(PHASE.COUNTDOWN)
  })

  it('a human offense running out the clock is not a problem, and nothing is touched', () => {
    const state = getGame(ROOM)
    state.possession = 0
    state.phase = PHASE.DEAD
    startNextPlay(ROOM, g.io, { quiet: true })
    const report = checkGameHealth(state, g.io, { offenseSlot: 0 })
    expect(report.healthy).toBe(true)
    expect(report.fixed).toEqual([])
    expect(state.phase).toBe(PHASE.PRE_SNAP)
  })
})

describe('a refused set is tried again', () => {
  it('⚠️ SENT IS NOT ACCEPTED — the computer retries once the refusal clears', () => {
    const state = computerOnOffense()
    // The set is refused: a stoppage is standing when it arrives.
    beginStoppage(state, STOPPAGE.TIMEOUT, 5)
    g.brain.onEvent('defense_set')          // "set now"
    expect(state.phase).toBe(PHASE.PRE_SNAP)
    expect(g.brain.done.set).toBe(false)   // it knows it was refused

    endStoppage(state)
    g.brain.onEvent('play_clock_update', { playClock: state.playClock })
    expect(state.phase).toBe(PHASE.COUNTDOWN)
  })
})
