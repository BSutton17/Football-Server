import { describe, it, expect } from '@jest/globals'
import { runPushForce } from '../game/systems/pushForce.js'
import { ENGAGEMENT_RADIUS } from '../game/utils/engagementZone.js'

const DT = 0.05

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

// OL blocker with velocity pointing toward (dx, dy).
function drivingOL(id, bx, by, dx, dy) {
  const len = Math.sqrt((dx - bx) ** 2 + (dy - by) ** 2) || 1
  return { id, label: 'OL', x: bx, y: by, vx: (dx - bx) / len * 4, vy: (dy - by) / len * 4 }
}

function still(id, label, x, y) {
  return { id, label, x, y, vx: 0, vy: 0 }
}

function makeState({ offense = [], defense = [] } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    ballCarrierId: null,
  }
}

function snap(p) { return { x: p.x, y: p.y, vx: p.vx, vy: p.vy } }

// ── No engagement ─────────────────────────────────────────────────────────────

describe('runPushForce — no engagement', () => {
  it('applies no force when players are beyond the engagement radius', () => {
    const o = drivingOL('ol1', 26, 55, 26, 57)
    const d = still('d1', 'DL', 26, 55 + ENGAGEMENT_RADIUS + 1)  // clearly outside zone
    const state = makeState({ offense: [o], defense: [d] })
    const before = [snap(o), snap(d)]

    runPushForce(state, null, DT)

    expect(o).toMatchObject(before[0])
    expect(d).toMatchObject(before[1])
  })

  it('applies no force when the offensive player is a route runner (not a blocker)', () => {
    const wr = { ...still('wr1', 'WR', 26, 58), route: 'go' }
    const d  = still('d1', 'CB', 26, 59.5)  // 1.5 yards — inside radius but not a blocker pair
    const state = makeState({ offense: [wr], defense: [d] })
    const before = [snap(wr), snap(d)]

    runPushForce(state, null, DT)

    expect(wr).toMatchObject(before[0])
    expect(d).toMatchObject(before[1])
  })
})

// ── Offense has leverage ──────────────────────────────────────────────────────

describe('runPushForce — offense has leverage', () => {
  // QB at y=50, blocker at y=58, defender at y=60.
  // Separation = 2 yards (inside zone). Blocker between ball and defender → inside leverage.
  function insideSetup() {
    const qb = still('qb1', 'QB', 26, 50)
    const ol = drivingOL('ol1', 26, 58, 26, 60)   // driving north
    const dl = still('d1', 'DL', 26, 60)           // 2 yards away
    return { qb, ol, dl }
  }

  it('pushes the defender away from the ball when offense has leverage', () => {
    const { qb, ol, dl } = insideSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })
    const vyBefore = dl.vy

    runPushForce(state, null, DT)

    // Defender should gain northward velocity (pushed away from QB at y=50)
    expect(dl.vy).toBeGreaterThan(vyBefore)
  })

  it('applies a reaction force to the blocker in the opposite direction', () => {
    const { qb, ol, dl } = insideSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })
    const vyBefore = ol.vy

    runPushForce(state, null, DT)

    // Reaction pushes the blocker slightly back south
    expect(ol.vy).toBeLessThan(vyBefore)
  })

  it('reaction force on blocker is smaller than the force on the defender', () => {
    const { qb, ol, dl } = insideSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })
    const olVy0 = ol.vy
    const dlVy0 = dl.vy

    runPushForce(state, null, DT)

    expect(Math.abs(dl.vy - dlVy0)).toBeGreaterThan(Math.abs(ol.vy - olVy0))
  })

  it('driving blocker produces more force than a stationary one', () => {
    const qb = still('qb1', 'QB', 26, 50)
    const dl = still('d1', 'DL', 26, 60)

    const dl2 = still('d1', 'DL', 26, 60)

    const driving    = drivingOL('ol1', 26, 58, 26, 60)
    const stationary = still('ol1', 'OL', 26, 58)

    const s1 = makeState({ offense: [driving,    still('qb1', 'QB', 26, 50)], defense: [dl] })
    const s2 = makeState({ offense: [stationary, still('qb1', 'QB', 26, 50)], defense: [dl2] })

    runPushForce(s1, null, DT)
    runPushForce(s2, null, DT)

    const d1 = s1.defensePlayers.get('d1')
    const d2 = s2.defensePlayers.get('d1')
    expect(Math.abs(d1.vy)).toBeGreaterThan(Math.abs(d2.vy))
  })

  it('closer engagement produces more force than far engagement', () => {
    const qb = still('qb1', 'QB', 26, 50)

    // Deep in zone: 1.0 yard separation
    const olNear = drivingOL('ol1', 26, 58, 26, 59)
    const dlNear = still('d1', 'DL', 26, 59)
    const sNear  = makeState({ offense: [olNear, still('qb1', 'QB', 26, 50)], defense: [dlNear] })

    // Near zone edge: 2.3 yard separation
    const olFar = drivingOL('ol1', 26, 58, 26, 60.3)
    const dlFar = still('d1', 'DL', 26, 60.3)
    const sFar  = makeState({ offense: [olFar, still('qb1', 'QB', 26, 50)], defense: [dlFar] })

    runPushForce(sNear, null, DT)
    runPushForce(sFar,  null, DT)

    const nearDelta = Math.abs(dlNear.vy)
    const farDelta  = Math.abs(dlFar.vy)
    expect(nearDelta).toBeGreaterThan(farDelta)
  })
})

// ── Defense has leverage ──────────────────────────────────────────────────────

describe('runPushForce — defense has leverage', () => {
  // QB at y=55, defender at y=58, blocker at y=60.
  // Defender is between the ball and the blocker → defense has leverage.
  // Separation = 2 yards (blocker to defender).
  function defenseSetup() {
    const qb = still('qb1', 'QB', 26, 55)
    const ol = still('ol1', 'OL', 26, 60)
    const dl = still('d1',  'DL', 26, 58)   // 2 yards from blocker, closer to ball
    return { qb, ol, dl }
  }

  it('pushes the blocker back toward the ball when defense has leverage', () => {
    const { qb, ol, dl } = defenseSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })
    const vyBefore = ol.vy

    runPushForce(state, null, DT)

    // Ball is southward (low y) — blocker should be pushed south
    expect(ol.vy).toBeLessThan(vyBefore)
  })

  it('blocker is pushed toward the ball (negative vy when ball is south)', () => {
    const { qb, ol, dl } = defenseSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })

    runPushForce(state, null, DT)

    expect(ol.vy).toBeLessThan(0)
  })

  it('a won pass rush drives the rusher WITH the blocker toward the QB (closes in, no recoil)', () => {
    // Mirror of a won run block: the rusher and blocker get the same drive toward the ball, so the
    // pocket collapses as a unit and the rusher closes in — not a light backward recoil ([pass-block]).
    const { qb, ol, dl } = defenseSetup()
    const state = makeState({ offense: [ol, qb], defense: [dl] })
    const olVy0 = ol.vy
    const dlVy0 = dl.vy

    runPushForce(state, null, DT)

    expect(dl.vy).toBeLessThan(dlVy0)   // rusher closes toward the ball (south), not recoiling away
    expect(Math.abs((ol.vy - olVy0) - (dl.vy - dlVy0))).toBeLessThan(1e-6)   // drives together
  })
})

// ── Pocket shaping ────────────────────────────────────────────────────────────

describe('runPushForce — pocket and run lane shaping', () => {
  it('left tackle with inside leverage pushes DE toward the left sideline', () => {
    // LT at (12, 58), DE at (13, 60) — 2.24 yd separation, within zone.
    // QB at (26, 50). LT is between QB and DE (inside leverage).
    const qb = still('qb1', 'QB', 26, 50)
    const lt = drivingOL('lt1', 12, 58, 13, 60)
    const de = still('d1', 'DE', 13, 60)
    const state = makeState({ offense: [lt, qb], defense: [de] })

    runPushForce(state, null, DT)

    // DE should move toward the left sideline (negative x)
    expect(de.vx).toBeLessThan(0)
  })

  it('right tackle with inside leverage pushes DE toward the right sideline', () => {
    // RT at (40, 58), DE at (39, 60) — 2.24 yd separation.
    const qb = still('qb1', 'QB', 26, 50)
    const rt = drivingOL('rt1', 40, 58, 39, 60)
    const de = still('d1', 'DE', 39, 60)
    const state = makeState({ offense: [rt, qb], defense: [de] })

    runPushForce(state, null, DT)

    // DE should move toward the right sideline (positive x)
    expect(de.vx).toBeGreaterThan(0)
  })
})

// ── Multiple simultaneous engagements ─────────────────────────────────────────

describe('runPushForce — multiple simultaneous engagements', () => {
  it('resolves left and right tackle engagements independently', () => {
    const qb  = still('qb1', 'QB', 26, 50)
    const lt  = drivingOL('lt1', 12, 58, 13, 60)
    const rt  = drivingOL('rt1', 40, 58, 39, 60)
    const deL = still('deL', 'DE', 13, 60)
    const deR = still('deR', 'DE', 39, 60)
    const state = makeState({ offense: [lt, rt, qb], defense: [deL, deR] })

    runPushForce(state, null, DT)

    // Left DE pushed left, right DE pushed right
    expect(deL.vx).toBeLessThan(0)
    expect(deR.vx).toBeGreaterThan(0)
  })

  it('double-team produces more force on the defender than a single block', () => {
    const qb1  = still('qb1', 'QB', 26, 50)
    const ol1  = drivingOL('ol1', 26, 58, 26, 60)
    const dl1  = still('dl1', 'DL', 26, 60)
    const singleBlock = makeState({ offense: [ol1, qb1], defense: [dl1] })

    const qb2  = still('qb2', 'QB', 26, 50)
    // Offset by only 0.2 yards in x so they stay nearly as close as the single blocker.
    const ol2a = drivingOL('ol2a', 25.8, 58, 26, 60)
    const ol2b = drivingOL('ol2b', 26.2, 58, 26, 60)
    const dl2  = still('dl2', 'DL', 26, 60)
    const doubleTeam = makeState({ offense: [ol2a, ol2b, qb2], defense: [dl2] })

    runPushForce(singleBlock, null, DT)
    runPushForce(doubleTeam,  null, DT)

    expect(Math.abs(dl2.vy)).toBeGreaterThan(Math.abs(dl1.vy))
  })

  it('an unengaged player is not affected', () => {
    const qb  = still('qb1', 'QB', 26, 50)
    const ol  = drivingOL('ol1', 26, 58, 26, 60)
    const dl1 = still('dl1', 'DL', 26, 60)                        // engaged
    const dl2 = still('dl2', 'DL', 40, 80)                        // far away
    const state = makeState({ offense: [ol, qb], defense: [dl1, dl2] })
    const dl2Before = snap(dl2)

    runPushForce(state, null, DT)

    expect(dl2.vx).toBeCloseTo(dl2Before.vx, 5)
    expect(dl2.vy).toBeCloseTo(dl2Before.vy, 5)
  })
})

// ── Run-blocking displacement ([priority 5]) ──────────────────────────────────

describe('runPushForce — run blocking drives defenders', () => {
  // RB (ballRef) in the backfield; OL between the RB and DL, driving downfield. The OL has
  // inside leverage, so the offense wins and drives the DL the way the OL is moving.
  function setup(playType) {
    const rb = { id: 'rb', label: 'RB', x: 26, y: 50, vx: 0, vy: 0 }
    const ol = { id: 'ol', label: 'OL', x: 26, y: 54, vx: 0, vy: 4 }    // driving downfield
    const dl = { id: 'dl', label: 'DL', x: 26, y: 55.5, vx: 0, vy: 0 }  // engaged ~1.5 yd ahead
    const state = {
      offensePlayers: makeMap([rb, ol]),
      defensePlayers: makeMap([dl]),
      ballCarrierId: 'rb',
      direction: 1,                 // offense advancing toward +y (downfield)
      playDesign: { playType },
    }
    runPushForce(state, null, DT)
    return dl.vy
  }

  it('drives the defender downfield, and harder than pass pro would', () => {
    const runPush  = setup('run')
    const passPush = setup('pass')
    expect(runPush).toBeGreaterThan(0)         // defender driven downfield (displacement)
    expect(runPush).toBeGreaterThan(passPush)  // run blocking moves him more than pocket shaping
  })
})
