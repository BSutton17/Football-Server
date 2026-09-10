import { describe, it, expect } from '@jest/globals'
import { runPancake, pancakeMatchupScore, resetPancakes, isPancaked } from '../game/systems/pancake.js'
import { runTackleDetection } from '../game/systems/tackleDetection.js'
import { runCollisionResponse } from '../game/systems/collisionResponse.js'
import { interiorLinemanIds } from '../game/utils/playerQuery.js'
import { findRunningLane } from '../game/utils/rbVision.js'
import { PANCAKE, FIELD, SIM } from '../constants.js'

// ── [pancake] Dominant blocks put a defender on the ground ───────────────────
//
// Three rules define the feature and each is pinned here:
//   • only a blocker who genuinely outclasses his man can do it,
//   • a flattened defender is out of the play entirely — no movement, no tackle, no body,
//   • on a PASS the blocker goes down too, so a pancake can never free him up to help elsewhere.

const DT = SIM.TICK_MS / 1000
const LOS = 25, MID = FIELD.WIDTH / 2, EZ = FIELD.END_ZONE_DEPTH, LOSY = LOS + EZ

const always = () => 0      // every roll succeeds
const never  = () => 1      // no roll ever succeeds

function state({ playType = 'run', olStrength = 95, dlStrength = 60 } = {}) {
  const off = new Map(), def = new Map()
  off.set('ol1', {
    id: 'ol1', label: 'OL', x: MID, y: LOSY - 0.4, vx: 0, vy: 0, blockAnchorX: MID,
    ratings: { strength: olStrength, runBlock: olStrength, passBlock: olStrength },
  })
  // Square, body-to-body contact with the blocker between him and the ball.
  def.set('dl1', {
    id: 'dl1', label: 'DL', x: MID, y: LOSY + 0.4, vx: 0, vy: 0, isEngaged: false,
    ratings: { strength: dlStrength, passRush: dlStrength },
  })
  off.set('qb', { id: 'qb', label: 'QB', x: MID, y: LOSY - 5, vx: 0, vy: 0 })
  return {
    roomId: 'pancake-test', direction: 1, yardLine: LOS, ballX: MID,
    offensePlayers: off, defensePlayers: def, defenseCoverage: new Map(),
    playerFatigue: new Map(), playDesign: { playType }, ballCarrierId: null, tick: 0,
  }
}

describe('who can pancake', () => {
  it('a much stronger blocker beats a weak defender', () => {
    expect(pancakeMatchupScore(
      { ratings: { strength: 95, runBlock: 95 } },
      { ratings: { strength: 60 } }, true)).toBeGreaterThan(0)
  })

  it('two evenly matched linemen never pancake each other', () => {
    expect(pancakeMatchupScore(
      { ratings: { strength: 85, runBlock: 85 } },
      { ratings: { strength: 85 } }, true)).toBe(0)
  })

  it('a WEAKER blocker never pancakes anybody, however the dice fall', () => {
    const s = state({ olStrength: 70, dlStrength: 90 })
    for (let i = 0; i < 40; i++) runPancake(s, null, DT, always)
    expect(isPancaked(s.defensePlayers.get('dl1'))).toBe(false)
  })

  it('the score rises the bigger the mismatch', () => {
    const mild = pancakeMatchupScore({ ratings: { strength: 88, runBlock: 88 } }, { ratings: { strength: 78 } }, true)
    const huge = pancakeMatchupScore({ ratings: { strength: 99, runBlock: 99 } }, { ratings: { strength: 40 } }, true)
    expect(huge).toBeGreaterThan(mild)
  })
})

describe('a pancaked defender is out of the play', () => {
  it('is flattened for the full window and then gets up', () => {
    const s = state()
    runPancake(s, null, DT, always)
    const d = s.defensePlayers.get('dl1')
    expect(d.pancakedFor).toBeCloseTo(PANCAKE.DURATION_SECONDS, 5)

    // Tick it out — nobody rolls again while he is down.
    const ticks = Math.ceil(PANCAKE.DURATION_SECONDS / DT)
    for (let i = 0; i < ticks; i++) runPancake(s, null, DT, never)
    expect(d.pancakedFor).toBe(0)
  })

  it('cannot move', () => {
    const s = state()
    runPancake(s, null, DT, always)
    const d = s.defensePlayers.get('dl1')
    d.vx = 5; d.vy = 5
    runPancake(s, null, DT, never)
    expect(d.vx).toBe(0)
    expect(d.vy).toBe(0)
  })

  it('cannot tackle — the ball carrier runs straight through him', () => {
    const s = state()
    runPancake(s, null, DT, always)
    // Put the carrier right on top of him.
    const carrier = { id: 'rb1', label: 'RB', x: MID, y: LOSY + 0.4, vx: 0, vy: 6, ratings: { runPower: 0 } }
    s.offensePlayers.set('rb1', carrier)
    s.ballCarrierId = 'rb1'
    runTackleDetection(s, null, DT, never)
    expect(s.tackleEnqueued).toBeFalsy()
  })

  it('…and would have made that tackle if he were on his feet', () => {
    const s = state()
    const carrier = { id: 'rb1', label: 'RB', x: MID, y: LOSY + 0.4, vx: 0, vy: 6, ratings: { runPower: 0 } }
    s.offensePlayers.set('rb1', carrier)
    s.ballCarrierId = 'rb1'
    runTackleDetection(s, null, DT, never)     // no pancake this time
    expect(s.tackleEnqueued).toBe(true)
  })

  it('is not a body any more — he does not shove the carrier off his line', () => {
    const s = state()
    runPancake(s, null, DT, always)
    const carrier = { id: 'rb1', label: 'RB', x: MID, y: LOSY + 0.3, vx: 0, vy: 6 }
    s.offensePlayers.set('rb1', carrier)
    s.ballCarrierId = 'rb1'
    const before = { x: carrier.x, y: carrier.y, vy: carrier.vy }
    runCollisionResponse(s, null, DT)
    expect(carrier.x).toBeCloseTo(before.x, 6)
    expect(carrier.y).toBeCloseTo(before.y, 6)
    expect(carrier.vy).toBeCloseTo(before.vy, 6)   // no tackle drag either
  })

  it('walls no running lane — the back can see straight through him', () => {
    const downed  = { id: 'd1', label: 'DL', x: MID, y: LOSY + 4, isEngaged: false, pancakedFor: 3 }
    const upright = { ...downed, pancakedFor: 0 }
    const carrier = { id: 'rb', x: MID, y: LOSY - 2 }
    // Read the ray pointing STRAIGHT at him — the best lane would simply route around a lone body.
    const ahead = (d) => {
      const lane = findRunningLane(carrier, [d], [], 1, 0, null, null)
      return lane.rays.reduce((a, r) => Math.abs(r.angle) < Math.abs(a.angle) ? r : a).clear
    }
    expect(ahead(upright)).toBeLessThan(15)      // he blocks the lane…
    expect(ahead(downed)).toBeGreaterThan(ahead(upright))   // …and on the floor he does not
  })
})

describe('the two play types differ', () => {
  it('on a PASS the blocker is frozen too, so he cannot go help elsewhere', () => {
    const s = state({ playType: 'pass' })
    runPancake(s, null, DT, always)
    expect(s.offensePlayers.get('ol1').pancakeFrozenFor).toBeCloseTo(PANCAKE.DURATION_SECONDS, 5)
  })

  it('on a RUN the blocker keeps working upfield', () => {
    const s = state({ playType: 'run' })
    runPancake(s, null, DT, always)
    expect(s.offensePlayers.get('ol1').pancakeFrozenFor ?? 0).toBe(0)
  })
})

describe('between plays', () => {
  it('everybody gets back up', () => {
    const s = state({ playType: 'pass' })
    runPancake(s, null, DT, always)
    resetPancakes(s)
    expect(s.defensePlayers.get('dl1').pancakedFor).toBe(0)
    expect(s.offensePlayers.get('ol1').pancakeFrozenFor).toBe(0)
  })
})

// ── [interior seam] The back squeezes between his own center and guards ──────

describe('the interior seam', () => {
  const line = new Map()
  ;[['lt', -3.5], ['lg', -1.75], ['c', 0], ['rg', 1.75], ['rt', 3.5]].forEach(([id, dx]) =>
    line.set(id, { id, label: 'OL', x: MID + dx, y: LOSY, blockAnchorX: MID + dx }))

  it('is the center and both guards — not the tackles', () => {
    const ids = interiorLinemanIds(line, MID)
    expect([...ids].sort()).toEqual(['c', 'lg', 'rg'])
  })

  it('is decided by where they LINED UP, not where they have been driven', () => {
    const shoved = new Map(line)
    shoved.set('lt', { id: 'lt', label: 'OL', x: MID, y: LOSY, blockAnchorX: MID - 3.5 })   // washed inside
    const ids = interiorLinemanIds(shoved, MID)
    expect(ids.has('lt')).toBe(false)
    expect([...ids].sort()).toEqual(['c', 'lg', 'rg'])
  })

  it('follows the ball across the field', () => {
    const wide = new Map()
    ;[['a', 10], ['b', 11.75], ['c2', 13.5], ['d', 15.25], ['e', 17]].forEach(([id, x]) =>
      wide.set(id, { id, label: 'OL', x, y: LOSY, blockAnchorX: x }))
    expect([...interiorLinemanIds(wide, 13.5)].sort()).toEqual(['b', 'c2', 'd'])
  })

  const straightAhead = (carrier, blockers, squeeze) => {
    const lane = findRunningLane(carrier, [], blockers, 1, 0, null, squeeze)
    return lane.rays.reduce((a, r) => Math.abs(r.angle) < Math.abs(a.angle) ? r : a).clear
  }

  it('lets the back read a crease where an engaged guard stands', () => {
    const guard   = { id: 'lg', label: 'OL', x: MID, y: LOSY + 1, isEngaged: true }
    const carrier = { id: 'rb', x: MID, y: LOSY - 3 }
    const walled = straightAhead(carrier, [guard], null)
    const crease = straightAhead(carrier, [guard], new Set(['lg']))
    expect(walled).toBeLessThan(15)              // engaged, he used to wall the lane outright…
    expect(crease).toBeGreaterThan(walled)       // …now the back can fit through
  })

  it('but a tackle is still a wall', () => {
    const tackle  = { id: 'rt', label: 'OL', x: MID, y: LOSY + 1, isEngaged: true }
    const carrier = { id: 'rb', x: MID, y: LOSY - 3 }
    const a = straightAhead(carrier, [tackle], new Set(['lg']))   // rt is NOT in the squeeze set
    const b = straightAhead(carrier, [tackle], null)
    expect(a).toBeCloseTo(b, 6)
    expect(a).toBeLessThan(15)
  })
})
