import { describe, it, expect } from '@jest/globals'
import { getRouteTarget, isSettled } from '../game/utils/routeEngine.js'
import { ROUTE_DEF, STOP_ROUTES } from '../game/utils/routeDefinitions.js'
import { FIELD } from '../constants.js'

const HALF_W = FIELD.WIDTH / 2  // 26.665 yards — midfield

// Minimal player object sufficient for the route engine
function makePlayer(route, x, overrides = {}) {
  return {
    id: 'p1',
    label: 'WR',
    route,
    x,
    y: 60,
    vx: 0,
    vy: 0,
    routeDepthScale: 1,
    ...overrides,
  }
}

// ── Route definitions ─────────────────────────────────────────────────────────

describe('ROUTE_DEF', () => {
  it('every route is a non-empty list of [nearFactor, dd] number pairs', () => {
    for (const segs of Object.values(ROUTE_DEF)) {
      expect(Array.isArray(segs)).toBe(true)
      expect(segs.length).toBeGreaterThanOrEqual(1)
      for (const seg of segs) {
        expect(seg).toHaveLength(2)
        expect(typeof seg[0]).toBe('number')
        expect(typeof seg[1]).toBe('number')
      }
    }
  })

  it('breaking routes have at least two waypoint segments (a stem and a break)', () => {
    const breaking = ['slant', 'zig', 'curl', 'out', 'comeback', 'dig', 'post', 'corner', 'wheel', 'deep_cross', 'texas']
    for (const r of breaking) {
      expect(ROUTE_DEF[r].length).toBeGreaterThanOrEqual(2)
    }
  })

  it('stop routes set contains curl, comeback, and block', () => {
    expect(STOP_ROUTES.has('curl')).toBe(true)
    expect(STOP_ROUTES.has('comeback')).toBe(true)
    expect(STOP_ROUTES.has('block')).toBe(true)
  })

  it('stop routes are not accidentally applied to go or slant', () => {
    expect(STOP_ROUTES.has('go')).toBe(false)
    expect(STOP_ROUTES.has('slant')).toBe(false)
  })

  it('go route has zero horizontal offset and deep downfield distance', () => {
    const [[nearFactor, dd]] = ROUTE_DEF.go
    expect(nearFactor).toBe(0)
    expect(dd).toBeGreaterThan(20)
  })

  it('slant final segment cuts inside (negative nearFactor)', () => {
    const [, [nearFactor]] = ROUTE_DEF.slant
    expect(nearFactor).toBeLessThan(0)
  })

  it('zig final segment cuts outside (positive nearFactor)', () => {
    const [nearFactor] = ROUTE_DEF.zig.at(-1)   // last segment is the final break
    expect(nearFactor).toBeGreaterThan(0)
  })
})

// ── Waypoint initialization ───────────────────────────────────────────────────

describe('getRouteTarget — waypoint initialization', () => {
  it('returns null when player has no route', () => {
    const p = makePlayer(null, 10)
    expect(getRouteTarget(p, 60, 1, 0.05)).toBeNull()
  })

  it('sets routeWaypoints, routeWaypointIdx, routeElapsed, routePhase on first call', () => {
    const p = makePlayer('go', 10)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints).toBeDefined()
    expect(p.routeWaypointIdx).toBe(0)
    expect(p.routeElapsed).toBeCloseTo(0.05, 5)
    expect(p.routePhase).toBe('running')
  })

  it('does not reinitialize waypoints on subsequent calls', () => {
    const p = makePlayer('go', 10)
    getRouteTarget(p, 60, 1, 0.05)
    const originalWaypoints = p.routeWaypoints
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints).toBe(originalWaypoints)  // same reference
  })

  it('go route produces one waypoint directly downfield', () => {
    const p = makePlayer('go', 20)
    const target = getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints).toHaveLength(1)
    expect(target.x).toBeCloseTo(20, 5)   // no horizontal shift
    expect(target.y).toBeGreaterThan(60)  // northward when dir=1
  })

  it('slant route produces two waypoints', () => {
    const p = makePlayer('slant', 20)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints).toHaveLength(2)
  })

  it('unknown route falls back to a single downfield waypoint', () => {
    const p = makePlayer('not_a_real_route', 20)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints).toHaveLength(1)
    expect(p.routeWaypoints[0].y).toBeGreaterThan(60)
  })
})

// ── Mirroring and sideline behavior ──────────────────────────────────────────

describe('getRouteTarget — mirroring', () => {
  it('flat route shifts left player toward the left sideline', () => {
    const p = makePlayer('flat', 10)  // left of center → near = -1
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints[0].x).toBeLessThan(p.x)
  })

  it('flat route shifts right player toward the right sideline', () => {
    const p = makePlayer('flat', 45)  // right of center → near = +1
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints[0].x).toBeGreaterThan(p.x)
  })

  it('symmetric players on opposite sides produce mirror-image final waypoints', () => {
    const losY = 60
    const pL   = makePlayer('out', HALF_W - 15)
    const pR   = makePlayer('out', HALF_W + 15)

    getRouteTarget(pL, losY, 1, 0.05)
    getRouteTarget(pR, losY, 1, 0.05)

    const leftFinal  = pL.routeWaypoints.at(-1)
    const rightFinal = pR.routeWaypoints.at(-1)

    // Horizontal distance from midfield should be equal and opposite
    expect(rightFinal.x - HALF_W).toBeCloseTo(HALF_W - leftFinal.x, 5)
    // Depth should be equal
    expect(leftFinal.y).toBeCloseTo(rightFinal.y, 5)
  })

  it('slant left player cuts right (toward center)', () => {
    const p = makePlayer('slant', 10)  // left side
    getRouteTarget(p, 60, 1, 0.05)
    const [wp0, wp1] = p.routeWaypoints
    expect(wp1.x).toBeGreaterThan(wp0.x)
  })

  it('slant right player cuts left (toward center)', () => {
    const p = makePlayer('slant', 45)  // right side
    getRouteTarget(p, 60, 1, 0.05)
    const [wp0, wp1] = p.routeWaypoints
    expect(wp1.x).toBeLessThan(wp0.x)
  })

  it('waypoints are clamped to within the field boundaries', () => {
    // Place player near the sideline — wide offset should not go out of bounds
    const p = makePlayer('flat', 1)
    getRouteTarget(p, 60, 1, 0.05)
    for (const wp of p.routeWaypoints) {
      expect(wp.x).toBeGreaterThanOrEqual(1)
      expect(wp.x).toBeLessThanOrEqual(FIELD.WIDTH - 1)
    }
  })
})

// ── Direction handling ────────────────────────────────────────────────────────

describe('getRouteTarget — direction', () => {
  it('dir=1 sends the route northward (y increases)', () => {
    const p = makePlayer('go', 20)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypoints[0].y).toBeGreaterThan(60)
  })

  it('dir=-1 sends the route southward (y decreases)', () => {
    const p = makePlayer('go', 20)
    getRouteTarget(p, 60, -1, 0.05)
    expect(p.routeWaypoints[0].y).toBeLessThan(60)
  })

  it('dir=1 and dir=-1 produce vertically mirrored route paths', () => {
    const losY = 60

    const pN = makePlayer('dig', 25)
    const pS = makePlayer('dig', 25)

    getRouteTarget(pN, losY, 1, 0.05)
    getRouteTarget(pS, losY, -1, 0.05)

    pN.routeWaypoints.forEach((wp, i) => {
      const northDiff = wp.y - losY
      const southDiff = pS.routeWaypoints[i].y - losY
      expect(southDiff).toBeCloseTo(-northDiff, 5)
    })
  })
})

// ── Depth scaling ─────────────────────────────────────────────────────────────

describe('getRouteTarget — depth scaling', () => {
  it('routeDepthScale=0.5 halves the downfield distance', () => {
    const losY = 60

    const pFull = makePlayer('go', 20, { routeDepthScale: 1.0 })
    const pHalf = makePlayer('go', 20, { routeDepthScale: 0.5 })

    getRouteTarget(pFull, losY, 1, 0.05)
    getRouteTarget(pHalf, losY, 1, 0.05)

    const fullDepth = pFull.routeWaypoints[0].y - losY
    const halfDepth = pHalf.routeWaypoints[0].y - losY

    expect(halfDepth).toBeCloseTo(fullDepth * 0.5, 5)
  })

  it('routeDepthScale scales all segments proportionally', () => {
    const losY = 60

    const p1x = makePlayer('post', 20, { routeDepthScale: 1.0 })
    const p2x = makePlayer('post', 20, { routeDepthScale: 2.0 })

    getRouteTarget(p1x, losY, 1, 0.05)
    getRouteTarget(p2x, losY, 1, 0.05)

    p1x.routeWaypoints.forEach((wp, i) => {
      const depth1 = wp.y - losY
      const depth2 = p2x.routeWaypoints[i].y - losY
      expect(depth2).toBeCloseTo(depth1 * 2, 5)
    })
  })
})

// ── Route timing ──────────────────────────────────────────────────────────────

describe('getRouteTarget — timing', () => {
  it('routeElapsed accumulates dt each tick', () => {
    const p = makePlayer('go', 20)
    getRouteTarget(p, 60, 1, 0.05)
    getRouteTarget(p, 60, 1, 0.05)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeElapsed).toBeCloseTo(0.15, 5)
  })

  it('routeElapsed starts at dt value after the first tick', () => {
    const p = makePlayer('go', 20)
    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeElapsed).toBeCloseTo(0.05, 5)
  })
})

// ── Phase transitions ─────────────────────────────────────────────────────────

describe('getRouteTarget — phase transitions', () => {
  it('advances to next waypoint when player reaches intermediate threshold', () => {
    const p = makePlayer('slant', 26)
    getRouteTarget(p, 60, 1, 0)

    // Teleport to the first waypoint
    const wp0 = p.routeWaypoints[0]
    p.x = wp0.x
    p.y = wp0.y

    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routeWaypointIdx).toBe(1)
  })

  it('stop route transitions to settled when player reaches the final waypoint', () => {
    const p = makePlayer('curl', 26)
    getRouteTarget(p, 60, 1, 0)

    // Jump to final waypoint
    p.routeWaypointIdx = p.routeWaypoints.length - 1
    const finalWP = p.routeWaypoints.at(-1)
    p.x = finalWP.x
    p.y = finalWP.y

    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routePhase).toBe('settled')
    expect(isSettled(p)).toBe(true)
  })

  it('continuation route extends the final waypoint forward when player arrives', () => {
    const p = makePlayer('go', 26)
    getRouteTarget(p, 60, 1, 0)

    p.routeWaypointIdx = p.routeWaypoints.length - 1
    const originalY = p.routeWaypoints.at(-1).y
    p.x  = p.routeWaypoints.at(-1).x
    p.y  = originalY
    p.vx = 0
    p.vy = 5  // moving northward

    getRouteTarget(p, 60, 1, 0.05)

    expect(p.routeWaypoints.at(-1).y).toBeGreaterThan(originalY)
    expect(p.routePhase).toBe('running')
  })

  it('block route is a stop route (player settles at position)', () => {
    const p = makePlayer('block', 26)
    getRouteTarget(p, 60, 1, 0)

    p.routeWaypointIdx = p.routeWaypoints.length - 1
    const finalWP = p.routeWaypoints.at(-1)
    p.x = finalWP.x
    p.y = finalWP.y

    getRouteTarget(p, 60, 1, 0.05)
    expect(p.routePhase).toBe('settled')
  })
})
