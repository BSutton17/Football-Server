import { describe, it, expect } from '@jest/globals'
import { findZoneThreat, getZoneTarget } from '../game/systems/movement.js'
import { pairUnderneathZones } from '../ai/playbook/alignAuthored.js'

// ⚠️ "TOO MANY TIMES A RB IN THE FLAT IS WIDE OPEN BECAUSE A DEFENDER IN THE FLAT ABANDONED THEIR
// ZONE." The threat pick took whoever was nearest the landmark, full stop — including a receiver
// already outside the zone and running away from it. The flat defender shaded out after him and
// the back arriving underneath found nobody home.

const receivers = (...list) => new Map(list.map(p => [p.id, { label: 'WR', vx: 0, vy: 0, ...p }]))
const FLAT = { x: 8, y: 42 }        // a flat landmark, just outside the numbers

describe('who a zone defender answers for', () => {
  it('⚠️ TAKES THE MAN IN HIS ZONE OVER A CLOSER ONE OUTSIDE IT', () => {
    const threat = findZoneThreat(FLAT, receivers(
      { id: 'inZone', x: 10, y: 44 },                 // his responsibility
      { id: 'leaving', x: 8, y: 52, vy: 4 },          // running away, and further out
    ), 55)
    expect(threat.id).toBe('inZone')
  })

  it('⚠️ PICKS UP THE BACK ARRIVING IN THE FLAT, not the receiver leaving it', () => {
    // This is the reported failure, in one assertion: the back is further away right now, and he
    // is the one about to be open.
    const threat = findZoneThreat(FLAT, receivers(
      { id: 'departing', x: 9, y: 47, vx: 1, vy: 7 },    // through the zone and gone
      { id: 'rbToFlat', x: 16, y: 41, vx: -7, vy: 1, label: 'RB' },  // breaking into it
    ), 55)
    expect(threat.id).toBe('rbToFlat')
  })

  it('still reads a threat before it arrives — detection reaches past the boundary', () => {
    const threat = findZoneThreat(FLAT, receivers(
      // Detection reaches ZONE_RADIUS (7) + 4 at 99 awareness, so 9 yards out is within it.
      { id: 'incoming', x: 16, y: 44, vx: -8 },
    ), 99)
    expect(threat?.id).toBe('incoming')
  })

  it('sees nobody when the area really is clear', () => {
    expect(findZoneThreat(FLAT, receivers({ id: 'faraway', x: 50, y: 90 }), 55)).toBeNull()
  })

  it('ignores players who are not eligible receivers', () => {
    const threat = findZoneThreat(FLAT, new Map([
      ['ol', { id: 'ol', label: 'OL', x: 9, y: 42, vx: 0, vy: 0 }],
    ]), 55)
    expect(threat).toBeNull()
  })

  it('does not fall over on players with no velocity yet', () => {
    const threat = findZoneThreat(FLAT, new Map([
      ['wr', { id: 'wr', label: 'WR', x: 9, y: 43 }],
    ]), 55)
    expect(threat.id).toBe('wr')
  })
})

describe('where an underneath zone lines up', () => {
  const LOS = 40
  const split = [
    { id: 'wide', label: 'WR', x: 5, y: LOS },
    { id: 'slot', label: 'WR', x: 17, y: LOS },
    { id: 'back', label: 'RB', x: 26, y: LOS - 6 },   // in the backfield, not a body to align on
  ]
  const zone = (slot, dx, x, z) => ({ slot, job: 'zone', zone: z, dx, x, depth: 4, label: 'CB' })

  it('⚠️ TAKES A MAN EACH RATHER THAN THE AVERAGE OF SEVERAL', () => {
    // Sliding to the mean parks a flat defender between two receivers, covering neither.
    const pairs = pairUnderneathZones(
      [zone('CB1', -18, 8, 'flat'), zone('LB1', -8, 18, 'curl')], split, LOS, 26.7,
    )
    expect(pairs.get('CB1')?.id).toBe('wide')
    expect(pairs.get('LB1')?.id).toBe('slot')
  })

  it('never gives two defenders the same receiver', () => {
    const pairs = pairUnderneathZones(
      [zone('CB1', -18, 6, 'flat'), zone('LB1', -14, 7, 'curl')], split, LOS, 26.7,
    )
    const claimed = [...pairs.values()].map(r => r.id)
    expect(new Set(claimed).size).toBe(claimed.length)
  })

  it('⚠️ LEAVES DEEP ZONES ALONE — they are responsible for an area behind everyone', () => {
    const deep = [{ slot: 'S1', job: 'zone', zone: 'deep', dx: -8, x: 18, depth: 15, label: 'S' }]
    expect(pairUnderneathZones(deep, split, LOS, 26.7).size).toBe(0)
  })

  it('does not align on a back still in the backfield', () => {
    const pairs = pairUnderneathZones([zone('LB1', 0, 26, 'hook')], split, LOS, 26.7)
    expect([...pairs.values()].some(r => r.id === 'back')).toBe(false)
  })

  it('holds its landmark rather than running across the formation', () => {
    // A receiver far outside the reach is somebody else's problem.
    const pairs = pairUnderneathZones([zone('CB1', 20, 48, 'flat')], [split[0]], LOS, 26.7)
    expect(pairs.size).toBe(0)
  })
})

describe('⚠️ A DEEP DEFENDER DOES NOT COME DOWN', () => {
  // His landmark is fifteen yards off the line and the zone radius is seven, so reacting to
  // anything underneath could pull him to eight — and the ball goes over the top of exactly the
  // man who is there to prevent that.
  const LOS = 40
  const landmark = { x: 26, y: LOS + 15 }
  const underneath = { id: 'dig', label: 'WR', x: 24, y: LOS + 6, vx: 0, vy: 0 }

  it('holds its depth against an underneath threat', () => {
    const free = getZoneTarget(landmark, underneath, 99, { dir: 1 })
    const held = getZoneTarget(landmark, underneath, 99, { dir: 1, holdDepthY: LOS + 12 })
    // Unfloored it is dragged forward; floored it is not.
    expect(free.y).toBeLessThan(LOS + 12)
    expect(held.y).toBeGreaterThanOrEqual(LOS + 12)
  })

  it('⚠️ THE FLOOR SURVIVES THE BOUNDARY BREAK, which is applied first', () => {
    // A threat beyond the radius makes the target the zone edge toward him — that edge is shallow,
    // so the floor has to be applied after it or it achieves nothing.
    const faraway = { id: 'far', label: 'WR', x: 26, y: LOS + 2, vx: 0, vy: 0 }
    const held = getZoneTarget(landmark, faraway, 99, { dir: 1, holdDepthY: LOS + 12, radius: 7 })
    expect(held.y).toBeGreaterThanOrEqual(LOS + 12)
  })

  it('still lets him squeeze, so the zone is not frozen', () => {
    const held = getZoneTarget(landmark, underneath, 99, { dir: 1, holdDepthY: LOS + 12 })
    expect(held.y).toBeLessThan(landmark.y)
  })

  it('works the other way when the offense runs the other way', () => {
    const southbound = { x: 26, y: LOS - 15 }
    const under = { id: 'u', label: 'WR', x: 24, y: LOS - 6, vx: 0, vy: 0 }
    const held = getZoneTarget(southbound, under, 99, { dir: -1, holdDepthY: LOS - 12 })
    expect(held.y).toBeLessThanOrEqual(LOS - 12)
  })

  it('leaves an underneath zone alone — no floor, no change', () => {
    const flat = { x: 8, y: LOS + 3 }
    const a = getZoneTarget(flat, underneath, 99, { dir: 1 })
    const b = getZoneTarget(flat, underneath, 99, { dir: 1, holdDepthY: null })
    expect(a).toEqual(b)
  })
})
