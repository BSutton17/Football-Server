import { describe, it, expect } from '@jest/globals'
import { runTackleDetection } from '../game/systems/tackleDetection.js'
import { advance } from '../game/utils/movement.js'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'
import { FIELD, PLAYER } from '../constants.js'

// [out of bounds] Requested: "If a player is significantly over the white sideline call them out of
// bounds and down the ball there. A little overlap is fine but if they are actually on the border they
// are out of bounds. The clock should stop if there is less than 1 minute in the half." Before this a
// carrier could never reach the line at all — every body was clamped a radius inside it — so he ran up
// the sideline indefinitely, and the OUT_OF_BOUNDS handler was an empty stub nothing ever fired.

const map = (ps) => new Map(ps.map(p => [p.id, p]))
const noIo = { to: () => ({ emit: () => {} }) }
const enqueued = []

function detectState(carrierX) {
  return {
    roomId: 'OOB_DETECT', playDesign: { playType: 'run' }, ballCarrierId: null, tackleEnqueued: false,
    offensePlayers: map([{ id: 'rb', label: 'RB', x: carrierX, y: 50 }]),
    defensePlayers: map([{ id: 'lb', label: 'LB', x: 26, y: 70 }]),   // nobody near him
  }
}

describe('who is out', () => {
  it('a carrier on the border is out of bounds', () => {
    const s = detectState(0.1)
    runTackleDetection(s, null, 0.05, () => 1)
    expect(s.tackleEnqueued).toBe(true)
  })

  it('the far sideline counts too', () => {
    const s = detectState(FIELD.WIDTH - 0.1)
    runTackleDetection(s, null, 0.05, () => 1)
    expect(s.tackleEnqueued).toBe(true)
  })

  it('a little overlap with the white is still in play', () => {
    // Body edge 0.15 yd over the line: centre at 0.6, well short of the border.
    const s = detectState(0.6)
    runTackleDetection(s, null, 0.05, () => 1)
    expect(s.tackleEnqueued).toBe(false)
  })
})

describe('only the ball carrier can reach the line', () => {
  it('the carrier may step onto it; anyone else is held a body inside', () => {
    const carrier = { x: 1, y: 50, vx: -40, vy: 0, sidelineFree: true }
    const other   = { x: 1, y: 50, vx: -40, vy: 0, sidelineFree: false }
    advance(carrier, 0.1); advance(other, 0.1)
    expect(carrier.x).toBeLessThanOrEqual(PLAYER.OOB_INSET)
    expect(other.x).toBe(PLAYER.RADIUS)
  })
})

function oob(roomId, over = {}) {
  const state = {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: 'rb1', clockStopped: 'unset', quarter: 1, clock: 200,
    offensePlayers: map([{ id: 'rb1', label: 'RB', x: 0.1, y: 64 }]),
    defensePlayers: map([{ id: 'cb1', label: 'CB', x: 2, y: 64 }]),
    stats: null,
    ...over,
  }
  enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 0.1, y: 64, outOfBounds: true })
  processQueue(roomId, state, noIo)
  return state
}

describe('downed where he went out, and the clock', () => {
  it('is spotted at the crossing like a tackle (4-yard gain)', () => {
    const s = oob('oob-spot')
    expect(s.yardLine).toBe(54)
    expect(s.down).toBe(2)
  })

  it('keeps the clock running with more than a minute left', () => {
    expect(oob('oob-q1', { quarter: 1, clock: 50 }).clockStopped).toBe(false)     // not end of a half
    expect(oob('oob-q2-early', { quarter: 2, clock: 75 }).clockStopped).toBe(false)
  })

  it('stops the clock inside the last minute of EITHER half', () => {
    expect(oob('oob-q2-late', { quarter: 2, clock: 45 }).clockStopped).toBe(true)
    expect(oob('oob-q4-late', { quarter: 4, clock: 12 }).clockStopped).toBe(true)
  })
})
void enqueued
