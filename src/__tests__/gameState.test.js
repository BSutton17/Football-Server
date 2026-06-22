import { describe, it, expect } from '@jest/globals'
import { getLosY, yardLineFromAbsY, advanceDown, commitThrowTarget, resolveThrowTarget } from '../game/gameState.js'

// getLosY (yardLine → absolute y) and yardLineFromAbsY (absolute y → yardLine) are inverses.
// dir=+1: losY = 10 + yardLine.   dir=-1: losY = 110 - yardLine.

describe('yardLineFromAbsY ([162])', () => {
  it('inverts getLosY for a north-bound offense (dir = +1)', () => {
    const state = { direction: 1, yardLine: 30 }
    expect(getLosY(state)).toBe(40)
    expect(yardLineFromAbsY(state, getLosY(state))).toBeCloseTo(30, 6)
  })

  it('inverts getLosY for a south-bound offense (dir = -1)', () => {
    const state = { direction: -1, yardLine: 30 }
    expect(getLosY(state)).toBe(80)
    expect(yardLineFromAbsY(state, getLosY(state))).toBeCloseTo(30, 6)
  })

  it('yields the exact (fractional) yard line of a dead-ball spot, not a rounded one', () => {
    const state = { direction: 1, yardLine: 25 }       // LOS at absolute y = 35
    expect(yardLineFromAbsY(state, 47.4)).toBeCloseTo(37.4, 6)   // tackled 12.4 yds downfield
  })

  it('reports a spot in the offense own end zone as a negative yard line (safety)', () => {
    const state = { direction: 1, yardLine: 5 }
    expect(yardLineFromAbsY(state, 8)).toBeLessThan(0)    // y=8 is inside the 0–10 end zone
  })

  it('reports a spot in the opponent end zone as past 100 (touchdown)', () => {
    const state = { direction: 1, yardLine: 95 }
    expect(yardLineFromAbsY(state, 112)).toBeGreaterThan(100)   // y=112 is past the 110 goal line
  })
})

// The dead-ball spot drives the next line of scrimmage and the first-down measurement:
// advanceDown is fed the exact forward progress (spot yard line − old yard line).
describe('spotting the ball from the exact tackle location ([162])', () => {
  function spotAndAdvance(state, tackleAbsY) {
    const yardsGained = yardLineFromAbsY(state, tackleAbsY) - state.yardLine
    return advanceDown(state, yardsGained)
  }

  it('sets the new LOS to the exact spot when the runner falls short of the marker', () => {
    const state = { direction: 1, yardLine: 25, down: 1, distance: 10 }
    // LOS at y=35; tackled at y=41.2 → 6.2-yard gain.
    const result = spotAndAdvance(state, 41.2)
    expect(result).toBe('continue')
    expect(state.yardLine).toBeCloseTo(31.2, 6)   // spotted exactly where down
    expect(state.down).toBe(2)
    expect(state.distance).toBeCloseTo(3.8, 6)     // 10 − 6.2 still to go
  })

  it('awards a first down when the exact spot reaches the marker', () => {
    const state = { direction: 1, yardLine: 25, down: 2, distance: 10 }
    // LOS at y=35; tackled at y=47.4 → 12.4-yard gain, past the 10 to go.
    const result = spotAndAdvance(state, 47.4)
    expect(result).toBe('first_down')
    expect(state.yardLine).toBeCloseTo(37.4, 6)
    expect(state.down).toBe(1)
    expect(state.distance).toBe(10)
  })

  it('moves the LOS backward on a tackle for loss', () => {
    const state = { direction: 1, yardLine: 40, down: 1, distance: 10 }
    // LOS at y=50; tackled at y=47 → 3-yard loss.
    spotAndAdvance(state, 47)
    expect(state.yardLine).toBeCloseTo(37, 6)
    expect(state.distance).toBeCloseTo(13, 6)
  })
})

describe('commitThrowTarget — first tap wins, then locks ([165]/[166])', () => {
  it('the first tapped receiver becomes the throw target', () => {
    const state = { targetReceiverId: null }
    expect(commitThrowTarget(state, 'wr1')).toBe(true)
    expect(state.targetReceiverId).toBe('wr1')
  })

  it('ignores a later tap on a different receiver — the decision is locked', () => {
    const state = { targetReceiverId: null }
    commitThrowTarget(state, 'wr1')
    expect(commitThrowTarget(state, 'wr2')).toBe(false)   // extra input rejected
    expect(state.targetReceiverId).toBe('wr1')            // target unchanged
  })

  it('ignores a repeat tap on the same receiver (no re-commit)', () => {
    const state = { targetReceiverId: null }
    commitThrowTarget(state, 'wr1')
    expect(commitThrowTarget(state, 'wr1')).toBe(false)
    expect(state.targetReceiverId).toBe('wr1')
  })
})

describe('resolveThrowTarget — intended receiver & catch location ([167])', () => {
  function stateWith(...receivers) {
    const offensePlayers = new Map()
    for (const r of receivers) offensePlayers.set(r.id, r)
    return { offensePlayers }
  }

  it('aims the ball at the receiver position at the moment of the throw', () => {
    const state = stateWith({ id: 'wr1', label: 'WR', x: 31, y: 58 })
    expect(resolveThrowTarget(state, 'wr1')).toEqual({ receiverId: 'wr1', x: 31, y: 58 })
  })

  it('snapshots the catch location — later receiver movement does not change it', () => {
    const wr = { id: 'wr1', label: 'WR', x: 31, y: 58 }
    const state = stateWith(wr)
    const target = resolveThrowTarget(state, 'wr1')
    wr.x = 40; wr.y = 70   // receiver keeps running after the release
    expect(target).toEqual({ receiverId: 'wr1', x: 31, y: 58 })   // ball still headed to the release spot
  })

  it('returns null when the intended receiver is no longer on the field', () => {
    const state = stateWith({ id: 'wr1', label: 'WR', x: 31, y: 58 })
    expect(resolveThrowTarget(state, 'ghost')).toBeNull()
  })
})
