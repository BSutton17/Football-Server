import { describe, it, expect } from '@jest/globals'
import { buildWaypoints, getRouteTarget } from '../game/utils/routeEngine.js'
import { routeTraits } from '../game/utils/routeGeometry.js'
import { isReceiverReady } from '../game/serialization.js'
import { ROUTE_DEF, STOP_ROUTES } from '../game/utils/routeDefinitions.js'

// [screen] A screen receiver holds his spot and is throwable from the snap. Both halves matter:
// the route has to resolve to where he already IS (not to the line of scrimmage, which would walk
// an off-ball receiver forward), and the throw light has to be on without waiting out the usual
// declare delay.

const LOS = 35, DIR = 1, PIVOT = 26.665, DT = 0.05

function receiver({ x = 40, y = LOS } = {}) {
  const p = { id: 'wr1', label: 'WR', x, y, vx: 0, vy: 0, route: 'screen' }
  p.routeWaypoints   = buildWaypoints('screen', p.x, LOS, DIR, 1, PIVOT, p.y)
  p.routeWaypointIdx = 0
  p.routeElapsed     = 0
  p.routePhase       = 'running'
  p.routeTraits      = routeTraits(p.routeWaypoints, p.y, LOS, DIR, p.x, PIVOT)
  p.routeStart       = { x: p.x, y: p.y }
  return p
}

describe('screen route — stands still', () => {
  it('resolves to the receiver’s own spot, on the ball', () => {
    const p = receiver({ x: 40, y: LOS })
    expect(p.routeWaypoints).toEqual([{ x: 40, y: LOS }])
  })

  it('…and off the ball, rather than walking him up to the line', () => {
    const p = receiver({ x: 40, y: LOS - 1.5 })   // slot receiver lined up off the ball
    expect(p.routeWaypoints).toEqual([{ x: 40, y: LOS - 1.5 }])
  })

  it('the steering target never leaves his spot', () => {
    const p = receiver({ x: 40, y: LOS - 1 })
    for (let i = 0; i < 40; i++) {                // two seconds of ticks
      const t = getRouteTarget(p, LOS, DIR, DT, PIVOT)
      expect(t).toEqual({ x: 40, y: LOS - 1 })
    }
    expect(p.routePhase).toBe('settled')
  })
})

describe('screen route — instantly ready', () => {
  it('the throw light is on from the very first tick', () => {
    const p = receiver()
    expect(isReceiverReady(p)).toBe(true)
    expect(p.routeElapsed).toBe(0)
    expect(p.routeWaypointIdx).toBe(0)
  })

  it('is ready off the ball too', () => {
    expect(isReceiverReady(receiver({ x: 12, y: LOS - 2 }))).toBe(true)
  })

  it('a normal route still has to declare', () => {
    const p = receiver()
    p.route = 'go'
    p.routeWaypoints = buildWaypoints('go', p.x, LOS, DIR, 1, PIVOT, p.y)
    p.routeTraits    = routeTraits(p.routeWaypoints, p.y, LOS, DIR, p.x, PIVOT)
    expect(isReceiverReady(p)).toBe(false)

    p.routeElapsed = 1.4
    expect(isReceiverReady(p)).toBe(true)
  })
})

describe('screen route — classification', () => {
  it('is a stop route, and the geometric classifier agrees', () => {
    expect(STOP_ROUTES.has('screen')).toBe(true)
    expect(ROUTE_DEF.screen).toEqual([[0, 0]])
    expect(receiver().routeTraits).toMatchObject({ settles: true, goesNowhere: true, deepVertical: false })
  })
})
