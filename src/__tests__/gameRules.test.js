import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'

// [210] Football rules, verified end-to-end through the event queue: first downs, turnover on
// downs, touchdowns, sacks, and clock stop/continue behavior.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}
const noIo = { to: () => ({ emit: () => {} }) }

function liveState(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: null, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

describe('first downs ([197]/[198])', () => {
  it('a gain past the marker resets to 1st & 10 and keeps possession', () => {
    // LOS abs y = 60 (yardLine 50), 2nd & 8. Tackled at y=72 → 12-yard gain.
    const s = liveState('gr-fd', { down: 2, distance: 8 })
    enqueue('gr-fd', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 72 })
    processQueue('gr-fd', s, noIo)
    expect(s.down).toBe(1)
    expect(s.distance).toBe(10)
    expect(s.yardLine).toBeCloseTo(62, 6)
    expect(s.possession).toBe(0)
  })

  it('a gain short of the marker just advances the down', () => {
    const s = liveState('gr-short', { down: 1, distance: 10 })
    enqueue('gr-short', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 64 })  // +4
    processQueue('gr-short', s, noIo)
    expect(s.down).toBe(2)
    expect(s.distance).toBeCloseTo(6, 6)
  })
})

describe('turnover on downs ([199]/[200])', () => {
  it('a 4th-down failure flips possession at the spot', () => {
    const s = liveState('gr-tod', { down: 4, distance: 5, yardLine: 60 })
    // LOS y=70; tackled at y=72 → +2, short of 5 to go.
    enqueue('gr-tod', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 72 })
    processQueue('gr-tod', s, noIo)
    expect(s.possession).toBe(1)
    expect(s.direction).toBe(-1)
    expect(s.yardLine).toBeCloseTo(38, 6)   // spot rel 62 → 100−62 for the new offense
    expect(s.down).toBe(1)
    expect(s.distance).toBe(10)
  })
})

describe('touchdowns ([194]/[195])', () => {
  it('[51] crossing the goal line scores 6 and arms the extra-point try', () => {
    const s = liveState('gr-td', { yardLine: 98, ballCarrierId: 'rb1',
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 111 }]) })
    enqueue('gr-td', EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    processQueue('gr-td', s, noIo)
    expect(s.score[0]).toBe(6)
    expect(s.possession).toBe(0)            // scorer keeps the ball for the try
    expect(s.conversionPending).toBe(true)
  })
})

describe('sacks ([201])', () => {
  it('records the yardage loss, advances the down, and keeps the clock running', () => {
    const s = liveState('gr-sack', { down: 1, distance: 10, yardLine: 50 })
    // LOS y=60; QB sacked at y=54 → 6-yard loss.
    enqueue('gr-sack', EVENT.SACK, { qbY: 54, losY: 60, dir: 1 })
    processQueue('gr-sack', s, noIo)
    expect(s.yardLine).toBeCloseTo(44, 6)   // 50 − 6
    expect(s.distance).toBeCloseTo(16, 6)   // 10 + 6 to go
    expect(s.down).toBe(2)
    expect(s.clockStopped).toBe(false)      // in-bounds → running clock
  })
})

describe('clock behavior ([204])', () => {
  it('an incompletion stops the clock; an in-bounds tackle keeps it running', () => {
    const inc = liveState('gr-clk-inc')
    enqueue('gr-clk-inc', EVENT.PASS_INCOMPLETE, {})
    processQueue('gr-clk-inc', inc, noIo)
    expect(inc.clockStopped).toBe(true)

    const tkl = liveState('gr-clk-tkl', { offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 64 }]) })
    enqueue('gr-clk-tkl', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 64 })
    processQueue('gr-clk-tkl', tkl, noIo)
    expect(tkl.clockStopped).toBe(false)
  })
})
