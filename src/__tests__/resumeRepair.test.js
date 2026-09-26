import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { repairAfterResume } from '../game/resumeRepair.js'
import { PHASE } from '../game/stateMachine.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// [pause repair] A pause freezes the simulation but not the world around it. Timers keep firing,
// sockets drop and reconnect, and a client that resyncs mid-countdown throws away state it cannot
// get back. These are the ways a resumed game could come back stuck.

const ROOM = '9600'

function human(io, id = 'humanA') {
  const emits = []
  const handlers = new Map()
  const s = {
    id, data: {}, emits,
    on(e, fn) { handlers.set(e, fn) },
    emit(e, payload) { emits.push({ event: e, payload }) },
    join() {}, to() { return { emit() {} } },
    fire(e, payload) { handlers.get(e)?.(payload); return handlers.has(e) },
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
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 4242 })
  const mine = TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId)
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: mine })
  g = { io, you, state: getGame(ROOM) }
})
afterEach(cleanup)

const lastOf = (event) => {
  const m = g.io.of(event)
  return m.length ? m[m.length - 1].payload : null
}

describe('a clean pause needs no repair', () => {
  it('reports nothing when the game can move on its own', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.PRE_SNAP
    st.decisionPending = false
    expect(repairAfterResume(st, g.io, ROOM)).toEqual([])
  })

  it('still resyncs everybody, because a reconnect cannot ask for it', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.PRE_SNAP
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)
    expect(g.io.of('game_state').length).toBeGreaterThan(0)
  })
})

describe('⚠️ A COUNTDOWN WHOSE UNLOCK ALREADY FIRED', () => {
  it('re-sends the snap unlock when no ticks are left', () => {
    // The countdown's ticks are one-shot timers. If the zero fired while the game was frozen,
    // nobody is holding the unlock and the offense can never snap.
    const st = getGame(ROOM)
    st.phase = PHASE.COUNTDOWN
    st.countdownTimers = []
    g.io.clear()

    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(lastOf('hike_countdown')).toEqual({ count: 0 })
    expect(fixed.join(' ')).toMatch(/snap unlock/)
  })

  it('leaves a countdown that is still counting alone', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.COUNTDOWN
    st.countdownTimers = [1, 2, 3]       // still booked
    st.playClock = 6
    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed.join(' ')).not.toMatch(/snap unlock/)
    expect(lastOf('hike_countdown').count).toBeGreaterThan(0)
  })
})

describe('⚠️ A DEAD BALL WITH NO TIMER LEFT', () => {
  it('starts the next play itself', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.DEAD
    st.nextPlayTimer = null              // the timer fired while frozen, and did nothing
    st.nextPlayDueAt = 0

    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed.join(' ')).toMatch(/next play/)
    expect(getGame(ROOM).phase).not.toBe(PHASE.DEAD)
  })

  it('leaves a dead ball that still has a timer alone', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.DEAD
    st.nextPlayTimer = 1234
    st.nextPlayDueAt = Date.now() + 5000
    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed.join(' ')).not.toMatch(/next play/)
    expect(getGame(ROOM).phase).toBe(PHASE.DEAD)
  })
})

describe('⚠️ A DECISION MENU THAT RAN OUT WHILE NOBODY COULD ANSWER', () => {
  it('takes the default', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.PRE_SNAP
    st.decisionPending = true
    st.decisionTimer = 0

    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed.join(' ')).toMatch(/menu/)
    expect(getGame(ROOM).decisionPending).toBe(false)
  })

  it('leaves a menu that is still ticking alone', () => {
    const st = getGame(ROOM)
    // ⚠️ THE HUMAN HOLDS THE BALL, so the computer does not answer the menu for us. With the AI on
    // offense it resolves the decision the moment the resync reaches it — correct behaviour, and
    // it would make this assertion about the AI rather than about the repair.
    st.possession = 0
    st.phase = PHASE.PRE_SNAP
    st.decisionPending = true
    st.decisionTimer = 4
    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed.join(' ')).not.toMatch(/menu/)
    expect(getGame(ROOM).decisionPending).toBe(true)
  })
})

describe('the whole path, through resume', () => {
  it('⚠️ A PAUSE DURING A COUNTDOWN LEAVES THE GAME ABLE TO SNAP', () => {
    // The reported symptom, end to end: paused while ready to play, resumed, still stuck.
    const st = getGame(ROOM)
    // The human is the one who has to snap; with the AI on offense it snaps immediately on the
    // unlock, which is the right outcome but hides whether the unlock was the thing that did it.
    st.possession = 0
    st.phase = PHASE.COUNTDOWN
    st.countdownTimers = []              // the unlock fired during the pause

    g.you.fire('pause_game')
    g.io.clear()
    g.you.fire('resume_game')

    expect(lastOf('hike_countdown')).toEqual({ count: 0 })
    expect(getGame(ROOM).phase).toBe(PHASE.COUNTDOWN)   // still the same play, just unstuck
  })

  it('does not fall over on a game with no room behind it', () => {
    expect(() => repairAfterResume(getGame(ROOM), g.io, 'nosuchroom')).not.toThrow()
  })

  it('does nothing at all for a missing state', () => {
    expect(repairAfterResume(null, g.io, ROOM)).toEqual([])
  })
})
