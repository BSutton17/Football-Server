import { describe, it, expect } from '@jest/globals'
import {
  isEndOfHalfWindow, canFieldGoal, canPunt, decisionRequired, decisionDefault,
  END_OF_HALF_SECONDS, DECISION,
} from '../game/specialTeams.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

// [end of half] Under thirty seconds in a quarter that ENDS something, the down number stops being
// what decides whether to kick: on 1st and 10 with twenty seconds left and the ball on the 30, the
// choice between running another play and taking the points is a real one. The menu only ever
// opened on fourth down.

const at = (over = {}) => ({
  phase: PHASE.PRE_SNAP, down: 1, quarter: 4, clock: 20, yardLine: 70, specialTeams: null, ...over,
})

describe('the end-of-half window', () => {
  it('opens in the last thirty seconds of the second and fourth quarters', () => {
    expect(isEndOfHalfWindow(at({ quarter: 2, clock: 20 }))).toBe(true)
    expect(isEndOfHalfWindow(at({ quarter: 4, clock: END_OF_HALF_SECONDS }))).toBe(true)
  })

  it('stays shut in a quarter that ends nothing', () => {
    expect(isEndOfHalfWindow(at({ quarter: 1 }))).toBe(false)
    expect(isEndOfHalfWindow(at({ quarter: 3 }))).toBe(false)
  })

  it('stays shut with time still on the clock', () => {
    expect(isEndOfHalfWindow(at({ clock: 90 }))).toBe(false)
  })

  it('⚠️ STAYS SHUT OUT OF RANGE — a menu with nothing to choose is just a pause', () => {
    expect(isEndOfHalfWindow(at({ yardLine: 25 }))).toBe(false)
  })
})

describe('what the window offers', () => {
  it('⚠️ OFFERS THE CHOICE ON ANY DOWN, not only fourth', () => {
    expect(decisionRequired(at({ down: 1 }))).toBe(true)
    expect(canFieldGoal(at({ down: 2 }))).toBe(true)
  })

  it('does not offer a punt — that was never one of the two options', () => {
    // Punting away the last twenty seconds of a half is not a decision anybody needs offered.
    expect(canPunt(at({ down: 1 }))).toBe(false)
    expect(canPunt(at({ down: RULES.DOWNS, yardLine: 40 }))).toBe(true)   // still normal on 4th
  })

  it('⚠️ DEFAULTS TO PLAYING ON, so a slow decision does not kick for you', () => {
    // The timeout default exists so a kick still happens when nobody answers a FOURTH-down menu.
    // Applying that on 1st and 10 would kick because the player thought for five seconds.
    expect(decisionDefault(at({ down: 1 }))).toBe(DECISION.GO_FOR_IT)
    expect(decisionDefault(at({ down: 2 }))).toBe(DECISION.GO_FOR_IT)
  })

  it('still behaves normally on fourth down inside the window', () => {
    expect(decisionDefault(at({ down: RULES.DOWNS, yardLine: 70 }))).toBe(DECISION.FIELD_GOAL)
  })

  it('leaves ordinary downs alone outside the window', () => {
    expect(decisionRequired(at({ down: 1, quarter: 1, clock: 600 }))).toBe(false)
    expect(canFieldGoal(at({ down: 1, quarter: 1, clock: 600 }))).toBe(false)
  })
})
