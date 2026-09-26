import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createSoloRoom } from '../ai/solo.js'
import { getAiSeat, clearAiSeats } from '../ai/seats.js'
import { createFakeIo, stepTicks, runPlayToWhistle } from '../headless/harness.js'
import { getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { getGame, deleteGame } from '../game/gameState.js'
import { getTeamSelect, clearTeamSelect } from '../game/teamSelect.js'
import { getTokensByRoomId, invalidateSession } from '../game/sessionManager.js'
import { stopGameLoop } from '../game/simulation.js'
import { PHASE } from '../game/stateMachine.js'
import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'
import { TEAMS } from '../data/teams.js'

// [offline] End to end: a solo room with the heuristic AI in seat 1, played through the real
// engine with no sockets and no timers. This is the test that says the AI PLAYS, as opposed to the
// unit tests which only say it decides sensibly.
//
// Everything the AI does here goes through the ordinary handlers — place_player, assign_coverage,
// set_offense, snap_ball. If any of it were illegal the validators would refuse it and the field
// would come back empty, which is exactly what these assertions check.

const ROOM = '9100'

// A human's socket, wired to the same handlers a real connection gets.
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

const MID = 26.665

// The human's five skill players, dragged out one at a time exactly as a phone would. The AI
// defense lines up in response to these — with nothing on the field it correctly does nothing,
// which is what an earlier version of this test mistook for a bug.
function placeHumanOffense(you, losY) {
  const spots = [
    ['h_wr1', 'WR', MID - 18, losY],
    ['h_wr2', 'WR', MID + 18, losY],
    ['h_wr3', 'WR', MID + 11, losY - 1],
    ['h_te1', 'TE', MID - 6, losY],
    ['h_rb1', 'RB', MID, losY - 7],
  ]
  for (const [id, label, x, y] of spots) {
    you.fire('place_player', { id, x, y, label, team: 'o' })
  }
  return spots
}

function humanFormation(losY, extra = []) {
  return [
    { id: 'auto_ol_lt', x: MID - 3.5, y: losY - 1, team: 'o', label: 'OL' },
    { id: 'auto_ol_lg', x: MID - 1.75, y: losY - 1, team: 'o', label: 'OL' },
    { id: 'auto_ol_c', x: MID, y: losY - 1, team: 'o', label: 'OL' },
    { id: 'auto_ol_rg', x: MID + 1.75, y: losY - 1, team: 'o', label: 'OL' },
    { id: 'auto_ol_rt', x: MID + 3.5, y: losY - 1, team: 'o', label: 'OL' },
    { id: 'auto_qb', x: MID, y: losY - 6, team: 'o', label: 'QB' },
    ...extra,
  ]
}

// Stands up a solo game and gets it to the first live pre-snap.
function startGame(seed = 424242) {
  const io = createFakeIo()
  const you = human(io)
  const solo = createSoloRoom(io, you, { roomId: ROOM, mode: 'automatic', seed })

  // Pick a team that is not the one the computer locked, then lock it — that starts the game.
  const mine = TEAMS.map(t => t.id).find(id => id !== solo.aiTeamId)
  you.data.roomId = ROOM
  you.fire('lock_team', { teamId: mine })

  return { io, you, solo, ai: getAiSeat(solo.aiSocketId), state: getGame(ROOM) }
}

let g
beforeEach(() => {
  cleanup()
  g = startGame()
  // If the human has the ball, line up — the AI defense responds to what it can see.
  if (g.state.possession === 0) placeHumanOffense(g.you, g.state.yardLine)
})
afterEach(cleanup)

describe('the AI takes the field', () => {
  it('the game starts with both seats and a live state', () => {
    expect(g.state).toBeTruthy()
    expect(g.state.phase).toBe(PHASE.PRE_SNAP)
    expect(g.state.teams.filter(Boolean)).toHaveLength(2)
  })

  it('puts eleven men on the field on whichever side it is', () => {
    const aiIsOffense = g.state.possession === 1
    const mine = aiIsOffense ? g.state.offensePlayers : g.state.defensePlayers

    if (aiIsOffense) {
      // The offense places its five skill players and ships the line in set_offense, so the map
      // only fills once the formation is locked — which the AI does in the same breath.
      expect(g.state.playDesign).toBeTruthy()
      expect(g.state.playDesign.players.length).toBe(11)
    } else {
      expect(mine.size).toBe(11)   // seven in coverage plus the four down linemen it sends itself
    }
  })

  it('gives every coverage player it places a real assignment', () => {
    if (g.state.possession === 1) return   // the AI is on offense this time; nothing to check

    // ⚠️ SEVEN OR EIGHT, NOT ALWAYS SEVEN. A four-man front leaves seven behind it and a
    // three-man front eight, and the authored playbook has both. What must always hold is that
    // every defender who is NOT a lineman has a real assignment, and that nobody has one who is
    // no longer on the field.
    const cover = [...g.state.defensePlayers.values()].filter(p => p.label !== 'DL')
    expect(g.state.defenseCoverage.size).toBe(cover.length)
    expect(g.state.defenseCoverage.size).toBeGreaterThanOrEqual(7)
    expect(g.state.defenseCoverage.size).toBeLessThanOrEqual(8)
    for (const id of g.state.defenseCoverage.keys()) {
      expect(g.state.defensePlayers.has(id)).toBe(true)
    }
    const legal = new Set(['man', 'zone', 'blitz', 'spy'])
    for (const [id, cov] of g.state.defenseCoverage) {
      expect({ id, type: cov.type, ok: legal.has(cov.type) }).toEqual({ id, type: cov.type, ok: true })
      if (cov.type === 'man') expect(cov.targetId).toBeTruthy()
      if (cov.type === 'zone') expect(cov.zoneType).toBeTruthy()
    }
  })

  it('places everyone inside the legal box — nothing was silently refused', () => {
    const losAbs = 10 + g.state.yardLine
    for (const p of g.state.defensePlayers.values()) {
      expect({ id: p.id, onside: p.y >= losAbs }).toEqual({ id: p.id, onside: true })
    }
    for (const p of g.state.offensePlayers.values()) {
      expect({ id: p.id, onside: p.y <= losAbs }).toEqual({ id: p.id, onside: true })
    }
  })

  it('leaves no COVERAGE player without an assignment, and every lineman without one', () => {
    if (g.state.possession === 1) return
    // The engine treats a defender with no assignment as a pass rusher, which is exactly right for
    // the four down linemen and exactly wrong for anybody else — an unassigned corner is a hole in
    // the coverage that sprints at the quarterback.
    for (const p of g.state.defensePlayers.values()) {
      const shouldRush = p.label === 'DL'
      expect({ id: p.id, assigned: g.state.defenseCoverage.has(p.id) })
        .toEqual({ id: p.id, assigned: !shouldRush })
    }
  })
})

describe('a whole play runs', () => {
  // Drives whichever side the human is on just enough to get the ball snapped, then lets the
  // engine run the play out.
  function snapAndRun() {
    const state = getGame(ROOM)
    const humanIsOffense = state.possession === 0

    if (humanIsOffense) {
      const los = state.yardLine
      const skill = [...state.offensePlayers.values()]
        .filter(p => ['WR', 'TE', 'RB'].includes(p.label))
        .map(p => ({ id: p.id, x: p.x, y: los - Math.abs(los - (p.y - 10)), team: 'o', label: p.label, route: 'curl' }))
      g.you.fire('set_offense', {
        playSerial: state.playSerial ?? 0, playType: 'pass', runAngle: 0,
        players: humanFormation(los, skill),
      })
      g.you.fire('snap_ball')
    } else {
      // The AI is the offense: it has already set. The snap is its call, so fire its own path.
      g.ai.fire('snap_ball')
    }
    return getGame(ROOM)
  }

  it('reaches LIVE and runs to a whistle', () => {
    const before = getGame(ROOM)
    expect(before.phase).toBe(PHASE.PRE_SNAP)

    snapAndRun()
    const state = getGame(ROOM)
    expect(state.phase).toBe(PHASE.LIVE)

    const { ticks } = runPlayToWhistle(ROOM, g.io, { maxTicks: 800 })
    expect(ticks).toBeGreaterThan(0)
    expect(getGame(ROOM).phase).not.toBe(PHASE.LIVE)
  })

  it('players actually move once it is live', () => {
    snapAndRun()
    const state = getGame(ROOM)
    const before = [...state.defensePlayers.values()].map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|')
    stepTicks(ROOM, g.io, 20)
    const after = [...getGame(ROOM).defensePlayers.values()].map(p => `${p.x.toFixed(2)},${p.y.toFixed(2)}`).join('|')
    expect(after).not.toBe(before)
  })

  it('the AI never has an action refused', () => {
    snapAndRun()
    runPlayToWhistle(ROOM, g.io, { maxTicks: 800 })
    // A rejected action emits room_error back at the actor. The AI's inbox is its controller, so a
    // refusal shows up as an emit aimed at its socket id.
    const refusals = g.io.emits.filter(e => e.event === 'room_error' && String(e.target).startsWith('ai:'))
    expect(refusals.map(r => r.payload?.message)).toEqual([])
  })
})

describe('the ball is on a hash, not in the middle', () => {
  // ⚠️ The AI hardcoded the field middle for its formation, its line, and its defensive front.
  // The ball is spotted on a HASH that moves laterally all game, so the client drew the offensive
  // line on the hash while the server simulated it up to thirteen yards away — the line visibly
  // JUMPED at the snap, and a defense correctly lined up on the hash faced nobody.
  const MIDDLE = 26.665

  function relocateBall(toX) {
    const state = getGame(ROOM)
    state.ballX = toX
    // A fresh play on the new hash.
    state.playSerial = (state.playSerial ?? 0) + 1
    const ai = getAiSeat(g.solo.aiSocketId)
    ai.emit('game_state', {
      phase: 'pre_snap', role: state.possession === 1 ? 'offense' : 'defense',
      down: 1, distance: 10, yardLine: state.yardLine, ballX: toX,
      clock: 600, playClock: 4, quarter: 1, score: { own: 0, opp: 0 },
      mode: 'automatic', difficulty: 'easy', playSerial: state.playSerial,
    })
    ai.emit('play_clock_update', { playClock: 3 })
    return state
  }

  it('lines the offense up on the hash the ball is actually on', () => {
    const state = getGame(ROOM)
    if (state.possession !== 1) return    // the AI is on defense this run

    const HASH = 40
    relocateBall(HASH)
    const design = getGame(ROOM).playDesign
    expect(design).toBeTruthy()

    const centre = design.players.find(p => p.id === 'auto_ol_c')
    expect(centre).toBeTruthy()
    expect(Math.abs(centre.x - HASH)).toBeLessThan(1)
    expect(Math.abs(centre.x - MIDDLE)).toBeGreaterThan(10)   // …and NOT the middle

    const qb = design.players.find(p => p.id === 'auto_qb')
    expect(Math.abs(qb.x - HASH)).toBeLessThan(1)
  })

  it('lines the defensive front up on the hash too', () => {
    const state = getGame(ROOM)
    if (state.possession === 1) return    // the AI is on offense this run

    const HASH = 13
    relocateBall(HASH)
    // Give it an offense to line up against on the new hash.
    // ⚠️ SPLIT TOWARD THE FIELD. `HASH - 15` is x = -2 on this hash, which place_player refuses, so
    // the wideout the defense was supposed to be lining up against never reached the field at all.
    for (const [id, label, x] of [['o_wr1', 'WR', HASH - 8], ['o_wr2', 'WR', HASH + 20], ['o_te1', 'TE', HASH + 6], ['o_rb1', 'RB', HASH]]) {
      g.you.fire('place_player', { id, x, y: getGame(ROOM).yardLine, label, team: 'o' })
    }

    // ⚠️ THE FRONT IS NO LONGER ALWAYS FOUR. An authored 3-4 or 3-3-5 fields three linemen and
    // eight behind them; asserting four here was asserting that the hand-written shells were the
    // only ones that existed. What must hold either way is that the front lines up ON THE BALL.
    const front = [...getGame(ROOM).defensePlayers.values()].filter(p => p.label === 'DL')
    expect(front.length).toBeGreaterThanOrEqual(3)
    expect(front.length).toBeLessThanOrEqual(4)
    const centreOfFront = front.reduce((a, p) => a + p.x, 0) / front.length
    expect(Math.abs(centreOfFront - HASH)).toBeLessThan(1.5)
    expect(Math.abs(centreOfFront - MIDDLE)).toBeGreaterThan(10)
  })

  it('⚠️ PULLS A LINEMAN WHEN THE FRONT SHRINKS, instead of leaving him where he stood', () => {
    // A four-man front going to a three-man one places DL1-3 and says nothing about DL4. Left on
    // the field he still counts toward the eleven and still rushes, and after the ball moves he is
    // standing at the OLD hash — which is how this was found: a front whose centre was four yards
    // off the ball because a stranded lineman was dragging the average across the field.
    const state = getGame(ROOM)
    if (state.possession === 1) return

    // The defense re-aligns when the OFFENSE moves, not when the ball does, so the ball is moved
    // and then an offense is put down in front of it — which is what a real drive does too.
    relocateBall(13)
    for (const [id, label, x] of [['s_wr1', 'WR', 5], ['s_wr2', 'WR', 33], ['s_te1', 'TE', 19], ['s_rb1', 'RB', 13]]) {
      g.you.fire('place_player', { id, x, y: getGame(ROOM).yardLine, label, team: 'o' })
    }

    const linemen = [...getGame(ROOM).defensePlayers.values()].filter(p => p.label === 'DL')
    // Whatever the shell fields, every lineman on the field belongs to the CURRENT front: nobody is
    // sitting more than a few yards from the ball.
    for (const dl of linemen) expect(Math.abs(dl.x - 13)).toBeLessThan(6)
    expect(getGame(ROOM).defensePlayers.size).toBe(11)
  })
})

describe('motion — the defense follows a receiver that moves', () => {
  it('re-aligns when the offense shifts, without changing the call', () => {
    const state = getGame(ROOM)
    if (state.possession === 1) return    // AI is on offense; nothing to follow

    const controller = getAiSeat(g.solo.aiSocketId)
    const callBefore = JSON.stringify(g.io.emits.length)

    // The human drags a receiver clear across the formation.
    const los = state.yardLine
    g.you.fire('place_player', { id: 'mover1', x: 6, y: los, label: 'WR', team: 'o' })
    const spotsA = [...getGame(ROOM).defensePlayers.values()].map(p => p.x.toFixed(2)).join('|')

    g.you.fire('place_player', { id: 'mover1', x: 46, y: los, label: 'WR', team: 'o' })
    const spotsB = [...getGame(ROOM).defensePlayers.values()].map(p => p.x.toFixed(2)).join('|')

    expect(spotsB).not.toBe(spotsA)
    expect(callBefore).toBeTruthy()
  })
})
