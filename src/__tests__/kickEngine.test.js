import { describe, it, expect } from '@jest/globals'
import {
  computeKick, calculateKickResult, isKickGood, UPRIGHT_HALF_WIDTH,
  computePuntReturn, computePuntBounce, resolvePuntBounce,
  PUNT_RETURN_MAX_YARDS, PUNT_BOUNCE_MIN_YARDS, PUNT_BOUNCE_MAX_YARDS, PUNT_BOUNCE_TOUCHBACK_LINE,
} from '../game/kickEngine.js'

// [Special Teams][6][15][16][17] The unified kick math: meter power × Power rating → distance; aim ±
// Accuracy-scaled error → trajectory. A fixed rng of 0.5 zeroes the random error for exact math.
const noNoise = () => 0.5

describe('[15] distance — power meter × kicker Power rating', () => {
  it('scales between a floor (empty meter) and ceiling (full meter) set by the rating', () => {
    expect(computeKick({ power: 1, kickerPower: 99 }, noNoise).distance).toBeCloseTo(75)
    expect(computeKick({ power: 0, kickerPower: 99 }, noNoise).distance).toBeCloseTo(40)
    expect(computeKick({ power: 1, kickerPower: 0  }, noNoise).distance).toBeCloseTo(45)
    expect(computeKick({ power: 0, kickerPower: 0  }, noNoise).distance).toBeCloseTo(10)
  })

  it('a higher-rated kicker is more forgiving of a weak meter (higher floor)', () => {
    const strong = computeKick({ power: 0, kickerPower: 99 }, noNoise).distance
    const weak   = computeKick({ power: 0, kickerPower: 20 }, noNoise).distance
    expect(strong).toBeGreaterThan(weak)
  })

  it('clamps out-of-range power', () => {
    expect(computeKick({ power: 2, kickerPower: 99 }, noNoise).distance).toBeCloseTo(75)
    expect(computeKick({ power: -1, kickerPower: 99 }, noNoise).distance).toBeCloseTo(40)
  })
})

describe('[16] trajectory — aim ± Accuracy-scaled error', () => {
  it('a perfectly-aimed kick goes straight; a deflected one pushes wide', () => {
    expect(computeKick({ angle: 0, kickerAccuracy: 99 }, noNoise).pushYards).toBeCloseTo(0)
    expect(computeKick({ angle: 1, kickerAccuracy: 99 }, noNoise).pushYards).toBeCloseTo(14)
    expect(computeKick({ angle: -1, kickerAccuracy: 99 }, noNoise).pushYards).toBeCloseTo(-14)
  })

  it('high Accuracy removes angular error; low Accuracy lets the kick wander', () => {
    // worst-case rng (=1) → max error to one side
    const precise = computeKick({ angle: 0, kickerAccuracy: 99 }, () => 1)
    const sloppy  = computeKick({ angle: 0, kickerAccuracy: 0  }, () => 1)
    expect(Math.abs(precise.pushYards)).toBeCloseTo(0)
    expect(Math.abs(sloppy.pushYards)).toBeGreaterThan(3)
  })
})

describe('isKickGood', () => {
  it('good with the distance and inside the uprights; otherwise no good', () => {
    expect(isKickGood({ distance: 50, pushYards: 0 }, 45)).toBe(true)
    expect(isKickGood({ distance: 40, pushYards: 0 }, 45)).toBe(false)              // short
    expect(isKickGood({ distance: 50, pushYards: UPRIGHT_HALF_WIDTH + 0.1 }, 45)).toBe(false)  // wide
  })
})

describe('[17] calculateKickResult — full outcome', () => {
  it('reports distance, trajectory, and hang time for every kick', () => {
    const r = calculateKickResult({ kickType: 'field_goal', power: 1, angle: 0, kickerPower: 99, requiredDistance: 30 }, noNoise)
    expect(r.distance).toBeCloseTo(75)
    expect(r.pushYards).toBeCloseTo(0)
    expect(r.hangTime).toBeGreaterThan(0)
    expect(r.good).toBe(true)
  })

  it('a field goal short of the required distance is no good', () => {
    const r = calculateKickResult({ kickType: 'field_goal', power: 0.2, angle: 0, kickerPower: 50, requiredDistance: 60 }, noNoise)
    expect(r.good).toBe(false)
  })

  it('a punt reports the landing yard line in the receiving frame', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 0.5, kickerPower: 75, yardLine: 30 }, noNoise)
    expect(r.touchback).toBe(false)
    expect(r.landingYardLine).toBeGreaterThan(0)
    expect(r.landingYardLine).toBeLessThan(50)
  })

  it('a punt that sails into the end zone is a touchback at the 20', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 85 }, noNoise)
    expect(r.touchback).toBe(true)
    expect(r.landingYardLine).toBe(20)
  })
})

describe('[18] field position — kicks originate from the hash', () => {
  const CENTER = 53.33 / 2          // ≈ 26.67, where the uprights sit
  const LEFT_HASH  = 53.33 * 0.35   // ≈ 18.67
  const RIGHT_HASH = 53.33 * 0.65   // ≈ 34.67
  const fg = (ballX, angle) => calculateKickResult(
    { kickType: 'field_goal', power: 1, angle, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 30, ballX, uprightsX: CENTER },
    noNoise,
  )

  it('from the center, a straight kick splits the uprights', () => {
    expect(fg(CENTER, 0).good).toBe(true)
  })

  it('from a hash, a straight kick sails wide — it must angle back toward center', () => {
    expect(fg(LEFT_HASH, 0).good).toBe(false)    // straight → wide left
    expect(fg(LEFT_HASH, 0.57).good).toBe(true)  // angled right toward center → good
    expect(fg(RIGHT_HASH, 0).good).toBe(false)   // mirror
    expect(fg(RIGHT_HASH, -0.57).good).toBe(true)
  })

  it('reports the lateral offset (which way center is from the ball)', () => {
    expect(fg(LEFT_HASH, 0).lateralOffset).toBeGreaterThan(0)   // center is to the right
    expect(fg(RIGHT_HASH, 0).lateralOffset).toBeLessThan(0)
  })
})

describe('[42] field goal trajectory — every input contributes', () => {
  const WIDTH = 53.33
  const CENTER = WIDTH / 2
  const LEFT_HASH = WIDTH * 0.35
  const fg = (o, rng = noNoise) =>
    calculateKickResult({ kickType: 'field_goal', uprightsX: CENTER, fieldWidth: WIDTH, ...o }, rng)

  it('a centered, full-power, accurate kick splits the uprights — full trajectory reported', () => {
    const r = fg({ power: 1, angle: 0, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 40, ballX: CENTER })
    expect(r.good).toBe(true)
    expect(r.hasDistance).toBe(true)
    expect(r.splitsUprights).toBe(true)
    expect(r.missReason).toBeNull()
    expect(r.lateralAtGoal).toBeCloseTo(0)        // dead center
    expect(r.goalCrossX).toBeCloseTo(CENTER)
    expect(r.hangTime).toBeGreaterThan(0)
  })

  it('power + field position drive the leg: a weak/long kick is short, more power clears it', () => {
    const short = fg({ power: 0.2, angle: 0, kickerPower: 40, kickerAccuracy: 99, requiredDistance: 60, ballX: CENTER })
    expect(short.hasDistance).toBe(false)
    expect(short.good).toBe(false)
    expect(short.missReason).toBe('short')
    const long = fg({ power: 1, angle: 0, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 60, ballX: CENTER })
    expect(long.hasDistance).toBe(true)
  })

  it('user aim + field position: from a hash a straight kick sails wide; angling back splits it', () => {
    const wide = fg({ power: 1, angle: 0, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 35, ballX: LEFT_HASH })
    expect(wide.splitsUprights).toBe(false)
    expect(wide.good).toBe(false)
    expect(wide.missReason).toBe('wide_left')     // left hash, no correction → left of the centered posts
    const corrected = fg({ power: 1, angle: 0.57, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 35, ballX: LEFT_HASH })
    expect(corrected.splitsUprights).toBe(true)
    expect(corrected.good).toBe(true)
  })

  it('kicker Accuracy: a wild leg drifts off-line, widening lateralAtGoal', () => {
    const precise = fg({ power: 1, angle: 0, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 35, ballX: CENTER })
    const wild    = fg({ power: 1, angle: 0, kickerPower: 99, kickerAccuracy: 10, requiredDistance: 35, ballX: CENTER }, () => 1)
    expect(Math.abs(wild.lateralAtGoal)).toBeGreaterThan(Math.abs(precise.lateralAtGoal))
  })

  it('reports the absolute crossing X for rendering the flight', () => {
    const r = fg({ power: 1, angle: 0.3, kickerPower: 99, kickerAccuracy: 99, requiredDistance: 35, ballX: CENTER })
    expect(r.goalCrossX).toBeCloseTo(CENTER + r.pushYards)
  })
})

describe('[23] punt trajectory — aim splits distance into downfield + lateral', () => {
  const WIDTH = 53.33

  it('a straight punt goes farther downfield than an angled one (same power)', () => {
    const straight = calculateKickResult({ kickType: 'punt', power: 0.6, kickerPower: 75, yardLine: 30, angle: 0,   ballX: 26.67, fieldWidth: WIDTH }, noNoise)
    const angled   = calculateKickResult({ kickType: 'punt', power: 0.6, kickerPower: 75, yardLine: 30, angle: 0.8, ballX: 26.67, fieldWidth: WIDTH }, noNoise)
    expect(straight.distance).toBeCloseTo(angled.distance)               // same leg
    expect(straight.downfieldDistance).toBeGreaterThan(angled.downfieldDistance)  // angled loses downfield
    expect(straight.landingYardLine).toBeLessThan(angled.landingYardLine)         // straight pins deeper
  })

  it('an angled punt lands laterally off the kick origin, and reports a hang time', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 0.5, kickerPower: 75, yardLine: 30, angle: 0.5, ballX: 26.67, fieldWidth: WIDTH }, noNoise)
    expect(r.landingX).toBeGreaterThan(26.67)   // aimed right → lands right of center
    expect(r.hangTime).toBeGreaterThan(0)
    expect(r.finalAngle).toBeCloseTo(0.5)
  })
})

describe('[25] automatic touchback on a punt that lands in the end zone in the air', () => {
  const WIDTH = 53.33

  it('a punt whose carry reaches the end zone is an immediate touchback (no roll)', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 60, angle: 0, ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    expect(r.touchback).toBe(true)
    expect(r.airTouchback).toBe(true)     // [29] came down IN the end zone — no return menu
    expect(r.outOfBounds).toBe(false)
    expect(r.landingYardLine).toBe(20)    // receiving offense at its own 20
  })

  it('an air touchback cannot be saved by backspin (the ball is already in the end zone)', () => {
    const flat = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 60, angle: 0, backspin: false, ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    const spin = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 60, angle: 0, backspin: true,  ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    expect(flat.touchback).toBe(true)
    expect(spin.touchback).toBe(true)
  })
})

describe('[26] punt landing prediction accounts for every input', () => {
  const WIDTH = 53.33
  const base = { kickType: 'punt', kickerPower: 75, kickerAccuracy: 75, yardLine: 20, ballX: WIDTH / 2, fieldWidth: WIDTH }

  it('the predicted landing shifts with power, aim, kicker rating, and backspin', () => {
    const ref  = calculateKickResult({ ...base, power: 0.6, angle: 0,    backspin: false }, noNoise)
    // more power → lands farther (deeper for the receiver)
    expect(calculateKickResult({ ...base, power: 0.9, angle: 0, backspin: false }, noNoise).landingYardLine)
      .toBeLessThan(ref.landingYardLine)
    // a stronger punter → lands farther
    expect(calculateKickResult({ ...base, kickerPower: 99, power: 0.6, angle: 0, backspin: false }, noNoise).landingYardLine)
      .toBeLessThan(ref.landingYardLine)
    // aiming wide → less downfield (shallower for the receiver) + a lateral landing
    const wide = calculateKickResult({ ...base, power: 0.6, angle: 0.8, backspin: false }, noNoise)
    expect(wide.landingYardLine).toBeGreaterThan(ref.landingYardLine)
    expect(wide.landingX).not.toBeCloseTo(ref.landingX)
    // [33] the kick result is the AIR landing only — backspin/roll are resolved at Let It Bounce, so
    // the predicted (air) landing itself is unaffected by backspin
    expect(calculateKickResult({ ...base, power: 0.6, angle: 0, backspin: true }, noNoise).landingYardLine)
      .toBeCloseTo(ref.landingYardLine)
  })
})

describe('[27] punt preview — projected (air) landing, no roll revealed', () => {
  const WIDTH = 53.33

  it('the preview is the AIR landing — the bounce/roll is not part of the kick result', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 0.5, kickerPower: 75, yardLine: 30, angle: 0, backspin: false, ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    // [33] the roll is resolved at Let It Bounce, so the result carries only the air landing — the
    // preview and the (kick-time) landing are one and the same.
    expect(r.previewLandingYardLine).toBeCloseTo(r.landingYardLine)
    expect(r.previewLandingYardLine).toBeCloseTo(100 - (r.distance + 30))   // 100 − (yardLine + carry)
  })

  it('backspin does not change the air-landing preview (it only affects a later bounce)', () => {
    const flat = calculateKickResult({ kickType: 'punt', power: 0.5, kickerPower: 75, yardLine: 30, angle: 0, backspin: false, ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    const spin = calculateKickResult({ kickType: 'punt', power: 0.5, kickerPower: 75, yardLine: 30, angle: 0, backspin: true,  ballX: WIDTH / 2, fieldWidth: WIDTH }, noNoise)
    expect(flat.previewLandingYardLine).toBeCloseTo(spin.previewLandingYardLine)
    expect(spin.backspin).toBe(true)   // [34] the kicker's choice is recorded for the bounce step
  })
})

describe('[24] out-of-bounds punt detection', () => {
  const WIDTH = 53.33
  const RIGHT_HASH = WIDTH * 0.65   // ≈ 34.67

  it('a hard angle toward the sideline goes out of bounds, downed at the crossing', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 40, angle: 1, ballX: RIGHT_HASH, fieldWidth: WIDTH }, noNoise)
    expect(r.outOfBounds).toBe(true)
    expect(r.landingX).toBeCloseTo(WIDTH)        // crossed the right sideline
    expect(r.landingYardLine).toBeGreaterThan(0)
    expect(r.landingYardLine).toBeLessThan(100)
  })

  it('a straight punt stays in bounds', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 40, angle: 0, ballX: RIGHT_HASH, fieldWidth: WIDTH }, noNoise)
    expect(r.outOfBounds).toBe(false)
  })
})

describe('[33] let-it-bounce roll', () => {
  it('rolls forward 3 to 10 yards (toward the receiving goal)', () => {
    expect(computePuntBounce({ backspin: false }, () => 0)).toBeCloseTo(PUNT_BOUNCE_MIN_YARDS)   // min roll = 3
    expect(computePuntBounce({ backspin: false }, () => 1)).toBeCloseTo(PUNT_BOUNCE_MAX_YARDS)   // max roll = 10
    const r = computePuntBounce({ backspin: false }, noNoise)
    expect(r).toBeGreaterThanOrEqual(PUNT_BOUNCE_MIN_YARDS)
    expect(r).toBeLessThanOrEqual(PUNT_BOUNCE_MAX_YARDS)
  })
})

describe('[34] backspin reduces the bounce', () => {
  it('backspin only ever reduces the roll (never adds distance)', () => {
    const flat = computePuntBounce({ backspin: false }, noNoise)
    const spin = computePuntBounce({ backspin: true },  noNoise)
    expect(spin).toBeLessThan(flat)                 // pulled back relative to a flat bounce
    expect(flat - spin).toBeGreaterThanOrEqual(3)   // [34] by 3…8 yards
    expect(flat - spin).toBeLessThanOrEqual(8)
  })

  it('with a small bounce, backspin can pull the ball behind the landing (negative roll)', () => {
    // minimum forward roll (3) then a maximum backspin pull (8) → net negative
    const seq = [0, 1]; let i = 0; const rng = () => seq[i++]   // roll uses 0, backspin pull uses 1
    expect(computePuntBounce({ backspin: true }, rng)).toBeLessThan(0)
  })
})

describe('[35] bounce + backspin interaction', () => {
  // The two effects are drawn separately, so we can assert the EXACT combined value.
  const seqRng = (...draws) => { let i = 0; return () => draws[i++] }

  it('the net roll is exactly the forward bounce MINUS the backspin pull', () => {
    // roll draw 0 → 3 yds forward; backspin draw 0.5 → 3 + 0.5*5 = 5.5 yds back → net −2.5
    expect(computePuntBounce({ backspin: true }, seqRng(0, 0.5))).toBeCloseTo(3 - 5.5)
    // roll draw 1 → 10 yds forward; backspin draw 0 → 3 yds back → net +7
    expect(computePuntBounce({ backspin: true }, seqRng(1, 0))).toBeCloseTo(10 - 3)
  })

  it('for the SAME forward roll, adding backspin always lands the ball shorter', () => {
    const flat = computePuntBounce({ backspin: false }, seqRng(0.7))           // 3 + 0.7*7 = 7.9
    const both = computePuntBounce({ backspin: true },  seqRng(0.7, 0.4))      // 7.9 − (3 + 0.4*5) = 7.9 − 5
    expect(both).toBeLessThan(flat)
    expect(flat - both).toBeCloseTo(3 + 0.4 * 5)   // the difference is precisely the backspin pull
  })

  it('a strong roll still outruns a weak backspin (net stays forward)', () => {
    // big roll (0.9 → 9.3) vs a light backspin bite (0.1 → 3.5) → net forward 5.8
    expect(computePuntBounce({ backspin: true }, seqRng(0.9, 0.1))).toBeCloseTo((3 + 0.9 * 7) - (3 + 0.1 * 5))
  })
})

describe('[36] coffin corner — emerges from aim + accuracy, not a separate mechanic', () => {
  const WIDTH = 53.33
  const HASH  = WIDTH * 0.65
  const base  = { kickType: 'punt', power: 0.7, kickerPower: 80, yardLine: 58, ballX: HASH, fieldWidth: WIDTH }

  it('angling toward the sideline turns a would-be touchback into a deep out-of-bounds pin', () => {
    const straight = calculateKickResult({ ...base, kickerAccuracy: 99, angle: 0 }, noNoise)
    const corner   = calculateKickResult({ ...base, kickerAccuracy: 99, angle: 1 }, noNoise)
    expect(straight.touchback).toBe(true)         // straight on → carries into the end zone
    expect(corner.outOfBounds).toBe(true)         // angled → crosses the sideline first
    expect(corner.touchback).toBe(false)          // …so it is NOT a touchback
    expect(corner.landingYardLine).toBeLessThan(15)   // pinned deep
  })

  it('Accuracy drives reliability — a precise leg places the corner kick, a wild one sprays', () => {
    const precise = calculateKickResult({ ...base, kickerAccuracy: 99, angle: 0.8 }, () => 1)   // worst-case noise
    const wild    = calculateKickResult({ ...base, kickerAccuracy: 10, angle: 0.8 }, () => 1)
    expect(Math.abs(precise.finalAngle - 0.8)).toBeLessThan(Math.abs(wild.finalAngle - 0.8))
  })
})

describe('[37] touchback on a deep no-backspin bounce', () => {
  it('a no-backspin roll that stops inside the 8 is converted to a touchback', () => {
    // lands at the 12, max forward roll (rng→1 = 10 yds) → would stop at the 2 (inside the 8) → touchback
    const r = resolvePuntBounce({ airLanding: 12, backspin: false }, () => 1)
    expect(r.touchback).toBe(true)
    expect(r.yardLine).toBe(20)
  })

  it('backspin keeps the ball out of the end zone — it can be downed inside the 8', () => {
    // lands at the 6; backspin nets a 0-yard roll, so it stays pinned at the 6 and is DOWNED (not a TB)
    const r = resolvePuntBounce({ airLanding: 6, backspin: true }, () => 0)   // roll 3, backspin pull 3 → net 0
    expect(r.touchback).toBe(false)
    expect(r.yardLine).toBeLessThan(PUNT_BOUNCE_TOUCHBACK_LINE)   // pinned deep, inside the 8
    expect(r.yardLine).toBeGreaterThan(0)
  })

  it('a bounce that comes to rest outside the 8 is downed normally (no touchback)', () => {
    const r = resolvePuntBounce({ airLanding: 40, backspin: false }, noNoise)   // ~the 33 — nowhere near the goal
    expect(r.touchback).toBe(false)
    expect(r.yardLine).toBeGreaterThanOrEqual(PUNT_BOUNCE_TOUCHBACK_LINE)
  })

  it('a roll past the goal line is always a touchback (with or without backspin)', () => {
    expect(resolvePuntBounce({ airLanding: 4, backspin: false }, () => 1).touchback).toBe(true)
  })
})

describe('[31][32] punt return', () => {
  it('most returns land between 0 and the cap, and a better returner gains more', () => {
    const weak   = computePuntReturn({ hangTime: 2.5, returnerRating: 20, punterPower: 75 }, noNoise)
    const strong = computePuntReturn({ hangTime: 2.5, returnerRating: 99, punterPower: 75 }, noNoise)
    expect(weak.yards).toBeGreaterThanOrEqual(0)
    expect(strong.yards).toBeLessThanOrEqual(PUNT_RETURN_MAX_YARDS)
    expect(strong.yards).toBeGreaterThan(weak.yards)        // [31] returner ability matters
  })

  it('[31] more hang time (better coverage) yields fewer return yards', () => {
    const lowHang  = computePuntReturn({ hangTime: 1.8, returnerRating: 75, punterPower: 75 }, noNoise)
    const highHang = computePuntReturn({ hangTime: 4.4, returnerRating: 75, punterPower: 75 }, noNoise)
    expect(highHang.yards).toBeLessThan(lowHang.yards)
  })

  it('[32] the touchdown chance is ~1%, lifted by returner rating and a low hang', () => {
    const base = computePuntReturn({ hangTime: 2.5, returnerRating: 75, punterPower: 75 }, noNoise)
    expect(base.tdChance).toBeGreaterThan(0)
    expect(base.tdChance).toBeLessThan(0.03)               // stays small (~1%)
    const elite = computePuntReturn({ hangTime: 1.7, returnerRating: 99, punterPower: 75 }, noNoise)
    const poor  = computePuntReturn({ hangTime: 4.5, returnerRating: 10, punterPower: 75 }, noNoise)
    expect(elite.tdChance).toBeGreaterThan(poor.tdChance)  // ratings + hang still influence it
  })

  it('[32] a breakaway roll flags a touchdown', () => {
    // rng→0: noise pulls yards down, but the TD roll (0) is below any positive chance → touchdown
    expect(computePuntReturn({ hangTime: 1.7, returnerRating: 99, punterPower: 75 }, () => 0).touchdown).toBe(true)
    // rng→1: the TD roll (1) is above the tiny chance → no touchdown
    expect(computePuntReturn({ hangTime: 2.5, returnerRating: 75, punterPower: 75 }, () => 1).touchdown).toBe(false)
  })
})

describe('[19] hang time — from power and distance', () => {
  const punt = (power, kickerPower) => calculateKickResult({ kickType: 'punt', power, kickerPower, yardLine: 30 }, noNoise)

  it('a long, high-power kick hangs longer than a short, weak one', () => {
    expect(punt(1, 99).hangTime).toBeGreaterThan(punt(0.2, 20).hangTime)
  })

  it('at equal distance, more power means more hang time', () => {
    // a mid leg at full meter vs a strong leg at a low meter — tuned to the same ~60-yd distance, so
    // the only difference is how hard it was struck (power), which breaks the tie.
    const a = calculateKickResult({ kickType: 'punt', power: 1.0,   kickerPower: 50, yardLine: 30 }, noNoise)
    const b = calculateKickResult({ kickType: 'punt', power: 0.575, kickerPower: 99, yardLine: 30 }, noNoise)
    expect(a.distance).toBeCloseTo(b.distance, 0)
    expect(a.hangTime).toBeGreaterThan(b.hangTime)
  })

  it('stays within sane bounds', () => {
    expect(punt(0, 0).hangTime).toBeGreaterThanOrEqual(1.6)
    expect(punt(1, 99).hangTime).toBeLessThanOrEqual(4.6)
  })
})
