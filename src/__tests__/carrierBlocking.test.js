import { describe, it, expect } from '@jest/globals'
import { runMovement } from '../game/systems/movement.js'

// [carrier blocking] Non-carrier skill players (WR / TE / extra RB) block FOR the ball carrier —
// on a designed run, and after a catch for the yards that follow it. The two rules that make it
// look like blocking rather than milling about:
//   • threats are ranked by the DEFENDER'S distance to the CARRIER, not to the blocker
//   • targets are CLAIMED, so two receivers can't drive the same man while a third comes free
//
// dir=+1, yardLine=25 → losY=35; the offense runs north (increasing y).

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], playType = 'run', ballCarrierId = null, catchSpot = null } = {}) {
  return {
    direction: 1,
    yardLine: 25,
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    defenseCoverage: new Map(),
    playerFatigue: new Map(),
    playDesign: { playType },
    ballCarrierId,
    catchSpot,
  }
}

const wr  = (id, x, y) => ({ id, label: 'WR', x, y, vx: 0, vy: 0, isEngaged: false })
const te  = (id, x, y) => ({ id, label: 'TE', x, y, vx: 0, vy: 0, isEngaged: false })
const rb  = (id, x, y) => ({ id, label: 'RB', x, y, vx: 0, vy: 6, isEngaged: false })
const ol  = (id, x, y = 35) => ({ id, label: 'OL', x, y, vx: 0, vy: 0, isEngaged: false, passBlockAnchorX: null, passBlockAnchorY: null })
const cb  = (id, x, y) => ({ id, label: 'CB', x, y, vx: 0, vy: 0, isEngaged: false })

describe('carrier blocking — target selection', () => {
  it('a receiver takes the defender nearest the CARRIER, not the one nearest itself', () => {
    const back = rb('rb1', 26, 36)
    const w    = wr('wr1', 40, 45)
    // near: 3 yards from the WR but 15 from the back. threat: right on top of the back.
    const near   = cb('near',   43, 45)
    const threat = cb('threat', 27, 39)
    const state = makeState({ offense: [back, w], defense: [near, threat], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(w.carrierBlockId).toBe('threat')
  })

  it('two receivers never claim the same man', () => {
    const back = rb('rb1', 26, 36)
    const a = wr('wr1', 24, 42)
    const b = wr('wr2', 28, 42)
    const only  = cb('d1', 26, 40)
    const other = cb('d2', 30, 44)
    const state = makeState({ offense: [back, a, b], defense: [only, other], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(a.carrierBlockId).not.toBe(b.carrierBlockId)
    expect(new Set([a.carrierBlockId, b.carrierBlockId])).toEqual(new Set(['d1', 'd2']))
  })

  it('leaves a defender the line already has to the line', () => {
    const back = rb('rb1', 26, 36)
    const w    = wr('wr1', 30, 41)
    const lineman = ol('ol1', 26, 35)
    const dt   = { id: 'dt1', label: 'DL', x: 26, y: 37, vx: 0, vy: 0, isEngaged: false }
    const free = cb('cb1', 33, 43)
    const state = makeState({ offense: [back, w, lineman], defense: [dt, free], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(lineman.blockAssignmentId).toBe('dt1')   // the line has the DT…
    expect(w.carrierBlockId).toBe('cb1')            // …so the WR takes the free man
  })

  it('a blocker with nobody in range leads out in front of the carrier', () => {
    const back = rb('rb1', 26, 36)
    const w    = wr('wr1', 44, 40)
    const far  = cb('cb1', 10, 80)   // way outside both radii
    const state = makeState({ offense: [back, w], defense: [far], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(w.carrierBlockId).toBeFalsy()
    expect(w.vy).toBeGreaterThan(0)              // pressing upfield ahead of the back
    expect(w.vx).toBeLessThan(0)                 // …and back toward the carrier's lane
  })
})

describe('carrier blocking — when it applies', () => {
  it('applies after a catch (YAC), not while the ball is still in the air', () => {
    const catcher = { id: 'wr1', label: 'WR', x: 30, y: 48, vx: 0, vy: 7, isEngaged: false }
    const other   = { id: 'wr2', label: 'WR', x: 40, y: 50, vx: 0, vy: 6, isEngaged: false, route: 'go' }
    const d       = cb('cb1', 32, 52)

    // Ball in the air: the second receiver is still running its route.
    const air = makeState({ offense: [catcher, other], defense: [d], playType: 'pass' })
    runMovement(air, null, DT)
    expect(other.carrierBlockId).toBeFalsy()

    // Caught: it converts to a blocker.
    const caught = makeState({
      offense: [catcher, other], defense: [d], playType: 'pass',
      ballCarrierId: 'wr1', catchSpot: { x: 30, y: 48 },
    })
    runMovement(caught, null, DT)
    expect(other.carrierBlockId).toBe('cb1')
  })

  it('does not block for a defender returning an interception', () => {
    const w = wr('wr1', 30, 48)
    const picker = { id: 'cb1', label: 'CB', x: 30, y: 50, vx: 0, vy: -7, isEngaged: false }
    const state = makeState({
      offense: [w], defense: [picker], playType: 'pass',
      ballCarrierId: 'cb1', catchSpot: { x: 30, y: 50 },
    })

    runMovement(state, null, DT)

    expect(w.carrierBlockId).toBeFalsy()
  })
})

describe('carrier blocking — detached TE', () => {
  it('a split TE blocks for the carrier instead of being clamped into the line', () => {
    const back = rb('rb1', 26, 36)
    const line = [ol('olA', 23), ol('olB', 26), ol('olC', 29)]
    const split = te('te1', 44, 35)          // way outside the tackles
    const edge  = cb('cb1', 40, 41)
    const state = makeState({ offense: [back, ...line, split], defense: [edge], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(split.teInline).toBe(false)
    expect(split.blockAssignmentId).toBeFalsy()   // not folded into the line's scheme
    expect(split.carrierBlockId).toBe('cb1')
  })

  it('an attached TE still blocks inside the line’s coordinated scheme', () => {
    const back = rb('rb1', 26, 36)
    const line = [ol('olA', 23), ol('olB', 26), ol('olC', 29)]
    const inline = te('te1', 31, 35)         // just outside the right tackle
    const front  = { id: 'dl1', label: 'DL', x: 31, y: 37, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [back, ...line, inline], defense: [front], ballCarrierId: 'rb1' })

    runMovement(state, null, DT)

    expect(inline.teInline).toBe(true)
    expect(inline.blockAssignmentId).toBe('dl1')
    expect(inline.carrierBlockId).toBeFalsy()
  })
})
