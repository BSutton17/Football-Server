import { describe, it, expect } from '@jest/globals'
import { computeZoneCoordination, getZoneTarget } from '../game/systems/movement.js'
import { FIELD } from '../constants.js'

// ── [zone strength] Zone defenders reading the field together ────────────────
//
// The shell is resolved as a unit each tick: one receiver per defender, and a zone that stretches
// when nothing else threatens it so the defender carries his man instead of releasing him at a
// line on the grass. The whole read is built from positions and velocities only — never the play
// call — which these tests lean on by never setting a `route` anywhere.

const LOS = 40      // absolute y of the line of scrimmage
const DIR = 1       // offense advancing toward +y

// Zone centers are stored offense-relative; with dir 1 the absolute y is center + 10.
const toRel = (absY) => absY - FIELD.END_ZONE_DEPTH

function build({ defenders, receivers }) {
  const defensePlayers = new Map()
  const defenseCoverage = new Map()
  for (const d of defenders) {
    // zoneClaimId is the defender's assignment from the previous tick — the stickiness input.
    defensePlayers.set(d.id, { id: d.id, label: d.label ?? 'CB', x: d.x, y: d.y, vx: 0, vy: 0, ratings: d.ratings, zoneClaimId: d.claim ?? null })
    defenseCoverage.set(d.id, {
      type: 'zone',
      zoneType: d.zoneType ?? 'flat',
      zoneCenterX: d.cx,
      zoneCenterY: toRel(d.cy),
    })
  }
  const offensePlayers = new Map()
  for (const r of receivers) {
    offensePlayers.set(r.id, { id: r.id, label: r.label ?? 'WR', x: r.x, y: r.y, vx: r.vx ?? 0, vy: r.vy ?? 0 })
  }
  return { defensePlayers, defenseCoverage, offensePlayers }
}

describe('threat assignment across the shell', () => {
  it('gives each zone defender at most one receiver', () => {
    const state = build({
      defenders: [{ id: 'cb1', cx: 12, cy: 46 }, { id: 'cb2', cx: 40, cy: 46 }],
      receivers: [{ id: 'wr1', x: 12, y: 47 }, { id: 'wr2', x: 40, y: 47 }],
    })
    const out = computeZoneCoordination(state, LOS, DIR)
    expect(out.get('cb1').threat.id).toBe('wr1')
    expect(out.get('cb2').threat.id).toBe('wr2')
  })

  it('never lets two defenders claim the same receiver', () => {
    // One receiver sitting between two adjacent zones — previously both would break on him and
    // both areas would empty. Exactly one may own him.
    const state = build({
      defenders: [{ id: 'cb1', cx: 22, cy: 46 }, { id: 'cb2', cx: 30, cy: 46 }],
      receivers: [{ id: 'wr1', x: 26, y: 46 }],
    })
    const out = computeZoneCoordination(state, LOS, DIR)
    const claimants = ['cb1', 'cb2'].filter(id => out.get(id).threat?.id === 'wr1')
    expect(claimants).toHaveLength(1)
  })

  it('the tighter defender wins the receiver, the other stays home', () => {
    const state = build({
      defenders: [{ id: 'near', cx: 25, cy: 46 }, { id: 'far', cx: 34, cy: 46 }],
      receivers: [{ id: 'wr1', x: 25, y: 46 }],
    })
    const out = computeZoneCoordination(state, LOS, DIR)
    expect(out.get('near').threat.id).toBe('wr1')
    expect(out.get('far').threat).toBeNull()
  })

  it('ignores non-receivers such as the quarterback', () => {
    const state = build({
      defenders: [{ id: 'cb1', cx: 26, cy: 46 }],
      receivers: [{ id: 'qb', label: 'QB', x: 26, y: 46 }],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('cb1').threat).toBeNull()
  })

  it('returns nothing when nobody is playing zone', () => {
    const state = build({ defenders: [], receivers: [{ id: 'wr1', x: 26, y: 46 }] })
    expect(computeZoneCoordination(state, LOS, DIR).size).toBe(0)
  })
})

describe('carrying a receiver when the area is quiet — the Cover-2 flat corner', () => {
  // A flat corner with a single receiver running straight up the field past him, and nobody else
  // anywhere near his area. He should stretch his zone and carry rather than release at 7 yards.
  function coverTwoAllVertical() {
    return build({
      defenders: [{ id: 'flatCb', cx: 12, cy: 46, zoneType: 'flat' }],
      receivers: [
        { id: 'wr1', x: 12, y: 50, vy: 8 },     // climbing away from the flat
        { id: 'wr2', x: 44, y: 50, vy: 8 },     // far side, also going deep — not his problem
      ],
    })
  }

  it('stretches the zone when nothing else is coming', () => {
    const out = computeZoneCoordination(coverTwoAllVertical(), LOS, DIR).get('flatCb')
    expect(out.contested).toBe(false)
    expect(out.radius).toBeGreaterThan(7)
  })

  it('collapses back to a normal zone the moment somebody threatens the area', () => {
    // Same corner, but now a second receiver is breaking into his flat — he has to pass off.
    const state = build({
      defenders: [{ id: 'flatCb', cx: 12, cy: 46, zoneType: 'flat' }],
      receivers: [
        { id: 'wr1', x: 12, y: 50, vy: 8 },     // the vertical he was carrying
        { id: 'wr2', x: 16, y: 45, vx: -4 },    // arriving in the flat
      ],
    })
    const out = computeZoneCoordination(state, LOS, DIR).get('flatCb')
    expect(out.contested).toBe(true)
    expect(out.radius).toBe(7)
  })

  it('reads someone ARRIVING, not just someone already there', () => {
    // The receiver is currently well outside the zone but running hard at it. A defender watching
    // him would see him coming; the look-ahead is what encodes that.
    const state = build({
      defenders: [{ id: 'flatCb', cx: 12, cy: 46, zoneType: 'flat' }],
      receivers: [
        { id: 'wr1', x: 12, y: 52, vy: 9 },
        { id: 'wr2', x: 26, y: 46, vx: -9 },    // 14 yds away but closing fast on the flat
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('flatCb').contested).toBe(true)
  })

  it('a receiver running AWAY does not contest the area', () => {
    const state = build({
      defenders: [{ id: 'flatCb', cx: 12, cy: 46, zoneType: 'flat' }],
      receivers: [
        { id: 'wr1', x: 12, y: 50, vy: 8 },
        { id: 'wr2', x: 24, y: 46, vx: 9 },     // same distance as above, but leaving
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('flatCb').contested).toBe(false)
  })
})

describe('getZoneTarget', () => {
  const center = { x: 26, y: 50 }

  it('is unchanged for the original three-argument call', () => {
    const threat = { x: 40, y: 50, vx: 0, vy: 0 }
    const t = getZoneTarget(center, threat, 55)
    // Clamped to the default 7-yard radius toward the threat.
    expect(t.x).toBeCloseTo(33, 5)
    expect(t.reacting).toBe(true)
  })

  it('a stretched radius lets the defender follow further out', () => {
    const threat = { x: 40, y: 50, vx: 0, vy: 0 }
    const base    = getZoneTarget(center, threat, 55)
    const carried = getZoneTarget(center, threat, 55, { radius: 12 })
    expect(carried.x).toBeGreaterThan(base.x)
    expect(carried.x).toBeCloseTo(38, 5)
  })

  it('plays the throwing lane — biased from the receiver back toward the passer', () => {
    const threat = { x: 30, y: 55, vx: 0, vy: 0 }
    const qb     = { x: 26, y: 34 }
    const plain  = getZoneTarget(center, threat, 55)
    const laned  = getZoneTarget(center, threat, 55, { qb })
    // The lane-aware target sits nearer the passer (lower y) than the receiver's own spot.
    expect(laned.y).toBeLessThan(plain.y)
  })

  it('partial commitment shades from the landmark instead of chasing', () => {
    const threat = { x: 32, y: 50, vx: 0, vy: 0 }
    const full  = getZoneTarget(center, threat, 55, { commitment: 1 })
    const shade = getZoneTarget(center, threat, 55, { commitment: 0.5 })
    expect(shade.x).toBeLessThan(full.x)
    expect(shade.x).toBeGreaterThan(center.x)   // it still comes off the spot
  })

  it('still patrols the landmark with no threat at all', () => {
    const t = getZoneTarget(center, null, 55, { radius: 12, qb: { x: 26, y: 30 } })
    expect(t).toEqual({ x: 26, y: 50, reacting: false })
  })
})


describe('presence beats arrival ([zone decisiveness])', () => {
  // The regression that made defenders swirly: a receiver sprinting at the zone projected closer
  // than one already standing in it, so defenders abandoned the man in front of them to go meet
  // someone who had not arrived. Closing speed may discount a distance, never replace it.
  it('covers the receiver already in the area, not the one running at it', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46 }],
      receivers: [
        { id: 'settled',  x: 26, y: 49, vx: 0, vy: 0 },    // 3 yds away, stationary
        { id: 'arriving', x: 35, y: 47, vx: -9, vy: 0 },   // 9 yds away, sprinting straight at it
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('lb').threat.id).toBe('settled')
  })

  it('still prefers a closer receiver even when he is running away', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46 }],
      receivers: [
        { id: 'near', x: 26, y: 48, vx: 0, vy: 6 },        // leaving, but right here
        { id: 'far',  x: 33, y: 46, vx: -6, vy: 0 },       // closing, but seven yards out
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('lb').threat.id).toBe('near')
  })

  it('a genuinely closer arriving receiver does win', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46 }],
      receivers: [
        { id: 'edge',    x: 26, y: 53, vx: 0, vy: 0 },     // 7 yds out, going nowhere
        { id: 'closing', x: 28, y: 47, vx: -4, vy: 0 },    // 2 yds out and closing
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('lb').threat.id).toBe('closing')
  })
})

describe('the claim is sticky ([zone decisiveness])', () => {
  // Recomputing from scratch 20x a second made defenders flip between similarly-placed receivers
  // and cover neither. The incumbent keeps the assignment unless clearly beaten.
  it('keeps the man it already had when a challenger is only marginally closer', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46, claim: 'mine' }],
      receivers: [
        { id: 'mine',      x: 26, y: 49, vx: 0, vy: 0 },   // 3.0 yds
        { id: 'challenger', x: 26, y: 48.2, vx: 0, vy: 0 }, // 2.2 yds — closer, but not by much
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('lb').threat.id).toBe('mine')
  })

  it('gives it up when the challenger is clearly more urgent', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46, claim: 'mine' }],
      receivers: [
        { id: 'mine',       x: 26, y: 52, vx: 0, vy: 0 },  // drifted out to 6 yds
        { id: 'challenger', x: 26, y: 46.5, vx: 0, vy: 0 }, // right on the landmark
      ],
    })
    expect(computeZoneCoordination(state, LOS, DIR).get('lb').threat.id).toBe('challenger')
  })

  it('records the claim so the next tick can hold on to it', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46 }],
      receivers: [{ id: 'wr1', x: 26, y: 47 }],
    })
    computeZoneCoordination(state, LOS, DIR)
    expect(state.defensePlayers.get('lb').zoneClaimId).toBe('wr1')
  })

  it('clears the claim when there is no longer anyone to cover', () => {
    const state = build({
      defenders: [{ id: 'lb', label: 'LB', cx: 26, cy: 46, claim: 'gone' }],
      receivers: [{ id: 'wr1', x: 50, y: 90 }],       // miles away, undetectable
    })
    computeZoneCoordination(state, LOS, DIR)
    expect(state.defensePlayers.get('lb').zoneClaimId).toBeNull()
  })

  it('stickiness cannot make two defenders keep the same receiver', () => {
    const state = build({
      defenders: [
        { id: 'lb1', label: 'LB', cx: 24, cy: 46, claim: 'wr1' },
        { id: 'lb2', label: 'LB', cx: 28, cy: 46, claim: 'wr1' },
      ],
      receivers: [{ id: 'wr1', x: 26, y: 46 }],
    })
    const out = computeZoneCoordination(state, LOS, DIR)
    const holders = ['lb1', 'lb2'].filter(id => out.get(id).threat?.id === 'wr1')
    expect(holders).toHaveLength(1)
  })
})
