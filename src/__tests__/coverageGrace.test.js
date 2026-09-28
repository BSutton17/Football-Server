import { describe, it, expect } from '@jest/globals'
import { opennessBreakdown, computeReceiverOpenness } from '../game/utils/openness.js'
import { DEEP_CATCH_YARDS, CATCH_SLOW_TIME, CATCH_SLOW_FACTOR, moveDefense } from '../game/systems/movement.js'

// Four reports about coverage reading as beaten when it was not.

const qb = { x: 26, y: 34, label: 'QB' }
const wr = (over = {}) => ({ x: 26, y: 50, vx: 0, vy: 8, label: 'WR', routeTraits: {}, ...over })
const at = (x, y, over = {}) => ({ x, y, vx: 0, vy: 0, label: 'CB', ratings: {}, ...over })

describe('⚠️ TRAILING IS NOT THE SAME AS BEATEN', () => {
  // "On any route if a defender is trailing a WR but they are still very close to that WR, it should
  // at the very least be contested." The beaten boost used to apply at full strength even when the
  // trail was step-for-step, which is the case it should apply least to.
  const r = wr()

  it('a defender on the receiver’s hip leaves the window contested', () => {
    const tight = computeReceiverOpenness(r, [at(26, 49)], qb)     // one yard behind
    expect(tight).toBeLessThan(0.5)
  })

  it('…and a defender genuinely run past is still beaten', () => {
    const clear = computeReceiverOpenness(r, [at(26, 44)], qb)     // six yards behind
    expect(clear).toBeGreaterThan(0.7)
  })

  it('the window opens monotonically as the trailer concedes ground', () => {
    const seen = [49, 48, 47, 46, 45].map(y => computeReceiverOpenness(r, [at(26, y)], qb))
    for (let i = 1; i < seen.length; i++) expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1])
  })
})

describe('⚠️ A SAFETY IS JUDGED ON WHERE HE WILL BE', () => {
  // "Even if a safety is not currently in front of the WR, if they WOULD be there by the time the
  // ball gets there it should still be heavily contested." There is no ball flight in this engine,
  // so every read was taken at the instant of release and a closing safety counted for nothing.
  const deep = wr({ y: 62, vy: 9 })          // 28 yards from the quarterback — a 1.6s flight
  const corner = at(26, 58)                   // trailing by four, so there is a window to shrink

  // Both safeties start in the SAME PLACE, twelve yards off. One is standing still; the other is
  // running with the route and will be on top of the catch point when the ball is.
  const STILL   = { label: 'S' }
  const CLOSING = { label: 'S', vx: -7, vy: 2 }

  it('a closing safety contests the deep ball even when he is still far away', () => {
    const openStill = computeReceiverOpenness(deep, [corner, at(36, 70, STILL)], qb)
    const openClosing = computeReceiverOpenness(deep, [corner, at(36, 70, CLOSING)], qb)
    expect(openClosing).toBeLessThan(openStill)
  })

  it('counts him as help, which is what makes two-high mean anything', () => {
    expect(opennessBreakdown(deep, [corner, at(36, 70, CLOSING)], qb).safeties).toBe(1)
    // …and the one who is not going anywhere is not help.
    expect(opennessBreakdown(deep, [corner, at(36, 70, STILL)], qb).safeties).toBe(0)
  })

  it('⚠️ SHORT THROWS ARE UNAFFECTED — there is no flight to close during', () => {
    // A five-yard hitch is caught before anybody runs anywhere, so projecting positions forward
    // would be inventing coverage that cannot arrive.
    const quick = wr({ y: 39, vy: 2 })                            // five yards from the passer
    const far = at(40, 60, { label: 'S', vx: -9, vy: -9 })
    expect(opennessBreakdown(quick, [at(26, 38), far], qb).safeties).toBe(0)
  })
})

describe('⚠️ TRACKING A DEEP BALL COSTS YOU YOUR STRIDE', () => {
  it('halves the receiver’s speed, briefly', () => {
    expect(CATCH_SLOW_FACTOR).toBeCloseTo(0.5)
    expect(CATCH_SLOW_TIME).toBeCloseTo(0.75)
  })

  it('⚠️ ONLY ON A BALL YOU ACTUALLY HAVE TO TRACK', () => {
    // At 18 air yards this fired on intermediate routes and took explosive plays from 1.9% of snaps
    // to 0.1% — not reduced, gone. Thirty air yards is about twenty-four past the line.
    expect(DEEP_CATCH_YARDS).toBeGreaterThanOrEqual(26)
  })
})

// ── A defender manned on a back ([rb man]) ────────────────────────────────
//
// ⚠️ "DEFENDERS MANNED ON RB ARE CRASHING TOO SOON ON PASS PLAYS. IF THE RB HAS A QUICK OUT, WHEEL
// OR A FLAT ROUTE, THE DEFENDER HAS CRASHED AND IS NOW TRAILING THE RB."
//
// Mirroring a back who is still standing in the backfield drags the defender down past the line
// with him. The moment the back releases, the defender is behind him and beaten to the flat.
describe('⚠️ YOU DO NOT CHASE A BACK INTO THE BACKFIELD', () => {
  const LOS = 50

  // Run one defender for a few ticks against a back and report where he ends up, in DEPTH off the
  // line (positive = on the defensive side, where he belongs).
  function coverBack(backY, ticks = 20) {
    const back = { id: 'rb', label: 'RB', x: 26, y: backY, vx: 0, vy: 0, ratings: {} }
    const def = { id: 'lb', label: 'LB', x: 26, y: LOS + 4, vx: 0, vy: 0, ratings: {} }
    const state = {
      direction: 1, yardLine: LOS, ballX: 26, phase: 'live',
      offensePlayers: new Map([['rb', back]]),
      defensePlayers: new Map([['lb', def]]),
      defenseCoverage: new Map([['lb', { type: 'man', targetId: 'rb' }]]),
      playDesign: { playType: 'pass' },
      playerFatigue: new Map(),
      engagements: new Map(),
      tick: 0,
    }
    for (let i = 0; i < ticks; i++) moveDefense(state, 0.05)
    return (def.y - LOS) * state.direction
  }

  it('holds his depth while the back is still behind the line', () => {
    // The back is six yards deep. Chasing him puts the defender behind the line of scrimmage.
    expect(coverBack(LOS - 6)).toBeGreaterThan(2)
  })

  it('…and picks him up normally once he releases', () => {
    // Out past the line, he is covered like anybody else — the hold is only for the backfield.
    const depth = coverBack(LOS + 4)
    expect(depth).toBeGreaterThan(2)
  })
})
