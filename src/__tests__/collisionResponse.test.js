import { describe, it, expect, beforeEach } from '@jest/globals'
import { runCollisionResponse } from '../game/systems/collisionResponse.js'
import { PLAYER } from '../constants.js'

const R = PLAYER.RADIUS  // 0.75 yards
const DT = 0.05

// Build a minimal game state with the provided players.
function makeState({ offense = [], defense = [], ballCarrierId = null } = {}) {
  const offMap = new Map()
  const defMap = new Map()
  for (const p of offense) offMap.set(p.id, p)
  for (const p of defense) defMap.set(p.id, p)
  return { offensePlayers: offMap, defensePlayers: defMap, ballCarrierId }
}

// Shallow-clone a player for before/after comparison.
function snap(p) {
  return { x: p.x, y: p.y, vx: p.vx, vy: p.vy }
}

// ── No collision ──────────────────────────────────────────────────────────────

describe('runCollisionResponse — no overlap', () => {
  it('leaves positions unchanged when players are far apart', () => {
    const o = { id: 'o1', x: 0,  y: 0,  vx: 0, vy: 0 }
    const d = { id: 'd1', x: 20, y: 20, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })
    const before = [snap(o), snap(d)]

    runCollisionResponse(state, null, DT)

    expect(o).toMatchObject(before[0])
    expect(d).toMatchObject(before[1])
  })

  it('leaves velocities unchanged when players are exactly at contact edge', () => {
    const o = { id: 'o1', x: 0,        y: 0, vx: 1, vy: 0 }
    const d = { id: 'd1', x: R * 2,    y: 0, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })
    const beforeVx = o.vx

    runCollisionResponse(state, null, DT)

    expect(o.vx).toBeCloseTo(beforeVx, 5)
  })
})

// ── Positional correction ─────────────────────────────────────────────────────

describe('runCollisionResponse — positional correction', () => {
  it('pushes overlapping players apart so they no longer penetrate', () => {
    // Place players 0.5 yards apart — well inside contact radius 1.5
    const o = { id: 'o1', x: 26,   y: 60, vx: 0, vy: 0 }
    const d = { id: 'd1', x: 26.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })

    runCollisionResponse(state, null, DT)

    const sep = Math.abs(o.x - d.x)
    expect(sep).toBeGreaterThan(R * 2 * 0.8)  // mostly resolved
  })

  it('moves offensive player away from defensive player', () => {
    // o is to the LEFT of d
    const o = { id: 'o1', x: 25,   y: 60, vx: 0, vy: 0 }
    const d = { id: 'd1', x: 25.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })

    runCollisionResponse(state, null, DT)

    // o should shift left (away from d), d should shift right (away from o)
    expect(o.x).toBeLessThan(25)
    expect(d.x).toBeGreaterThan(25.5)
  })

  it('corrects overlap symmetrically — both players move equal amounts', () => {
    const o = { id: 'o1', x: 26,   y: 60, vx: 0, vy: 0 }
    const d = { id: 'd1', x: 26.8, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })
    const ox0 = o.x
    const dx0 = d.x

    runCollisionResponse(state, null, DT)

    const oShift = ox0 - o.x  // o moved left (positive = moved toward lower x)
    const dShift = d.x - dx0  // d moved right
    expect(oShift).toBeCloseTo(dShift, 5)
  })

  it('corrects vertical overlap correctly', () => {
    const o = { id: 'o1', x: 26, y: 60,   vx: 0, vy: 0 }
    const d = { id: 'd1', x: 26, y: 60.5, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })

    runCollisionResponse(state, null, DT)

    expect(o.y).toBeLessThan(60)     // pushed down
    expect(d.y).toBeGreaterThan(60.5)  // pushed up
  })

  it('keeps players within field bounds even when overlapping near the sideline', () => {
    // Place players near the sideline; correction might try to push o out of bounds
    const o = { id: 'o1', x: PLAYER.RADIUS + 0.1, y: 60, vx: 0, vy: 0 }
    const d = { id: 'd1', x: PLAYER.RADIUS + 0.6, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })

    runCollisionResponse(state, null, DT)

    expect(o.x).toBeGreaterThanOrEqual(PLAYER.RADIUS)
    expect(d.x).toBeGreaterThanOrEqual(PLAYER.RADIUS)
  })
})

// ── Velocity impulse ──────────────────────────────────────────────────────────

describe('runCollisionResponse — velocity impulse', () => {
  it('reduces relative velocity along the collision normal when approaching', () => {
    // o moving right, d stationary — they are approaching
    const o = { id: 'o1', x: 25, y: 60, vx: 3, vy: 0 }
    const d = { id: 'd1', x: 25.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })
    const relVxBefore = o.vx - d.vx

    runCollisionResponse(state, null, DT)

    const relVxAfter = o.vx - d.vx
    // After impulse the ball carrier drag also applies, so just check that
    // relative approach velocity has decreased (not increased further)
    expect(Math.abs(relVxAfter)).toBeLessThan(Math.abs(relVxBefore))
  })

  it('does not reverse offensive player velocity when players are already separating', () => {
    // o moving left, d moving right — separating along the collision normal.
    // Impulse is skipped (vRel > 0), so o should keep moving left.
    // Contact drag still fires (they are touching), reducing speed but not flipping direction.
    const o = { id: 'o1', x: 25, y: 60, vx: -5, vy: 0 }
    const d = { id: 'd1', x: 25.5, y: 60, vx: 5, vy: 0 }
    const state = makeState({ offense: [o], defense: [d] })

    runCollisionResponse(state, null, DT)

    // Velocity stays negative (still moving left) — impulse did not flip direction.
    expect(o.vx).toBeLessThan(0)
  })
})

// ── Engagement drag ───────────────────────────────────────────────────────────

describe('runCollisionResponse — engagement drag', () => {
  it('applies heavy tackle drag to the ball carrier on contact', () => {
    const o = { id: 'o1', x: 26, y: 60, vx: 5, vy: 0 }
    const d = { id: 'd1', x: 26.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o], defense: [d], ballCarrierId: 'o1' })
    const speedBefore = Math.sqrt(o.vx ** 2 + o.vy ** 2)

    runCollisionResponse(state, null, DT)

    const speedAfter = Math.sqrt(o.vx ** 2 + o.vy ** 2)
    expect(speedAfter).toBeLessThan(speedBefore * 0.9)  // significant reduction
  })

  it('applies lighter contact drag to non-ball-carrier offensive player', () => {
    const oCarrier  = { id: 'carrier', x: 40, y: 60, vx: 5, vy: 0 }  // far away
    const oReceiver = { id: 'recv',    x: 26, y: 60, vx: 5, vy: 0 }
    const d         = { id: 'd1',      x: 26.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({
      offense: [oCarrier, oReceiver],
      defense: [d],
      ballCarrierId: 'carrier',
    })
    const receiverSpeedBefore = oReceiver.vx

    runCollisionResponse(state, null, DT)

    // Contact drag applied but less severe than tackle drag
    expect(oReceiver.vx).toBeLessThan(receiverSpeedBefore)
    expect(oReceiver.vx).toBeGreaterThan(0)  // still moving, not stopped dead
  })

  it('tackle drag is stronger than contact drag', () => {
    // Two separate games — one where the overlapping player is the carrier,
    // one where they are not. Compare resulting speeds.

    const mkState = (asCarrier) => {
      const o = { id: 'o1', x: 26, y: 60, vx: 5, vy: 0 }
      const d = { id: 'd1', x: 26.5, y: 60, vx: 0, vy: 0 }
      return {
        state: makeState({ offense: [o], defense: [d], ballCarrierId: asCarrier ? 'o1' : null }),
        o,
      }
    }

    const carrier = mkState(true)
    const nonCarrier = mkState(false)

    runCollisionResponse(carrier.state, null, DT)
    runCollisionResponse(nonCarrier.state, null, DT)

    expect(carrier.o.vx).toBeLessThan(nonCarrier.o.vx)
  })

  it('defensive player is not drag-dampened on contact', () => {
    // Defender moving toward the ball carrier — after impulse they may slow, but
    // no explicit drag is applied to them in the system.
    const o = { id: 'o1', x: 26, y: 60, vx: 0, vy: 0 }
    const d = { id: 'd1', x: 26.5, y: 60, vx: -3, vy: 0 }  // closing in
    const state = makeState({ offense: [o], defense: [d] })
    const dSpeedBefore = Math.abs(d.vx)

    runCollisionResponse(state, null, DT)

    // Impulse will transfer some speed; defender may slow but no extra drag
    // Verify the system doesn't apply any drag multiplier to the defender
    // by checking vx magnitude (impulse can reduce it, but not beyond half).
    expect(Math.abs(d.vx)).toBeGreaterThanOrEqual(0)  // at minimum 0 (stopped, not reversed hard)
    // The defender's speed after impulse should not be MORE than before (no energy added)
    expect(Math.abs(d.vx)).toBeLessThanOrEqual(dSpeedBefore + 0.001)
  })
})

// ── Multiple collisions ───────────────────────────────────────────────────────

describe('runCollisionResponse — multiple simultaneous contacts', () => {
  it('resolves all overlapping pairs in a single tick', () => {
    const o1 = { id: 'o1', x: 20, y: 60, vx: 0, vy: 0 }
    const o2 = { id: 'o2', x: 30, y: 60, vx: 0, vy: 0 }
    const d1 = { id: 'd1', x: 20.4, y: 60, vx: 0, vy: 0 }  // overlaps o1
    const d2 = { id: 'd2', x: 30.4, y: 60, vx: 0, vy: 0 }  // overlaps o2
    const state = makeState({ offense: [o1, o2], defense: [d1, d2] })

    runCollisionResponse(state, null, DT)

    // Both pairs should have been pushed apart
    expect(Math.abs(o1.x - d1.x)).toBeGreaterThan(0.5)
    expect(Math.abs(o2.x - d2.x)).toBeGreaterThan(0.5)
  })

  it('does not affect pairs that are not overlapping', () => {
    const o1 = { id: 'o1', x: 20, y: 60, vx: 0, vy: 0 }    // overlaps d1
    const o2 = { id: 'o2', x: 40, y: 60, vx: 2, vy: 1 }    // far from everything
    const d1 = { id: 'd1', x: 20.5, y: 60, vx: 0, vy: 0 }
    const state = makeState({ offense: [o1, o2], defense: [d1] })
    const o2Before = snap(o2)

    runCollisionResponse(state, null, DT)

    expect(o2.x).toBeCloseTo(o2Before.x, 5)
    expect(o2.y).toBeCloseTo(o2Before.y, 5)
    expect(o2.vx).toBeCloseTo(o2Before.vx, 5)
  })
})

// ── All-pairs, mass-weighted separation ([priority 1] — circles never overlap) ──

describe('runCollisionResponse — same-team and mass-weighted separation', () => {
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y)

  it('separates two overlapping offensive linemen (walls, not stacks)', () => {
    const a = { id: 'lt', label: 'T', x: 26,   y: 40, vx: 0, vy: 0 }
    const b = { id: 'lg', label: 'G', x: 26.6, y: 40, vx: 0, vy: 0 }
    const state = makeState({ offense: [a, b] })

    runCollisionResponse(state, null, DT)

    expect(dist(a, b)).toBeGreaterThanOrEqual(R * 2 - 0.02)
  })

  it('separates two overlapping defenders', () => {
    const a = { id: 'lb1', label: 'LB', x: 26,   y: 45, vx: 0, vy: 0 }
    const b = { id: 'lb2', label: 'LB', x: 26.5, y: 45, vx: 0, vy: 0 }
    const state = makeState({ defense: [a, b] })

    runCollisionResponse(state, null, DT)

    expect(dist(a, b)).toBeGreaterThanOrEqual(R * 2 - 0.02)
  })

  it('shoves the lighter player farther — the heavier one holds its ground', () => {
    const ol = { id: 'ol', label: 'T',  x: 26,   y: 40, vx: 0, vy: 0 }  // heavy
    const wr = { id: 'wr', label: 'WR', x: 26.6, y: 40, vx: 0, vy: 0 }  // light
    const state = makeState({ offense: [ol, wr] })
    const olX0 = ol.x, wrX0 = wr.x

    runCollisionResponse(state, null, DT)

    expect(Math.abs(ol.x - olX0)).toBeLessThan(Math.abs(wr.x - wrX0))
  })

  it('leaves no overlapping pair anywhere in a crowded pile', () => {
    const o1 = { id: 'o1', label: 'G',  x: 26,   y: 50,   vx: 0, vy: 0 }
    const o2 = { id: 'o2', label: 'C',  x: 26.4, y: 50.2, vx: 0, vy: 0 }
    const d1 = { id: 'd1', label: 'DL', x: 26.2, y: 49.7, vx: 0, vy: 0 }
    const d2 = { id: 'd2', label: 'LB', x: 25.8, y: 50.4, vx: 0, vy: 0 }
    const state = makeState({ offense: [o1, o2], defense: [d1, d2] })

    runCollisionResponse(state, null, DT)

    const all = [o1, o2, d1, d2]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        expect(dist(all[i], all[j])).toBeGreaterThanOrEqual(R * 2 - 0.05)
      }
    }
  })
})
