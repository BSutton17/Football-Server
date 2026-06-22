import { describe, it, expect } from '@jest/globals'
import {
  runMovement, getManTarget, anticipateRouteBreak, getPursuitTarget, findBallCarrier,
  findZoneThreat, getZoneTarget, computeSafetyRotation, isQbScrambling,
} from '../game/systems/movement.js'
import { pursuitLeadQuality } from '../data/ratings.js'
import { runEngagement } from '../game/systems/engagement.js'
import { runPushForce } from '../game/systems/pushForce.js'
import { runCollisionResponse } from '../game/systems/collisionResponse.js'

const MID = 26.665   // FIELD.WIDTH / 2

// A receiver mid-route with an upcoming break: running up to (30, 45), then cutting
// right to (38, 45). distToBreak = |cur - receiver|.
function routeRunner({ y = 43, label = 'WR', idx = 0 } = {}) {
  return {
    label, x: 30, y, vx: 0, vy: 6,
    routeWaypoints: [{ x: 30, y: 45 }, { x: 38, y: 45 }],
    routeWaypointIdx: idx,
  }
}

// getLosY: dir===1 → 10 + yardLine, dir===-1 → 110 - yardLine
// Test setup: dir=1, yardLine=25 → losY=35
// Offense going north (increasing y). QB is south of LOS (y < 35).
// Anchor y = 35 - 1 * 1.5 = 33.5  (1.5 yards south of LOS, toward QB)

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], dir = 1, yardLine = 25, playType = 'pass' } = {}) {
  return {
    direction: dir,
    yardLine,
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    defenseCoverage: new Map(),
    playerFatigue: new Map(),
    playDesign: { playType },
    ballCarrierId: null,
  }
}

function ol(id = 'ol1', x = 26, y = 35) {
  return { id, label: 'OL', x, y, vx: 0, vy: 0, isEngaged: false, passBlockAnchorX: null, passBlockAnchorY: null }
}

function dl(id = 'dl1', x = 26, y = 37) {
  return { id, label: 'DL', x, y, vx: 0, vy: 0, isEngaged: false }
}

// ── Anchor initialization ─────────────────────────────────────────────────────

describe('pass-block anchor initialization', () => {
  it('the center sets at LOS minus PASS_SET_DEPTH (2.5 yards behind)', () => {
    const p = ol('ol1', MID, 35)   // dead center → no pocket-cup widening
    const state = makeState({ offense: [p] })

    runMovement(state, null, DT)

    expect(p.passBlockAnchorX).toBeCloseTo(MID)
    expect(p.passBlockAnchorY).toBeCloseTo(32.5)   // 35 - 1 * 2.5
  })

  it('an outside lineman sets DEEPER than the center (pocket cup)', () => {
    const c = ol('c', MID, 35)
    const t = ol('t', MID + 9, 35)   // a wide tackle
    const state = makeState({ offense: [c, t] })

    runMovement(state, null, DT)

    // dir=+1 → deeper means a smaller y; the tackle's anchor is behind the center's.
    expect(t.passBlockAnchorY).toBeLessThan(c.passBlockAnchorY)
  })

  it('does not overwrite the anchor on subsequent ticks', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p] })

    runMovement(state, null, DT)
    const ax = p.passBlockAnchorX
    const ay = p.passBlockAnchorY

    // Simulate position drift
    p.x = 27; p.y = 34

    runMovement(state, null, DT)

    expect(p.passBlockAnchorX).toBeCloseTo(ax)
    expect(p.passBlockAnchorY).toBeCloseTo(ay)
  })

  it('anchor y is south of LOS when direction is +1 (toward QB)', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], dir: 1 })

    runMovement(state, null, DT)

    expect(p.passBlockAnchorY).toBeLessThan(35)    // anchor behind LOS
  })

  it('anchor y is north of LOS when direction is -1 (offense going south)', () => {
    // dir=-1, yardLine=25 → losY = 110 - 25 = 85
    const p = ol('ol1', 26, 85)
    p.passBlockAnchorX = null; p.passBlockAnchorY = null
    const state = makeState({ offense: [p], dir: -1, yardLine: 25 })

    runMovement(state, null, DT)

    expect(p.passBlockAnchorY).toBeGreaterThan(85)  // anchor behind LOS (north when going south)
  })

  it('each lineman gets their own anchor x from their snap position', () => {
    const lt = ol('lt', 17, 35)
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 37, 35)
    const state = makeState({ offense: [lt, c, rt] })

    runMovement(state, null, DT)

    expect(lt.passBlockAnchorX).toBeCloseTo(17)
    expect(c.passBlockAnchorX).toBeCloseTo(26)
    expect(rt.passBlockAnchorX).toBeCloseTo(37)
  })
})

// ── Pass-set footwork ─────────────────────────────────────────────────────────

describe('pass-set footwork', () => {
  it('lineman moves backward (toward QB) on a pass play', () => {
    // dir=+1: backward = decreasing y (south)
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], playType: 'pass' })

    runMovement(state, null, DT)

    // vy should be negative — moving south toward anchor at 33.5
    expect(p.vy).toBeLessThan(0)
  })

  it('lineman fires forward (past LOS) on a run play', () => {
    // dir=+1: forward = increasing y (north)
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], playType: 'run' })

    runMovement(state, null, DT)

    // vy should be positive — moving north toward losY + 2 = 37
    expect(p.vy).toBeGreaterThan(0)
  })

  it('run-play lineman does NOT initialize a pass-block anchor', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], playType: 'run' })

    runMovement(state, null, DT)

    // Anchor should still be null — not set on run plays
    expect(p.passBlockAnchorX).toBeNull()
    expect(p.passBlockAnchorY).toBeNull()
  })

  it('C/G/T labels also use pass-block logic (not just OL)', () => {
    const c = { ...ol('c1', 26, 35), label: 'C' }
    const g = { ...ol('g1', 21, 35), label: 'G' }
    const t = { ...ol('t1', 17, 35), label: 'T' }
    const state = makeState({ offense: [c, g, t], playType: 'pass' })

    runMovement(state, null, DT)

    // All should drift backward (negative vy when dir=+1)
    expect(c.vy).toBeLessThan(0)
    expect(g.vy).toBeLessThan(0)
    expect(t.vy).toBeLessThan(0)
  })
})

// ── Gap rusher mirroring ──────────────────────────────────────────────────────

describe('gap rusher mirroring', () => {
  it('lineman holds anchor x when no defender is in range', () => {
    const p = ol('ol1', 26, 35)
    const far = dl('dl1', 26, 46)   // 11 yards away — beyond scan radius
    const state = makeState({ offense: [p], defense: [far] })

    runMovement(state, null, DT)

    // No lateral movement — vx should be ≈ 0
    expect(Math.abs(p.vx)).toBeLessThan(0.01)
  })

  it('lineman mirrors a rusher directly in front (no lateral component)', () => {
    // Rusher is directly north of lineman — same x, closer y
    const p = ol('ol1', 26, 35)
    const rusher = dl('dl1', 26, 37)   // 2 yards north, same x
    const state = makeState({ offense: [p], defense: [rusher] })

    runMovement(state, null, DT)

    // No lateral steering needed
    expect(Math.abs(p.vx)).toBeLessThan(0.1)
  })

  it('lineman mirrors a rusher shifted right → gains rightward velocity', () => {
    const p = ol('ol1', 26, 35)
    const rusher = dl('dl1', 29, 37)   // 3 yards to the right, 2 yards north
    const state = makeState({ offense: [p], defense: [rusher] })

    runMovement(state, null, DT)

    expect(p.vx).toBeGreaterThan(0)   // steering right to mirror
  })

  it('lineman mirrors a rusher shifted left → gains leftward velocity', () => {
    const p = ol('ol1', 26, 35)
    const rusher = dl('dl1', 23, 37)   // 3 yards to the left, 2 yards north
    const state = makeState({ offense: [p], defense: [rusher] })

    runMovement(state, null, DT)

    expect(p.vx).toBeLessThan(0)   // steering left to mirror
  })

  it('lineman holds anchor y regardless of rusher depth', () => {
    // Rusher deep in backfield shouldn't drag lineman forward or back beyond anchor
    const p = ol('ol1', 26, 35)
    const rusher = dl('dl1', 26, 39)   // 4 yards north (rusher has broken free)
    const state = makeState({ offense: [p], defense: [rusher] })

    runMovement(state, null, DT)

    // lineman should still steer toward anchor y (33.5), not rusher y (39)
    // → vy negative (moving south toward anchor), not positive (chasing rusher)
    expect(p.vy).toBeLessThan(0)
  })

  it('lineman ignores a rusher outside its lateral gap window (>4 yards)', () => {
    // Rusher 5 yards to the right — outside this lineman's gap assignment
    const p = ol('ol1', 26, 35)
    const rusher = dl('dl1', 31.5, 37)   // |dx| = 5.5 > MAX_LATERAL_DRIFT = 4
    const state = makeState({ offense: [p], defense: [rusher] })

    runMovement(state, null, DT)

    // No lateral drift — lineman holds anchor
    expect(Math.abs(p.vx)).toBeLessThan(0.1)
  })
})

// ── Pass blockers latch on and stay engaged ──────────────────────────────────

describe('pass blocker latches onto its rusher (stays engaged all play)', () => {
  it('follows a rusher that loops outside the original gap window', () => {
    const p  = ol('ol1', 26, 35)
    const d  = dl('dl1', 26, 37)   // aligned in the gap at the snap
    const state = makeState({ offense: [p], defense: [d], playType: 'pass' })

    runMovement(state, null, DT)   // OL picks up and latches the DL

    // The rusher loops well outside the ±4yd gap window it was picked up in.
    d.x = 34
    runMovement(state, null, DT)

    expect(p.vx).toBeGreaterThan(0)   // chases it out instead of releasing back to the anchor
  })

  it('a rusher aligned outside every gap window is not latched (held by no one yet)', () => {
    const p  = ol('ol1', 26, 35)
    const d  = dl('dl1', 33, 37)   // 7 yards from the anchor — outside the pickup window
    const state = makeState({ offense: [p], defense: [d], playType: 'pass' })

    runMovement(state, null, DT)

    expect(Math.abs(p.vx)).toBeLessThan(0.1)   // holds the pocket, no phantom pickup
  })
})

// ── Gap assignment across the line ───────────────────────────────────────────

describe('gap assignment across the offensive line', () => {
  // Standard shotgun line: LT(17), LG(21), C(26), RG(31), RT(36)
  // Two rushers: interior DT at (24, 37) and edge DE at (38, 37)
  //   Interior DT is in C/LG gap — should be picked up by nearest interior lineman
  //   Edge DE is near RT — should be picked up by RT, not center

  it('interior rusher is handled by the center, not the tackle', () => {
    const c  = ol('c',  26, 35)
    const lt = ol('lt', 17, 35)
    const rt = ol('rt', 36, 35)
    const interiorDT = dl('dt', 24, 37)   // 2 yards from C anchor, 7 from RT anchor

    const state = makeState({ offense: [c, lt, rt], defense: [interiorDT] })
    runMovement(state, null, DT)

    // C should move toward DT (leftward)
    expect(c.vx).toBeLessThan(0)
    // RT should not move laterally (DT is outside RT's lateral window)
    expect(Math.abs(rt.vx)).toBeLessThan(0.1)
  })

  it('edge rusher is handled by the tackle, not the center', () => {
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 36, 35)
    const edgeDE = dl('de', 39, 37)   // 3 yards from RT anchor, 13 from C anchor

    const state = makeState({ offense: [c, rt], defense: [edgeDE] })
    runMovement(state, null, DT)

    // RT should mirror the edge rusher (rightward)
    expect(rt.vx).toBeGreaterThan(0)
    // C should not react (DE is outside C's lateral window)
    expect(Math.abs(c.vx)).toBeLessThan(0.1)
  })

  it('multiple linemen hold their gaps when no rusher is in range', () => {
    const lt = ol('lt', 17, 35)
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 36, 35)
    const state = makeState({ offense: [lt, c, rt], defense: [] })

    runMovement(state, null, DT)

    // All should drift backward (toward anchor) with no lateral movement
    for (const p of [lt, c, rt]) {
      expect(p.vy).toBeLessThan(0)
      expect(Math.abs(p.vx)).toBeLessThan(0.1)
    }
  })
})

// ── Blitz pickup ([blitz feedback]) ───────────────────────────────────────────

describe('blitz pickup — kept-in back', () => {
  it('picks up the FREE blitzer, not a DL the line already has', () => {
    const qb = { id: 'qb', label: 'QB', x: 26, y: 29, vx: 0, vy: 0 }
    const lg = ol('lg', 24, 35)                                      // blocks the DL in its gap
    const rb = { id: 'rb', label: 'RB', x: 26, y: 31, vx: 0, vy: 0, route: 'block' }
    const dt_ = dl('dt', 24, 36)                                     // the LG's man (left)
    const lb = { id: 'lb', label: 'LB', x: 33, y: 36, vx: 0, vy: 0 } // unblocked edge blitzer (right)
    const state = makeState({ offense: [qb, lg, rb], defense: [dt_, lb], playType: 'pass', yardLine: 25 })
    state.defenseCoverage.set('lb', { type: 'blitz' })

    runMovement(state, null, DT)

    // The back steps toward the blitzer on the RIGHT, not the DL on the left.
    expect(rb.vx).toBeGreaterThan(0)
  })

  it('holds in front of the QB when every rusher is already blocked', () => {
    const qb = { id: 'qb', label: 'QB', x: 26, y: 29, vx: 0, vy: 0 }
    const lg = ol('lg', 24, 35)
    const rb = { id: 'rb', label: 'RB', x: 26, y: 31, vx: 0, vy: 0, route: 'block' }
    const dt_ = dl('dt', 24, 36)   // sole rusher, claimed by the LG
    const state = makeState({ offense: [qb, lg, rb], defense: [dt_], playType: 'pass', yardLine: 25 })

    runMovement(state, null, DT)

    // No free rusher → the back doesn't chase the blocked DL across the formation.
    expect(rb.blockTargetId ?? null).toBeNull()
  })
})

// ── Run-block: drive block ────────────────────────────────────────────────────

describe('run-block — drive block', () => {
  // dir=+1, yardLine=25 → losY=35. Lineman at (26,35), DT at (26,37).

  it('lineman steers toward the gap defender (drive block)', () => {
    const p = { ...ol('ol1', 26, 35), passBlockAnchorX: null, passBlockAnchorY: null }
    const d = dl('dl1', 26, 37)
    const state = makeState({ offense: [p], defense: [d], playType: 'run' })

    runMovement(state, null, DT)

    expect(p.vy).toBeGreaterThan(0)   // moving north toward DT
  })

  it('lineman gains lateral velocity toward a defender shifted right', () => {
    const p = ol('ol1', 26, 35)
    const d = dl('dl1', 29, 37)   // 3 right, 2 north — within lateral window
    const state = makeState({ offense: [p], defense: [d], playType: 'run' })

    runMovement(state, null, DT)

    expect(p.vx).toBeGreaterThan(0)
    expect(p.vy).toBeGreaterThan(0)
  })

  it('lineman gains lateral velocity toward a defender shifted left', () => {
    const p = ol('ol1', 26, 35)
    const d = dl('dl1', 23, 37)   // 3 left, 2 north — within lateral window
    const state = makeState({ offense: [p], defense: [d], playType: 'run' })

    runMovement(state, null, DT)

    expect(p.vx).toBeLessThan(0)
    expect(p.vy).toBeGreaterThan(0)
  })

  it('a lineman ignores a defender in another area — the nearer lineman covers it', () => {
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 36, 35)
    const d  = dl('dl1', 31.5, 37)   // between them, nearer to the tackle
    const state = makeState({ offense: [c, rt], defense: [d], playType: 'run' })

    runMovement(state, null, DT)

    expect(rt.blockAssignmentId).toBe('dl1')   // the nearer lineman takes it
    expect(Math.abs(c.vx)).toBeLessThan(0.1)   // the far lineman doesn't chase it
  })
})

// ── Run-block: second-level release ──────────────────────────────────────────

describe('run-block — second-level release', () => {
  it('lineman releases upfield when no defender is in the gap', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], defense: [], playType: 'run' })

    runMovement(state, null, DT)

    expect(p.vy).toBeGreaterThan(0)   // moving north (upfield) to find LBs
  })

  it('release target is further upfield than the pass-block anchor depth', () => {
    // Run release goes to losY + 8 = 43; pass anchor goes to losY - 1.5 = 33.5
    // Both start at y=35. Run lineman should have higher vy than pass lineman.
    const pRun  = ol('run1',  26, 35)
    const pPass = ol('pass1', 26, 35)

    runMovement(makeState({ offense: [pRun],  defense: [], playType: 'run'  }), null, DT)
    runMovement(makeState({ offense: [pPass], defense: [], playType: 'pass' }), null, DT)

    expect(pRun.vy).toBeGreaterThan(pPass.vy)
  })

  it('released lineman does not veer laterally when gap is clear', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], defense: [], playType: 'run' })

    runMovement(state, null, DT)

    expect(Math.abs(p.vx)).toBeLessThan(0.1)
  })
})

// ── Run-block: gap assignment across the line ─────────────────────────────────

describe('run-block — gap assignment across the line', () => {
  it('center attacks interior DT; tackle ignores it', () => {
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 36, 35)
    const dt = dl('dt', 24, 37)   // 2 yards left of C, 12 from RT → only in C gap

    const state = makeState({ offense: [c, rt], defense: [dt], playType: 'run' })
    runMovement(state, null, DT)

    expect(c.vx).toBeLessThan(0)            // C angles left toward DT
    expect(Math.abs(rt.vx)).toBeLessThan(0.1)  // RT ignores out-of-gap DT
  })

  it('edge DE is attacked by the tackle; center ignores it', () => {
    const c  = ol('c',  26, 35)
    const rt = ol('rt', 36, 35)
    const de = dl('de', 38, 37)   // 2 yards right of RT, 12 from C

    const state = makeState({ offense: [c, rt], defense: [de], playType: 'run' })
    runMovement(state, null, DT)

    expect(rt.vx).toBeGreaterThan(0)        // RT angles right toward DE
    expect(Math.abs(c.vx)).toBeLessThan(0.1)   // C ignores out-of-gap DE
  })

  it('two adjacent linemen both attack the same defender (natural double team)', () => {
    // NT directly between the LG and C — both within 4 yards laterally
    const lg = ol('lg', 21, 35)
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)   // |24-21|=3 from LG, |24-26|=2 from C — both in window

    const state = makeState({ offense: [lg, c], defense: [nt], playType: 'run' })
    runMovement(state, null, DT)

    // Both linemen should converge toward the NT
    expect(lg.vx).toBeGreaterThan(0)   // LG moves right toward NT
    expect(c.vx).toBeLessThan(0)       // C moves left toward NT
    expect(lg.vy).toBeGreaterThan(0)
    expect(c.vy).toBeGreaterThan(0)
  })
})

// ── Latched gap assignments & anchoring ([P2]/[P3]) ───────────────────────────

describe('run-block — latched assignments and anchoring', () => {
  it('keeps its latched gap assignment — does not switch to a closer defender ([P2])', () => {
    const p  = ol('ol1', 26, 35)
    const d1 = dl('d1', 26, 37)   // in the gap → assigned first
    const state = makeState({ offense: [p], defense: [d1], playType: 'run' })

    runMovement(state, null, DT)
    expect(p.blockAssignmentId).toBe('d1')

    // A second defender slips into the gap slightly closer — the blocker must NOT switch.
    state.defensePlayers.set('d2', { id: 'd2', label: 'DL', x: 26.4, y: 36.6, vx: 0, vy: 0, isEngaged: false })
    runMovement(state, null, DT)
    expect(p.blockAssignmentId).toBe('d1')
  })

  it('stays anchored — passes off a defender that crosses out of its gap instead of chasing ([P3])', () => {
    const p = ol('ol1', 26, 35)
    const d = dl('d1', 26, 37)
    const state = makeState({ offense: [p], defense: [d], playType: 'run' })

    runMovement(state, null, DT)               // latch anchor at x=26, assign d

    d.x = 40                                   // defender crosses far out of the gap
    for (let i = 0; i < 15; i++) runMovement(state, null, DT)

    expect(Math.abs(p.x - 26)).toBeLessThanOrEqual(2.6)   // held its anchor, didn't chase laterally
    expect(p.blockAssignmentId).toBeNull()                 // passed the crosser off
  })
})

// ── Run-block does not set passBlockAnchor ────────────────────────────────────

describe('run-block does not initialize pass-block state', () => {
  it('no passBlockAnchor is set on a run play', () => {
    const p = ol('ol1', 26, 35)
    const state = makeState({ offense: [p], playType: 'run' })

    runMovement(state, null, DT)

    expect(p.passBlockAnchorX).toBeNull()
    expect(p.passBlockAnchorY).toBeNull()
  })
})

// ── Double-team: secondary release ───────────────────────────────────────────

describe('double-team — secondary blocker release to second level', () => {
  // Layout: LG(21,35), C(26,35), NT(24,37). dir=+1, yardLine=25 → losY=35.
  //
  // Distances from lineman to NT:
  //   LG → NT: √((24-21)²+(37-35)²) = √(9+4) = √13 ≈ 3.61
  //   C  → NT: √((24-26)²+(37-35)²) = √(4+4) = √8  ≈ 2.83
  //
  // C is 0.78 yards closer (> DOUBLE_TEAM_MARGIN=0.5) → C is primary, LG is secondary.
  // Second-level targets must be > 3 yards past LOS (y > 38 when dir=+1).

  it('primary (closer) lineman stays on the first-level defender', () => {
    const lg = ol('lg', 21, 35)
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)
    const lb = dl('lb', 35, 42)   // LB to the right — if C peeled it would gain +vx
    const state = makeState({ offense: [lg, c], defense: [nt, lb], playType: 'run' })
    runMovement(state, null, DT)

    // C (primary) targets NT at x=24 — steers left (vx < 0), not right toward LB
    expect(c.vx).toBeLessThan(0)
  })

  it('a double-team secondary climbs to a linebacker once the block is secured ([priority 2])', () => {
    // C sits right on the NT (block secured); LG is the secondary, and an LB is at the 2nd level.
    const c  = ol('c',  24, 36.5)   // on top of the NT → secured
    const lg = ol('lg', 21, 35)
    const nt = dl('nt', 24, 37)
    const lb = { id: 'lb', label: 'LB', x: 18, y: 42, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [lg, c], defense: [nt, lb], playType: 'run' })
    runMovement(state, null, DT)

    // LG releases to the LB at x=18 (to its left) instead of staying on the NT at x=24.
    expect(lg.vx).toBeLessThan(0)
    expect(lg.vy).toBeGreaterThan(0)
  })

  it('a free blocker climbs to an available linebacker — the 2nd level is accounted for ([P6])', () => {
    const lg = ol('lg', 21, 35)
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)
    const lb = { id: 'lb', label: 'LB', x: 18, y: 42, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [lg, c], defense: [nt, lb], playType: 'run' })
    runMovement(state, null, DT)

    expect(c.blockAssignmentId).toBe('nt')   // the down lineman is covered
    expect(lg.vx).toBeLessThan(0)            // the free blocker climbs to the LB at x=18
  })

  it('a climbing blocker targets linebackers, never safeties ([priority 2])', () => {
    const c  = ol('c',  24, 36.5)   // secured on the NT
    const lg = ol('lg', 21, 35)
    const nt = dl('nt', 24, 37)
    const safety = { id: 's', label: 'S', x: 18, y: 42, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [lg, c], defense: [nt, safety], playType: 'run' })
    runMovement(state, null, DT)

    expect(lg.vx).toBeGreaterThan(0)   // no LB to climb to → stays on the NT, ignores the safety
  })

  it('secondary stays on double team when no second-level target is available', () => {
    const lg = ol('lg', 21, 35)
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)   // only first-level defender — no LBs
    const state = makeState({ offense: [lg, c], defense: [nt], playType: 'run' })
    runMovement(state, null, DT)

    // LG is secondary but nowhere to peel → stays on NT at x=24 → steers right
    expect(lg.vx).toBeGreaterThan(0)
    expect(lg.vy).toBeGreaterThan(0)
  })

  it('single blocker is never secondary — stays on the gap defender', () => {
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)
    const lb = dl('lb', 35, 42)   // LB to the right — would be vx > 0 if C peeled
    const state = makeState({ offense: [c], defense: [nt, lb], playType: 'run' })
    runMovement(state, null, DT)

    // C is the only lineman → primary → stays on NT (steers left, vx < 0)
    expect(c.vx).toBeLessThan(0)
  })

  it('covers every front defender — no down lineman left unblocked ([every man accounted for])', () => {
    const lg  = ol('lg', 21, 35)
    const c   = ol('c',  26, 35)
    const nt  = dl('nt',  24, 37)
    const dt2 = dl('dt2', 15, 37)   // a wide DL that the old greedy logic ignored
    const state = makeState({ offense: [lg, c], defense: [nt, dt2], playType: 'run' })
    runMovement(state, null, DT)

    const assignments = [lg.blockAssignmentId, c.blockAssignmentId]
    expect(assignments).toContain('nt')    // both down linemen are accounted for
    expect(assignments).toContain('dt2')
  })

  it('an in-line TE shares the assignment so an edge rusher is accounted for ([run feedback])', () => {
    // Five OL plus a TE outside the right tackle; a wide DE sits beyond the tackle where only the
    // TE can reach it. Every front defender — including that DE — must get a blocker.
    const lt = ol('lt', 23, 35), lg = ol('lg', 24.75, 35), c = ol('c', 26.5, 35)
    const rg = ol('rg', 28.25, 35), rt = ol('rt', 30, 35)
    const te = { id: 'te', label: 'TE', x: 32, y: 35, vx: 0, vy: 0, isEngaged: false, blockAnchorX: null }
    const d1 = dl('d1', 23, 37), d2 = dl('d2', 25, 37), d3 = dl('d3', 27, 37)
    const d4 = dl('d4', 29, 37), de = dl('de', 33, 37)
    const state = makeState({ offense: [lt, lg, c, rg, rt, te], defense: [d1, d2, d3, d4, de], playType: 'run' })

    runMovement(state, null, DT)

    const ids = [lt, lg, c, rg, rt, te].map(b => b.blockAssignmentId)
    for (const id of ['d1', 'd2', 'd3', 'd4', 'de']) expect(ids).toContain(id)  // everyone blocked
    expect(te.blockAssignmentId).toBe('de')   // the TE takes the edge rusher it's aligned over
  })

  it('second-level scan does not reach a defender beyond the scan radius', () => {
    const lg = ol('lg', 21, 35)
    const c  = ol('c',  26, 35)
    const nt = dl('nt', 24, 37)
    const farSafety = dl('s', 20, 80)   // 45 yards away — beyond 15-yard scan radius
    const state = makeState({ offense: [lg, c], defense: [nt, farSafety], playType: 'run' })
    runMovement(state, null, DT)

    // Safety is out of range — LG stays on NT → steers right (vx > 0)
    expect(lg.vx).toBeGreaterThan(0)
  })
})

// ── route='block' non-linemen are unaffected ─────────────────────────────────

describe('route=block (RB/TE) uses old blocker logic, not pass-block', () => {
  it('TE with route=block does not get a passBlockAnchor', () => {
    const te = { id: 'te1', label: 'TE', route: 'block', x: 32, y: 35, vx: 0, vy: 0, isEngaged: false }
    const qb = { id: 'qb1', label: 'QB', x: 26, y: 27, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [te, qb] })

    runMovement(state, null, DT)

    expect(te.passBlockAnchorX).toBeUndefined()
  })
})

// ── DL auto-rush — no coverage assignment ────────────────────────────────────
//
// dir=+1, yardLine=25 → losY=35. QB at y=27 (behind LOS), DL at y=37 (past LOS).
// A DL with no coverage assignment auto-rushes toward the QB.

function defDL(id = 'dl1', x = 26, y = 37) {
  return { id, label: 'DL', x, y, vx: 0, vy: 0, isEngaged: false }
}

function defQB(x = 26, y = 27) {
  return { id: 'qb', label: 'QB', x, y, vx: 0, vy: 0, isEngaged: false }
}

describe('DL auto-rush — no coverage assignment', () => {
  it('DL moves toward the QB (southward when dir=+1)', () => {
    const d = defDL('dl1', 26, 37)
    const state = makeState({ offense: [defQB()], defense: [d] })

    runMovement(state, null, DT)

    expect(d.vy).toBeLessThan(0)   // steering south toward QB at y=27
  })

  it('interior DL does not drift laterally when QB is directly ahead (same x)', () => {
    // A lone DL is its own edge rusher and arcs outside; add flanks so this one is interior.
    const leftDL  = defDL('ldl', 15, 37)
    const d       = defDL('dl1', 26, 37)   // interior, directly below QB
    const rightDL = defDL('rdl', 38, 37)
    const state   = makeState({ offense: [defQB(26, 27)], defense: [d, leftDL, rightDL] })

    runMovement(state, null, DT)

    expect(Math.abs(d.vx)).toBeLessThan(0.1)
  })

  it('interior DL steers laterally when QB is off-center', () => {
    // A solo DL becomes its own edge rusher and contains. Add flanking DLs so this
    // one is interior and uses qb.x directly.
    const leftDL  = defDL('ldl', 15, 37)
    const d       = defDL('dl1', 26, 37)   // interior
    const rightDL = defDL('rdl', 38, 37)
    const state   = makeState({ offense: [defQB(30, 27)], defense: [d, leftDL, rightDL] })

    runMovement(state, null, DT)

    expect(d.vx).toBeGreaterThan(0)   // interior DL steers right toward QB.x = 30
  })

  it('non-DL with no coverage drifts to 5 yards past LOS, not toward QB', () => {
    // LB default: steer toward losY + dir*5 = 40. LB at y=37 → vy > 0 (northward to 40).
    const lb = { id: 'lb1', label: 'LB', x: 26, y: 37, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [defQB()], defense: [lb] })

    runMovement(state, null, DT)

    expect(lb.vy).toBeGreaterThan(0)   // drifting north toward 40, not chasing QB
  })
})

// ── DL contain — edge rushers hold outside lanes ──────────────────────────────
//
// Edge rushers are the outermost defenders not in zone/man coverage.
// They hold their x-lane until within CONTAIN_CLOSE_THRESHOLD (3 yards) of QB depth,
// then close inside toward QB.x.

describe('DL contain — edge rushers rush outside', () => {
  it('edge DL flares outside toward its contain lane while upfield of the QB', () => {
    // QB at x=26 → contain lanes sit at 26 ± 4.5 = 21.5 (left) and 30.5 (right).
    // Edge rushers starting inside their lane flare outward to keep contain,
    // while still pressing toward QB depth.
    const leftDL  = defDL('ldl', 24, 37)   // inside the left lane → steers left (outside)
    const rightDL = defDL('rdl', 28, 37)   // inside the right lane → steers right (outside)
    const state   = makeState({ offense: [defQB(26, 27)], defense: [leftDL, rightDL] })

    runMovement(state, null, DT)

    expect(leftDL.vx).toBeLessThan(0)      // flaring outside-left
    expect(rightDL.vx).toBeGreaterThan(0)  // flaring outside-right
    expect(leftDL.vy).toBeLessThan(0)      // still pressing upfield toward QB depth
    expect(rightDL.vy).toBeLessThan(0)
  })

  it('edge DL closes on QB when within CONTAIN_CLOSE_THRESHOLD (3 yards of QB depth)', () => {
    // QB at y=27, DL at y=29 → |29-27| = 2 < 3 → close inside toward QB.x
    const leftDL  = defDL('ldl', 15, 29)
    const rightDL = defDL('rdl', 38, 29)
    const state   = makeState({ offense: [defQB(26, 27)], defense: [leftDL, rightDL] })

    runMovement(state, null, DT)

    // tx = QB.x = 26. Left DL at x=15 → steers right; right DL at x=38 → steers left
    expect(leftDL.vx).toBeGreaterThan(0)
    expect(rightDL.vx).toBeLessThan(0)
  })

  it('interior DL (not outermost) rushes straight at QB.x without contain', () => {
    const leftDL   = defDL('ldl', 15, 37)
    const centerDL = defDL('cdl', 26, 37)
    const rightDL  = defDL('rdl', 38, 37)
    const state    = makeState({ offense: [defQB(26, 27)], defense: [leftDL, centerDL, rightDL] })

    runMovement(state, null, DT)

    // centerDL is interior — rushes directly at QB.x=26 (same x → minimal lateral)
    expect(Math.abs(centerDL.vx)).toBeLessThan(0.1)
    expect(centerDL.vy).toBeLessThan(0)
  })

  it('zone-covered DL is excluded from the edge-rusher set', () => {
    // leftDL has zone coverage → excluded. rightDL is only uncovered defender.
    const leftDL  = defDL('ldl', 15, 37)
    const rightDL = defDL('rdl', 38, 37)
    const state   = makeState({ offense: [defQB(26, 27)], defense: [leftDL, rightDL] })
    state.defenseCoverage.set('ldl', { type: 'zone', zoneCenterX: 10, zoneCenterY: 40 })

    runMovement(state, null, DT)

    // rightDL has no coverage → auto-rushes QB (southward)
    expect(rightDL.vy).toBeLessThan(0)
    // leftDL steers toward zone center at x=10 (left of x=15 → vx < 0)
    expect(leftDL.vx).toBeLessThan(0)
  })
})

// ── Blitz engaged speed — BLITZ_ENGAGED_MULT vs ENGAGED_SPEED_MULT ────────────
//
// Engaged blitzers (BLITZ_ENGAGED_MULT = 0.75) should reach higher speed than
// engaged DL auto-rushing (ENGAGED_SPEED_MULT = 0.5).

describe('blitz engaged speed multiplier', () => {
  it('engaged blitzer moves faster than an engaged standard auto-rusher', () => {
    const qb1    = defQB(26, 27)
    const blitzLB = { id: 'lb', label: 'LB', x: 26, y: 37, vx: 0, vy: 0, isEngaged: true }
    const state1  = makeState({ offense: [qb1], defense: [blitzLB] })
    state1.defenseCoverage.set('lb', { type: 'blitz' })

    const qb2   = defQB(26, 27)
    const stdDL = { id: 'dl', label: 'DL', x: 26, y: 37, vx: 0, vy: 0, isEngaged: true }
    const state2 = makeState({ offense: [qb2], defense: [stdDL] })
    // no coverage → default DL auto-rush path (uses ENGAGED_SPEED_MULT = 0.5)

    runMovement(state1, null, DT)
    runMovement(state2, null, DT)

    // Blitz uses BLITZ_ENGAGED_MULT (0.75) × topSpd; standard uses ENGAGED_SPEED_MULT (0.5) × topSpd
    const blitzSpeed = Math.sqrt(blitzLB.vx ** 2 + blitzLB.vy ** 2)
    const stdSpeed   = Math.sqrt(stdDL.vx   ** 2 + stdDL.vy   ** 2)
    expect(blitzSpeed).toBeGreaterThan(stdSpeed)
  })

  it('unengaged blitzer moves faster than an engaged blitzer', () => {
    const makeBlitz = (id, isEngaged) => {
      const q = defQB(26, 27)
      const d = { id, label: 'LB', x: 26, y: 37, vx: 0, vy: 0, isEngaged }
      const s = makeState({ offense: [q], defense: [d] })
      s.defenseCoverage.set(id, { type: 'blitz' })
      return { state: s, d }
    }

    const { state: sEng,   d: dEng   } = makeBlitz('lb_eng',   true)
    const { state: sUneng, d: dUneng } = makeBlitz('lb_uneng', false)

    runMovement(sEng,   null, DT)
    runMovement(sUneng, null, DT)

    const speedEng   = Math.sqrt(dEng.vx   ** 2 + dEng.vy   ** 2)
    const speedUneng = Math.sqrt(dUneng.vx ** 2 + dUneng.vy ** 2)
    expect(speedUneng).toBeGreaterThan(speedEng)
  })
})

// ── Man coverage — getManTarget (mirror / anticipate / trail) ─────────────────

describe('getManTarget — man coverage blend', () => {
  it('anticipates by leading a receiver sprinting downfield (stays over the top)', () => {
    const rec = { x: MID, y: 50, vx: 0, vy: 9 }   // sprinting north
    const t = getManTarget(rec, 1)
    expect(t.y).toBeGreaterThan(rec.y)             // target ahead of the receiver, not trailing it
  })

  it('trails slightly underneath a stationary receiver (toward the LOS)', () => {
    const rec = { x: MID, y: 50, vx: 0, vy: 0 }
    const t = getManTarget(rec, 1)
    expect(t.y).toBeLessThan(rec.y)                // underneath when there is no downfield push
  })

  it('underneath leverage flips with offense direction', () => {
    const rec = { x: MID, y: 50, vx: 0, vy: 0 }
    const t = getManTarget(rec, -1)
    expect(t.y).toBeGreaterThan(rec.y)
  })

  it('holds inside leverage on a right-hash receiver (biases toward midfield)', () => {
    const rec = { x: 40, y: 50, vx: 0, vy: 0 }
    const t = getManTarget(rec, 1)
    expect(t.x).toBeLessThan(rec.x)                // inside = toward center
  })

  it('holds inside leverage on a left-hash receiver', () => {
    const rec = { x: 13, y: 50, vx: 0, vy: 0 }
    const t = getManTarget(rec, 1)
    expect(t.x).toBeGreaterThan(rec.x)
  })

  it('mirrors a lateral cut — the lead shifts toward the break', () => {
    const still = getManTarget({ x: MID, y: 50, vx: 0, vy: 0 }, 1)
    const cut   = getManTarget({ x: MID, y: 50, vx: 7, vy: 0 }, 1)   // breaking right
    expect(cut.x).toBeGreaterThan(still.x)
  })

  it('tolerates a receiver with no velocity fields', () => {
    const t = getManTarget({ x: MID, y: 50 }, 1)
    expect(Number.isFinite(t.x)).toBe(true)
    expect(Number.isFinite(t.y)).toBe(true)
  })
})

describe('man coverage movement (integration)', () => {
  it('a man defender pursues its assigned receiver downfield', () => {
    const rec = { id: 'wr1', label: 'WR', x: 30, y: 46, vx: 0, vy: 0 }
    const def = { id: 'cb1', label: 'CB', x: 30, y: 38, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rec], defense: [def] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    runMovement(state, null, DT)

    expect(def.vy).toBeGreaterThan(0)   // receiver is downfield → defender closes north
  })

  it('a man defender with a missing target does not move', () => {
    const def = { id: 'cb1', label: 'CB', x: 30, y: 38, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [], defense: [def] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'ghost' })

    runMovement(state, null, DT)

    expect(def.vx).toBe(0)
    expect(def.vy).toBe(0)
  })
})

// ── [144] Route-break prediction — anticipateRouteBreak ───────────────────────

describe('anticipateRouteBreak', () => {
  it('returns null for a receiver with no route waypoints', () => {
    expect(anticipateRouteBreak({ label: 'WR', x: 30, y: 43 }, 99)).toBeNull()
  })

  it('returns null on the final route segment (no upcoming break)', () => {
    const rec = routeRunner({ idx: 1 })   // already on the last waypoint
    expect(anticipateRouteBreak(rec, 99)).toBeNull()
  })

  it('only awareness 95+ predicts ahead of the cut', () => {
    // Same receiver right on top of the break; sub-elite recognition can't read it early.
    const sloppy = { y: 44.9, label: 'QB' }   // 0.1 yd from the break, easy to read
    expect(anticipateRouteBreak(routeRunner(sloppy), 94)).toBeNull()
    expect(anticipateRouteBreak(routeRunner(sloppy), 95)).not.toBeNull()
  })

  it('a sub-elite defender never anticipates, even right at the break', () => {
    expect(anticipateRouteBreak(routeRunner({ y: 44.9 }), 90)).toBeNull()
  })

  it('reads the break and points toward the post-break direction when close', () => {
    const rec  = routeRunner({ y: 43.5 })   // 1.5 yards from the break
    const pred = anticipateRouteBreak(rec, 99)
    expect(pred).not.toBeNull()
    expect(pred.react).toBeGreaterThan(0)
    expect(pred.react).toBeLessThanOrEqual(1)
    expect(pred.dirX).toBeCloseTo(1)      // break cuts to the right (+x)
    expect(pred.dirY).toBeCloseTo(0)
  })

  it('better awareness reacts earlier within the elite band', () => {
    // At 2 yards out, a 99 reads it but a 95 is still outside its (smaller) window.
    const at95 = anticipateRouteBreak(routeRunner({ y: 43, label: 'QB' }), 95)
    const at99 = anticipateRouteBreak(routeRunner({ y: 43, label: 'QB' }), 99)
    expect(at99.react).toBeGreaterThan(at95?.react ?? 0)
  })

  it('a sharper route runner is read later than a sloppy one', () => {
    // Same elite defender and distance; higher routeRunning disguises the break.
    const vsSharp  = anticipateRouteBreak(routeRunner({ y: 43, label: 'WR' }), 99)  // WR rr=88
    const vsSloppy = anticipateRouteBreak(routeRunner({ y: 43, label: 'QB' }), 99)  // QB rr=40
    expect(vsSloppy.react).toBeGreaterThan(vsSharp.react)
  })

  it('elite route deception can keep even a 95-awareness defender from reading the cut', () => {
    // 95 awareness (bottom of the elite band) vs an elite WR route runner: window collapses.
    expect(anticipateRouteBreak(routeRunner({ y: 44.5, label: 'WR' }), 95)).toBeNull()
  })

  it('getManTarget shifts toward an anticipated break the defender is leveraged for', () => {
    // routeRunner breaks right; a defender with RIGHT leverage (+1) is in position to jump it.
    const noBreak   = getManTarget({ x: 30, y: 43.5, vx: 0, vy: 6 }, 1, 99, 1)
    const withBreak = getManTarget(routeRunner({ y: 43.5 }), 1, 99, 1)
    expect(withBreak.x).toBeGreaterThan(noBreak.x)   // jumps toward the right-breaking cut
  })
})

// ── [149-fix] Man coverage respects alignment / leverage ──────────────────────

describe('getManTarget — leverage and alignment', () => {
  it('holds the leverage cushion on the defender\'s aligned side', () => {
    const rec = { x: 26.665, y: 50, vx: 0, vy: 0 }
    const right = getManTarget(rec, 1, 55, 1)    // defender aligned to the receiver's right
    const left  = getManTarget(rec, 1, 55, -1)   // aligned to the left
    expect(right.x).toBeGreaterThan(rec.x)       // stays right of the receiver
    expect(left.x).toBeLessThan(rec.x)           // stays left of the receiver
  })

  it('does NOT pre-jump a break away from its leverage (outside leverage vs inside post)', () => {
    // routeRunner breaks right; an outside (LEFT-leverage) defender must trail, not undercut.
    const baseline = getManTarget({ x: 30, y: 43.5, vx: 0, vy: 6 }, 1, 99, -1)
    const facing   = getManTarget(routeRunner({ y: 43.5 }), 1, 99, -1)
    expect(facing.x).toBeCloseTo(baseline.x)     // no anticipation shift toward the break
  })

  it('does NOT anticipate a comeback (break back toward the LOS)', () => {
    // A receiver about to plant and come back: break direction is back toward the LOS.
    const comeback = {
      label: 'WR', x: 30, y: 53, vx: 0, vy: 4,
      routeWaypoints: [{ x: 30, y: 55 }, { x: 30, y: 50 }], routeWaypointIdx: 0,
    }
    const baseline = getManTarget({ x: 30, y: 53, vx: 0, vy: 4 }, 1, 99, 1)
    const facing   = getManTarget(comeback, 1, 99, 1)
    expect(facing.y).toBeCloseTo(baseline.y)     // doesn't pre-stop — must react late / overrun
  })

  it('still jumps a break toward its leverage (inside leverage vs inside break)', () => {
    // routeRunner breaks right; a RIGHT-leverage defender is leveraged and may jump it.
    const baseline = getManTarget({ x: 30, y: 43.5, vx: 0, vy: 6 }, 1, 99, 1)
    const facing   = getManTarget(routeRunner({ y: 43.5 }), 1, 99, 1)
    expect(facing.x).toBeGreaterThan(baseline.x)
  })
})

describe('man coverage alignment (integration)', () => {
  it('a corner holds its alignment side rather than crossing the receiver', () => {
    // CB aligned outside (to the receiver's right) keeps outside leverage over time.
    const wr  = { id: 'wr1', label: 'WR', x: 40, y: 45, vx: 0, vy: 0, isEngaged: false }
    const cb  = { id: 'cb1', label: 'CB', x: 42, y: 44, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [wr], defense: [cb] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    for (let i = 0; i < 15; i++) runMovement(state, null, DT)

    expect(cb.x).toBeGreaterThan(wr.x)   // never crossed to the inside
  })
})

// ── [143] Momentum-limited coverage — no impossible movements ─────────────────

describe('man coverage — realistic trailing (momentum)', () => {
  it('a defender at speed cannot instantly reverse direction', () => {
    // CB sprinting north; the receiver is behind it (south), demanding a reversal.
    const rec = { id: 'wr1', label: 'WR', x: 30, y: 30, vx: 0, vy: 0 }
    const def = { id: 'cb1', label: 'CB', x: 30, y: 40, vx: 0, vy: 8, isEngaged: false }
    const state = makeState({ offense: [rec], defense: [def] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    runMovement(state, null, DT)

    // Momentum is preserved — still moving north this tick, not snapped south.
    expect(def.vy).toBeGreaterThan(0)
  })

  it('a defender comes around over several ticks rather than teleporting', () => {
    // Receiver sits near losY+8 (≈43) so moveOffense leaves it roughly in place;
    // the defender starts sprinting north (away) and must turn all the way around.
    const rec = { id: 'wr1', label: 'WR', x: 30, y: 43, vx: 0, vy: 0 }
    const def = { id: 'cb1', label: 'CB', x: 30, y: 55, vx: 0, vy: 8, isEngaged: false }
    const state = makeState({ offense: [rec], defense: [def] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    for (let i = 0; i < 40; i++) runMovement(state, null, DT)

    expect(def.vy).toBeLessThan(0)   // has turned around and is now pursuing south
  })

  it('never exceeds its max speed while turning', () => {
    const rec = { id: 'wr1', label: 'WR', x: 45, y: 30, vx: 0, vy: 0 }
    const def = { id: 'cb1', label: 'CB', x: 30, y: 40, vx: 0, vy: 8, isEngaged: false }
    const state = makeState({ offense: [rec], defense: [def] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    for (let i = 0; i < 20; i++) {
      runMovement(state, null, DT)
      const speed = Math.sqrt(def.vx ** 2 + def.vy ** 2)
      expect(speed).toBeLessThanOrEqual(9.5 + 0.01)   // MAX_SPEED ceiling (rating 99)
    }
  })
})

// ── [145] Pursuit angles — getPursuitTarget ───────────────────────────────────

describe('getPursuitTarget', () => {
  it('aims at the current position for a stationary target (no lead)', () => {
    const t = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 0, vy: 0 }, 6)
    expect(t.x).toBeCloseTo(0)
    expect(t.y).toBeCloseTo(10)
  })

  it('leads a target moving laterally (intercept ahead in its travel direction)', () => {
    // Pursuer below the target; target sprinting right. Intercept must lead to the right.
    const t = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 4, vy: 0 }, 7)
    expect(t.x).toBeGreaterThan(0)   // led toward where the target is heading
    expect(t.y).toBeCloseTo(10)
  })

  it('the intercept is a real meeting point (pursuer and target arrive together)', () => {
    const pursuer = { x: 0, y: 0 }
    const target  = { x: 0, y: 10, vx: 4, vy: 0 }
    const s = 7
    const t = getPursuitTarget(pursuer, target, s)

    const pursuerTime = Math.hypot(t.x - pursuer.x, t.y - pursuer.y) / s
    const targetTime  = (t.x - target.x) / target.vx   // time for target to reach intercept x
    expect(pursuerTime).toBeCloseTo(targetTime, 2)
  })

  it('leads further ahead of a faster carrier than a slower one', () => {
    const slow = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 2, vy: 0 }, 7)
    const fast = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 5, vy: 0 }, 7)
    expect(fast.x).toBeGreaterThan(slow.x)
  })

  it('takes a deep angle (not a direct chase) when the carrier is pulling away ([priority 5])', () => {
    // Target sprinting straight downfield faster than the pursuer → no clean intercept.
    const t = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 0, vy: 9 }, 5)
    expect(t.y).toBeGreaterThan(10)   // aims ahead of the carrier (deep angle), not at its current spot
    expect(t.x).toBeCloseTo(0)
  })

  it('a faster defender takes a flatter angle; a slower one aims deeper ([priority 5])', () => {
    const pursuer = { x: 18, y: 50 }
    const carrier = { x: 26, y: 50, vx: 0, vy: 6 }   // running straight downfield
    const fast = getPursuitTarget(pursuer, carrier, 9)
    const slow = getPursuitTarget(pursuer, carrier, 6.5)
    expect(fast.y).toBeLessThan(slow.y)   // fast cuts it off shallow; slow takes a deeper angle
  })

  it('caps the lead distance for a deep, fast carrier (no off-field targets)', () => {
    const t = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 60, vx: 9, vy: 0 }, 9.2)
    // Lead is clamped to PURSUIT_MAX_LEAD (3.5s), and x is clamped to the field.
    expect(t.x).toBeLessThanOrEqual(53.33)
    expect(t.x).toBeGreaterThanOrEqual(0)
  })

  it('tolerates a target with no velocity fields', () => {
    const t = getPursuitTarget({ x: 5, y: 5 }, { x: 10, y: 20 }, 6)
    expect(t.x).toBeCloseTo(10)
    expect(t.y).toBeCloseTo(20)
  })

  it('a higher pursuit IQ anticipates the intercept more than a lower one ([160])', () => {
    const pursuer = { x: 0, y: 0 }
    const target  = { x: 0, y: 10, vx: 4, vy: 0 }
    const hi = getPursuitTarget(pursuer, target, 7, pursuitLeadQuality(95))
    const lo = getPursuitTarget(pursuer, target, 7, pursuitLeadQuality(20))
    expect(hi.x).toBeGreaterThan(lo.x)       // takes a better cut-off angle
    expect(lo.x).toBeGreaterThan(target.x)   // still leads somewhat — not a pure tail chase
  })

  it('a zero lead quality is a pure tail chase (aims at the current spot) ([160])', () => {
    const t = getPursuitTarget({ x: 0, y: 0 }, { x: 0, y: 10, vx: 4, vy: 0 }, 7, 0)
    expect(t.x).toBeCloseTo(0)
    expect(t.y).toBeCloseTo(10)
  })
})

describe('findBallCarrier', () => {
  it('returns null during pocket passing (no explicit carrier, pass play)', () => {
    const state = makeState({ offense: [{ id: 'qb', label: 'QB', x: 26, y: 30 }], playType: 'pass' })
    expect(findBallCarrier(state)).toBeNull()
  })

  it('returns the RB on a run play', () => {
    const rb = { id: 'rb', label: 'RB', x: 26, y: 30 }
    const state = makeState({ offense: [rb], playType: 'run' })
    expect(findBallCarrier(state)).toBe(rb)
  })

  it('returns the explicit ball carrier when set, regardless of play type', () => {
    const wr = { id: 'wr', label: 'WR', x: 26, y: 40 }
    const state = makeState({ offense: [wr], playType: 'pass' })
    state.ballCarrierId = 'wr'
    expect(findBallCarrier(state)).toBe(wr)
  })
})

// ── Ball-carrier transition: catch & scramble ([181][183][186]) ───────────────

describe('ball-carrier transition', () => {
  it('a receiver set as carrier runs downfield through the shared model ([181])', () => {
    const wr = { id: 'wr1', label: 'WR', x: 26, y: 50, vx: 0, vy: 8 }
    const state = makeState({ offense: [wr], playType: 'pass' })
    state.ballCarrierId = 'wr1'

    for (let i = 0; i < 20; i++) runMovement(state, null, DT)

    expect(wr.y).toBeGreaterThan(50)   // advanced upfield as a runner
    expect(wr.vy).toBeGreaterThan(0)
  })

  it('preserves the receiver momentum on the catch — no acceleration reset ([183])', () => {
    // Catches in stride at ~top speed; the very next tick it must still be moving fast,
    // not decelerated to re-accelerate as a "new" runner.
    const wr = { id: 'wr1', label: 'WR', x: 26, y: 50, vx: 0, vy: 8 }
    const state = makeState({ offense: [wr], playType: 'pass' })
    state.ballCarrierId = 'wr1'

    runMovement(state, null, DT)

    expect(Math.hypot(wr.vx, wr.vy)).toBeGreaterThan(7.5)   // kept its stride
  })

  it('a scrambling QB turns upfield (north-south) instead of carrying its backpedal ([186])', () => {
    // QB dropped back (moving away from the LOS) when the scramble is called.
    const qb = { id: 'qb', label: 'QB', x: 26, y: 30, vx: 0, vy: -5 }
    const state = makeState({ offense: [qb], playType: 'pass' })
    state.ballCarrierId = 'qb'   // scramble committed

    for (let i = 0; i < 40; i++) runMovement(state, null, DT)

    expect(qb.vy).toBeGreaterThan(0)   // reversed its backpedal and is running upfield
  })
})

describe('ball-carrier pursuit (integration)', () => {
  it('on a run, a box defender shuffles laterally and holds depth before collapsing ([run fix])', () => {
    // Carrier up and to the right of an interior linebacker.
    const rb  = { id: 'rb', label: 'RB', x: 32, y: 45, vx: 0, vy: 0 }
    const def = { id: 'lb', label: 'LB', x: 20, y: 30, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rb], defense: [def], playType: 'run' })

    runMovement(state, null, DT)
    expect(def.vx).toBeGreaterThan(0)          // mirrors the carrier laterally (to the right)
    expect(Math.abs(def.vy)).toBeLessThan(1)   // holds its depth — does not crash downhill yet

    // After the ~1s hold it commits and pursues the ball upfield.
    for (let i = 0; i < 25; i++) runMovement(state, null, DT)
    expect(def.vy).toBeGreaterThan(0)
  })

  it('box defenders flow to their own gaps and stay spread — no piling on one hole ([priority 4])', () => {
    const rb  = { id: 'rb',  label: 'RB', x: 30, y: 45, vx: 0, vy: 0 }
    const lb1 = { id: 'lb1', label: 'LB', x: 20, y: 40, vx: 0, vy: 0, isEngaged: false }
    const lb2 = { id: 'lb2', label: 'LB', x: 33, y: 40, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rb], defense: [lb1, lb2], playType: 'run' })

    for (let i = 0; i < 10; i++) runMovement(state, null, DT)   // within the ~1s hold

    // Both flow toward the play, but the front stays spread — they don't converge on the RB.
    expect(lb2.x - lb1.x).toBeGreaterThan(8)
    expect(lb1.x).toBeLessThan(rb.x)   // each keeps its gap rather than stacking on the ball
  })

  it('a run-blocked defender is driven off its spot — real displacement, not a stalemate ([P5]/[P9])', () => {
    // Full block-fight pipeline: OL between the RB and DL, driving on a run.
    const rb = { id: 'rb', label: 'RB', x: 26, y: 31, vx: 0, vy: 0 }
    const ol = { id: 'ol', label: 'OL', x: 24, y: 35, vx: 0, vy: 0 }
    const dl = { id: 'dl', label: 'DL', x: 24, y: 36, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rb, ol], defense: [dl], playType: 'run', yardLine: 25 })
    state.ballCarrierId = 'rb'

    const x0 = dl.x, y0 = dl.y
    for (let i = 0; i < 30; i++) {            // ~1.5s of the full pipeline
      runEngagement(state, null, DT)
      runMovement(state, null, DT)
      runPushForce(state, null, DT)
      runCollisionResponse(state, null, DT)
    }

    const disp = Math.hypot(dl.x - x0, dl.y - y0)
    expect(disp).toBeGreaterThan(1.5)   // the block physically moved the defender off its spot
  })

  it('keeps every player separated through the full run pipeline — no overlaps ([P10])', () => {
    const off = [
      { id: 'rb', label: 'RB', x: 26, y: 31, vx: 0, vy: 0 },
      { id: 'lg', label: 'G',  x: 24, y: 35, vx: 0, vy: 0 },
      { id: 'c',  label: 'C',  x: 26, y: 35, vx: 0, vy: 0 },
      { id: 'rg', label: 'G',  x: 28, y: 35, vx: 0, vy: 0 },
    ]
    const def = [
      { id: 'nt',  label: 'DL', x: 25, y: 36, vx: 0, vy: 0, isEngaged: false },
      { id: 'dt',  label: 'DL', x: 27, y: 36, vx: 0, vy: 0, isEngaged: false },
      { id: 'mlb', label: 'LB', x: 26, y: 40, vx: 0, vy: 0, isEngaged: false },
    ]
    const state = makeState({ offense: off, defense: def, playType: 'run', yardLine: 25 })
    state.ballCarrierId = 'rb'

    for (let i = 0; i < 30; i++) {
      runEngagement(state, null, DT)
      runMovement(state, null, DT)
      runPushForce(state, null, DT)
      runCollisionResponse(state, null, DT)
    }

    const all = [...off, ...def]
    for (let i = 0; i < all.length; i++) {
      for (let j = i + 1; j < all.length; j++) {
        const sep = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)
        expect(sep).toBeGreaterThanOrEqual(1.5 - 0.1)   // 2×PLAYER.RADIUS, minus solver tolerance
      }
    }
  })

  it('a deep safety holds the top until the RB reaches the 2nd level, then triggers downhill ([P8])', () => {
    // losY = 35. Deep safety at y=55 (20 yds off the ball). Carrier depth = (y - 35).
    function setup(carrierY) {
      const rb = { id: 'rb', label: 'RB', x: 30, y: carrierY, vx: 0, vy: 5 }
      const s  = { id: 's', label: 'S', x: 20, y: 55, vx: 0, vy: 0, isEngaged: false }
      const state = makeState({ offense: [rb], defense: [s], playType: 'run', yardLine: 25 })
      state.ballCarrierId = 'rb'
      runMovement(state, null, DT)
      return s
    }
    const shallow = setup(36)   // depth ~1 — still behind the linebackers
    const deep    = setup(42)   // depth ~7 — past the second level

    expect(Math.abs(shallow.vy)).toBeLessThan(0.7)   // holds the top, slides horizontally
    expect(deep.vy).toBeLessThan(-0.3)               // triggers downhill toward the ball
  })

  it('a man defender abandons coverage to pursue once the ball is loose', () => {
    // Same defender is in man coverage, but an explicit carrier (a different player)
    // is set — pursuit overrides the coverage assignment.
    const carrier = { id: 'rb', label: 'RB', x: 40, y: 36, vx: 6, vy: 2 }
    const wr      = { id: 'wr1', label: 'WR', x: 12, y: 50, vx: 0, vy: 0 }
    const def     = { id: 'cb1', label: 'CB', x: 20, y: 30, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [carrier, wr], defense: [def], playType: 'pass' })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })
    state.ballCarrierId = 'rb'   // ball is loose with the RB, not the covered WR

    runMovement(state, null, DT)

    // Heads toward the carrier (right), not toward its man (the WR is to the left).
    expect(def.vx).toBeGreaterThan(0)
  })

  it('a pursuing defender flows around a blocker in its path instead of into it ([priority 6])', () => {
    // Carrier straight ahead of the defender; a blocker sits directly in the lane between them.
    const carrier = { id: 'rb', label: 'RB', x: 26, y: 55, vx: 0, vy: 0 }
    const blocker = { id: 'ol', label: 'OL', x: 26, y: 48, vx: 0, vy: 0 }
    const def = { id: 'lb', label: 'LB', x: 26, y: 45, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [carrier, blocker], defense: [def], playType: 'pass' })
    state.ballCarrierId = 'rb'

    runMovement(state, null, DT)

    expect(Math.abs(def.vx)).toBeGreaterThan(0.1)   // veers laterally to get around the block
  })

  it('does not hijack coverage during pocket passing', () => {
    // No carrier on a pass play → man defender keeps covering its receiver.
    const rec = { id: 'wr1', label: 'WR', x: 30, y: 46, vx: 0, vy: 0 }
    const def = { id: 'cb1', label: 'CB', x: 30, y: 38, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rec], defense: [def], playType: 'pass' })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })

    runMovement(state, null, DT)

    expect(def.vy).toBeGreaterThan(0)   // still pursuing its man downfield
  })

  it('a heady defender commits to the intercept while a low-awareness one still hesitates ([160])', () => {
    // Carrier sprinting straight upfield; pursuer off to the side at the same depth. A
    // committed defender leads ahead into the carrier's path (large vy toward where it's
    // heading); one still inside its reaction beat just chases the current spot (small vy).
    function setup(awareness) {
      // A pass completed to a runner (carrier set) — the whole defense rallies immediately,
      // so this isolates the awareness-driven pursuit reaction from run-fit discipline.
      const carrier = { id: 'rb', label: 'RB', x: 30, y: 50, vx: 0, vy: 7 }
      const def = { id: 's', label: 'S', awareness, x: 10, y: 50, vx: 0, vy: 0, isEngaged: false }
      const state = makeState({ offense: [carrier], defense: [def], playType: 'pass' })
      state.ballCarrierId = 'rb'
      return { def, state }
    }
    const hi = setup(99)   // reads it in ~0.05s → committed on the first tick
    const lo = setup(10)   // reads it in ~0.45s → still flat-footed on the first tick

    runMovement(hi.state, null, DT)
    runMovement(lo.state, null, DT)

    expect(hi.def.vy).toBeGreaterThan(lo.def.vy)   // committed defender leads the carrier upfield
    expect(lo.def.vy).toBeLessThan(1)              // hesitating one just chases the current spot
  })
})

// ── [146]–[148] Zone coverage — findZoneThreat ────────────────────────────────

function makeOffense(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

describe('findZoneThreat', () => {
  const center = { x: 26, y: 50 }

  it('returns null when no receivers are near the zone', () => {
    const off = makeOffense([{ id: 'qb', label: 'QB', x: 26, y: 50 }])  // QB is not a receiver
    expect(findZoneThreat(center, off, 55)).toBeNull()
  })

  it('ignores non-receivers (QB, linemen) inside the zone', () => {
    const off = makeOffense([
      { id: 'qb', label: 'QB', x: 26, y: 51 },
      { id: 'ol', label: 'OL', x: 27, y: 50 },
    ])
    expect(findZoneThreat(center, off, 55)).toBeNull()
  })

  it('detects a receiver inside the zone radius', () => {
    const wr = { id: 'wr', label: 'WR', x: 26, y: 55 }   // 5 yards from center (< 7)
    expect(findZoneThreat(center, makeOffense([wr]), 55)).toBe(wr)
  })

  it('ignores a receiver well beyond any detection range', () => {
    const wr = { id: 'wr', label: 'WR', x: 26, y: 64 }   // 14 yards out (> 11 max)
    expect(findZoneThreat(center, makeOffense([wr]), 99)).toBeNull()
  })

  it('prioritizes the receiver closest to the landmark', () => {
    const near = { id: 'near', label: 'WR', x: 26, y: 53 }   // 3 yards
    const far  = { id: 'far',  label: 'TE', x: 26, y: 56 }   // 6 yards
    expect(findZoneThreat(center, makeOffense([far, near]), 55)).toBe(near)
  })

  it('elite awareness reads a threat that low awareness misses (extended range)', () => {
    const wr = { id: 'wr', label: 'WR', x: 26, y: 59 }   // 9 yards out
    // low: detect = 7 + (40/99)*4 ≈ 8.6  → miss;  elite: 7 + 4 = 11 → read
    expect(findZoneThreat(center, makeOffense([wr]), 40)).toBeNull()
    expect(findZoneThreat(center, makeOffense([wr]), 99)).toBe(wr)
  })
})

describe('getZoneTarget', () => {
  const center = { x: 26, y: 50 }

  it('patrols the landmark when there is no threat', () => {
    const t = getZoneTarget(center, null, 55)
    expect(t.x).toBeCloseTo(26)
    expect(t.y).toBeCloseTo(50)
    expect(t.reacting).toBe(false)
  })

  it('breaks on a threat inside the zone and flags reacting', () => {
    const threat = { x: 30, y: 52, vx: 0, vy: 0 }
    const t = getZoneTarget(center, threat, 55)
    expect(t.reacting).toBe(true)
    expect(t.x).toBeCloseTo(30)
    expect(t.y).toBeCloseTo(52)
  })

  it('leads a moving threat by its velocity', () => {
    const threat = { x: 26, y: 52, vx: 0, vy: 5 }   // driving deeper
    const t = getZoneTarget(center, threat, 55)
    expect(t.y).toBeGreaterThan(52)                 // target leads ahead of the threat
  })

  it('better coverage skill leads further ahead', () => {
    const threat = () => ({ x: 26, y: 52, vx: 0, vy: 5 })
    const low  = getZoneTarget(center, threat(), 0)
    const high = getZoneTarget(center, threat(), 99)
    expect(high.y).toBeGreaterThan(low.y)
  })

  it('clamps the target to the zone radius — never vacates the area (integrity)', () => {
    const threat = { x: 26, y: 64, vx: 0, vy: 0 }   // 14 yards from center, well outside
    const t = getZoneTarget(center, threat, 55)
    const distFromCenter = Math.hypot(t.x - center.x, t.y - center.y)
    expect(distFromCenter).toBeCloseTo(7)           // pinned to the zone boundary toward the threat
    expect(t.y).toBeCloseTo(57)                      // 50 + 7, edge nearest the threat
  })
})

describe('zone coverage movement (integration)', () => {
  // makeState: dir=1, yardLine=25 → losY=35, toAbsY(rel) = rel + 10.
  // zoneCenterY=40 (relative) → absolute y=50.
  function zoneState({ offense, defender }) {
    const s = makeState({ offense, defense: [defender] })
    s.defenseCoverage.set(defender.id, { type: 'zone', zoneCenterX: 26, zoneCenterY: 40 })
    return s
  }

  it('a zone defender sinks toward its landmark when the area is clear', () => {
    const qb  = { id: 'qb', label: 'QB', x: 26, y: 27, vx: 0, vy: 0 }   // not a receiver
    const def = { id: 's1', label: 'S', x: 26, y: 57, vx: 0, vy: 0, isEngaged: false }
    const state = zoneState({ offense: [qb], defender: def })

    runMovement(state, null, DT)

    expect(def.vy).toBeLessThan(0)            // moving south toward the landmark at y=50
    expect(Math.abs(def.vx)).toBeLessThan(0.1)
  })

  it('a zone defender breaks toward a receiver that has cut into its area', () => {
    // routePhase 'settled' marks a route that has declared its cut — the zone defender breaks on it.
    const wr  = { id: 'wr1', label: 'WR', x: 32, y: 50, vx: 0, vy: 0, routePhase: 'settled' }
    const def = { id: 's1',  label: 'S',  x: 26, y: 50, vx: 0, vy: 0, isEngaged: false }
    const state = zoneState({ offense: [wr], defender: def })

    runMovement(state, null, DT)

    expect(def.vx).toBeGreaterThan(0)         // reacting toward the threat on the right
  })

  it('a zone defender HOLDS its landmark on a receiver still running its stem (no cut yet)', () => {
    // Same receiver in the area but mid-stem (no waypoint cleared, not settled): the defender stays
    // home until the route declares ([zone feedback]).
    const wr  = { id: 'wr1', label: 'WR', x: 32, y: 50, vx: 0, vy: 6 }   // running through, uncut
    const def = { id: 's1',  label: 'S',  x: 26, y: 50, vx: 0, vy: 0, isEngaged: false }
    const state = zoneState({ offense: [wr], defender: def })

    runMovement(state, null, DT)

    expect(Math.abs(def.vx)).toBeLessThan(0.1)   // does not break toward the uncut receiver
  })

  it('an underneath zone defender works AROUND a player blocking its path back to its zone', () => {
    // CB returning to its flat landmark with an offensive player directly in the path — it
    // should side-step around rather than bulldoze straight into it.
    function setup(withObstacle) {
      const cb = { id: 'cb', label: 'CB', x: 20, y: 53, vx: 0, vy: 0, isEngaged: false }
      const offense = withObstacle ? [{ id: 'ol', label: 'OL', x: 20, y: 50, vx: 0, vy: 0 }] : []
      const state = makeState({ offense, defense: [cb], playType: 'pass', yardLine: 25 })
      state.defenseCoverage.set('cb', { type: 'zone', zoneType: 'flat', zoneCenterX: 20, zoneCenterY: 34 })  // abs y=44
      for (let i = 0; i < 5; i++) runMovement(state, null, DT)
      return cb
    }
    const around = setup(true)
    const clear  = setup(false)
    expect(Math.abs(around.vx)).toBeGreaterThan(Math.abs(clear.vx) + 0.1)   // routed around the obstacle
  })
})

describe('deep-zone vertical carry (integration)', () => {
  // dir=1, yardLine=25 → losY=35. A deep safety zone at relative y=40 → absolute 50
  // (15 yards past the LOS, deep enough to give over-the-top help).
  function deepSafetyState({ extraOffense = [], cb, wr, safety }) {
    const offense = [wr, ...extraOffense]
    const s = makeState({ offense, defense: [safety, cb] })
    s.defenseCoverage.set(safety.id, { type: 'zone', zoneCenterX: 40, zoneCenterY: 40 })
    s.defenseCoverage.set(cb.id, { type: 'man', targetId: wr.id })
    return s
  }

  it('a deep safety carries a vertical route over the top', () => {
    // WR running a go on the left; a deep safety to the right rotates over to cap it.
    const cb     = { id: 'cb', label: 'CB', x: 20, y: 48, vx: 0, vy: 0, isEngaged: false }
    const wr     = { id: 'wr', label: 'WR', route: 'go', x: 20, y: 52, vx: 0, vy: 0 }
    const safety = { id: 'fs', label: 'S',  x: 40, y: 50, vx: 0, vy: 0, isEngaged: false }
    const state  = deepSafetyState({ cb, wr, safety })

    runMovement(state, null, DT)

    expect(safety.vx).toBeLessThan(0)   // breaks left to stay over the top of the vertical
  })

  it('a deep safety holds its zone when no vertical threatens', () => {
    // The receiver is settled underneath (not pressing deep) — nothing to carry.
    const cb     = { id: 'cb', label: 'CB', x: 20, y: 51, vx: 0, vy: 0, isEngaged: false }
    const wr     = { id: 'wr', label: 'WR', x: 20, y: 52, vx: 0, vy: 0 }   // no route, no downfield push
    const safety = { id: 'fs', label: 'S',  x: 40, y: 50, vx: 0, vy: 0, isEngaged: false }
    const state  = deepSafetyState({ cb, wr, safety })

    runMovement(state, null, DT)

    expect(Math.abs(safety.vx)).toBeLessThan(0.1)   // stays home on its landmark
  })
})

// ── [150] Safety rotation — computeSafetyRotation ─────────────────────────────

describe('computeSafetyRotation', () => {
  const LOS = 35   // dir=1, yardLine=25 → losY=35
  const dir = 1

  // Deep zone defenders sit on deep landmarks (zoneCenterY=40 → absolute 50, 15 yds deep).
  function rotationState({ safeties, verticals = [] }) {
    const state = makeState({ offense: verticals, defense: safeties })
    for (const s of safeties) {
      state.defenseCoverage.set(s.id, { type: 'zone', zoneCenterX: s.x, zoneCenterY: 40 })
    }
    return state
  }

  it('returns an empty map when there are no deep defenders', () => {
    const rec = { id: 'wr', label: 'WR', x: 20, y: 52, vx: 0, vy: 6 }
    const state = rotationState({ safeties: [], verticals: [rec] })
    expect(computeSafetyRotation(state, LOS, dir).size).toBe(0)
  })

  it('assigns a deep defender to carry a vertical route', () => {
    const safety = { id: 'fs', label: 'S',  x: 40, y: 50 }
    const rec    = { id: 'wr', label: 'WR', x: 20, y: 52, vx: 0, vy: 6 }   // pressing deep
    const state  = rotationState({ safeties: [safety], verticals: [rec] })

    const rot = computeSafetyRotation(state, LOS, dir)
    expect(rot.get('fs')).toBe(rec)
  })

  it('two deep defenders divide two verticals — each takes the nearer one', () => {
    const s1  = { id: 's1', label: 'S', x: 15, y: 50 }
    const s2  = { id: 's2', label: 'S', x: 40, y: 50 }
    const wr1 = { id: 'wr1', label: 'WR', x: 12, y: 62, vx: 0, vy: 6 }   // left, near s1
    const wr2 = { id: 'wr2', label: 'WR', x: 43, y: 62, vx: 0, vy: 6 }   // right, near s2
    const state = rotationState({ safeties: [s1, s2], verticals: [wr1, wr2] })

    const rot = computeSafetyRotation(state, LOS, dir)
    expect(rot.get('s1')).toBe(wr1)
    expect(rot.get('s2')).toBe(wr2)
  })

  it('two deep defenders never both carry the same vertical — only the nearer is assigned', () => {
    const s1 = { id: 's1', label: 'S', x: 24, y: 50 }   // closer to the route
    const s2 = { id: 's2', label: 'S', x: 32, y: 50 }
    const wr = { id: 'wr', label: 'WR', x: 26, y: 64, vx: 0, vy: 6 }   // single vertical between them
    const state = rotationState({ safeties: [s1, s2], verticals: [wr] })

    const rot = computeSafetyRotation(state, LOS, dir)
    expect(rot.size).toBe(1)               // not doubled
    expect(rot.get('s1')).toBe(wr)         // the nearer defender carries it
    expect(rot.get('s2')).toBeUndefined()  // the other is free to hold its area
  })

  it('leaves a settled underneath route to carry a vertical (prioritizes the deep threat)', () => {
    const safety  = { id: 'fs', label: 'S',  x: 26, y: 50 }
    const settled = { id: 'wz', label: 'WR', x: 28, y: 50, vx: 0, vy: 0 }   // sitting underneath, not vertical
    const vert    = { id: 'wv', label: 'WR', x: 20, y: 60, vx: 0, vy: 6 }   // pressing deep
    const state   = rotationState({ safeties: [safety], verticals: [settled, vert] })

    const rot = computeSafetyRotation(state, LOS, dir)
    expect(rot.get('fs')).toBe(vert)   // carries the vertical, not the settled route
  })

  it('does not carry a route that has not gotten deep yet (still developing)', () => {
    const safety = { id: 'fs', label: 'S',  x: 40, y: 50 }
    const rec    = { id: 'wr', label: 'WR', x: 20, y: 42, vx: 0, vy: 6 }   // vertical but only 7 yds deep
    const state  = rotationState({ safeties: [safety], verticals: [rec] })

    expect(computeSafetyRotation(state, LOS, dir).size).toBe(0)
  })

  it('does not carry a settled route at depth (no downfield speed)', () => {
    const safety = { id: 'fs', label: 'S',  x: 40, y: 50 }
    const rec    = { id: 'wr', label: 'WR', x: 20, y: 55, vx: 0, vy: 0 }   // deep but stopped (curl/comeback)
    const state  = rotationState({ safeties: [safety], verticals: [rec] })

    expect(computeSafetyRotation(state, LOS, dir).size).toBe(0)
  })

  it('a single-high safety cheats over to a wide deep route outside its zone ([deep-zone feedback])', () => {
    // Lone safety in the middle of the field; a deep vertical breaks WIDE outside, far beyond the
    // old ~18-yard reach cap. The deep shell's job is that nobody gets behind it, so the safety is
    // still assigned the route and works over the top of it.
    const safety = { id: 'fs', label: 'S',  x: 26, y: 50 }                  // middle of the field
    const wide   = { id: 'wr', label: 'WR', x: 50, y: 55, vx: 0, vy: 6 }    // ~24 yds away, pressing deep
    const state  = rotationState({ safeties: [safety], verticals: [wide] })

    expect(computeSafetyRotation(state, LOS, dir).get('fs')).toBe(wide)
  })

  it('reads a known vertical (go) early — before it reaches the deep-threat depth', () => {
    // A tagged go route only 7 yds deep and still climbing: recognized as a vertical immediately so
    // the deep defender starts working over the top in time, rather than waiting until 12 yds.
    const safety = { id: 'fs', label: 'S',  x: 26, y: 50 }
    const go     = { id: 'wr', label: 'WR', x: 22, y: 42, vx: 0, vy: 6, route: 'go' }   // 7 yds deep
    const state  = rotationState({ safeties: [safety], verticals: [go] })

    expect(computeSafetyRotation(state, LOS, dir).get('fs')).toBe(go)
  })

  it('stays home on a vertical the corner already has on top ([zone feedback])', () => {
    // Wide vertical pressing deep, but a man corner is on top of it (covering). The deep safety
    // must NOT abandon its zone — it holds for the other deep routes.
    const safety = { id: 'fs', label: 'S',  x: 26, y: 50 }
    const wr     = { id: 'wr', label: 'WR', x: 40, y: 55, vx: 0, vy: 6 }
    const cb     = { id: 'cb', label: 'CB', x: 40, y: 56, vx: 0, vy: 6 }   // on top of the WR
    const state  = makeState({ offense: [wr], defense: [safety, cb], playType: 'pass', yardLine: 25 })
    state.defenseCoverage.set('fs', { type: 'zone', zoneCenterX: 26, zoneCenterY: 40 })
    state.defenseCoverage.set('cb', { type: 'man', targetId: 'wr' })

    expect(computeSafetyRotation(state, LOS, dir).has('fs')).toBe(false)
  })

  it('rotates over once the receiver has beaten the corner over the top ([zone feedback])', () => {
    const safety = { id: 'fs', label: 'S',  x: 26, y: 50 }
    const wr     = { id: 'wr', label: 'WR', x: 40, y: 58, vx: 0, vy: 6 }   // run past the corner
    const cb     = { id: 'cb', label: 'CB', x: 40, y: 55, vx: 0, vy: 6 }   // trailing (beaten)
    const state  = makeState({ offense: [wr], defense: [safety, cb], playType: 'pass', yardLine: 25 })
    state.defenseCoverage.set('fs', { type: 'zone', zoneCenterX: 26, zoneCenterY: 40 })
    state.defenseCoverage.set('cb', { type: 'man', targetId: 'wr' })

    expect(computeSafetyRotation(state, LOS, dir).get('fs')).toBe(wr)
  })
})

describe('deep-zone carry stays over the top (integration)', () => {
  it('shifts horizontally to cap a vertical but holds its depth (no driving down)', () => {
    // Deep vertical on the left; a deep safety to the right caps it over the top.
    const wr     = { id: 'wr', label: 'WR', route: 'go', x: 20, y: 54, vx: 0, vy: 0 }   // depth 19, running deep
    const safety = { id: 'fs', label: 'S',  x: 40, y: 56, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [wr], defense: [safety] })
    state.defenseCoverage.set('fs', { type: 'zone', zoneCenterX: 40, zoneCenterY: 46 })  // deep landmark (abs 56)

    runMovement(state, null, DT)

    expect(safety.vx).toBeLessThan(0)            // slides over toward the route
    expect(safety.vy).toBeGreaterThan(-0.5)      // but does NOT drive down to the catch point
  })
})

describe('deep-zone carry — division (integration)', () => {
  it('only the nearer of two deep safeties carries a single vertical', () => {
    // Two deep-zone safeties; one vertical route between them.
    const s1 = { id: 's1', label: 'S', x: 24, y: 50, vx: 0, vy: 0, isEngaged: false }
    const s2 = { id: 's2', label: 'S', x: 32, y: 50, vx: 0, vy: 0, isEngaged: false }
    const wr = { id: 'wr', label: 'WR', route: 'go', x: 26, y: 64, vx: 0, vy: 0 }
    const state = makeState({ offense: [wr], defense: [s1, s2] })
    state.defenseCoverage.set('s1', { type: 'zone', zoneCenterX: 24, zoneCenterY: 40 })
    state.defenseCoverage.set('s2', { type: 'zone', zoneCenterX: 32, zoneCenterY: 40 })

    runMovement(state, null, DT)

    expect(s1.vx).toBeGreaterThan(0)             // nearer safety carries it
    expect(Math.abs(s2.vx)).toBeLessThan(0.1)    // the other holds its zone (no double-cover)
  })
})

// ── [151] QB spy ─────────────────────────────────────────────────────────────

describe('isQbScrambling', () => {
  const CENTER = 26.665
  const LOS = 35
  const dir = 1

  it('is false while the QB sits in the pocket', () => {
    expect(isQbScrambling({ x: CENTER, y: 27 }, CENTER, LOS, dir)).toBe(false)  // centered, 8 yds deep
  })

  it('is true when the QB breaks contain wide of the tackles', () => {
    expect(isQbScrambling({ x: 40, y: 27 }, CENTER, LOS, dir)).toBe(true)        // ~13 yds off center
  })

  it('is true when the QB steps up toward the line of scrimmage', () => {
    expect(isQbScrambling({ x: CENTER, y: 33 }, CENTER, LOS, dir)).toBe(true)    // only 2 yds behind the LOS
  })

  it('is false when there is no QB', () => {
    expect(isQbScrambling(null, CENTER, LOS, dir)).toBe(false)
  })
})

describe('QB spy movement (integration)', () => {
  it('shadows the QB in the pocket without committing', () => {
    const qb  = { id: 'qb', label: 'QB', x: 26.665, y: 29, vx: 0, vy: 0 }
    const spy = { id: 'lb', label: 'LB', x: 20, y: 32.5, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [qb], defense: [spy] })
    state.defenseCoverage.set('lb', { type: 'spy' })

    runMovement(state, null, DT)

    expect(spy.spyCommitted).toBeFalsy()       // still just shadowing
    expect(spy.vx).toBeGreaterThan(0)          // mirroring toward the QB's x (center)
  })

  it('commits and attacks once the QB breaks the pocket', () => {
    const qb  = { id: 'qb', label: 'QB', x: 45, y: 27, vx: 0, vy: 0 }   // scrambled wide
    const spy = { id: 'lb', label: 'LB', x: 26.665, y: 32.5, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [qb], defense: [spy] })
    state.defenseCoverage.set('lb', { type: 'spy' })

    runMovement(state, null, DT)

    expect(spy.spyCommitted).toBe(true)        // committed to the attack
    expect(spy.vx).toBeGreaterThan(0)          // pursuing the QB toward the sideline
  })

  it('stays committed even if the QB ducks back into the pocket', () => {
    const qb  = { id: 'qb', label: 'QB', x: 45, y: 27, vx: 0, vy: 0 }
    const spy = { id: 'lb', label: 'LB', x: 26.665, y: 32.5, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [qb], defense: [spy] })
    state.defenseCoverage.set('lb', { type: 'spy' })

    runMovement(state, null, DT)            // QB wide → spy commits
    qb.x = 26.665                           // QB retreats back to center
    runMovement(state, null, DT)

    expect(spy.spyCommitted).toBe(true)        // does not relax — keeps attacking
  })
})

// ── [153] Coverage — route combinations ──────────────────────────────────────

describe('coverage reacts consistently across route combinations', () => {
  it('two man defenders each track their own receiver, not the same one', () => {
    const wr1 = { id: 'wr1', label: 'WR', x: 12, y: 48, vx: 0, vy: 0 }   // left
    const wr2 = { id: 'wr2', label: 'WR', x: 41, y: 48, vx: 0, vy: 0 }   // right
    const cb1 = { id: 'cb1', label: 'CB', x: 14, y: 44, vx: 0, vy: 0, isEngaged: false }
    const cb2 = { id: 'cb2', label: 'CB', x: 39, y: 44, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [wr1, wr2], defense: [cb1, cb2] })
    state.defenseCoverage.set('cb1', { type: 'man', targetId: 'wr1' })
    state.defenseCoverage.set('cb2', { type: 'man', targetId: 'wr2' })

    runMovement(state, null, DT)

    expect(cb1.vx).toBeLessThan(0)      // cb1 works toward the left receiver
    expect(cb2.vx).toBeGreaterThan(0)   // cb2 works toward the right receiver — no convergence
  })

  it('a deep zone safety carries the vertical while man coverage holds underneath', () => {
    const vert  = { id: 'wv', label: 'WR', route: 'go', x: 30, y: 50, vx: 0, vy: 0 }   // vertical
    const under = { id: 'wu', label: 'WR', x: 16, y: 40, vx: 0, vy: 0 }                // underneath
    const safety = { id: 'fs', label: 'S',  x: 40, y: 55, vx: 0, vy: 0, isEngaged: false }
    const cb     = { id: 'cb', label: 'CB', x: 18, y: 38, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [vert, under], defense: [safety, cb] })
    state.defenseCoverage.set('fs', { type: 'zone', zoneCenterX: 40, zoneCenterY: 45 })  // deep (abs 55)
    state.defenseCoverage.set('cb', { type: 'man', targetId: 'wu' })

    runMovement(state, null, DT)

    expect(safety.vx).toBeLessThan(0)      // safety rotates over to carry the vertical (to its left)
    expect(cb.vy).toBeGreaterThan(0)       // corner stays on its underneath man, doesn't bail deep
  })

  it('two verticals into a two-deep shell are split, one safety each', () => {
    const v1 = { id: 'v1', label: 'WR', route: 'go', x: 14, y: 50, vx: 0, vy: 0 }
    const v2 = { id: 'v2', label: 'WR', route: 'go', x: 40, y: 50, vx: 0, vy: 0 }
    const s1 = { id: 's1', label: 'S', x: 16, y: 55, vx: 0, vy: 0, isEngaged: false }
    const s2 = { id: 's2', label: 'S', x: 38, y: 55, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [v1, v2], defense: [s1, s2] })
    state.defenseCoverage.set('s1', { type: 'zone', zoneCenterX: 16, zoneCenterY: 45 })
    state.defenseCoverage.set('s2', { type: 'zone', zoneCenterX: 38, zoneCenterY: 45 })

    runMovement(state, null, DT)

    // Each safety works toward the vertical on its own side — neither bails to the other.
    expect(s1.vx).toBeLessThan(0)       // s1 caps the left vertical (to its left)
    expect(s2.vx).toBeGreaterThan(0)    // s2 caps the right vertical (to its right)
  })
})

// ── [154] RB vision (integration) ────────────────────────────────────────────

describe('RB vision movement (integration)', () => {
  it('the ball carrier cuts away from a defender clogging its path (after the hit-the-hole burst)', () => {
    const rb = { id: 'rb', label: 'RB', x: 26, y: 30, vx: 0, vy: 0, isEngaged: false }
    const dl = { id: 'dl', label: 'DL', x: 26, y: 40, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rb], defense: [dl], playType: 'run' })

    // Past the 0.35s forced commit, the back reads its vision and bounces off the clogged lane.
    for (let i = 0; i < 12; i++) runMovement(state, null, DT)

    expect(rb.vy).toBeGreaterThan(0)               // still pressing forward
    expect(Math.abs(rb.vx)).toBeGreaterThan(0.1)   // cutting around the defender in its lane
  })

  it('the ball carrier runs straight through a clear hole', () => {
    const rb = { id: 'rb', label: 'RB', x: 26, y: 30, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [rb], defense: [], playType: 'run' })

    runMovement(state, null, DT)

    expect(rb.vy).toBeGreaterThan(0)
    expect(Math.abs(rb.vx)).toBeLessThan(0.2)      // no reason to bounce — hits it downhill
  })

  it('a high-vision back re-reads the field sooner than a low-vision back ([155])', () => {
    function setup(vision) {
      const rb = { id: 'rb', label: 'RB', vision, x: 26, y: 30, vx: 0, vy: 0, isEngaged: false }
      const state = makeState({ offense: [rb], defense: [], playType: 'run' })
      return { rb, state }
    }
    const hi = setup(99)   // re-reads every 0.2s
    const lo = setup(0)    // re-reads every 3s

    // Run past the 0.35s hit-the-hole burst on a clear field: both do their first vision
    // read and stay straight.
    for (let i = 0; i < 10; i++) {
      runMovement(hi.state, null, DT)
      runMovement(lo.state, null, DT)
    }

    // Now drop a defender into the straight path of each.
    for (const s of [hi.state, lo.state]) {
      s.defensePlayers.set('dl', { id: 'dl', label: 'DL', x: 26, y: 44, vx: 0, vy: 0, isEngaged: false })
    }

    // Step ~0.5s — the elite back re-reads and cuts; the poor back is still committed to its
    // stale (now clogged) straight lane.
    for (let i = 0; i < 10; i++) {
      runMovement(hi.state, null, DT)
      runMovement(lo.state, null, DT)
    }

    expect(Math.abs(hi.rb.vx)).toBeGreaterThan(Math.abs(lo.rb.vx))
  })
})

// ── [157] Shared ball-carrier movement ─────────────────────────────────────────

describe('ball-carrier movement system ([157])', () => {
  it('a receiver after the catch uses the same vision pathfinding as a runner', () => {
    // WR holding the ball (post-catch) with a defender clogging the straight path —
    // it should read the field and cut around exactly like a designed runner does.
    const wr = { id: 'wr', label: 'WR', x: 26, y: 40, vx: 0, vy: 0, isEngaged: false }
    const def = { id: 'cb', label: 'CB', x: 26, y: 46, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [wr], defense: [def], playType: 'pass' })
    state.ballCarrierId = 'wr'   // the catch just happened

    runMovement(state, null, DT)

    expect(wr.vy).toBeGreaterThan(0)               // pressing upfield
    expect(Math.abs(wr.vx)).toBeGreaterThan(0.1)   // cutting around the defender, via the raycast
  })

  it('a receiver who catches at full speed keeps its momentum (no acceleration reset)', () => {
    // WR sprinting straight upfield at top speed as the ball arrives. Becoming the carrier
    // must not zero or shrink its velocity — it stays at top speed, continuing its stride.
    const wr = { id: 'wr', label: 'WR', x: 26, y: 50, vx: 0, vy: 9.0, isEngaged: false }
    const state = makeState({ offense: [wr], defense: [], playType: 'pass' })
    state.ballCarrierId = 'wr'

    const speedBefore = Math.hypot(wr.vx, wr.vy)
    runMovement(state, null, DT)
    const speedAfter = Math.hypot(wr.vx, wr.vy)

    expect(speedAfter).toBeGreaterThanOrEqual(speedBefore)   // momentum carried, not reset
    expect(wr.vy).toBeGreaterThan(0)                          // still driving forward
  })

  it('a scrambling QB carrying the ball runs through the shared carrier model', () => {
    // QB designated as the ball carrier (a scramble) reads the field and runs to open
    // space rather than dropping back to the pocket.
    const qb = { id: 'qb', label: 'QB', x: 26, y: 36, vx: 0, vy: 0, isEngaged: false }
    const state = makeState({ offense: [qb], defense: [], playType: 'pass', yardLine: 25 })
    state.ballCarrierId = 'qb'   // QB broke the pocket and took off

    runMovement(state, null, DT)

    expect(qb.vy).toBeGreaterThan(0)   // advancing upfield, not retreating to drop depth
  })

  it('a hard cut bleeds speed, and a faster accelerator keeps more of it ([159])', () => {
    // Both carriers sprint laterally (left) while the only open lane is straight upfield —
    // a ~90° cut. Acceleration governs how much speed survives the plant: identical setup
    // apart from the acceleration rating, so the burstier back ends the cut faster.
    // A back carrying after the catch (no hit-the-hole burst), so the cut logic runs at once.
    function setup(acceleration) {
      const rb = { id: 'rb', label: 'RB', acceleration, x: 26, y: 50, vx: -8, vy: 0, isEngaged: false }
      const state = makeState({ offense: [rb], defense: [], playType: 'pass' })
      state.ballCarrierId = 'rb'
      return { rb, state }
    }
    const hi = setup(99)
    const lo = setup(20)

    runMovement(hi.state, null, DT)
    runMovement(lo.state, null, DT)

    const hiSpd = Math.hypot(hi.rb.vx, hi.rb.vy)
    const loSpd = Math.hypot(lo.rb.vx, lo.rb.vy)
    expect(hiSpd).toBeGreaterThan(loSpd)        // burstier back loses less momentum cutting
    expect(loSpd).toBeLessThan(8)               // the cut genuinely cost the slow back speed
  })

  it('does not bleed speed when the carrier keeps running roughly straight ([159])', () => {
    // Moving forward into an open field — the chosen lane matches the heading, so no cut
    // penalty: the carrier accelerates rather than slowing.
    const rb = { id: 'rb', label: 'RB', x: 26, y: 50, vx: 0, vy: 7, isEngaged: false }
    const state = makeState({ offense: [rb], defense: [], playType: 'run' })

    const before = Math.hypot(rb.vx, rb.vy)
    runMovement(state, null, DT)
    const after = Math.hypot(rb.vx, rb.vy)

    expect(after).toBeGreaterThanOrEqual(before)   // built speed, never bled it
  })
})
