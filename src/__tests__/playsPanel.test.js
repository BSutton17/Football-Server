import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { clearAiSeats } from '../ai/seats.js'
import { createFakeIo } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// [authored] The player asking the AI what it would call — over the real socket handlers, against
// the real authored playbook, so this fails if the recommendation path is not actually reachable.

const ROOM = '9400'
const MID = 26.665

function human(io, id = 'humanA') {
  const emits = []
  const handlers = new Map()
  const s = {
    id,
    data: {},
    emits,
    on(event, fn) { handlers.set(event, fn) },
    emit(event, payload) { emits.push({ event, payload }) },
    join() {},
    to() { return { emit() {} } },
    fire(event, payload) { handlers.get(event)?.(payload); return handlers.has(event) },
    of(event) { return emits.filter(e => e.event === event) },
    last(event) { const m = s.of(event); return m.length ? m[m.length - 1].payload : null },
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
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed: 31337 })
  const mine = TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId)
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: mine })
  g = { io, you, state: getGame(ROOM) }
})
afterEach(cleanup)

// ⚠️ POSSESSION IS SET, NOT WAITED FOR. Role is derived from who has the ball, so at a fixed seed
// a test that skips itself when the human is on defense is a test that never runs — and half of
// these would have been quietly vacuous. Both sides are exercised every time instead.
const giveBallTo = (slot) => { getGame(ROOM).possession = slot }
const HUMAN = 0, AI = 1

describe('the offense asks for plays', () => {
  it('offers a shortlist with enough to put the play on the field', () => {
    giveBallTo(HUMAN)
    g.you.fire('request_plays')

    const offered = g.you.last('plays_offered')
    expect(offered).toBeTruthy()
    expect(offered.plays.length).toBeGreaterThan(0)

    for (const p of offered.plays) {
      expect(p.name).toBeTruthy()
      expect(p.formationName).toBeTruthy()
      expect(p.why).toBeTruthy()
      // ⚠️ THE LAYOUT IS THE POINT. A name the client cannot put on the field is a menu item that
      // does nothing — the server has no roster, so it owes the client a spot per slot.
      expect(p.layout.spots.length).toBeGreaterThan(0)
      for (const sp of p.layout.spots) {
        expect(typeof sp.x).toBe('number')
        expect(typeof sp.y).toBe('number')
        expect(['WR', 'TE', 'RB']).toContain(sp.label)
      }
    }
  })

  it('lays the play out on the hash the ball is actually on', () => {
    giveBallTo(HUMAN)
    const state = getGame(ROOM)
    state.ballX = 13
    g.you.fire('request_plays')

    const spots = g.you.last('plays_offered').plays[0].layout.spots
    // Everyone is placed relative to the ball, so the formation's centre travels with it.
    const centre = spots.reduce((a, s) => a + s.x, 0) / spots.length
    expect(Math.abs(centre - MID)).toBeGreaterThan(2)
  })

  it('offers pass plays — the run is already its own button', () => {
    giveBallTo(HUMAN)
    g.you.fire('request_plays')
    expect(g.you.last('plays_offered').plays.every(p => p.playType !== 'run')).toBe(true)
  })

  it('⚠️ REFUSES THE DEFENSE, because a shortlist of the offense’s plays is the play call', () => {
    // The defense never sees what the offense is running. That rule does not get an exception for
    // a convenience feature.
    giveBallTo(AI)
    g.you.fire('request_plays')
    expect(g.you.last('plays_offered')).toBeNull()
    expect(g.you.last('room_error')?.message).toMatch(/offense/i)
  })
})

describe('the defense asks for shells', () => {
  // Put a full offense on the field so there is a formation to read.
  function lineUpOffense() {
    const los = getGame(ROOM).yardLine
    const state = getGame(ROOM)
    // The AI has already lined up by now, so this replaces its formation rather than adding to it —
    // otherwise the personnel read comes back as six receivers.
    state.offensePlayers.clear()
    for (const [id, label, x] of [
      ['o_wr1', 'WR', MID - 18], ['o_wr2', 'WR', MID + 18], ['o_wr3', 'WR', MID + 11],
      ['o_te1', 'TE', MID - 6], ['o_rb1', 'RB', MID],
    ]) {
      state.offensePlayers.set(id, { id, x, y: los, label, team: 'o' })
    }
  }

  it('always offers one zone, one man and one blitz', () => {
    giveBallTo(AI)
    lineUpOffense()
    g.you.fire('request_shells')

    const offered = g.you.last('shells_offered')
    expect(offered).toBeTruthy()
    // ⚠️ Three shades of zone is a menu that looks like a choice and is not.
    expect(offered.shells.map(s => s.kind).sort()).toEqual(['blitz', 'man', 'zone'])
    for (const s of offered.shells) expect(s.why).toBeTruthy()
  })

  it('reads the personnel standing in front of it', () => {
    giveBallTo(AI)
    lineUpOffense()
    g.you.fire('request_shells')
    expect(g.you.last('shells_offered').look).toMatchObject({ wr: 3, te: 1, rb: 1, id: '3wr1te1rb' })
  })

  it('⚠️ REFUSES THE OFFENSE — and this is the rule that matters most', () => {
    // An offense that could ask for the defensive shortlist would be reading the defense's mind.
    giveBallTo(HUMAN)
    g.you.fire('request_shells')
    expect(g.you.last('shells_offered')).toBeNull()
    expect(g.you.last('room_error')?.message).toMatch(/defense/i)
  })

  it('⚠️ ALIGNS THE SHELL AGAINST THE OFFENSE THAT IS ACTUALLY THERE', () => {
    // The authored shell is where the eleven stand against nobody. Handing that over would give the
    // player a shape that looks right and is lined up against an offense that is not on the field —
    // so this goes through the same alignment layer the AI's own defense does.
    giveBallTo(AI)
    lineUpOffense()
    g.you.fire('request_shells')

    for (const s of g.you.last('shells_offered').shells) {
      expect(s.layout.spots.length).toBeGreaterThan(0)
      // No linemen: both sides auto-place the front already.
      expect(s.layout.spots.every(sp => sp.label !== 'DL')).toBe(true)
      for (const sp of s.layout.spots) {
        expect(typeof sp.x).toBe('number')
        expect(typeof sp.y).toBe('number')
        expect(['man', 'zone', 'rush', 'spy']).toContain(sp.job)
        // A zone always carries a real landmark: a null centre had the whole assignment refused,
        // which left that defender with no job — and the engine rushes anyone it has no job for.
        if (sp.job === 'zone') expect(typeof sp.zoneCenterX).toBe('number')
      }
    }
  })

  it('covers the receivers who are on the field, by their real ids', () => {
    giveBallTo(AI)
    lineUpOffense()
    g.you.fire('request_shells')

    const onField = new Set([...getGame(ROOM).offensePlayers.keys()])
    const manRows = g.you.last('shells_offered').shells
      .flatMap(s => s.layout.spots)
      .filter(sp => sp.job === 'man' && sp.covers)
    // Whoever is being covered has to be somebody who exists, or the client cannot assign it.
    for (const row of manRows) expect(onField.has(row.covers)).toBe(true)
  })

  it('never names the play, only the look', () => {
    giveBallTo(AI)
    lineUpOffense()
    // Whatever the offense has decided, the payload must not carry it.
    getGame(ROOM).playDesign = { playType: 'pass', players: [{ id: 'o_wr1', drawnRoute: [{ dx: 0, dd: 12 }] }] }
    g.you.fire('request_shells')

    const wire = JSON.stringify(g.you.last('shells_offered'))
    expect(wire).not.toMatch(/drawnRoute/)
    expect(wire).not.toMatch(/playDesign/)
  })
})
