import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'

// [204] Clock stop/continue rules + [201] sacks are running-clock + [202] safety framework.
// We assert the clockStopped flag each play result leaves behind (the simulation ticks the
// game clock between plays only when clockStopped is false).

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

const noIo = { to: () => ({ emit: () => {} }) }

function baseState(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: null,
    clockStopped: 'unset',   // sentinel so we can prove the handler set it explicitly
    offensePlayers: makeMap([]), defensePlayers: makeMap([]),
    ...over,
  }
}

function run(roomId, type, payload, over) {
  const state = baseState(roomId, over)
  enqueue(roomId, type, payload)
  processQueue(roomId, state, noIo)
  return state
}

describe('clock keeps running ([201]/[204])', () => {
  it('an in-bounds tackle (down still left) keeps the clock running', () => {
    // LOS abs y = 60 (yardLine 50). Tackle at y=65 → 5-yard gain, still 2nd down.
    const s = run('clk-tackle', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 65 })
    expect(s.clockStopped).toBe(false)
    expect(s.down).toBe(2)
  })

  it('a sack keeps the clock running ([201])', () => {
    // QB at y=53, LOS y=60 → 7-yard loss, 2nd down.
    const s = run('clk-sack', EVENT.SACK, { qbY: 53, losY: 60, dir: 1 })
    expect(s.clockStopped).toBe(false)
    expect(s.down).toBe(2)
  })
})

describe('clock stops ([204])', () => {
  it('an incompletion stops the clock', () => {
    const s = run('clk-incomplete', EVENT.PASS_INCOMPLETE, {})
    expect(s.clockStopped).toBe(true)
  })

  it('a turnover on downs (4th-down tackle short) stops the clock', () => {
    const s = run('clk-tod', EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 62 }, { down: 4, distance: 5 })
    expect(s.clockStopped).toBe(true)
    expect(s.possession).toBe(1)
  })

  it('an interception (change of possession) stops the clock', () => {
    const s = run('clk-int', EVENT.TACKLE, { carrierId: 'cb1', x: 26, y: 40, interceptionReturn: true }, {
      interceptionReturn: true, ballCarrierId: 'cb1',
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 26, y: 40 }]),
    })
    expect(s.clockStopped).toBe(true)
    expect(s.possession).toBe(1)
  })

  it('a touchdown stops the clock', () => {
    const s = run('clk-td', EVENT.TOUCHDOWN, { scoringSlot: 0, x: 26, y: 111 })
    expect(s.clockStopped).toBe(true)
  })
})

// [202] Safety framework — foundation for scoring/possession.
describe('safety framework ([202])', () => {
  it('awards 2 points to the other team, turns the ball over, and stops the clock', () => {
    const s = run('safety-1', EVENT.SAFETY, { safetySlot: 0 })
    expect(s.score[1]).toBe(2)        // the non-conceding team scores
    expect(s.possession).toBe(1)      // and takes possession
    expect(s.clockStopped).toBe(true)
    expect(s.down).toBe(1)
    expect(s.distance).toBe(10)
  })
})
