import { describe, it, expect } from '@jest/globals'
import {
  sanitizeDrawnRoute, drawnRouteWaypoints, routeTraits, vertexAngles,
  MAX_ROUTE_LENGTH, CUT_LOCK_DISTANCE,
} from '../game/utils/routeGeometry.js'
import { FIELD } from '../constants.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { initLivePhase } from '../game/systems/init.js'
import { getRouteTarget } from '../game/utils/routeEngine.js'
import { ROUTE_DEF, STOP_ROUTES } from '../game/utils/routeDefinitions.js'
import { afterEach } from '@jest/globals'

// ── [route draw] Route geometry ──────────────────────────────────────────────
//
// sanitizeDrawnRoute is the authoritative clamp on a drawn route — the client beautifies, but the
// server decides what is actually legal. routeTraits answers the questions the sim used to answer
// by looking at a route's NAME, which a drawn route does not have.

const len = (pts) => {
  let total = 0, prev = { dx: 0, dd: 0 }
  for (const p of pts) { total += Math.hypot(p.dx - prev.dx, p.dd - prev.dd); prev = p }
  return total
}

describe('sanitizeDrawnRoute', () => {
  it('keeps a simple, legal route intact', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 8 }, { dx: 6, dd: 8 }])
    expect(out).toHaveLength(2)
    expect(out[1]).toEqual({ dx: 6, dd: 8 })
  })

  it('drops noise points that repeat the previous one', () => {
    const out = sanitizeDrawnRoute([
      { dx: 0, dd: 5 }, { dx: 0.05, dd: 5.05 }, { dx: 0.1, dd: 5.1 }, { dx: 0, dd: 12 },
    ])
    expect(out.length).toBeLessThan(4)
  })

  it('rejects an empty or unusable drawing', () => {
    expect(sanitizeDrawnRoute([])).toBeNull()
    expect(sanitizeDrawnRoute(null)).toBeNull()
    expect(sanitizeDrawnRoute([{ dx: NaN, dd: 3 }])).toBeNull()
  })

  it('ignores non-finite points rather than trusting the client', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 6 }, { dx: Infinity, dd: 2 }, { dx: 4, dd: 9 }])
    expect(out.every(p => Number.isFinite(p.dx) && Number.isFinite(p.dd))).toBe(true)
  })

  it('clamps a route that runs off the sideline back inbounds', () => {
    const startX = 4
    const out = sanitizeDrawnRoute([{ dx: -20, dd: 5 }], startX)
    expect(startX + out[0].dx).toBeGreaterThanOrEqual(1)
  })

  it('caps the total length', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 200 }])
    expect(len(out)).toBeLessThanOrEqual(MAX_ROUTE_LENGTH + 0.01)
  })
})

describe('cuts are locked out past the limit', () => {
  it('a cut inside the limit survives', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 10 }, { dx: 8, dd: 10 }])
    expect(out.length).toBeGreaterThanOrEqual(2)
    expect(out[1].dx).toBeCloseTo(8, 5)
  })

  it('a cut beyond the limit is replaced by a straight continuation', () => {
    // Runs 30 yards up (past the 20-yard lock) then tries to break hard inside.
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 30 }, { dx: -15, dd: 30 }])
    // The hard inside break must not survive: nothing may sit sharply left of the stem.
    expect(Math.min(...out.map(p => p.dx))).toBeGreaterThan(-1)
  })

  it('locks at exactly the cut distance and then runs straight', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 40 }, { dx: -12, dd: 40 }])
    const lockPt = out.find(p => Math.abs(p.dd - CUT_LOCK_DISTANCE) < 0.01)
    expect(lockPt).toBeDefined()          // the route is split at the lock distance
    expect(out[out.length - 1].dd).toBeGreaterThan(CUT_LOCK_DISTANCE)
  })

  it('the locked continuation still respects the overall length cap', () => {
    const out = sanitizeDrawnRoute([{ dx: 0, dd: 60 }, { dx: -20, dd: 60 }])
    expect(len(out)).toBeLessThanOrEqual(MAX_ROUTE_LENGTH + 0.01)
  })

  it('a route that never reaches the lock keeps every cut', () => {
    const drawn = [{ dx: 0, dd: 5 }, { dx: 4, dd: 7 }, { dx: 0, dd: 12 }]
    const out = sanitizeDrawnRoute(drawn)
    expect(out).toHaveLength(3)
  })
})

describe('drawnRouteWaypoints', () => {
  it('places offsets relative to the receiver, downfield in the offense direction', () => {
    const wp = drawnRouteWaypoints([{ dx: 3, dd: 10 }], 20, 35, 1)
    expect(wp[0]).toEqual({ x: 23, y: 45 })
  })

  it('flips downfield for an offense going the other way', () => {
    const wp = drawnRouteWaypoints([{ dx: 3, dd: 10 }], 20, 85, -1)
    expect(wp[0]).toEqual({ x: 23, y: 75 })
  })

  it('keeps waypoints inside the sidelines', () => {
    const wp = drawnRouteWaypoints([{ dx: -40, dd: 5 }], 6, 35, 1)
    expect(wp[0].x).toBeGreaterThanOrEqual(1)
    expect(wp[0].x).toBeLessThanOrEqual(FIELD.WIDTH - 1)
  })
})

describe('routeTraits', () => {
  const LOS = 40, START = 40, DIR = 1

  it('a straight vertical reads deep and does not settle', () => {
    const wp = [{ x: 26, y: LOS + 25 }]
    const t = routeTraits(wp, START, LOS, DIR)
    expect(t.deepVertical).toBe(true)
    expect(t.breaksBack).toBe(false)
    expect(t.settles).toBe(false)
    expect(t.maxDepth).toBeCloseTo(25, 5)
  })

  it('a comeback breaks back and settles', () => {
    const wp = [{ x: 26, y: LOS + 14 }, { x: 30, y: LOS + 10 }]
    const t = routeTraits(wp, START, LOS, DIR)
    expect(t.breaksBack).toBe(true)
    expect(t.settles).toBe(true)
    expect(t.deepVertical).toBe(false)   // it turned back, so the deep shell shouldn't chase it
  })

  it('a dig cutting flat across is neither deep-vertical nor a settle', () => {
    const wp = [{ x: 26, y: LOS + 10 }, { x: 12, y: LOS + 10 }]
    const t = routeTraits(wp, START, LOS, DIR)
    expect(t.breaksBack).toBe(false)
    expect(t.settles).toBe(false)
  })

  it('a shallow drag is not deep', () => {
    const wp = [{ x: 26, y: LOS + 3 }, { x: 40, y: LOS + 4 }]
    expect(routeTraits(wp, START, LOS, DIR).deepVertical).toBe(false)
  })

  it('works for an offense running the other way', () => {
    const los = 80, start = 80, dir = -1
    const t = routeTraits([{ x: 26, y: los - 25 }], start, los, dir)
    expect(t.deepVertical).toBe(true)
    expect(t.maxDepth).toBeCloseTo(25, 5)
  })

  it('an empty route classifies as nothing rather than throwing', () => {
    expect(routeTraits([], START, LOS, DIR)).toEqual({
      settles: false, breaksBack: false, deepVertical: false, maxDepth: 0,
    })
  })
})

describe('vertexAngles', () => {
  it('a straight line has no turn', () => {
    expect(vertexAngles([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }])[0]).toBeCloseTo(0, 5)
  })

  it('a right-angle break measures ninety degrees', () => {
    expect(vertexAngles([{ x: 0, y: 0 }, { x: 0, y: 5 }, { x: 5, y: 5 }])[0]).toBeCloseTo(90, 5)
  })

  it('reports one angle per interior vertex', () => {
    expect(vertexAngles([{ x: 0, y: 0 }, { x: 0, y: 4 }, { x: 3, y: 6 }, { x: 3, y: 10 }])).toHaveLength(2)
  })
})

// ── End to end: a drawn route actually runs ──────────────────────────────────

describe('a drawn route through initLivePhase and the route engine', () => {
  const ROOM = 'drawn-route-room'

  function playWithDrawnRoute(drawnRoute) {
    deleteGame(ROOM)
    const state = initGame(ROOM, 0)
    state.yardLine = 25
    state.offensePlayers = new Map([
      ['wr1', { id: 'wr1', label: 'WR', x: 12, y: 35, vx: 0, vy: 0 }],
    ])
    state.playDesign = {
      playType: 'pass',
      players: [{ id: 'wr1', team: 'o', label: 'WR', x: 12, y: 25, drawnRoute }],
    }
    initLivePhase(state)
    return state.offensePlayers.get('wr1')
  }

  afterEach(() => deleteGame(ROOM))

  it('becomes a custom route with pre-built waypoints instead of a template', () => {
    const wr = playWithDrawnRoute([{ dx: 0, dd: 8 }, { dx: 7, dd: 9 }])
    expect(wr.route).toBe('custom')
    expect(wr.routeWaypoints).toHaveLength(2)
    // Anchored to the receiver, downfield in the offense's direction (dir 1 → +y).
    expect(wr.routeWaypoints[0]).toEqual({ x: 12, y: 43 })
    expect(wr.routeWaypoints[1]).toEqual({ x: 19, y: 44 })
  })

  it('carries traits so the sim can classify it without a name', () => {
    const deep = playWithDrawnRoute([{ dx: 0, dd: 25 }])
    expect(deep.routeTraits.deepVertical).toBe(true)
    expect(deep.routeTraits.settles).toBe(false)

    const comeback = playWithDrawnRoute([{ dx: 0, dd: 14 }, { dx: 4, dd: 10 }])
    expect(comeback.routeTraits.breaksBack).toBe(true)
    expect(comeback.routeTraits.settles).toBe(true)
  })

  it('the route engine walks the drawn waypoints rather than rebuilding them', () => {
    const wr = playWithDrawnRoute([{ dx: 0, dd: 8 }, { dx: 7, dd: 9 }])
    const before = JSON.stringify(wr.routeWaypoints)
    const target = getRouteTarget(wr, 35, 1, 0.05, 26)

    // The steering point is a look-ahead ALONG the path, not the waypoint itself — that is what
    // stops the receiver sawing between headings on a curve. It still heads at the first waypoint.
    expect(target.x).toBeCloseTo(12, 5)
    expect(target.y).toBeGreaterThan(wr.y)
    expect(target.y).toBeLessThanOrEqual(43)
    expect(JSON.stringify(wr.routeWaypoints)).toBe(before)   // untouched by buildWaypoints
  })

  it('a drawn comeback settles at its endpoint', () => {
    const wr = playWithDrawnRoute([{ dx: 0, dd: 14 }, { dx: 3, dd: 10 }])
    // Walk it to the end.
    for (let i = 0; i < 400 && wr.routePhase !== 'settled'; i++) {
      const t = getRouteTarget(wr, 35, 1, 0.05, 26)
      wr.x += (t.x - wr.x) * 0.5
      wr.y += (t.y - wr.y) * 0.5
    }
    expect(wr.routePhase).toBe('settled')
  })

  it('a drawn vertical does NOT settle — it runs through the endpoint', () => {
    const wr = playWithDrawnRoute([{ dx: 0, dd: 20 }])
    for (let i = 0; i < 100; i++) {
      const t = getRouteTarget(wr, 35, 1, 0.05, 26)
      wr.x += (t.x - wr.x) * 0.5
      wr.y += (t.y - wr.y) * 0.5
      wr.vx = 0; wr.vy = 5
    }
    expect(wr.routePhase).toBe('running')
  })

  it('an unusable drawing leaves the receiver with no route at all', () => {
    const wr = playWithDrawnRoute([])
    expect(wr.route).toBeNull()
  })

  it('the server clamps an over-long drawing even if the client did not', () => {
    const wr = playWithDrawnRoute([{ dx: 0, dd: 500 }])
    const last = wr.routeWaypoints[wr.routeWaypoints.length - 1]
    expect((last.y - 35)).toBeLessThanOrEqual(MAX_ROUTE_LENGTH + 0.01)
  })
})

// ── The geometric classifier reproduces the old name-based one ───────────────
//
// [route geometry] This is the proof that replacing the route-NAME lookups with shape derivation
// was behaviour-neutral. For every route in ROUTE_DEF, at every alignment across the field, the
// traits derived from its built waypoints must match the legacy name sets that used to drive
// openness, the deep-safety rotation and the settle check.
//
// Two documented exceptions, both asserted explicitly below rather than waved away.

describe('geometry reproduces the legacy route-name classification', () => {
  const LEGACY_BREAK_BACK = new Set(['comeback', 'curl', 'return'])
  const LEGACY_DEEP       = new Set(['go', 'seam', 'post', 'corner', 'wheel', 'deep_cross'])
  const LOS = 40, DIR = 1, PIVOT = 26.67

  // Mirrors buildWaypoints in routeEngine.js, near-side flip included.
  function build(segs, startX, scale = 1) {
    const near = startX >= PIVOT ? 1 : -1
    return segs.map(([nf, dd]) => ({ x: startX + near * nf, y: LOS + DIR * dd * scale }))
  }

  // Split ends, slot receivers and backs, on both sides of the ball.
  const ALIGNMENTS = [46, 40, 33, 20, 12, 5]

  it.each(ALIGNMENTS)('settles matches STOP_ROUTES at x=%s', (startX) => {
    for (const [name, segs] of Object.entries(ROUTE_DEF)) {
      const t = routeTraits(build(segs, startX), LOS, LOS, DIR, startX, PIVOT)
      expect({ name, settles: t.settles }).toEqual({ name, settles: STOP_ROUTES.has(name) })
    }
  })

  it.each(ALIGNMENTS)('breaksBack matches the legacy set at x=%s', (startX) => {
    for (const [name, segs] of Object.entries(ROUTE_DEF)) {
      const t = routeTraits(build(segs, startX), LOS, LOS, DIR, startX, PIVOT)
      expect({ name, breaksBack: t.breaksBack }).toEqual({ name, breaksBack: LEGACY_BREAK_BACK.has(name) })
    }
  })

  it.each(ALIGNMENTS)('deepVertical matches the legacy set at x=%s', (startX) => {
    for (const [name, segs] of Object.entries(ROUTE_DEF)) {
      const t = routeTraits(build(segs, startX), LOS, LOS, DIR, startX, PIVOT)
      expect({ name, deep: t.deepVertical }).toEqual({ name, deep: LEGACY_DEEP.has(name) })
    }
  })

  it('holds for an offense going the other way', () => {
    const los = 80, dir = -1, startX = 40
    const build2 = (segs) => segs.map(([nf, dd]) => ({ x: startX + nf, y: los + dir * dd }))
    for (const [name, segs] of Object.entries(ROUTE_DEF)) {
      const t = routeTraits(build2(segs), los, los, dir, startX, PIVOT)
      expect({ name, settles: t.settles }).toEqual({ name, settles: STOP_ROUTES.has(name) })
    }
  })

  // ── The documented exceptions ──

  it('block is reproduced too — a route that goes nowhere is one you stand still on', () => {
    // Its definition is a single waypoint on top of the receiver, so it has zero path length. No
    // name lookup needed. (Blockers never actually reach the route engine, but the classifier
    // agreeing anyway means there is no special case to remember.)
    const t = routeTraits(build(ROUTE_DEF.block, 40), LOS, LOS, DIR, 40, PIVOT)
    expect(t.settles).toBe(true)
  })

  it('a receiver stacked on the ball loses the return read, by design', () => {
    // "Break out then back inside" needs an outside to break to. Lined up on the ball there is
    // none, so the lateral read abstains rather than guessing — an alignment the QB/centre occupy
    // in practice anyway.
    const onBall = routeTraits(build(ROUTE_DEF.return, 27), LOS, LOS, DIR, 27, PIVOT)
    expect(onBall.breaksBack).toBe(false)
    const split = routeTraits(build(ROUTE_DEF.return, 40), LOS, LOS, DIR, 40, PIVOT)
    expect(split.breaksBack).toBe(true)
  })

  it('a route shortened with the depth handle is judged as what it became', () => {
    // A "go" pulled down to a third of its depth is no longer a deep threat, and the geometric
    // classifier says so — the old name lookup could not.
    const full  = routeTraits(build(ROUTE_DEF.go, 40, 1),    LOS, LOS, DIR, 40, PIVOT)
    const short = routeTraits(build(ROUTE_DEF.go, 40, 0.35), LOS, LOS, DIR, 40, PIVOT)
    expect(full.deepVertical).toBe(true)
    expect(short.deepVertical).toBe(false)
  })
})
