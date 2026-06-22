import { describe, it, expect } from '@jest/globals'
import { findRunningLane, visionInterval } from '../game/utils/rbVision.js'

// Carrier advancing toward higher y (dir = 1, "forward" = north). Defenders ahead are
// at higher y; lateral +x is to the carrier's right.
const dir = 1

function carrierAt(x = 26, y = 50) {
  return { x, y }
}

describe('findRunningLane', () => {
  it('runs straight ahead when the field is clear', () => {
    const lane = findRunningLane(carrierAt(), [], [], dir)
    expect(Math.abs(lane.dirX)).toBeLessThan(0.05)   // no lateral cut
    expect(lane.dirY).toBeGreaterThan(0.9)           // pressing forward
  })

  it('cuts off the straight path when a defender clogs it', () => {
    const defender = { x: 26, y: 58 }                // 8 yds directly ahead
    const lane = findRunningLane(carrierAt(), [defender], [], dir)
    expect(Math.abs(lane.dirX)).toBeGreaterThan(0.2) // bounces to a side lane
    expect(lane.clear).toBeGreaterThan(8)            // into clearer space than straight (8)
  })

  it('cuts toward the open side when the front and one side are clogged', () => {
    const straight = { x: 26, y: 58 }
    const left     = { x: 22, y: 57 }
    const lane = findRunningLane(carrierAt(), [straight, left], [], dir)
    expect(lane.dirX).toBeGreaterThan(0)   // open space is to the right
  })

  it('cuts left when the front and right are clogged (mirror)', () => {
    const straight = { x: 26, y: 58 }
    const right    = { x: 30, y: 57 }
    const lane = findRunningLane(carrierAt(), [straight, right], [], dir)
    expect(lane.dirX).toBeLessThan(0)
  })

  it('an engaged blocker walls the ray — the OL/DL pile occupies the lane ([run feedback])', () => {
    // An OL actively engaging a DL is a pile in the path, not a clear lane: it walls the ray just
    // like a defender, and it's the back's job to find the route around it.
    const blocker = { id: 'ol', x: 26, y: 54, isEngaged: true, engagedWithId: 'dl', label: 'OL' }
    const lane = findRunningLane(carrierAt(), [], [blocker], dir)
    const center = lane.rays.find(r => Math.abs(r.angle) < 1e-6)
    expect(center.clear).toBeCloseTo(4, 1)   // pile 4 yds ahead stops the straight ray
  })

  it('the back runs around an engaged pile clogging the straight lane ([run feedback])', () => {
    const ol = { id: 'ol', x: 26, y: 54, isEngaged: true, engagedWithId: 'dl', label: 'OL' }
    const dl = { id: 'dl', x: 26, y: 55, isEngaged: true, engagedWithId: 'ol', leverageScore: 0.7, label: 'DL' }
    const lane = findRunningLane(carrierAt(), [dl], [ol], dir)
    const center = lane.rays.find(r => Math.abs(r.angle) < 1e-6)
    expect(center.clear).toBeLessThan(6)               // the pile walls the straight lane
    expect(Math.abs(lane.dirX)).toBeGreaterThan(0.1)   // so the back cuts around it
  })

  it('an engaged pile walls regardless of who is winning the block ([run feedback])', () => {
    // Whether the OL is sealing the DL or losing the rep, the bodies are in the lane — they wall.
    const ol = { id: 'ol', x: 26, y: 54, isEngaged: true, engagedWithId: 'dl', label: 'OL' }
    const dl = { id: 'dl', x: 26, y: 55, isEngaged: true, engagedWithId: 'ol', leverageScore: -0.5, label: 'DL' }
    const lane = findRunningLane(carrierAt(), [dl], [ol], dir)
    const center = lane.rays.find(r => Math.abs(r.angle) < 1e-6)
    expect(center.clear).toBeLessThan(8)   // engaged bodies wall the lane no matter the leverage
  })

  it('penalizes a lane flanked by defenders — scored, not just measured ([priority 3])', () => {
    const clean = findRunningLane(carrierAt(), [], [], dir)
    const cleanStraight = clean.rays.find(r => Math.abs(r.angle) < 1e-6)

    // Same straight lane, now flanked by two defenders just OUTSIDE it (traffic, not blocking).
    const flanked = findRunningLane(carrierAt(), [{ x: 24.3, y: 55 }, { x: 27.7, y: 55 }], [], dir)
    const flankedStraight = flanked.rays.find(r => Math.abs(r.angle) < 1e-6)

    expect(flankedStraight.clear).toBeCloseTo(cleanStraight.clear, 5)  // ray still unobstructed
    expect(flankedStraight.score).toBeLessThan(cleanStraight.score)    // but scored lower (congested)
  })

  it('avoids running into the sideline', () => {
    // Carrier hugging the right sideline (field width 53.33).
    const lane = findRunningLane(carrierAt(51, 50), [], [], dir)
    expect(lane.dirX).toBeLessThanOrEqual(0.05)    // does not bend further into the boundary
  })

  it('ignores defenders behind the carrier (outside the forward cone)', () => {
    const behind = { x: 26, y: 42 }                // 8 yds behind
    const lane = findRunningLane(carrierAt(), [behind], [], dir)
    expect(Math.abs(lane.dirX)).toBeLessThan(0.05) // unaffected — runs straight
    expect(lane.clear).toBeGreaterThan(12)
  })

  it('biases the lane toward the called run direction when space is equal', () => {
    const straight  = findRunningLane(carrierAt(), [], [], dir, 0)
    const rightCall = findRunningLane(carrierAt(), [], [], dir, (40 * Math.PI) / 180)
    expect(Math.abs(straight.dirX)).toBeLessThan(0.05)   // no bias → straight
    expect(rightCall.dirX).toBeGreaterThan(0.3)          // biased right → takes the right lane
  })

  it('bounces to the widest open space when the front and one side are walled ([156])', () => {
    // A diagonal wall clogs the center and the entire left side; the right side is wide open.
    // Selection scores each lane by its open space (own clearance widened by its neighbors),
    // so the carrier commits to the genuinely open right rather than a narrow inside gap.
    const wall = [{ x: 26, y: 55 }, { x: 24, y: 55 }, { x: 22, y: 56 }]
    const lane = findRunningLane(carrierAt(), wall, [], dir)
    expect(lane.dirX).toBeGreaterThan(0.2)   // commits to the open right side
  })

  it('exposes per-lane open space distinct from raw clearance ([156])', () => {
    const lane = findRunningLane(carrierAt(), [], [], dir)
    expect(lane.space).toBeGreaterThan(0)
    expect(lane.rays.every(r => typeof r.space === 'number')).toBe(true)
  })

  it('sticks with its committed heading to avoid oscillating between equal lanes ([priority 7])', () => {
    // The middle is clogged; the left and right creases are symmetric, so the committed
    // heading breaks the tie — the back keeps cutting the way it was already going.
    const straightDef = { x: 26, y: 56 }
    const rightDir = { x: Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6) }   // committed right
    const leftDir  = { x: -Math.sin(Math.PI / 6), y: Math.cos(Math.PI / 6) }  // committed left

    const goRight = findRunningLane(carrierAt(), [straightDef], [], dir, 0, rightDir)
    const goLeft  = findRunningLane(carrierAt(), [straightDef], [], dir, 0, leftDir)

    expect(goRight.dirX).toBeGreaterThan(0)   // continues right
    expect(goLeft.dirX).toBeLessThan(0)       // continues left
  })

  it('works for a carrier advancing the other direction (dir = -1)', () => {
    // Forward is now toward lower y; a defender ahead is at lower y.
    const carrier  = { x: 26, y: 50 }
    const defender = { x: 26, y: 42 }              // 8 yds ahead (south)
    const lane = findRunningLane(carrier, [defender], [], -1)
    expect(lane.dirY).toBeLessThan(0)              // pressing toward lower y
    expect(Math.abs(lane.dirX)).toBeGreaterThan(0.2)  // cuts off the clogged straight path
  })
})

// ── [164] Vision ray geometry & lane-selection correctness ─────────────────────

describe('vision ray geometry ([164])', () => {
  it('casts a symmetric fan of 31 unit-vector rays across the 90° cone', () => {
    const lane = findRunningLane(carrierAt(), [], [], dir)
    expect(lane.rays).toHaveLength(31)
    for (const r of lane.rays) {
      expect(Math.hypot(r.dirX, r.dirY)).toBeCloseTo(1, 6)   // unit heading
      expect(r.dirY).toBeGreaterThan(0)                       // every cone ray points forward (dir=+1)
      expect(r.clear).toBeGreaterThanOrEqual(0)
      expect(r.clear).toBeLessThanOrEqual(15)                 // capped at RAY_MAX
    }
    const xs = lane.rays.map(r => r.dirX)
    expect(xs[0]).toBeCloseTo(-xs[30], 6)  // outermost rays mirror laterally (±45°)
    expect(xs[15]).toBeCloseTo(0, 6)       // center ray straight ahead
    expect(Math.abs(xs[0])).toBeCloseTo(Math.sin(Math.PI / 4), 6)   // edge ray at 45°
    expect(xs).toEqual([...xs].sort((a, b) => a - b))   // fan sweeps left → right
  })

  it('mirrors the fan forward for a south-bound carrier (dir = -1)', () => {
    const lane = findRunningLane(carrierAt(), [], [], -1)
    for (const r of lane.rays) {
      expect(r.dirY).toBeLessThan(0)   // forward is now toward lower y
    }
  })

  it('selects the highest-scoring ray as the chosen lane', () => {
    const lane = findRunningLane(carrierAt(), [{ x: 26, y: 58 }], [], dir)
    const maxScore = Math.max(...lane.rays.map(r => r.score))
    expect(lane.score).toBeCloseTo(maxScore, 6)
    // The returned lane is exactly one of the evaluated rays.
    const match = lane.rays.find(r => r.angle === lane.angle)
    expect(match).toBeDefined()
    expect(match.dirX).toBeCloseTo(lane.dirX, 6)
    expect(match.clear).toBeCloseTo(lane.clear, 6)
  })

  it("a ray's clear distance stops at the defender standing in that lane", () => {
    // Defender 8 yds straight ahead → the center ray reads ~8 yards of room.
    const lane = findRunningLane(carrierAt(), [{ x: 26, y: 58 }], [], dir)
    const center = lane.rays.find(r => Math.abs(r.angle) < 1e-6)
    expect(center.clear).toBeCloseTo(8, 1)
  })

  it('an unobstructed ray reads the maximum look-ahead distance', () => {
    const lane = findRunningLane(carrierAt(), [], [], dir)
    const center = lane.rays.find(r => Math.abs(r.angle) < 1e-6)
    expect(center.clear).toBeCloseTo(15, 6)   // RAY_MAX with nothing in the way
  })

  it('prefers a deep lane over a shallow one, all else equal (most open space wins)', () => {
    // One defender clogs the right side shallow; the left and center stay deep. The chosen
    // lane must be one of the deep ones, never the shallow clogged side.
    const lane = findRunningLane(carrierAt(), [{ x: 31, y: 53 }], [], dir)
    expect(lane.dirX).toBeLessThanOrEqual(0.05)   // away from the shallow right-side clog
    expect(lane.clear).toBeGreaterThan(10)        // into deep open space
  })
})

describe('visionInterval ([155])', () => {
  it('an elite (99) vision back re-reads every ~0.25 s', () => {
    expect(visionInterval(99)).toBeCloseTo(0.25, 5)
  })

  it('a zero-vision back re-reads only every ~2 s', () => {
    expect(visionInterval(0)).toBeCloseTo(2.0, 5)
  })

  it('higher vision yields a shorter interval (monotonic)', () => {
    expect(visionInterval(80)).toBeLessThan(visionInterval(40))
    expect(visionInterval(40)).toBeLessThan(visionInterval(10))
  })

  it('clamps out-of-range vision ratings', () => {
    expect(visionInterval(150)).toBeCloseTo(0.25, 5)
    expect(visionInterval(-10)).toBeCloseTo(2.0, 5)
  })
})
