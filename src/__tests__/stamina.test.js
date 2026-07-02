import { describe, it, expect } from '@jest/globals'
import { drainStamina, applyTackleStamina } from '../game/systems/stamina.js'

// [fatigue effort] Drain scales with effort (movement speed + role), and contact (tackles) costs a
// one-time hit. Each comparison holds the position label fixed so only the effort factor differs.

function baseState(over = {}) {
  return {
    possession: 0,
    playerFatigue: new Map(),
    offensePlayers: new Map(),
    defensePlayers: new Map(),
    playDesign: { playType: 'pass' },
    ballCarrierId: null,
    ...over,
  }
}
const lost = (state, id) => 100 - (state.playerFatigue.get(id)?.stamina ?? 100)

describe('effort-based stamina drain', () => {
  it('a sprinting player drains more than one standing still', () => {
    const sprint = { id: 'wr1', label: 'WR', x: 26, y: 60, vx: 0, vy: 8 }
    const idle   = { id: 'wr2', label: 'WR', x: 30, y: 60, vx: 0, vy: 0 }
    const state = baseState({ offensePlayers: new Map([['wr1', sprint], ['wr2', idle]]) })
    drainStamina(state, null, 1)
    expect(lost(state, 'wr1')).toBeGreaterThan(lost(state, 'wr2'))
  })

  it('the ball carrier drains more than a teammate at the same speed', () => {
    const carrier = { id: 'rb1', label: 'RB', x: 26, y: 60, vx: 0, vy: 8 }
    const other   = { id: 'rb2', label: 'RB', x: 30, y: 60, vx: 0, vy: 8 }
    const state = baseState({
      offensePlayers: new Map([['rb1', carrier], ['rb2', other]]),
      playDesign: { playType: 'run' },
      ballCarrierId: 'rb1',
    })
    drainStamina(state, null, 1)
    expect(lost(state, 'rb1')).toBeGreaterThan(lost(state, 'rb2'))
  })

  it('a blocker drains less than a runner at the same speed', () => {
    const blocker = { id: 'te1', label: 'TE', x: 26, y: 60, vx: 0, vy: 8, route: 'block' }
    const runner  = { id: 'te2', label: 'TE', x: 30, y: 60, vx: 0, vy: 8 }
    const state = baseState({ offensePlayers: new Map([['te1', blocker], ['te2', runner]]) })
    drainStamina(state, null, 1)
    expect(lost(state, 'te1')).toBeLessThan(lost(state, 'te2'))
  })

  it('linemen never accumulate fatigue', () => {
    const ol = { id: 'ol1', label: 'OL', x: 26, y: 58, vx: 0, vy: 5 }
    const state = baseState({ offensePlayers: new Map([['ol1', ol]]) })
    drainStamina(state, null, 1)
    expect(state.playerFatigue.has('ol1')).toBe(false)
  })
})

describe('contact stamina cost — a tackle', () => {
  it('tires the ball carrier and the nearest defender, but not a far one', () => {
    const state = baseState({
      offensePlayers: new Map([['rb1', { id: 'rb1', label: 'RB', x: 26, y: 60 }]]),
      defensePlayers: new Map([
        ['lb1', { id: 'lb1', label: 'LB', x: 26.5, y: 60.5 }],   // closest to the spot
        ['cb1', { id: 'cb1', label: 'CB', x: 50,   y: 20   }],   // far away
      ]),
      playerFatigue: new Map([
        ['rb1', { stamina: 100, label: 'RB', slot: 0 }],
        ['lb1', { stamina: 100, label: 'LB', slot: 1 }],
        ['cb1', { stamina: 100, label: 'CB', slot: 1 }],
      ]),
    })
    applyTackleStamina(state, 'rb1', 26, 60)
    expect(lost(state, 'rb1')).toBeGreaterThan(0)   // carrier absorbed the hit
    expect(lost(state, 'lb1')).toBeGreaterThan(0)   // nearest defender made the tackle
    expect(lost(state, 'cb1')).toBe(0)              // far defender unaffected
  })
})
