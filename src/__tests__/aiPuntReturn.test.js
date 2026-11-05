import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame, applySituation } from '../training/game.js'
import { beginSpecialTeams, serializeSpecialTeams, KICK, ST_PHASE } from '../game/specialTeams.js'
import { RULES } from '../constants.js'

// [punt roll] "It should let it bounce when it thinks it will be a touchback. In other words it should take the
// decision that it thinks will result in the most yards."
//
// ⚠️ THROUGH THE REAL BRAIN, WITH THE REAL PAYLOAD. The bug here was a contract one: the computer read
// field names the server never sends, so a test handing it a hand-made object would have passed all along.
// So the server serializes exactly what a seat would receive, the seat's own controller reads it, and the
// answer comes back through the same socket handler a phone uses.

function puntAtTheComputer(landing, { backspin = false, seed = 77 } = {}) {
  const ctx = createTrainingGame({ seed, difficulty: 'medium' })
  const { state } = ctx
  applySituation(state, { possession: 0, down: 4, distance: 10, yardLine: 100 - landing - 40 })
  beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
  const st = state.specialTeams
  st.phase = ST_PHASE.KICKING
  st.backspin = backspin
  st.result = {
    kickType: KICK.PUNT, distance: 40, hangTime: 3, backspin, outOfBounds: false, touchback: false, airTouchback: false,
    previewLandingYardLine: landing, landingYardLine: landing, landingX: 26,
  }
  st.returnPending = true
  st.returnTimer = 5
  return ctx
}

// Slot 1 is told what the server would tell it, and that is the only thing that happens.
function deliverToReceiver(ctx) {
  ctx.brains[1].onEvent('special_teams_update', serializeSpecialTeams(ctx.state, 1))
}

const lastResult = (ctx) => ctx.io.of('play_result').at(-1)?.payload

describe('[punt roll] the computer receiving a punt', () => {
  it('⚠️ IT ANSWERS: no five-second wait, and never the fair catch it used to fall into', () => {
    for (const landing of [9, 20, 35, 60]) {
      const ctx = puntAtTheComputer(landing)
      try {
        deliverToReceiver(ctx)
        expect(ctx.state.specialTeams?.returnPending ?? false).toBe(false)
        expect(lastResult(ctx)?.detail).not.toBe('fair_catch')
      } finally { destroyTrainingGame(ctx) }
    }
  })

  it('⚠️ A CERTAIN TOUCHBACK IS LEFT ALONE, and it takes the ball at the 20', () => {
    for (const landing of [3, 9, 11, 12]) {
      const ctx = puntAtTheComputer(landing)
      try {
        deliverToReceiver(ctx)
        expect(lastResult(ctx).detail).toBe('touchback')
        expect(ctx.state.yardLine).toBe(RULES.TOUCHBACK_YARD_LINE)
        expect(ctx.state.possession).toBe(1)
      } finally { destroyTrainingGame(ctx) }
    }
  })

  it('⚠️ A LIKELY TOUCHBACK IS LEFT ALONE TOO, and sometimes the bet does not come in', () => {
    const outcomes = new Set()
    for (let seed = 1; seed <= 60; seed++) {
      const ctx = puntAtTheComputer(13, { seed })
      try {
        deliverToReceiver(ctx)
        const { detail } = lastResult(ctx)
        // Never fielded: a touchback, or downed where the roll stopped. `detail` is null for the second.
        expect(['touchback', null]).toContain(detail)
        outcomes.add(detail)
      } finally { destroyTrainingGame(ctx) }
    }
    expect(outcomes.has('touchback')).toBe(true)
    expect(outcomes.has(null)).toBe(true)
  })

  it('with backspin on it, very deep, it still plays for the touchback', () => {
    const ctx = puntAtTheComputer(1, { backspin: true })
    try {
      deliverToReceiver(ctx)
      expect(['touchback', null]).toContain(lastResult(ctx).detail)
    } finally { destroyTrainingGame(ctx) }
  })

  it('⚠️ ANYTHING ELSE IS FIELDED AND RUN BACK', () => {
    let returned = 0
    for (let seed = 1; seed <= 40; seed++) {
      const ctx = puntAtTheComputer(30, { seed })
      try {
        deliverToReceiver(ctx)
        const detail = lastResult(ctx)?.detail
        // A return can go wrong at the catch, or take it all the way. It is never a bounce or a fair catch.
        expect(['touchback', 'fair_catch', null]).not.toContain(detail)
        if (detail === 'return') returned++
      } finally { destroyTrainingGame(ctx) }
    }
    expect(returned).toBeGreaterThan(30)
  })

  it('a backspin ball that will sit down short of a touchback is fielded', () => {
    const ctx = puntAtTheComputer(6, { backspin: true })
    try {
      deliverToReceiver(ctx)
      expect(['touchback', 'fair_catch']).not.toContain(lastResult(ctx)?.detail)
    } finally { destroyTrainingGame(ctx) }
  })
})
