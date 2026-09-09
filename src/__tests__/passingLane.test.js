import { describe, it, expect } from '@jest/globals'
import { shortPassLaneBlocked, computeReceiverOpenness, opennessBreakdown } from '../game/utils/openness.js'
import { opennessTier } from '../game/utils/passOutcome.js'

// ── [lane block] Short-pass throwing lanes ───────────────────────────────────
//
// A zone defender standing in the line between passer and target kills a short throw: the ball is
// flat and fast and he gets a hand on it. On a deeper ball the QB puts air under it and drops it
// over him, so the rule deliberately stops applying past LANE_SHORT_MAX_AIR.

const LOS = 40
const DIR = 1
const QB  = { x: 26, y: 34 }        // six yards behind the line, as the formation places him

const ctx = (ids = ['lb1']) => ({ losY: LOS, direction: DIR, zoneIds: new Set(ids) })

// A defender placed a given fraction along the QB→receiver line, offset sideways from it.
function inLane(receiver, t, offset = 0, id = 'lb1') {
  const dx = receiver.x - QB.x, dy = receiver.y - QB.y
  const len = Math.hypot(dx, dy)
  return {
    id, label: 'LB',
    x: QB.x + dx * t - (dy / len) * offset,
    y: QB.y + dy * t + (dx / len) * offset,
    vx: 0, vy: 0,
  }
}

describe('when the lane is blocked', () => {
  it('a zone defender squarely in the line on a 3-yard route blocks it', () => {
    const wr = { x: 26, y: LOS + 3 }
    expect(shortPassLaneBlocked(wr, [inLane(wr, 0.5)], QB, ctx())).toBe(true)
  })

  it('a defender a step off the line does not', () => {
    const wr = { x: 26, y: LOS + 3 }
    expect(shortPassLaneBlocked(wr, [inLane(wr, 0.5, 2.5)], QB, ctx())).toBe(false)
  })

  it('a screen behind the line of scrimmage counts as short', () => {
    const wr = { x: 34, y: LOS - 2 }
    expect(shortPassLaneBlocked(wr, [inLane(wr, 0.5)], QB, ctx())).toBe(true)
  })

  it('stops applying once the throw is deep enough to float over him', () => {
    const deep = { x: 26, y: LOS + 12 }
    expect(shortPassLaneBlocked(deep, [inLane(deep, 0.5)], QB, ctx())).toBe(false)
  })

  it('the cutoff is the air yards past the LOS', () => {
    const justShort = { x: 26, y: LOS + 4.5 }
    const justDeep  = { x: 26, y: LOS + 5.5 }
    expect(shortPassLaneBlocked(justShort, [inLane(justShort, 0.5)], QB, ctx())).toBe(true)
    expect(shortPassLaneBlocked(justDeep,  [inLane(justDeep,  0.5)], QB, ctx())).toBe(false)
  })
})

describe('who counts as a lane defender', () => {
  it('only defenders playing zone — a man defender has his back turned', () => {
    const wr = { x: 26, y: LOS + 3 }
    const d  = inLane(wr, 0.5, 0, 'cb1')
    expect(shortPassLaneBlocked(wr, [d], QB, ctx(['cb1']))).toBe(true)   // in zone → blocks
    expect(shortPassLaneBlocked(wr, [d], QB, ctx(['someoneElse']))).toBe(false)
  })

  it('a pass rusher bearing down on the QB is not a lane blocker', () => {
    const wr = { x: 26, y: LOS + 3 }
    expect(shortPassLaneBlocked(wr, [inLane(wr, 0.02)], QB, ctx())).toBe(false)
  })

  it('a defender draped on the receiver is ordinary coverage, not a lane block', () => {
    // That case is already priced in by separation; counting it twice would double-punish it.
    const wr = { x: 26, y: LOS + 3 }
    expect(shortPassLaneBlocked(wr, [inLane(wr, 0.97)], QB, ctx())).toBe(false)
  })

  it('does nothing without the context (no LOS, no zone read)', () => {
    const wr = { x: 26, y: LOS + 3 }
    const d  = [inLane(wr, 0.5)]
    expect(shortPassLaneBlocked(wr, d, QB, {})).toBe(false)
    expect(shortPassLaneBlocked(wr, d, null, ctx())).toBe(false)
    expect(shortPassLaneBlocked(wr, d, QB, { losY: LOS, direction: DIR, zoneIds: new Set() })).toBe(false)
  })

  it('works for an offense running the other way', () => {
    const wr = { x: 26, y: LOS - 3 }              // dir -1: downfield is decreasing y
    const qb = { x: 26, y: LOS + 6 }
    const dx = wr.x - qb.x, dy = wr.y - qb.y
    const mid = { id: 'lb1', label: 'LB', x: qb.x + dx * 0.5, y: qb.y + dy * 0.5 }
    expect(shortPassLaneBlocked(wr, [mid], qb, { losY: LOS, direction: -1, zoneIds: new Set(['lb1']) })).toBe(true)
  })
})

describe('effect on the window', () => {
  it('forces a wide-open short receiver into the smothered band', () => {
    // Nobody near him at all — this would otherwise read wide open.
    const wr  = { x: 26, y: LOS + 3, vx: 0, vy: 0 }
    const far = { id: 'x', label: 'CB', x: 50, y: 70, vx: 0, vy: 0 }
    const lb  = inLane(wr, 0.5)

    const clean   = computeReceiverOpenness(wr, [far], QB, ctx())
    const blocked = computeReceiverOpenness(wr, [far, lb], QB, ctx())

    expect(opennessTier(clean)).toBe('open')
    expect(opennessTier(blocked)).toBe('smothered')
    expect(blocked).toBeLessThan(0.33)
  })

  it('reports the block in the breakdown so the coverage log can explain it', () => {
    const wr = { x: 26, y: LOS + 3, vx: 0, vy: 0 }
    const lb = inLane(wr, 0.5)
    expect(opennessBreakdown(wr, [lb], QB, ctx()).laneBlocked).toBe(true)
    expect(opennessBreakdown(wr, [lb], QB, {}).laneBlocked).toBe(false)
  })

  it('never caps a deep window — the QB throws over the underneath zone', () => {
    // The underneath defender still affects the read through the ordinary separation and leverage
    // maths (he is, after all, nearby); what must NOT happen is the short-pass cap slamming it into
    // the smothered band. So this asserts the cap did not fire, not that nothing changed at all.
    const wr  = { x: 26, y: LOS + 14, vx: 0, vy: 0 }
    const far = { id: 'x', label: 'CB', x: 50, y: 80, vx: 0, vy: 0 }
    const lb  = inLane(wr, 0.35)   // in the line, but it's a deep ball

    const out = opennessBreakdown(wr, [far, lb], QB, ctx())
    expect(out.laneBlocked).toBe(false)
    expect(out.openness).toBeGreaterThan(0.33)   // nowhere near the forced smothered value
  })

  it('never makes a window better than it already was', () => {
    // A receiver who is genuinely smothered stays smothered; the cap only ever lowers.
    const wr  = { x: 26, y: LOS + 3, vx: 0, vy: 0 }
    const tight = { id: 'cb', label: 'CB', x: 26.2, y: LOS + 3, vx: 0, vy: 0 }
    const lb    = inLane(wr, 0.5)
    const blocked = computeReceiverOpenness(wr, [tight, lb], QB, ctx())
    expect(blocked).toBeLessThanOrEqual(0.15)
  })
})
