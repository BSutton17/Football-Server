import { describe, it, expect } from '@jest/globals'
import {
  getRatings, accelFromRating, speedFromRating, drainFromStaminaRating,
  cutRetentionFromAccel, pursuitReactionTime, pursuitLeadQuality,
} from '../data/ratings.js'

describe('ratings', () => {
  it('WR has higher speed than OL', () => {
    expect(getRatings('WR').speed).toBeGreaterThan(getRatings('OL').speed)
  })

  it('accelFromRating(99) is the maximum acceleration', () => {
    expect(accelFromRating(99)).toBeGreaterThan(accelFromRating(50))
  })

  it('speedFromRating scales linearly between min and max', () => {
    expect(speedFromRating(0)).toBeLessThan(speedFromRating(99))
    expect(speedFromRating(50)).toBeCloseTo((speedFromRating(0) + speedFromRating(99)) / 2, 1)
  })

  it('higher stamina rating means slower drain', () => {
    expect(drainFromStaminaRating(99)).toBeLessThan(drainFromStaminaRating(0))
  })

  it('rating 99 stamina drains ~1.5% per second', () => {
    expect(drainFromStaminaRating(99)).toBeCloseTo(1.5, 1)
  })

  it('unknown position falls back to defaults', () => {
    const r = getRatings('UNKNOWN')
    expect(r.speed).toBeGreaterThan(0)
    expect(r.acceleration).toBeGreaterThan(0)
  })

  it('higher acceleration keeps more speed through a cut ([159])', () => {
    expect(cutRetentionFromAccel(99)).toBeGreaterThan(cutRetentionFromAccel(20))
    expect(cutRetentionFromAccel(150)).toBeCloseTo(cutRetentionFromAccel(99), 5)  // clamped
    expect(cutRetentionFromAccel(-5)).toBeCloseTo(cutRetentionFromAccel(0), 5)
  })

  it('higher awareness reacts to pursuit faster ([160])', () => {
    expect(pursuitReactionTime(99)).toBeLessThan(pursuitReactionTime(20))
    expect(pursuitReactionTime(99)).toBeCloseTo(0.05, 5)
    expect(pursuitReactionTime(0)).toBeCloseTo(0.5, 5)
  })

  it('higher awareness takes a better pursuit angle ([160])', () => {
    expect(pursuitLeadQuality(99)).toBeGreaterThan(pursuitLeadQuality(20))
    expect(pursuitLeadQuality(99)).toBeCloseTo(1.0, 5)
    expect(pursuitLeadQuality(200)).toBeCloseTo(1.0, 5)   // clamped
  })
})
