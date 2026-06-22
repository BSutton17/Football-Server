import { describe, it, expect } from '@jest/globals'
import { initLivePhase } from '../game/systems/init.js'
import { speedFromRating, getRatings } from '../data/ratings.js'

// initLivePhase annotates placed players with label/route and seeds RB run-start momentum.
function makeState({ playType = 'run', dir = 1, players = [] } = {}) {
  const offensePlayers = new Map()
  // Pre-place skill players the way place_player would (defaults to a dead stop).
  for (const p of players) {
    if (p.team === 'o' && p.label !== 'OL' && p.label !== 'QB') {
      offensePlayers.set(p.id, { id: p.id, x: p.x, y: p.y, vx: 0, vy: 0 })
    }
  }
  return { direction: dir, playDesign: { playType, players }, offensePlayers }
}

const RB_TOP = speedFromRating(getRatings('RB').speed)

describe('initLivePhase — RB run-start momentum ([159])', () => {
  it('starts the RB at half max speed downfield on a run play', () => {
    const state = makeState({ playType: 'run', dir: 1, players: [
      { team: 'o', id: 'rb', label: 'RB', x: 26, y: 20 },
    ] })

    initLivePhase(state)

    const rb = state.offensePlayers.get('rb')
    expect(rb.vy).toBeCloseTo(0.35 * RB_TOP, 5)   // 35% top speed, toward the offense's goal
    expect(rb.vx).toBe(0)
  })

  it('aims the run-start momentum the right way for a south-bound offense (dir = -1)', () => {
    const state = makeState({ playType: 'run', dir: -1, players: [
      { team: 'o', id: 'rb', label: 'RB', x: 26, y: 20 },
    ] })

    initLivePhase(state)

    expect(state.offensePlayers.get('rb').vy).toBeCloseTo(-0.35 * RB_TOP, 5)
  })

  it('does not pre-seed momentum on a pass play', () => {
    const state = makeState({ playType: 'pass', dir: 1, players: [
      { team: 'o', id: 'rb', label: 'RB', x: 26, y: 20 },
    ] })

    initLivePhase(state)

    expect(state.offensePlayers.get('rb').vy).toBe(0)
  })
})

describe('initLivePhase — press jam ([press])', () => {
  // dir=1, yardLine=25 → losY=35. A man corner jammed at the line in front of its receiver.
  function pressState({ cbY = 36, cbX = 26 } = {}) {
    const wr = { id: 'wr', label: 'WR', x: 26, y: 35, vx: 0, vy: 0 }
    const cb = { id: 'cb', label: 'CB', x: cbX, y: cbY, vx: 0, vy: 0 }
    return {
      direction: 1, yardLine: 25,
      playDesign: { playType: 'pass', players: [] },
      offensePlayers:  new Map([['wr', wr]]),
      defensePlayers:  new Map([['cb', cb]]),
      defenseCoverage: new Map([['cb', { type: 'man', targetId: 'wr' }]]),
      _wr: wr, _cb: cb,
    }
  }

  it('stuns the corner when its press loses to the receiver route running', () => {
    const state = pressState()
    initLivePhase(state)
    // CB press 78 < WR routeRunning 88 → CB stunned (88-78)/50 = 0.2s; the WR releases clean.
    expect(state._cb.stunTimer).toBeCloseTo(0.2, 5)
    expect(state._wr.stunTimer ?? 0).toBe(0)
  })

  it('does not jam a defender lined up off the LOS (not press)', () => {
    const state = pressState({ cbY: 42 })   // 7 yds off the line
    initLivePhase(state)
    expect(state._cb.stunTimer ?? 0).toBe(0)
    expect(state._wr.stunTimer ?? 0).toBe(0)
  })
})
