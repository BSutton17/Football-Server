import { describe, it, expect } from '@jest/globals'
import { shouldCallTimeout, snapsLeft, TIMEOUT_SECONDS_SAVED } from '../ai/clockManagement.js'

// [clock] ⚠️ "WHEN THEY ARE TRYING TO SCORE LATE IN THE 2ND OR 4TH QUARTER THEY SHOULD BE USING
// TIMEOUTS IF NEED BE."
//
// The computer had three timeouts and never called one. It would take the ball with ninety seconds
// left, run a play, let forty of those seconds bleed away standing at the line, and then run out of
// time on the drive it was trying to score on.

const k = (over = {}) => ({
  phase: 'pre_snap', role: 'offense', quarter: 4, clock: 90,
  clockStopped: false, timeouts: { own: 3, opp: 3 },
  score: { own: 14, opp: 17 }, yardLine: 45,
  ...over,
})

describe('spending a timeout', () => {
  it('trailing, late, with the clock running — yes', () => {
    expect(shouldCallTimeout(k())).toBe(true)
  })

  it('⚠️ NEVER WHEN THE CLOCK IS ALREADY STOPPED', () => {
    // The single easiest way to throw three timeouts away, and what a naive "it is late, call one"
    // rule does on every incompletion.
    expect(shouldCallTimeout(k({ clockStopped: true }))).toBe(false)
  })

  it('never with none left', () => {
    expect(shouldCallTimeout(k({ timeouts: { own: 0, opp: 3 } }))).toBe(false)
  })

  it('not in the first or third quarter — the period ending is not the constraint', () => {
    expect(shouldCallTimeout(k({ quarter: 1 }))).toBe(false)
    expect(shouldCallTimeout(k({ quarter: 3 }))).toBe(false)
  })

  it('not early in the quarter', () => {
    expect(shouldCallTimeout(k({ quarter: 4, clock: 600 }))).toBe(false)
    expect(shouldCallTimeout(k({ quarter: 2, clock: 400 }))).toBe(false)
  })

  it('⚠️ NOT WITH ANY LEAD IN THE FOURTH — the clock is what is protecting it', () => {
    expect(shouldCallTimeout(k({ score: { own: 30, opp: 17 } }))).toBe(false)
    expect(shouldCallTimeout(k({ score: { own: 24, opp: 17 } }))).toBe(false)   // even one score
    // Level or behind, the points have to be scored and the time is needed to score them.
    expect(shouldCallTimeout(k({ score: { own: 17, opp: 17 } }))).toBe(true)
    expect(shouldCallTimeout(k({ score: { own: 10, opp: 17 } }))).toBe(true)
  })

  it('in the second quarter a lead is irrelevant — the half ends either way', () => {
    expect(shouldCallTimeout(k({ quarter: 2, clock: 90, score: { own: 30, opp: 0 } }))).toBe(true)
  })

  it('…but there has to be something to drive for', () => {
    // Backed up on the second-quarter two-minute warning, the half is simply over.
    expect(shouldCallTimeout(k({ quarter: 2, clock: 90, yardLine: 12 }))).toBe(false)
    expect(shouldCallTimeout(k({ quarter: 2, clock: 90, yardLine: 55 }))).toBe(true)
  })

  it('⚠️ ON DEFENCE ONLY WHEN THE BALL IS WANTED BACK', () => {
    // Level or behind: stop the clock. Ahead: every second that disappears is a second nearer the
    // final whistle, and a timeout would be helping the other team.
    expect(shouldCallTimeout(k({ role: 'defense', score: { own: 14, opp: 17 } }))).toBe(true)
    expect(shouldCallTimeout(k({ role: 'defense', score: { own: 17, opp: 17 } }))).toBe(true)
    expect(shouldCallTimeout(k({ role: 'defense', score: { own: 21, opp: 17 } }))).toBe(false)
  })

  it('not with too little time for the saved seconds to become a snap', () => {
    expect(shouldCallTimeout(k({ clock: 3 }))).toBe(false)
  })

  it('never during a kick or a decision menu, which the server refuses anyway', () => {
    expect(shouldCallTimeout(k({ specialTeams: { kickType: 'field_goal' } }))).toBe(false)
    expect(shouldCallTimeout(k({ decision: { options: [] } }))).toBe(false)
  })

  it('only while the ball is dead', () => {
    expect(shouldCallTimeout(k({ phase: 'live' }))).toBe(false)
    expect(shouldCallTimeout(k({ phase: 'countdown' }))).toBe(false)
  })

  it('survives a half-built knowledge object', () => {
    expect(shouldCallTimeout(null)).toBe(false)
    expect(shouldCallTimeout({})).toBe(false)
  })
})

describe('how much time there really is', () => {
  it('counts the timeouts as snaps', () => {
    expect(snapsLeft({ clock: 40, timeouts: { own: 0 } })).toBe(1)
    expect(snapsLeft({ clock: 40, timeouts: { own: 2 } })).toBe(3)
  })

  it('a timeout is worth about a play clock and the walk-up', () => {
    expect(TIMEOUT_SECONDS_SAVED).toBeGreaterThan(25)
    expect(TIMEOUT_SECONDS_SAVED).toBeLessThan(50)
  })
})
