import { describe, it, expect } from '@jest/globals'
import { circleOverlap, detectCollisions } from '../game/utils/collision.js'
import { PLAYER } from '../constants.js'

const R = PLAYER.RADIUS  // 0.75 yards

// ── circleOverlap ─────────────────────────────────────────────────────────────

describe('circleOverlap', () => {
  it('returns null when players are far apart', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 10 }
    expect(circleOverlap(a, b)).toBeNull()
  })

  it('returns null when circles are exactly touching (edge-to-edge, not overlapping)', () => {
    const a = { x: 0,      y: 0 }
    const b = { x: R * 2, y: 0 }  // distance == sum of radii exactly
    expect(circleOverlap(a, b)).toBeNull()
  })

  it('returns null when circles are exactly at PLAYER.CONTACT_RADIUS apart', () => {
    // CONTACT_RADIUS = R * 2 = 1.5 yards
    const a = { x: 0,                   y: 0 }
    const b = { x: PLAYER.CONTACT_RADIUS, y: 0 }
    expect(circleOverlap(a, b)).toBeNull()
  })

  it('detects overlap when circles are closer than the sum of their radii', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 1, y: 0 }  // distance = 1 < 1.5
    const result = circleOverlap(a, b)
    expect(result).not.toBeNull()
  })

  it('reports correct depth for a simple horizontal overlap', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 1, y: 0 }  // dist=1, minD=1.5 → depth=0.5
    const { depth } = circleOverlap(a, b)
    expect(depth).toBeCloseTo(0.5, 5)
  })

  it('reports correct depth when circles are fully stacked', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 0, y: 0 }  // dist=0, depth = minD = 1.5
    const { depth } = circleOverlap(a, b)
    expect(depth).toBeCloseTo(R * 2, 5)
  })

  it('normal vector points from b toward a (horizontal case)', () => {
    const a = { x: 2, y: 0 }
    const b = { x: 1, y: 0 }  // a is to the right of b
    const { nx, ny } = circleOverlap(a, b)
    expect(nx).toBeCloseTo(1, 5)   // pointing right (toward a)
    expect(ny).toBeCloseTo(0, 5)
  })

  it('normal vector points from b toward a (vertical case)', () => {
    const a = { x: 0, y: 2 }
    const b = { x: 0, y: 1 }  // a is above b
    const { nx, ny } = circleOverlap(a, b)
    expect(nx).toBeCloseTo(0, 5)
    expect(ny).toBeCloseTo(1, 5)   // pointing up (toward a)
  })

  it('normal vector is a unit vector (magnitude = 1)', () => {
    const a = { x: 0.3, y: 0.4 }
    const b = { x: 0,   y: 0   }
    const { nx, ny } = circleOverlap(a, b)
    expect(Math.sqrt(nx * nx + ny * ny)).toBeCloseTo(1, 5)
  })

  it('normal is anti-symmetric: swap a and b and the normal flips', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 1, y: 0 }
    const ab = circleOverlap(a, b)
    const ba = circleOverlap(b, a)
    expect(ab.nx).toBeCloseTo(-ba.nx, 5)
    expect(ab.ny).toBeCloseTo(-ba.ny, 5)
  })

  it('depth is symmetric regardless of argument order', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 1, y: 0 }
    expect(circleOverlap(a, b).depth).toBeCloseTo(circleOverlap(b, a).depth, 5)
  })

  it('applies diagonal overlap correctly', () => {
    // Place a and b at 45° with distance = sqrt(2) * 0.5 ≈ 0.707 (< 1.5)
    const a = { x: 0,    y: 0   }
    const b = { x: 0.5,  y: 0.5 }
    const dist = Math.sqrt(0.5)
    const result = circleOverlap(a, b)
    expect(result).not.toBeNull()
    expect(result.depth).toBeCloseTo(R * 2 - dist, 5)
    // Normal should point at 225° (from b toward a = upper-left)
    expect(result.nx).toBeCloseTo(-1 / Math.SQRT2, 5)
    expect(result.ny).toBeCloseTo(-1 / Math.SQRT2, 5)
  })

  it('accepts custom radii', () => {
    // Two circles of radius 2 placed 3 yards apart — should overlap by 1 yard
    const a = { x: 0, y: 0 }
    const b = { x: 3, y: 0 }
    const result = circleOverlap(a, b, 2, 2)
    expect(result).not.toBeNull()
    expect(result.depth).toBeCloseTo(1, 5)
  })

  it('does not overlap when custom radii are smaller', () => {
    // Same positions as above but radii=0.5 each → sum=1 < dist=3
    const a = { x: 0, y: 0 }
    const b = { x: 3, y: 0 }
    expect(circleOverlap(a, b, 0.5, 0.5)).toBeNull()
  })

  it('stacked players return a stable non-NaN normal', () => {
    const a = { x: 5, y: 5 }
    const b = { x: 5, y: 5 }
    const { nx, ny, depth } = circleOverlap(a, b)
    expect(Number.isNaN(nx)).toBe(false)
    expect(Number.isNaN(ny)).toBe(false)
    expect(Number.isNaN(depth)).toBe(false)
    expect(depth).toBeGreaterThan(0)
  })
})

// ── detectCollisions ──────────────────────────────────────────────────────────

describe('detectCollisions', () => {
  function makeMap(players) {
    const m = new Map()
    for (const p of players) m.set(p.id, p)
    return m
  }

  it('returns empty array when no players overlap', () => {
    const off = makeMap([{ id: 'o1', x: 0, y: 0 }])
    const def = makeMap([{ id: 'd1', x: 10, y: 0 }])
    expect(detectCollisions(off, def)).toHaveLength(0)
  })

  it('returns one collision when a single pair overlaps', () => {
    const off = makeMap([{ id: 'o1', x: 0,   y: 0 }])
    const def = makeMap([{ id: 'd1', x: 0.5, y: 0 }])
    const result = detectCollisions(off, def)
    expect(result).toHaveLength(1)
  })

  it('collision record has offense, defense, depth, nx, ny', () => {
    const off = makeMap([{ id: 'o1', x: 0,   y: 0 }])
    const def = makeMap([{ id: 'd1', x: 0.5, y: 0 }])
    const [col] = detectCollisions(off, def)
    expect(col.offense.id).toBe('o1')
    expect(col.defense.id).toBe('d1')
    expect(col.depth).toBeGreaterThan(0)
    expect(typeof col.nx).toBe('number')
    expect(typeof col.ny).toBe('number')
  })

  it('returns multiple collisions when several pairs overlap', () => {
    const off = makeMap([
      { id: 'o1', x: 0, y: 0 },
      { id: 'o2', x: 5, y: 0 },
    ])
    const def = makeMap([
      { id: 'd1', x: 0.5, y: 0 },  // overlaps o1
      { id: 'd2', x: 5.5, y: 0 },  // overlaps o2
    ])
    expect(detectCollisions(off, def)).toHaveLength(2)
  })

  it('detects one-to-many collisions (one defender in range of two offensive players)', () => {
    const off = makeMap([
      { id: 'o1', x: 0,    y: 0 },
      { id: 'o2', x: 0.8,  y: 0 },
    ])
    const def = makeMap([{ id: 'd1', x: 0.4, y: 0 }])  // between both
    // d1 may overlap both o1 and o2 depending on exact spacing
    const result = detectCollisions(off, def)
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('offense-vs-offense players do not generate collisions', () => {
    const off = makeMap([
      { id: 'o1', x: 0, y: 0 },
      { id: 'o2', x: 0, y: 0 },  // stacked
    ])
    const def = makeMap([])
    expect(detectCollisions(off, def)).toHaveLength(0)
  })

  it('returns empty when both maps are empty', () => {
    expect(detectCollisions(new Map(), new Map())).toHaveLength(0)
  })
})
