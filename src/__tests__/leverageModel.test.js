import { describe, it, expect } from '@jest/globals'
import { computeLeverage } from '../game/utils/leverageModel.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Blocker with velocity pointing toward the defender.
function drivingBlocker(bx, by, dx, dy) {
  const len = Math.sqrt((dx - bx) ** 2 + (dy - by) ** 2)
  return { x: bx, y: by, vx: (dx - bx) / len * 5, vy: (dy - by) / len * 5 }
}

// Stationary players.
const still = (x, y) => ({ x, y, vx: 0, vy: 0 })

// ── Score range ───────────────────────────────────────────────────────────────

describe('computeLeverage — score range', () => {
  it('returns score in [-1, 1]', () => {
    const blocker  = drivingBlocker(26, 58, 26, 62)
    const defender = still(26, 62)
    const ball     = still(26, 55)
    const { score } = computeLeverage(blocker, defender, ball)
    expect(score).toBeGreaterThanOrEqual(-1)
    expect(score).toBeLessThanOrEqual(1)
  })

  it('returns score=0 and side=balanced when all positions coincide', () => {
    const p = still(26, 60)
    const { score, side } = computeLeverage(p, p, p)
    expect(score).toBe(0)
    expect(side).toBe('balanced')
  })
})

// ── Inside leverage ───────────────────────────────────────────────────────────

describe('computeLeverage — inside leverage', () => {
  it('gives positive score when blocker is between ball and defender', () => {
    // Ball at y=55 (south), blocker at y=58, defender at y=62 (north).
    // Blocker sits between ball and defender along y-axis → inside leverage.
    const blocker  = drivingBlocker(26, 58, 26, 62)
    const defender = still(26, 62)
    const ball     = still(26, 55)
    const { score, side } = computeLeverage(blocker, defender, ball)
    expect(score).toBeGreaterThan(0)
    expect(side).toBe('inside')
  })

  it('inside leverage push direction points away from the ball', () => {
    // Ball at south (low y), defender at north → inside blocker pushes defender further north.
    const blocker  = drivingBlocker(26, 58, 26, 62)
    const defender = still(26, 62)
    const ball     = still(26, 55)
    const { pushX, pushY } = computeLeverage(blocker, defender, ball)
    // Ball is at lower y, so push should point to higher y (away from ball).
    expect(pushY).toBeGreaterThan(0)
  })

  it('inside leverage is symmetric: left and right side produce mirrored push directions', () => {
    const ball = still(26.67, 55)

    // Blocker on left side
    const bL  = drivingBlocker(10, 58, 10, 62)
    const dL  = still(10, 62)
    const levL = computeLeverage(bL, dL, ball)

    // Blocker on right side
    const bR  = drivingBlocker(44, 58, 44, 62)
    const dR  = still(44, 62)
    const levR = computeLeverage(bR, dR, ball)

    // Both should have inside leverage (positive score)
    expect(levL.score).toBeGreaterThan(0)
    expect(levR.score).toBeGreaterThan(0)
    // Push y components should both point away from ball (northward)
    expect(levL.pushY).toBeGreaterThan(0)
    expect(levR.pushY).toBeGreaterThan(0)
  })
})

// ── Outside leverage ──────────────────────────────────────────────────────────

describe('computeLeverage — outside leverage', () => {
  it('gives negative score when the defender is between the ball and the blocker', () => {
    // Ball at y=55, defender at y=58 (close to ball), blocker at y=62 (far side).
    // Defender is closer to the ball → they have the angle → defense has leverage.
    const blocker  = still(26, 62)
    const defender = still(26, 58)
    const ball     = still(26, 55)
    const { score, side } = computeLeverage(blocker, defender, ball)
    expect(score).toBeLessThan(0)
    expect(side).toBe('outside')
  })

  it('score is more negative when drive score is also negative (blocker retreating)', () => {
    // Defender between ball and blocker, plus blocker moving away.
    const blocker  = { x: 26, y: 62, vx: 0, vy: 2 }  // retreating north
    const defender = still(26, 58)
    const ball     = still(26, 55)
    const retreating = computeLeverage(blocker, defender, ball)

    // Compare to same geometry but stationary blocker.
    const stationary = computeLeverage(still(26, 62), defender, ball)

    expect(retreating.score).toBeLessThan(stationary.score)
  })
})

// ── Drive score ───────────────────────────────────────────────────────────────

describe('computeLeverage — drive score contribution', () => {
  it('driving into the defender increases score vs standing still', () => {
    const defender = still(26, 62)
    const ball     = still(26, 55)

    const driving    = computeLeverage(drivingBlocker(26, 58, 26, 62), defender, ball)
    const stationary = computeLeverage(still(26, 58), defender, ball)

    expect(driving.score).toBeGreaterThan(stationary.score)
  })

  it('stationary blocker still gets a positive score if in inside position', () => {
    // Position score alone should be enough for a positive result.
    const blocker  = still(26, 58)   // between ball(55) and defender(62)
    const defender = still(26, 62)
    const ball     = still(26, 55)
    const { score } = computeLeverage(blocker, defender, ball)
    expect(score).toBeGreaterThan(0)
  })

  it('driveScore component is 0 when blocker is stationary', () => {
    const { driveScore } = computeLeverage(still(26, 58), still(26, 62), still(26, 55))
    expect(driveScore).toBe(0)
  })
})

// ── Push direction ────────────────────────────────────────────────────────────

describe('computeLeverage — push direction', () => {
  it('push vector is a unit vector when non-zero', () => {
    const blocker  = drivingBlocker(26, 58, 26, 62)
    const defender = still(26, 62)
    const ball     = still(26, 55)
    const { pushX, pushY } = computeLeverage(blocker, defender, ball)
    const mag = Math.sqrt(pushX ** 2 + pushY ** 2)
    expect(mag).toBeCloseTo(1, 5)
  })

  it('inside leverage push is perpendicular or outward from the ball direction', () => {
    // Ball at y=55, inside blocker at y=58, defender at y=62.
    // The push should have a positive y component (pushing defender further north).
    const { pushX, pushY } = computeLeverage(
      drivingBlocker(26, 58, 26, 62),
      still(26, 62),
      still(26, 55),
    )
    expect(pushY).toBeGreaterThan(0)
    expect(pushX).toBeCloseTo(0, 1)  // straight-line case — no horizontal component
  })

  it('outside leverage push is perpendicular to the ball direction', () => {
    // Defender between ball and blocker — outside leverage.
    // Push should be perpendicular (not toward the ball).
    const blocker  = still(26, 62)
    const defender = still(26, 58)
    const ball     = still(26, 55)
    const { pushX, pushY } = computeLeverage(blocker, defender, ball)
    // pushY should NOT be negative (that would push defender toward ball)
    // It should be roughly horizontal (perpendicular to the y-axis approach)
    expect(Math.abs(pushX)).toBeGreaterThan(Math.abs(pushY) * 0.5)
  })
})

// ── Pocket shaping ────────────────────────────────────────────────────────────

describe('computeLeverage — pocket and run lane shaping', () => {
  it('OT with inside leverage on DE pushes DE toward the sideline', () => {
    // Left tackle at x=12, blocking a DE at x=13 who is trying to get to QB at x=26,y=50
    const lt  = drivingBlocker(12, 60, 13, 62)  // driving into DE
    const de  = still(13, 62)
    const qb  = still(26, 50)
    const { score, pushX } = computeLeverage(lt, de, qb)

    // Offense should have some leverage
    expect(score).toBeGreaterThan(0)
    // Push should send the DE to the LEFT (toward the sideline, negative x)
    expect(pushX).toBeLessThan(0)
  })

  it('right guard with inside leverage pushes DT to the right', () => {
    // Right guard at x=31, DT at x=30, QB at x=26, y=50
    const rg  = drivingBlocker(31, 60, 30, 62)
    const dt  = still(30, 62)
    const qb  = still(26, 50)
    const { score, pushX } = computeLeverage(rg, dt, qb)

    expect(score).toBeGreaterThan(0)
    // Push should send DT to the right (positive x, away from QB)
    expect(pushX).toBeGreaterThan(0)
  })
})
