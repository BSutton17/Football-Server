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

// ── The other team going invisible ([pause repair]) ──────────────────────────
//
// ⚠️ "PAUSING AND UNPAUSING MAKES THE OTHER TEAM'S PLAYERS INVISIBLE BUT STILL THERE."
//
// Pre-snap positions reach a client ONLY as `player_placed` events, one per body, as they are placed.
// `game_state` does not carry them. So a client that dropped and rebuilt during the pause — which is
// what a paused game on a phone does the moment the socket goes — holds none of them, and nothing
// will ever re-send: the opponent has finished placing their eleven and will not touch them again,
// and the computer only realigns when the picture CHANGES. The other team is invisible for the rest
// of the down, while the server still has them, which is exactly the symptom reported.
//
// The client half of this (not wiping a formation on a resend of the SAME play) is in the Client
// repo's resync tests. This is the server half: the formation is put back on the wire.

describe('⚠️ THE FORMATION IS RE-SENT, BECAUSE game_state DOES NOT CARRY IT', () => {
  function withEleven(phase = PHASE.PRE_SNAP) {
    const st = getGame(ROOM)
    st.phase = phase
    st.decisionPending = false
    // Cleared first: locking a team already puts a formation on the grass, so counting emits without
    // this measured the room's own setup as well and read 15 where it expected 10.
    st.offensePlayers.clear()
    st.defensePlayers.clear()
    // Five a side is enough to tell "re-sent" from "sent nothing".
    for (let i = 0; i < 5; i++) {
      st.offensePlayers.set(`o${i}`, { id: `o${i}`, x: 5 + i * 8, y: 40, vx: 0, vy: 0, label: 'WR' })
      st.defensePlayers.set(`d${i}`, { id: `d${i}`, x: 6 + i * 8, y: 46, vx: 0, vy: 0, label: 'CB' })
    }
    return st
  }

  it('puts every body on the field back on the wire', () => {
    const st = withEleven()
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)

    const placed = g.io.of('player_placed')
    expect(placed.length).toBe(10)
    const ids = new Set(placed.map(p => p.payload.id))
    for (let i = 0; i < 5; i++) { expect(ids.has(`o${i}`)).toBe(true); expect(ids.has(`d${i}`)).toBe(true) }
  })

  it('⚠️ CARRIES THE LABEL — it is load-bearing, not decoration', () => {
    // Movement, ratings and the auto-rush all key off the label; a re-send without one would put a
    // defender back on the field who cannot be a pass rusher.
    const st = withEleven()
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)
    for (const { payload } of g.io.of('player_placed')) {
      expect(payload.label).toBeTruthy()
      expect(payload.team === 'o' || payload.team === 'd').toBe(true)
    }
  })

  it('⚠️ IN THE RELATIVE FRAME THE CLIENT RENDERS IN, not the simulation’s absolute y', () => {
    // The server stores absolute y (0 = back of the south end zone); clients render offense-relative.
    // Sending the raw value would put the whole formation ten yards off, which looks like a different
    // bug entirely.
    const st = withEleven()
    st.direction = 1
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)
    const one = g.io.of('player_placed').find(p => p.payload.id === 'o0')
    expect(one.payload.y).toBeCloseTo(40 - 10, 5)   // FIELD.END_ZONE_DEPTH
  })

  it('also re-sends during a countdown that is still counting — the formation is on the grass', () => {
    const st = withEleven(PHASE.COUNTDOWN)
    // ⚠️ The countdown must still have ticks left. With none, the repair re-sends the snap unlock —
    // and the computer, hearing it, snaps: the phase leaves COUNTDOWN before the re-send is reached
    // and nothing is sent at all. That is the repair working, not a fault, but it makes an expired
    // countdown the wrong place to assert this from.
    st.countdownTimers = [setTimeout(() => {}, 5000)]
    st.playClock = 4
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)
    for (const t of st.countdownTimers) clearTimeout(t)
    expect(st.phase).toBe(PHASE.COUNTDOWN)
    expect(g.io.of('player_placed').length).toBe(10)
  })

  it('sends nothing once the ball is live — positions come from the sim then', () => {
    // During a play the 20 Hz positions_update is the truth, and a stale pre-snap spot laid over it
    // would fight the simulation.
    const st = withEleven(PHASE.LIVE)
    g.io.clear()
    repairAfterResume(st, g.io, ROOM)
    expect(g.io.of('player_placed')).toEqual([])
  })

  it('a dead ball places the NEXT play’s formation, which is the repair working', () => {
    // Not a re-send: a dead ball with no timer left has the next play started for it, and starting a
    // play is what puts eleven fresh men on the field. Asserting silence here would be asserting that
    // the repair above does not happen.
    const st = withEleven(PHASE.DEAD)
    st.nextPlayTimer = null
    g.io.clear()
    const fixed = repairAfterResume(st, g.io, ROOM)
    expect(fixed).toContain('the next play had no timer left — started it')
    // …and whatever arrives describes the new play, not the five stand-ins put there above.
    const ids = new Set(g.io.of('player_placed').map(p => p.payload.id))
    expect(ids.has('o0')).toBe(false)
  })

  it('an empty field re-sends nothing rather than throwing', () => {
    const st = getGame(ROOM)
    st.phase = PHASE.PRE_SNAP
    st.offensePlayers.clear()
    st.defensePlayers.clear()
    g.io.clear()
    expect(() => repairAfterResume(st, g.io, ROOM)).not.toThrow()
    expect(g.io.of('player_placed')).toEqual([])
  })
})
