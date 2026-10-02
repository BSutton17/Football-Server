import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { createStats } from '../game/stats.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES, FIELD } from '../constants.js'

// ── [189] An interception that ends in the end zone is a touchback ───────────
//
// ⚠️ IT USED TO HAND YOU THE BALL ON YOUR OWN GOAL LINE. The spot is mirrored into the new offense's
// frame (100 − the old-frame spot), which is NEGATIVE in the end zone, and that was clamped to 0. So
// intercepting a pass in your own end zone — a good play — started your drive on the goal line with a
// safety one bad snap away.
//
// Reported as "an interception in the endzone should be a touchback and taken to the 20".

const DIR = 1
const EZ = FIELD.END_ZONE_DEPTH

let room = 0
function pickState(over = {}) {
  const roomId = `it-${room++}`
  leaveRoom('itA'); leaveRoom('itB')
  createRoom(roomId, 'itA'); joinRoom(roomId, 'itB')
  return {
    roomId, phase: PHASE.LIVE, direction: DIR, yardLine: 85, down: 2, distance: 8,
    possession: 0, score: [0, 0], stats: createStats(), pendingStaminaRecovery: 0,
    deadBallSpot: null, interceptionReturn: true, tackleEnqueued: false,
    ballCarrierId: 'cb1', statsWasPass: true, statsPasser: null, clockStopped: false,
    offensePlayers: new Map(),
    defensePlayers: new Map([['cb1', { id: 'cb1', label: 'CB', slot: 1, x: 26, y: 0 }]]),
    ...over,
  }
}

const mockIo = () => ({ to: () => ({ emit: () => {} }) })

// Absolute y for an offense-relative yard line, going north (direction 1).
const absFor = (yardLine) => yardLine + EZ

describe('a pick that ends in the end zone', () => {
  it('comes out to the 20, not the goal line', () => {
    const s = pickState()
    // Three yards deep in the end zone the offense was throwing into.
    enqueue(s.roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: absFor(103), interceptionReturn: true })
    processQueue(s.roomId, s, mockIo())

    expect(s.possession).toBe(1)                               // the ball changed hands
    expect(s.yardLine).toBe(RULES.TOUCHBACK_YARD_LINE)         // …at the 20
  })

  it('is a touchback right on the goal line too', () => {
    const s = pickState()
    enqueue(s.roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: absFor(100), interceptionReturn: true })
    processQueue(s.roomId, s, mockIo())
    expect(s.yardLine).toBe(RULES.TOUCHBACK_YARD_LINE)
  })

  // ⚠️ AND IT IS NOT A SAFETY. A defender who picks it off in the field of play and is dragged back
  // into his own end zone gets the same twenty — his own momentum does not concede two points.
  it('never gives up points', () => {
    const s = pickState()
    enqueue(s.roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: absFor(101), interceptionReturn: true })
    processQueue(s.roomId, s, mockIo())
    expect(s.score).toEqual([0, 0])
  })
})

describe('a pick that ends in the field of play', () => {
  // The return is live until contact, so running it OUT of the end zone is spotted where he is downed.
  it('is spotted where he was brought down, not at the 20', () => {
    const s = pickState()
    // Downed at the old offense's 92 → the new offense's own 8.
    enqueue(s.roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: absFor(92), interceptionReturn: true })
    processQueue(s.roomId, s, mockIo())

    expect(s.possession).toBe(1)
    expect(s.yardLine).toBeCloseTo(8, 6)
  })

  it('and a long return is spotted upfield, untouched by the rule', () => {
    const s = pickState()
    enqueue(s.roomId, EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: absFor(35), interceptionReturn: true })
    processQueue(s.roomId, s, mockIo())
    expect(s.yardLine).toBeCloseTo(65, 6)
  })
})
