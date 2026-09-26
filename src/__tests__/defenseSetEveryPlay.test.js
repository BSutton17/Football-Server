import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame, resetPlay } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { startNextPlay } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// ⚠️ "THE SET DEFENSE BUTTON WORKS ONCE PER GAME."
//
// `markDefenseSet` refuses a second declaration while `solo.defenseSet` is still true, and that
// flag is meant to be cleared when a new play begins. It was cleared in `resetPlay` — which is
// called by the TRAINING harness and by nothing else. The real game starts its plays in
// `startNextPlay`, which had grown its own copy of the reset list and never included it.
//
// So the first press worked and every press afterwards was silently refused: no shortened
// countdown, and the computer's offense never got the signal to set early either. Two complaints,
// one cause.

const ROOM = '9500'

function human(io, id = 'humanA') {
  const emits = []
  const handlers = new Map()
  const s = {
    id, data: {}, emits,
    on(event, fn) { handlers.set(event, fn) },
    emit(event, payload) { emits.push({ event, payload }) },
    join() {}, to() { return { emit() {} } },
    fire(event, payload) { handlers.get(event)?.(payload); return handlers.has(event) },
    of(event) { return emits.filter(e => e.event === event) },
  }
  registerRoomHandlers(io, s)
  registerTeamSelectHandlers(io, s)
  registerGameHandlers(io, s)
  io.register?.(s)
  return s
}

function cleanup() {
  clearAiSeats(ROOM)
  for (const t of getTokensByRoomId(ROOM)) invalidateSession(t)
  if (getRoom(ROOM)) { leaveRoomBySlot(ROOM, 0); leaveRoomBySlot(ROOM, 1) }
  stopGameLoop(ROOM)
  deleteGame(ROOM)
  clearTeamSelect(ROOM)
}

let g
beforeEach(() => {
  cleanup()
  const io = createFakeIo()
  const you = human(io)
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 777 })
  const mine = TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId)
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: mine })
  g = { io, you }
})
afterEach(cleanup)

// Put the human on defense — the button is theirs — and get back to a fresh pre-snap.
function freshPlay() {
  const state = getGame(ROOM)
  state.possession = 1          // the computer has the ball, so the human defends
  state.phase = PHASE.DEAD
  startNextPlay(ROOM, g.io, { quiet: true })
  return getGame(ROOM)
}

describe('the defense may declare itself ready on EVERY play', () => {
  it('⚠️ ACCEPTS SET ON THE SECOND PLAY, NOT ONLY THE FIRST', () => {
    const a = freshPlay()
    g.you.fire('set_defense')
    expect(a.solo.defenseSet).toBe(true)

    const b = freshPlay()
    // The declaration belongs to the play that just ended, not to the game.
    expect(b.solo.defenseSet).toBe(false)

    g.you.fire('set_defense')
    expect(b.solo.defenseSet).toBe(true)
  })

  it('shortens the countdown every time, not just the first', () => {
    for (let play = 0; play < 3; play++) {
      const state = freshPlay()
      g.you.fire('set_defense')
      expect(state.solo.countdown).toBeGreaterThan(0)
      expect(state.solo.defenseSet).toBe(true)
    }
  })

  it('⚠️ TELLS THE OFFENSE TO SET, which is what makes the button speed the game up', () => {
    // `defense_set` is what flips the computer's `forceSet`; a refused declaration never emits it,
    // so the offense went on waiting out its randomly chosen set moment.
    freshPlay()
    g.you.fire('set_defense')
    const first = g.io.of('defense_set').length
    expect(first).toBeGreaterThan(0)

    freshPlay()
    g.you.fire('set_defense')
    expect(g.io.of('defense_set').length).toBeGreaterThan(first)
  })

  it('the two reset paths agree, so neither can drift from the other', () => {
    // `resetPlay` (training) and `startNextPlay` (the real game) both have to clear it.
    const state = freshPlay()
    g.you.fire('set_defense')
    expect(state.solo.defenseSet).toBe(true)
    resetPlay(state)
    expect(state.solo.defenseSet).toBe(false)
  })
})
