import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame } from '../training/game.js'
import { stepUntil } from '../headless/harness.js'
import { resolveConversion, executeKick, startNextPlay, resolveOnsideChoice, resolveOnsideAttempt } from '../game/eventQueue.js'
import {
  KICK, canChooseOnside, onsideRegion, onsideRecoveryProbability, canAttemptOnsideRecovery, serializeSpecialTeams,
} from '../game/specialTeams.js'
import { serializeGameState } from '../game/serialization.js'
import { snapshotGame, hydrateGame } from '../game/snapshot.js'
import { validateCallTimeout, validateSetOffense } from '../game/validation.js'
import { wantsOnsideKick, onsideRollPosition, fourthDownChoice, specialTeamsAction } from '../ai/specialTeams.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

// [onside] "If you are losing with 1:30 or less in the 4th quarter and you score a touchdown or field goal you
// should have the option to go for an onside kick." The rules below are the user's.

const stub = () => ({ onEvent() {} })

// A game with `slot` having just scored, at the moment of its extra point, in the window.
function atTheTry(ctx, { clock = 60, score = [0, 14], quarter = 4 } = {}) {
  const s = ctx.state
  Object.assign(s, { quarter, clock, score: [...score], phase: PHASE.PRE_SNAP, down: 1, distance: 10, yardLine: 85, conversionPending: true, conversionTimer: 5 })
  return s
}

// Takes the extra point and walks through to the kick-off menu, or to a normal kickoff if there is none.
function kickTheTry(ctx) {
  const s = ctx.state
  resolveConversion(s, ctx.io, 'extra_point')
  s.specialTeams.power = 1
  s.specialTeams.angle = s.specialTeams.targetAngle ?? 0
  executeKick(s, ctx.io)
  expect(s.phase).toBe(PHASE.DEAD)
  startNextPlay(ctx.roomId, ctx.io, { quiet: true })
  if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }
}

function withGame(fn, opts = {}) {
  const ctx = createTrainingGame({ seed: 41, ...opts })
  try { return fn(ctx) } finally {
    if (ctx.state.nextPlayTimer) clearTimeout(ctx.state.nextPlayTimer)
    destroyTrainingGame(ctx)
  }
}

// Both seats silent, so what happens is only what the test does.
const quiet = (fn) => withGame(fn, { controllers: { 0: stub(), 1: stub() } })

function onsideUnderway(ctx, opts) {
  const s = atTheTry(ctx, opts)
  kickTheTry(ctx)
  const kicker = s.possession
  resolveOnsideChoice(s, ctx.io, 'onside_kick')
  s.specialTeams.started = true
  return { s, kicker, receiver: 1 - kicker }
}

describe('[onside] who may', () => {
  const state = (over) => ({ quarter: 4, clock: 90, overtime: null, score: [10, 17], ...over })

  it('only the team still behind, with 1:30 or less left in the 4th', () => {
    expect(canChooseOnside(state({}), 0)).toBe(true)
    expect(canChooseOnside(state({ clock: 1 }), 0)).toBe(true)
    expect(canChooseOnside(state({}), 1)).toBe(false)                     // ahead
    expect(canChooseOnside(state({ score: [17, 17] }), 0)).toBe(false)    // the try tied it
    expect(canChooseOnside(state({ clock: 91 }), 0)).toBe(false)
    expect(canChooseOnside(state({ quarter: 3 }), 0)).toBe(false)
    expect(canChooseOnside(state({ clock: 0 }), 0)).toBe(false)
    expect(canChooseOnside(state({ overtime: { periods: 1 } }), 0)).toBe(false)
  })
})

describe('[onside] the meter', () => {
  it('is 75% green, 20% yellow, 5% red, and green is the middle', () => {
    const count = { green: 0, yellow: 0, red: 0 }
    const N = 10000
    for (let i = 0; i < N; i++) count[onsideRegion((i + 0.5) / N)]++
    expect(count.green / N).toBeCloseTo(0.75, 3)
    expect(count.yellow / N).toBeCloseTo(0.20, 3)
    expect(count.red / N).toBeCloseTo(0.05, 3)
    expect(onsideRegion(0.5)).toBe('green')
    expect(onsideRegion(0)).toBe('red')
    expect(onsideRegion(1)).toBe('red')
  })

  it('green succeeds, yellow is a coin flip, red fails', () => {
    expect(onsideRecoveryProbability('green')).toBe(1)
    expect(onsideRecoveryProbability('yellow')).toBe(0.5)
    expect(onsideRecoveryProbability('red')).toBe(0)
  })

  it('the computer rolls: 75 or less green, 76-95 yellow, 96 and up red', () => {
    const region = (roll) => onsideRegion(onsideRollPosition(roll))
    expect(region(1)).toBe('green')
    expect(region(75)).toBe('green')
    expect(region(76)).toBe('yellow')
    expect(region(95)).toBe('yellow')
    expect(region(96)).toBe('red')
    expect(region(100)).toBe('red')
  })
})

describe('[onside] the computer\'s rules, numbered as given', () => {
  const asks = (over) => wantsOnsideKick({ trailingBy: 7, clock: 60, timeouts: 0, ...over })

  it('1. down 7 or fewer with about 1:30 or less', () => {
    expect(asks({ trailingBy: 7, clock: 90 })).toBe(true)
    expect(asks({ trailingBy: 5, clock: 60 })).toBe(true)
  })
  it('2. down 8 to 14', () => {
    expect(asks({ trailingBy: 8, clock: 85 })).toBe(true)
    expect(asks({ trailingBy: 14, clock: 85, timeouts: 3 })).toBe(true)
  })
  it('3. a defense that has been run over goes onside even when it would otherwise trust it', () => {
    expect(asks({ trailingBy: 2, clock: 80, timeouts: 3 })).toBe(false)
    expect(asks({ trailingBy: 2, clock: 80, timeouts: 3, oppYardsPerPlay: 7.2 })).toBe(true)
  })
  it('5. down 7 with most timeouts and time for a stop kicks normally', () => {
    expect(asks({ trailingBy: 7, clock: 85, timeouts: 3 })).toBe(false)
    expect(asks({ trailingBy: 7, clock: 85, timeouts: 2 })).toBe(false)
    expect(asks({ trailingBy: 7, clock: 85, timeouts: 1 })).toBe(true)
    expect(asks({ trailingBy: 7, clock: 35, timeouts: 3 })).toBe(true)     // no time for the stop
  })
  it('6. down 8 or more under a minute always goes, whatever the form', () => {
    expect(asks({ trailingBy: 8, clock: 59, timeouts: 3, ownYardsPerPlay: 8, oppYardsPerPlay: 3 })).toBe(true)
  })
  it('7. a hot offense and a stout defense with time left kick normally', () => {
    const form = { ownYardsPerPlay: 7, oppYardsPerPlay: 4, clock: 85, timeouts: 3 }
    expect(asks({ ...form, trailingBy: 10 })).toBe(false)
    expect(asks({ ...form, trailingBy: 10, ownYardsPerPlay: 5 })).toBe(true)
    expect(asks({ ...form, trailingBy: 10, oppYardsPerPlay: 5 })).toBe(true)
  })
  it('8. down 3 or fewer only when a stop would come too late', () => {
    expect(asks({ trailingBy: 3, clock: 85, timeouts: 3 })).toBe(false)
    expect(asks({ trailingBy: 1, clock: 25, timeouts: 3 })).toBe(true)
    expect(asks({ trailingBy: 3, clock: 60, timeouts: 0 })).toBe(true)
  })
  it('never when not behind', () => {
    expect(asks({ trailingBy: 0 })).toBe(false)
    expect(asks({ trailingBy: -3 })).toBe(false)
  })
})

describe('[onside] the kick-off menu', () => {
  it('opens for the scoring team after a try that leaves them behind, and holds their ball', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 0; s.score[1 - kicker] = 14
    ctx.io.clear()
    kickTheTry(ctx)
    expect(s.onsideChoicePending).toBe(true)
    expect(s.possession).toBe(kicker)
    expect(s.phase).toBe(PHASE.PRE_SNAP)
    expect(ctx.io.of('switch_sides')).toHaveLength(0)

    const d = serializeGameState(s, kicker).decision
    expect(d).toMatchObject({ context: 'onside', defaultOption: 'kickoff' })
    expect(d.options.map(o => o.id)).toEqual(['kickoff', 'onside_kick'])
    // The other team is not shown it.
    expect(serializeGameState(s, 1 - kicker).decision).toBeNull()
  }))

  it('does not open for a try that ties it or takes the lead', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 13; s.score[1 - kicker] = 13
    kickTheTry(ctx)
    expect(s.onsideChoicePending).toBe(false)
    expect(s.possession).toBe(1 - kicker)
  }))

  it('a normal kickoff goes to the other team at their 30, with one role swap', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 0; s.score[1 - kicker] = 14
    kickTheTry(ctx)
    ctx.io.clear()
    resolveOnsideChoice(s, ctx.io, 'kickoff')
    expect(s.onsideChoicePending).toBe(false)
    expect(s.possession).toBe(1 - kicker)
    expect(s.yardLine).toBe(RULES.KICKOFF_RESULT_YARD_LINE)
    expect(s.specialTeams.kickType).toBe(KICK.KICKOFF)
    expect(ctx.io.of('switch_sides').length).toBe(2)     // one each, so one swap
  }))

  it('nobody answering is a normal kickoff when the five seconds run out', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 0; s.score[1 - kicker] = 14
    kickTheTry(ctx)
    expect(s.onsideChoiceTimer).toBe(RULES.ONSIDE_CHOICE_SECONDS)
    const ticks = stepUntil(ctx.roomId, ctx.io, st => !st.onsideChoicePending, { maxTicks: 400 })
    expect(ticks).toBeGreaterThan(0)
    expect(s.possession).toBe(1 - kicker)
  }))

  it('holds the game: no set, no timeout, no clock while it is up', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 0; s.score[1 - kicker] = 14
    kickTheTry(ctx)
    expect(validateCallTimeout(ctx.seats[kicker])).toMatch(/kickoff/)
    expect(validateSetOffense(ctx.seats[kicker], { formation: [], players: [] })).toBeTruthy()
    const clock = s.clock
    const playClock = s.playClock
    stepUntil(ctx.roomId, ctx.io, (_st, i) => i >= 20, { maxTicks: 21 })
    expect(s.clock).toBe(clock)
    expect(s.playClock).toBe(playClock)
  }))

  it('survives a save and a load', () => quiet((ctx) => {
    const s = atTheTry(ctx)
    const kicker = s.possession
    s.score[kicker] = 0; s.score[1 - kicker] = 14
    kickTheTry(ctx)
    const json = snapshotGame(s)
    const other = createTrainingGame({ seed: 42, controllers: { 0: stub(), 1: stub() } })
    try {
      expect(hydrateGame(other.state, json)).toBe(true)
      expect(other.state.onsideChoicePending).toBe(true)
      expect(other.state.possession).toBe(kicker)
      expect(serializeGameState(other.state, kicker).decision?.context).toBe('onside')
    } finally { destroyTrainingGame(other) }
  }))
})

describe('[onside] the kick', () => {
  const onside = (ctx) => {
    const s = ctx.state
    const kicker = s.possession
    const opts = { score: kicker === 0 ? [0, 14] : [14, 0] }
    return onsideUnderway(ctx, opts)
  }

  it('a tap in the green is the receiving team\'s ball at the 50', () => quiet((ctx) => {
    const { s, kicker, receiver } = onside(ctx)
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    expect(s.specialTeams.blockAttempted).toBe(true)
    // Nothing is settled, or shown, until the kick is away.
    expect(s.possession).toBe(kicker)
    expect(JSON.stringify(serializeSpecialTeams(s, kicker))).not.toMatch(/onsideRecovered/)
    ctx.io.clear()
    executeKick(s, ctx.io)
    expect(s.possession).toBe(receiver)
    expect(s.yardLine).toBe(RULES.ONSIDE_RECOVERY_YARD_LINE)
    expect(s.down).toBe(1)
    expect(s.distance).toBe(RULES.FIRST_DOWN_YARDS)
    expect(s.phase).toBe(PHASE.DEAD)
    expect(ctx.io.last('play_result').payload).toMatchObject({ outcome: 'onside_kick', detail: 'receiving_team' })
    expect(ctx.io.of('switch_sides').length).toBe(2)
  }))

  it('a tap in the red is the kicking team\'s ball at the 50', () => quiet((ctx) => {
    const { s, kicker, receiver } = onside(ctx)
    ctx.seats[receiver].fire('onside_recovery', { position: 0.99 })
    ctx.io.clear()
    executeKick(s, ctx.io)
    expect(s.possession).toBe(kicker)
    expect(s.yardLine).toBe(RULES.ONSIDE_RECOVERY_YARD_LINE)
    expect(ctx.io.last('play_result').payload).toMatchObject({ outcome: 'onside_kick', detail: 'kicking_team' })
  }))

  it('no tap at all is the kicking team\'s ball', () => quiet((ctx) => {
    const { s, kicker } = onside(ctx)
    executeKick(s, ctx.io)
    expect(s.possession).toBe(kicker)
    expect(s.yardLine).toBe(RULES.ONSIDE_RECOVERY_YARD_LINE)
  }))

  it('yellow is decided by the server\'s coin', () => quiet((ctx) => {
    const { s } = onside(ctx)
    resolveOnsideAttempt(s, ctx.io, 0.5 + 0.42, () => 0.49)
    expect(s.specialTeams.onsideRecovered).toBe(true)
    s.specialTeams.blockAttempted = false
    resolveOnsideAttempt(s, ctx.io, 0.5 + 0.42, () => 0.51)
    expect(s.specialTeams.onsideRecovered).toBe(false)
  }))

  it('the kicker\'s meter changes nothing', () => quiet((ctx) => {
    const { s, receiver } = onside(ctx)
    s.specialTeams.power = 0
    s.specialTeams.angle = -1
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    executeKick(s, ctx.io)
    expect(s.possession).toBe(receiver)
    expect(s.yardLine).toBe(RULES.ONSIDE_RECOVERY_YARD_LINE)
  }))

  it('one tap, by the receiving team, once the kick is under way', () => quiet((ctx) => {
    const { s, kicker, receiver } = onside(ctx)
    expect(canAttemptOnsideRecovery(s, kicker)).toBe(false)
    ctx.seats[kicker].fire('onside_recovery', { position: 0.5 })
    expect(s.specialTeams.blockAttempted).toBe(false)

    s.specialTeams.started = false
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    expect(s.specialTeams.blockAttempted).toBe(false)
    s.specialTeams.started = true

    ctx.seats[receiver].fire('onside_recovery', { position: 0.99 })
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    expect(s.specialTeams.onsideRecovered).toBe(false)     // the first tap stands
  }))

  it('the kick fires when the kicker\'s timer runs out, and the next play is a fresh drive', () => quiet((ctx) => {
    const { s, receiver } = onside(ctx)
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    const ticks = stepUntil(ctx.roomId, ctx.io, st => st.phase === PHASE.DEAD, { maxTicks: 200 })
    expect(ticks).toBeGreaterThan(0)
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).toBe(PHASE.PRE_SNAP)
    expect(s.specialTeams).toBeNull()
    expect(s.newDrive).toBe(true)
    expect(s.yardLine).toBe(RULES.ONSIDE_RECOVERY_YARD_LINE)
  }))
})

// ⚠️ THROUGH THE REAL BRAIN, ON WHAT THE SERVER REALLY SENDS. Twice now a computer special-teams decision has read
// a field nobody sends (the punt menu, the field-goal block) and every unit test passed, because the tests handed
// it the field. So here it hears the game the way it does in a real room.
describe('[onside] the computer, through the real messages', () => {
  it('answers the menu with what its rules say', () => {
    const answers = {}
    for (const [name, score, clock, timeouts] of [
      ['two scores, late', 8, 50, 3],
      ['down seven with timeouts', 7, 85, 3],
    ]) {
      withGame((ctx) => {
        const s = ctx.state
        const kicker = s.possession
        Object.assign(s, { quarter: 4, clock, phase: PHASE.PRE_SNAP, down: 1, distance: 10, yardLine: 35, onsideChoicePending: true, onsideChoiceTimer: 5 })
        s.score[kicker] = 0; s.score[1 - kicker] = score
        s.timeouts = [timeouts, timeouts]
        ctx.brains[kicker].onEvent('game_state', serializeGameState(s, kicker))
        answers[name] = s.specialTeams?.kickType === KICK.ONSIDE ? 'onside' : (s.onsideChoicePending ? 'nothing' : 'kickoff')
      })
    }
    expect(answers).toEqual({ 'two scores, late': 'onside', 'down seven with timeouts': 'kickoff' })
  })

  // 75 + half of 20: the receiving computer should come up with it about 85% of the time.
  it('rolls for the recovery once, as soon as a human kicker starts, and comes up with it about 85% of the time', () => {
    const KICKS = 400
    let recovered = 0
    for (let seed = 0; seed < KICKS; seed++) {
      withGame((ctx) => {
        const s = ctx.state
        const kicker = s.possession
        ctx.seats[kicker].emit = () => {}
        const score = kicker === 0 ? [0, 14] : [14, 0]
        Object.assign(s, { quarter: 4, clock: 60, score, phase: PHASE.PRE_SNAP, down: 1, distance: 10, yardLine: 35, onsideChoicePending: true, onsideChoiceTimer: 5 })
        resolveOnsideChoice(s, ctx.io, 'onside_kick')
        expect(s.specialTeams.blockAttempted).toBe(false)     // not before the kick is under way
        ctx.seats[kicker].fire('special_teams_input', { aim: 'left' })
        expect(s.specialTeams.blockAttempted).toBe(true)
        if (s.specialTeams.onsideRecovered) recovered++
      }, { seed: 500 + seed })
    }
    expect(recovered / KICKS).toBeGreaterThan(0.79)
    expect(recovered / KICKS).toBeLessThan(0.91)
  })

  it('a computer kicker has the ball away a few seconds after choosing, with the human still able to tap', () => withGame((ctx) => {
    const s = ctx.state
    const kicker = s.possession
    const receiver = 1 - kicker
    ctx.seats[receiver].emit = () => {}
    const score = kicker === 0 ? [0, 14] : [14, 0]
    Object.assign(s, { quarter: 4, clock: 50, score, phase: PHASE.PRE_SNAP, down: 1, distance: 10, yardLine: 35, onsideChoicePending: true, onsideChoiceTimer: 5 })
    ctx.brains[kicker].onEvent('game_state', serializeGameState(s, kicker))
    expect(s.specialTeams?.kickType).toBe(KICK.ONSIDE)
    expect(s.specialTeams.started).toBe(true)              // the computer commits at once
    expect(canAttemptOnsideRecovery(s, receiver)).toBe(true)
    ctx.seats[receiver].fire('onside_recovery', { position: 0.5 })
    const ticks = stepUntil(ctx.roomId, ctx.io, st => st.phase === PHASE.DEAD, { maxTicks: 200 })
    expect(ticks).toBeGreaterThan(40)
    expect(s.possession).toBe(receiver)
  }))
})

describe('[onside] plain policy checks', () => {
  it('the menu answer is one of the menu\'s options', () => {
    const k = {
      slot: 0, score: { own: 0, opp: 14 }, quarter: 4, clock: 40, timeouts: { own: 0, opp: 0 },
      decision: { context: 'onside', options: [{ id: 'kickoff', legal: true }, { id: 'onside_kick', legal: true }], form: { ownYardsPerPlay: null, oppYardsPerPlay: null } },
    }
    const action = fourthDownChoice(k, () => 0.5)
    expect(action.event).toBe('special_teams_choice')
    expect(['kickoff', 'onside_kick']).toContain(action.payload.option)
  })

  it('the kicking computer states a strike, and the aim is straight', () => {
    const k = { aiKick: null, yardLine: 35, specialTeams: { kicking: true, kickType: KICK.ONSIDE, phase: 'setup', targetAngle: 0 } }
    const action = specialTeamsAction(k, () => 0.5)
    expect(action.event).toBe('special_teams_input')
    expect(action.payload.angle).toBe(0)
  })
})
