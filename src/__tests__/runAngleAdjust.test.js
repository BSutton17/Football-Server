import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { initGame, deleteGame, clearPerPlayDeclarations } from '../game/gameState.js'
import { validateRunAngleAdjust } from '../game/validation.js'
import { PHASE } from '../game/stateMachine.js'

// [run adjust] ⚠️ "FOR RUN PLAYS, OFFENSE CAN MAKE ONE ADJUSTMENT AFTER THE DEFENSE IS SET OR 1
// SECOND BEFORE THE SNAP. THEY CAN CHANGE THE ANGLE OF THE RUN BASED ON THE POSITION OF THE
// DEFENSE. THIS IS ONLY FOR RUN PLAYS."
//
// The offense locks its formation and its run angle BEFORE the defense aligns — so the gap it
// picked was chosen against a defense that had not lined up yet, which is backwards: the lane you
// run is the one the front leaves you. Worth half a yard a carry, measured: 3.77 -> 4.27.

const ROOM = 'run-adj'
const socketOn = (role) => ({ id: 's1', data: { roomId: ROOM, role } })

beforeEach(() => deleteGame(ROOM))
afterEach(() => deleteGame(ROOM))

function setUp({ phase = PHASE.COUNTDOWN, playType = 'run' } = {}) {
  const state = initGame(ROOM, 0)
  state.phase = phase
  state.possession = 0
  state.playDesign = { playType, runAngle: 0, players: [] }
  state.runAngleAdjusted = false
  return state
}

describe('⚠️ ONE LOOK AT THE FRONT, ON A RUN, AFTER IT HAS SHOWN ITS HAND', () => {
  it('allows the offense to change the lane once the defense has set', () => {
    setUp()
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toBeNull()
  })

  it('⚠️ ONCE — it is an adjustment, not a second play call', () => {
    const state = setUp()
    state.runAngleAdjusted = true
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toMatch(/already adjusted/)
  })

  it('⚠️ RUN PLAYS ONLY', () => {
    setUp({ playType: 'pass' })
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toMatch(/only applies to a run/)
  })

  it('an RPO counts — the back still runs a lane', () => {
    setUp({ playType: 'rpo' })
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toBeNull()
  })

  it('⚠️ NOT BEFORE THE OFFENSE HAS SET — there is nothing to react to yet', () => {
    setUp({ phase: PHASE.PRE_SNAP })
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toBeTruthy()
  })

  it('…and not once the ball is live', () => {
    setUp({ phase: PHASE.LIVE })
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 30 })).toBeTruthy()
  })

  it('⚠️ THE DEFENSE MAY NOT TOUCH IT', () => {
    setUp()
    expect(validateRunAngleAdjust(socketOn('defense'), { runAngle: 30 })).toMatch(/Only the offense/)
  })

  it('refuses an angle off the dial', () => {
    setUp()
    expect(validateRunAngleAdjust(socketOn('offense'), { runAngle: 900 })).toBeTruthy()
    expect(validateRunAngleAdjust(socketOn('offense'), {})).toBeTruthy()
  })

  it('the one-per-play record dies with the play', () => {
    const state = setUp()
    state.runAngleAdjusted = true
    clearPerPlayDeclarations(state)
    expect(state.runAngleAdjusted).toBe(false)
  })
})
