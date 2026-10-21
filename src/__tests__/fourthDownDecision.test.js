import { describe, it, expect } from '@jest/globals'
import { fourthDownChoice } from '../ai/specialTeams.js'
import {
  DECISION, DECISION_SECONDS,
  canFieldGoal, canPunt, isDecisionLegal, decisionDefault, decisionRequired,
  serializeDecision,
} from '../game/specialTeams.js'
import { resolveDecision } from '../game/eventQueue.js'
import { runDecisionClock } from '../game/systems/decisionClock.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

function mockIo() {
  return { to() { return { emit() {} } } }
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}

// ── [4] Legality by field position ───────────────────────────────────────────────

describe('field-goal legality — only past midfield', () => {
  it('is illegal at or before midfield, legal once crossed', () => {
    expect(canFieldGoal({ down: 4, yardLine: 49 })).toBe(false)
    expect(canFieldGoal({ down: 4, yardLine: 50 })).toBe(false)   // AT midfield ≠ crossed
    expect(canFieldGoal({ down: 4, yardLine: 51 })).toBe(true)
    expect(canFieldGoal({ down: 4, yardLine: 80 })).toBe(true)
  })
  it('is only a 4th-down option', () => {
    expect(canFieldGoal({ down: 3, yardLine: 80 })).toBe(false)
  })
})

describe('punt legality — unavailable at the opponent 35 and in', () => {
  it('is legal in your own territory, illegal from the opponent 35 (yardLine 65)+', () => {
    expect(canPunt({ down: 4, yardLine: 20 })).toBe(true)
    expect(canPunt({ down: 4, yardLine: 64 })).toBe(true)
    expect(canPunt({ down: 4, yardLine: 65 })).toBe(false)
    expect(canPunt({ down: 4, yardLine: 80 })).toBe(false)
  })
})

describe('go for it / option legality', () => {
  it('Go For It is always legal on 4th down', () => {
    expect(isDecisionLegal({ down: 4, yardLine: 5 }, DECISION.GO_FOR_IT)).toBe(true)
    expect(isDecisionLegal({ down: 4, yardLine: 95 }, DECISION.GO_FOR_IT)).toBe(true)
  })
  it('rejects an unknown option', () => {
    expect(isDecisionLegal({ down: 4, yardLine: 50 }, 'kneel')).toBe(false)
  })
})

describe('auto-pick default', () => {
  it('punts from your own end / midfield', () => {
    expect(decisionDefault({ down: 4, yardLine: 20 })).toBe(DECISION.PUNT)
    expect(decisionDefault({ down: 4, yardLine: 60 })).toBe(DECISION.PUNT)   // both legal → punt
  })
  it('kicks the field goal once punting is off the table (opponent 35+)', () => {
    expect(decisionDefault({ down: 4, yardLine: 70 })).toBe(DECISION.FIELD_GOAL)
  })
})

describe('decisionRequired', () => {
  it('only on a pre-snap 4th down that is not already a kick', () => {
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 4, specialTeams: null })).toBe(true)
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 3, specialTeams: null })).toBe(false)
    expect(decisionRequired({ phase: PHASE.LIVE, down: 4, specialTeams: null })).toBe(false)
    expect(decisionRequired({ phase: PHASE.PRE_SNAP, down: 4, specialTeams: {} })).toBe(false)
  })
})

// ── [2][3] The menu the offense sees ─────────────────────────────────────────────

describe('serializeDecision', () => {
  it('returns null when no decision is pending', () => {
    expect(serializeDecision({ decisionPending: false }, 0)).toBeNull()
  })
  it('is shown only to the offense, with viewer-relative legality and a countdown', () => {
    const state = { decisionPending: true, decisionTimer: 4.2, possession: 0, down: 4, yardLine: 70 }
    expect(serializeDecision(state, 1)).toBeNull()   // defense doesn't choose
    const menu = serializeDecision(state, 0)
    expect(menu.context).toBe('fourth_down')
    expect(menu.secondsRemaining).toBe(5)            // ceil(4.2)
    expect(menu.defaultOption).toBe(DECISION.FIELD_GOAL)   // yardLine 70: punt illegal, FG legal
    const legal = Object.fromEntries(menu.options.map(o => [o.id, o.legal]))
    expect(legal[DECISION.GO_FOR_IT]).toBe(true)
    expect(legal[DECISION.PUNT]).toBe(false)
    expect(legal[DECISION.FIELD_GOAL]).toBe(true)
  })
})

// ── Resolving the choice (server-authoritative routing) ──────────────────────────

function decisionState(roomId, { yardLine = 30, possession = 0 } = {}) {
  return {
    roomId, phase: PHASE.PRE_SNAP, direction: 1, yardLine, down: 4, distance: 10,
    possession, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    decisionPending: true, decisionTimer: DECISION_SECONDS,
    interceptionReturn: false, tackleEnqueued: false, specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('resolveDecision — routes the choice into the kicking engine', () => {
  it('Punt clears the menu and brings up the punt kicking interface', () => {
    const roomId = 'dec-punt'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    resolveDecision(state, mockIo(), DECISION.PUNT)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams?.kickType).toBe('punt')
    expect(state.possession).toBe(0)   // not flipped yet — the kick hasn't been struck
  })

  it('Field Goal brings up the field-goal kicking interface', () => {
    const roomId = 'dec-fg'; room(roomId)
    const state = decisionState(roomId, { yardLine: 78 })
    resolveDecision(state, mockIo(), DECISION.FIELD_GOAL)
    expect(state.specialTeams?.kickType).toBe('field_goal')
  })

  it('an illegal option falls back to the default (FG inside own territory → punt)', () => {
    const roomId = 'dec-illegal'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })   // FG illegal here
    resolveDecision(state, mockIo(), DECISION.FIELD_GOAL)
    expect(state.specialTeams?.kickType).toBe('punt')   // fell back to punt (the default)
  })

  it('Go For It just clears the menu (no kick)', () => {
    const roomId = 'dec-go'; room(roomId)
    const state = decisionState(roomId, { yardLine: 45 })
    resolveDecision(state, mockIo(), DECISION.GO_FOR_IT)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams).toBeNull()
    expect(state.possession).toBe(0)
  })
})

describe('runDecisionClock — auto-pick on timeout', () => {
  it('counts down and auto-selects the default at zero (→ kicking interface)', () => {
    const roomId = 'dec-timer'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    state.decisionTimer = 0.04
    runDecisionClock(state, mockIo(), 0.05)   // ticks below zero → auto-pick (punt)
    expect(state.decisionPending).toBe(false)
    expect(state.specialTeams?.kickType).toBe('punt')
  })
  it('does nothing while time remains', () => {
    const roomId = 'dec-timer2'; room(roomId)
    const state = decisionState(roomId, { yardLine: 30 })
    state.decisionTimer = 3
    runDecisionClock(state, mockIo(), 0.05)
    expect(state.decisionPending).toBe(true)
    expect(state.decisionTimer).toBeCloseTo(2.95)
  })
})

// ── Fourth and inches ([4th down]) ────────────────────────────────────────
//
// ⚠️ "THE GAME SHOULD NEVER PUNT ON 4TH AND INCHES UNLESS THEY ARE ON THEIR OWN 40 YARD LINE OR
// BELOW, BUT THEY CAN STILL KICK A FIELD GOAL IF IN RANGE AND IF THE SITUATION MAKES SENSE."
//
// It used to punt anywhere short of midfield, so the computer kicked the ball away on 4th and a
// foot from its own 45. A yard is the easiest thing in football to gain; punting concedes the drive
// rather than take it.
// The menu as the engine builds it: punt legal short of the opponent's 35, field goal past midfield.
// ⚠️ THE SCORE IS { offense, defense } — the shape the engine sends (getScoreFor). The old fixtures
// used { own, opp }, which is why the tests passed while the real computer thought every game was tied.
const fourth = (yardLine, distance = 1, { quarter = 2, clock = 600, margin = 0, quarterSeconds = 300 } = {}) => ({
  down: 4, distance, yardLine, quarter, clock, quarterSeconds,
  score: { offense: 14 + margin, defense: 14 },
  decision: {
    context: 'fourth_down',
    fieldGoalDistance: (100 - yardLine) + 17,
    options: [
      { id: 'go_for_it', legal: true },
      { id: 'punt', legal: canPunt({ down: 4, yardLine }) },
      { id: 'field_goal', legal: canFieldGoal({ down: 4, yardLine }) },
    ],
  },
})
const pick = (yardLine, distance, sit) => fourthDownChoice(fourth(yardLine, distance, sit))?.payload?.option

describe('⚠️ FOURTH AND INCHES', () => {
  it('goes for it past the own 40 — never a punt there', () => {
    for (const yl of [41, 45, 50, 60, 70]) expect(pick(yl)).toBe('go_for_it')
  })

  // ⚠️ IT USED TO PUNT ON 4TH AND 1 FROM ITS OWN 25, 38 AND 40. Every analytics model says go: a yard
  // converts about two times in three in the NFL and three in four in this game, and the punt only
  // buys about forty yards of field position.
  it('goes for it from its own end too — the analytics answer', () => {
    for (const yl of [10, 25, 38, 40]) expect(pick(yl)).toBe('go_for_it')
  })

  // ⚠️ AND IT USED TO KICK ON 4TH AND 1 INSIDE THE 23. The yard is worth more than the three points
  // until the scoreboard says otherwise.
  it('takes the yard over a chip-shot field goal in a normal situation', () => {
    expect(pick(85)).toBe('go_for_it')
    expect(pick(78)).toBe('go_for_it')
    expect(pick(70)).toBe('go_for_it')   // a 47-yard attempt
  })

  it('…but kicks it when the field goal is the game', () => {
    // Last snap, down two: three points win it.
    expect(pick(85, 1, { quarter: 4, clock: 4, margin: -2 })).toBe('field_goal')
  })
})

// ── The expected-points model ([4th down analytics]) ───────────────────────────────
describe('fourth down, priced in expected points', () => {
  it('goes for it on 4th and short across the middle of the field', () => {
    expect(pick(50, 3)).toBe('go_for_it')    // 4th and 3 at midfield
    expect(pick(45, 3)).toBe('go_for_it')    // …and from the own 45 (this used to be a punt)
    expect(pick(30, 2)).toBe('go_for_it')    // 4th and 2 at the own 30
  })

  it('goes for it in no man\'s land — too far to kick, too close to punt', () => {
    expect(pick(60, 4)).toBe('go_for_it')    // 4th and 4 at the opponent's 40
    expect(pick(55, 5)).toBe('go_for_it')    // 4th and 5 at the opponent's 45
  })

  it('kicks the field goal on a longer 4th down in range', () => {
    expect(pick(75, 5)).toBe('field_goal')   // 4th and 5 at the 25
    expect(pick(70, 6)).toBe('field_goal')
    expect(pick(80, 10)).toBe('field_goal')
  })

  it('goes for it inside the ten, where failing pins the other side', () => {
    expect(pick(97, 3)).toBe('go_for_it')    // 4th and goal from the 3
    expect(pick(90, 4)).toBe('go_for_it')    // 4th and 4 at the 10
  })

  it('still punts on a long 4th down in its own end', () => {
    expect(pick(45, 6)).toBe('punt')
    expect(pick(30, 10)).toBe('punt')
    expect(pick(10, 2)).toBe('punt')         // 4th and 2 from the own 10: the one short one it kicks
  })

  it('the further to go, the less it goes — never the other way round', () => {
    for (const yl of [30, 45, 50, 60, 75, 90]) {
      let went = true
      for (let togo = 1; togo <= 10 && togo < 100 - yl; togo++) {
        const going = pick(yl, togo) === 'go_for_it'
        if (going) expect(went).toBe(true)
        went = going
      }
    }
  })
})

describe('fourth down, the scoreboard and the clock', () => {
  const lateQ4 = (clock, margin) => ({ quarter: 4, clock, margin })

  it('⚠️ READS THE REAL SCORE — behind late it goes for it where it would punt early', () => {
    expect(pick(30, 8)).toBe('punt')                              // 1st half: punt
    expect(pick(30, 8, lateQ4(60, -4))).toBe('go_for_it')         // 1:00 left, down 4
    expect(pick(30, 8, lateQ4(45, -10))).toBe('go_for_it')        // 0:45 left, down 10
  })

  it('is not desperate with time left — two minutes is a nudge, not a shove', () => {
    expect(pick(10, 10, lateQ4(120, -4))).toBe('punt')
    expect(pick(30, 10, lateQ4(120, -4))).toBe('punt')
  })

  it('kicks the go-ahead field goal late rather than chase the touchdown', () => {
    expect(pick(85, 5, lateQ4(120, -2))).toBe('field_goal')       // 4th and 5 at the 15, down 2
    expect(pick(75, 4, lateQ4(60, 0))).toBe('field_goal')         // tied, a minute left
  })

  it('down four or more late, a field goal does not help — it goes for it', () => {
    expect(pick(75, 4, lateQ4(45, -4))).toBe('go_for_it')
  })

  it('ahead late, it does not hand the other side a short field', () => {
    expect(pick(30, 2)).toBe('go_for_it')
    expect(pick(30, 2, lateQ4(120, 4))).toBe('punt')
  })

  it('on the last snap behind, it never punts the game away', () => {
    expect(pick(30, 10, lateQ4(4, -4))).toBe('go_for_it')
  })

  it('scales "late" by the host\'s quarter length', () => {
    // The same 1:30 is the end of a game of six-minute quarters, and an eighth of a game of
    // three-minute ones — time for another possession.
    expect(pick(30, 8, { quarter: 4, clock: 90, margin: -4, quarterSeconds: 360 })).toBe('go_for_it')
    expect(pick(30, 8, { quarter: 4, clock: 90, margin: -4, quarterSeconds: 180 })).toBe('punt')
  })
})

describe('the conversion after a touchdown reads the real score', () => {
  const conversion = (margin, quarter = 4) => fourthDownChoice({
    quarter, score: { offense: 20 + margin, defense: 20 },
    decision: { context: 'conversion', options: [{ id: 'extra_point', legal: true }, { id: 'two_point', legal: true }] },
  }).payload.option

  it('goes for two down two in the 4th quarter, kicks otherwise', () => {
    expect(conversion(-2)).toBe('two_point')
    expect(conversion(-1)).toBe('two_point')
    expect(conversion(-3)).toBe('extra_point')
    expect(conversion(-2, 2)).toBe('extra_point')
  })
})
