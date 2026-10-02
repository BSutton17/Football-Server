import { describe, it, expect, afterEach } from '@jest/globals'
import { enqueue, processQueue, startNextPlay, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

// ── A period ends when the PLAY ends, not when the clock does ([216]) ───────
//
// ⚠️ THIS FILE ASSERTED THE OPPOSITE FOR AN UNKNOWN LENGTH OF TIME, AND NOTHING SAID SO.
//
// The engine used to kill a LIVE play the instant the clock struck zero — the ball in the air, a back
// running, the quarter simply cutting it off. Reported as "the game ends the quarter or goes to
// halftime in the middle of a play, after the ball has been snapped", and fixed: a down in progress is
// always completed. These tests were never updated, so four of them have been failing ever since.
//
// They were invisible because Jest silently under-collects test files in this repo (OneDrive
// placeholders report as symlinks and the crawler skips them). `npm test` cheerfully reported "70
// suites, 1280 tests, all passed" while the repo has 104 files and 1680 tests. ⚠️ CHECK THE COLLECTED
// COUNT: `ls src/__tests__/*.js | wc -l` against `jest --listTests | wc -l`, and run the suite with
// `--runTestsByPath $(ls src/__tests__/*.js | tr '\n' ' ')` when they disagree.
//
// So there are two paths to a period ending and BOTH are tested here now.
//
// The first half of the rule -- that a live down is not cut off -- is ALSO asserted in
// pauseAndQuarter.test.js, which is where it was added with the fix and which additionally pins
// `periodEndPending`. The duplication here is deliberate: this is the period-transition file and it
// should not describe half a rule. The genuinely new coverage below is the deferred RESOLUTION --
// quarter advance, half-time, game over, tie -- which had none outside the solo half-time case.

function mockIo(socketIds = []) {
  const emits = []
  const sockets = new Map()
  for (const id of socketIds) sockets.set(id, { data: { role: 'unset' } })
  return {
    emits,
    sockets: { sockets },
    to: (id) => ({ emit: (event, payload) => emits.push({ to: id, event, payload }) }),
  }
}

function state(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, quarter: 1, clock: 0, direction: 1,
    yardLine: 40, down: 3, distance: 4, possession: 0, score: [0, 0],
    pendingStaminaRecovery: 0, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

// A game registered in the real registry, which is what `startNextPlay` reads — it takes a roomId, not
// a state, so the deferred path cannot be driven with a loose object the way processQueue can.
const rooms = []
function registered(roomId, slots, over = {}) {
  leaveRoom(slots[0]); leaveRoom(slots[1])
  deleteGame(roomId)
  createRoom(roomId, slots[0]); joinRoom(roomId, slots[1])
  const s = initGame(roomId, 0, {})
  Object.assign(s, {
    phase: PHASE.DEAD, clock: 0, quarter: 1, direction: 1, yardLine: 40, down: 3, distance: 4,
    possession: 0, score: [0, 0], headless: true, nextPlayTimer: null, ...over,
  })
  rooms.push({ roomId, slots })
  return s
}

// ⚠️ A RESOLVED PERIOD BOOKS THE NEXT PLAY ON A TIMER, so without this Jest hangs for a second at the
// end of the run and warns about open handles — which is how a leaked timer reads from the outside.
afterEach(() => {
  for (const { roomId, slots } of rooms) {
    const s = getGame(roomId)
    if (s?.nextPlayTimer) clearTimeout(s.nextPlayTimer)
    deleteGame(roomId)
    leaveRoom(slots[0]); leaveRoom(slots[1])
  }
  rooms.length = 0
})

describe('the clock running out does not cut a live play off ([216])', () => {
  it('leaves the down alone and resolves nothing yet', () => {
    const s = state('q-live')
    const io = mockIo()
    enqueue('q-live', EVENT.CLOCK_EXPIRED, {})
    processQueue('q-live', s, io)

    expect(s.phase).toBe(PHASE.LIVE)      // the play is still being played
    expect(s.quarter).toBe(1)             // …and the period has not turned over
    expect(s.clock).toBe(0)
    expect(io.emits.filter(e => e.event === 'period_transition')).toHaveLength(0)
  })

  it('does not end the game early either, with the clock gone in the fourth', () => {
    const s = state('q-live-q4', { quarter: RULES.QUARTERS, score: [10, 7] })
    const io = mockIo()
    enqueue('q-live-q4', EVENT.CLOCK_EXPIRED, {})
    processQueue('q-live-q4', s, io)

    expect(s.phase).toBe(PHASE.LIVE)
    expect(io.emits.filter(e => e.event === 'game_over')).toHaveLength(0)
  })

  // Between plays there is no down to finish, so this one still resolves on the spot.
  it('still resolves immediately when the clock expires between plays', () => {
    const s = state('q-pre', { phase: PHASE.PRE_SNAP })
    enqueue('q-pre', EVENT.CLOCK_EXPIRED, {})
    expect(() => processQueue('q-pre', s, mockIo())).not.toThrow()
    expect(s.quarter).toBe(2)
    expect(s.phase).toBe(PHASE.DEAD)
  })
})

// ── The deferred resolution, which is the common one in a real game ─────────
//
// The play runs to its own whistle, books the ordinary dead-ball gap, and `startNextPlay` finds
// `clock <= 0` and resolves the period from there instead of lining up with a dead clock.
describe('the period turns over once the down is finished', () => {
  it('advances the quarter and preserves possession, field, down & distance', () => {
    const io = mockIo(['qA', 'qB'])
    const s = registered('q-next', ['qA', 'qB'])
    startNextPlay('q-next', io)

    // [transition screens] a normal quarter break sends both players the End-of-Quarter interstitial
    const pt = io.emits.find(e => e.event === 'period_transition')
    expect(pt?.payload).toMatchObject({ kind: 'quarter', endedQuarter: 1 })

    expect(s.quarter).toBe(2)
    expect(s.clock).toBe(RULES.QUARTER_SECONDS)
    expect(s.possession).toBe(0)        // carried over
    expect(s.yardLine).toBe(40)
    expect(s.down).toBe(3)
    expect(s.distance).toBe(4)
  })

  it('hands the second half to the team that opened on defense, 1st & 10 on the 30', () => {
    const io = mockIo(['hA', 'hB'])
    const s = registered('q-half', ['hA', 'hB'], {
      quarter: 2, direction: -1, possession: 0, openingPossession: 0,
      yardLine: 80, down: 3, distance: 4, score: [7, 3], ballX: 40,
    })
    startNextPlay('q-half', io)

    expect(s.quarter).toBe(3)
    expect(s.possession).toBe(1)        // opening-defense team receives the second half
    expect(s.direction).toBe(-1)        // possession 1 → direction -1
    expect(s.yardLine).toBe(30)         // ball spotted on the receiving team's own 30
    expect(s.down).toBe(1)
    expect(s.distance).toBe(10)
    expect(s.newDrive).toBe(true)
    expect(s.score).toEqual([7, 3])     // score preserved
    const pt = io.emits.find(e => e.event === 'period_transition')
    expect(pt?.payload).toMatchObject({ kind: 'halftime', endedQuarter: 2 })
  })

  it('does not flip direction or possession on a non-halftime quarter change', () => {
    const io = mockIo(['nA', 'nB'])
    const s = registered('q-plain', ['nA', 'nB'], { quarter: 1, direction: 1, possession: 0 })
    startNextPlay('q-plain', io)
    expect(s.direction).toBe(1)
    expect(s.possession).toBe(0)
  })
})

describe('game over ([219]/[220])', () => {
  it('ends the game after Q4 and sends each player the viewer-relative result', () => {
    const io = mockIo(['gA', 'gB'])
    const s = registered('q-over', ['gA', 'gB'], { quarter: RULES.QUARTERS, score: [10, 7] })
    expect(() => startNextPlay('q-over', io)).not.toThrow()

    expect(s.phase).toBe(PHASE.GAME_OVER)   // [219] terminal — no further snaps
    const go = io.emits.filter(e => e.event === 'game_over')
    expect(go).toHaveLength(2)
    // ⚠️ `toMatchObject`, NOT `toEqual`. The real payload also carries the box score, which the old
    // version of this test could not see: it built the state as a loose object with no `stats`, so it
    // asserted a payload shape production has never sent.
    expect(go.find(e => e.to === 'gA').payload).toMatchObject({ score: { offense: 10, defense: 7 }, result: 'win' })
    expect(go.find(e => e.to === 'gB').payload).toMatchObject({ score: { offense: 7, defense: 10 }, result: 'loss' })
    // The box score rides along with it, viewer-relative like the score ([stats]).
    const a = go.find(e => e.to === 'gA').payload
    expect(a.top).toBeDefined()
    expect(a.teams).toMatchObject({ yours: expect.any(Object), theirs: expect.any(Object) })
  })

  it('reports a tie when the scores are level ([220])', () => {
    const io = mockIo(['tA', 'tB'])
    registered('q-tie', ['tA', 'tB'], { quarter: RULES.QUARTERS, score: [14, 14] })
    startNextPlay('q-tie', io)

    const go = io.emits.filter(e => e.event === 'game_over')
    expect(go.find(e => e.to === 'tA').payload.result).toBe('tie')
    expect(go.find(e => e.to === 'tB').payload.result).toBe('tie')
  })
})
