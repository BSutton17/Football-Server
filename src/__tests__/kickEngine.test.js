import { describe, it, expect } from '@jest/globals'
import {
  computeKick, calculateKickResult, isKickGood, UPRIGHT_HALF_WIDTH,
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
    expect(r.outOfBounds).toBe(false)
    expect(r.rollYards).toBe(0)           // it came down in the air — no roll/bounce
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
    // backspin → the ball is pulled back (shallower)
    expect(calculateKickResult({ ...base, power: 0.6, angle: 0, backspin: true }, noNoise).landingYardLine)
      .toBeGreaterThan(ref.landingYardLine)
  })
})

describe('[24] out-of-bounds punt detection', () => {
  const WIDTH = 53.33
  const RIGHT_HASH = WIDTH * 0.65   // ≈ 34.67

  it('a hard angle toward the sideline goes out of bounds, downed at the crossing', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 40, angle: 1, ballX: RIGHT_HASH, fieldWidth: WIDTH }, noNoise)
    expect(r.outOfBounds).toBe(true)
    expect(r.landingX).toBeCloseTo(WIDTH)        // crossed the right sideline
    expect(r.rollYards).toBe(0)                  // no roll once out of bounds
    expect(r.landingYardLine).toBeGreaterThan(0)
    expect(r.landingYardLine).toBeLessThan(100)
  })

  it('a straight punt stays in bounds', () => {
    const r = calculateKickResult({ kickType: 'punt', power: 1, kickerPower: 99, yardLine: 40, angle: 0, ballX: RIGHT_HASH, fieldWidth: WIDTH }, noNoise)
    expect(r.outOfBounds).toBe(false)
  })
})

describe('[21][22] punt backspin', () => {
  const punt = (yardLine, power, backspin, rng = noNoise) =>
    calculateKickResult({ kickType: 'punt', power, kickerPower: 75, yardLine, backspin }, rng)

  it('a flat punt rolls forward; backspin pulls the downed spot back', () => {
    const flat = punt(30, 0.5, false)
    const spin = punt(30, 0.5, true)
    expect(flat.rollYards).toBeGreaterThan(0)            // forward roll
    expect(spin.rollYards).toBeLessThan(0)               // [22] pulled backward
    expect(flat.landingYardLine).toBeLessThan(spin.landingYardLine)   // flat travels farther
  })

  it('[22] backspin pulls the ball back between 1 and 5 yards', () => {
    expect(punt(30, 0.5, true, () => 0).rollYards).toBeCloseTo(-1)   // min pull
    expect(punt(30, 0.5, true, () => 1).rollYards).toBeCloseTo(-5)   // max pull
    const r = punt(30, 0.5, true).rollYards
    expect(r).toBeLessThanOrEqual(-1)
    expect(r).toBeGreaterThanOrEqual(-5)
  })

  it('backspin avoids a touchback that a flat punt would roll into', () => {
    const flat = punt(50, 0.37, false)   // ~47 yds + 6 roll → into the end zone
    const spin = punt(50, 0.37, true)    // ~47 yds, pulled back → lands just short
    expect(flat.touchback).toBe(true)
    expect(spin.touchback).toBe(false)
    expect(spin.landingYardLine).toBeLessThan(20)   // pinned inside the 20 instead of a touchback
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
