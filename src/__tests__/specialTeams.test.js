import { describe, it, expect } from '@jest/globals'
import {
  KICK, ST_PHASE, KICK_CONFIG,
  getKickConfig, isValidKickType,
  beginSpecialTeams, isSpecialTeamsActive, advanceSTPhase, canSTTransition,
  applyKickInput, endSpecialTeams, serializeSpecialTeams,
} from '../game/specialTeams.js'
import { RULES } from '../constants.js'

// [Special Teams][1] The unified kicking-engine foundation: state container, config registry,
// sub-phase machine, server-authoritative input, and serialization.

function freshState(possession = 0) {
  return { possession, specialTeams: null }
}

describe('kick config', () => {
  it('has a config for all four kick kinds', () => {
    expect(Object.keys(KICK_CONFIG).sort()).toEqual(
      [KICK.KICKOFF, KICK.PUNT, KICK.FIELD_GOAL, KICK.EXTRA_POINT].sort(),
    )
  })

  it('field goal and extra point score points; kickoff and punt do not', () => {
    expect(getKickConfig(KICK.FIELD_GOAL).points).toBe(RULES.FG_POINTS)
    expect(getKickConfig(KICK.EXTRA_POINT).points).toBe(RULES.XP_POINTS)
    expect(getKickConfig(KICK.KICKOFF).points).toBe(0)
    expect(getKickConfig(KICK.PUNT).points).toBe(0)
  })

  it('kickoffs/punts are returnable & contested; FG/XP are not', () => {
    expect(getKickConfig(KICK.KICKOFF).returnable).toBe(true)
    expect(getKickConfig(KICK.PUNT).contested).toBe(true)
    expect(getKickConfig(KICK.FIELD_GOAL).returnable).toBe(false)
    expect(getKickConfig(KICK.EXTRA_POINT).contested).toBe(false)
  })

  it('validates kick types', () => {
    expect(isValidKickType(KICK.PUNT)).toBe(true)
    expect(isValidKickType('bunt')).toBe(false)
    expect(getKickConfig('bunt')).toBeNull()
  })
})

describe('lifecycle', () => {
  it('begins a special-teams play in SETUP, defaulting the kicking team to possession', () => {
    const state = freshState(1)
    expect(isSpecialTeamsActive(state)).toBe(false)

    const st = beginSpecialTeams(state, KICK.FIELD_GOAL)
    expect(isSpecialTeamsActive(state)).toBe(true)
    expect(st.kickType).toBe(KICK.FIELD_GOAL)
    expect(st.phase).toBe(ST_PHASE.SETUP)
    expect(st.kickingSlot).toBe(1)        // defaulted to possession
    expect(st.angle).toBe(0)              // [7] centered aim
    expect(st.power).toBe(1)              // [7][9] full power meter
    expect(st.started).toBe(false)        // [8] timer not running yet
    expect(st.playerControlled).toBe(true)
    expect(st.result).toBeNull()
  })

  it('lets the caller override the kicking team (e.g. kickoff by the scoring team)', () => {
    const state = freshState(0)
    const st = beginSpecialTeams(state, KICK.KICKOFF, { kickingSlot: 0 })
    expect(st.kickingSlot).toBe(0)
  })

  it('throws on an unknown kick type', () => {
    expect(() => beginSpecialTeams(freshState(), 'bunt')).toThrow()
  })

  it('endSpecialTeams clears the state', () => {
    const state = freshState()
    beginSpecialTeams(state, KICK.PUNT)
    endSpecialTeams(state)
    expect(isSpecialTeamsActive(state)).toBe(false)
    expect(state.specialTeams).toBeNull()
  })
})

describe('sub-phase machine', () => {
  it('allows SETUP → KICKING → RESOLVED, and nothing illegal', () => {
    expect(canSTTransition(ST_PHASE.SETUP, ST_PHASE.KICKING)).toBe(true)
    expect(canSTTransition(ST_PHASE.KICKING, ST_PHASE.RESOLVED)).toBe(true)
    expect(canSTTransition(ST_PHASE.SETUP, ST_PHASE.RESOLVED)).toBe(false)
    expect(canSTTransition(ST_PHASE.RESOLVED, ST_PHASE.SETUP)).toBe(false)
  })

  it('advanceSTPhase walks the kick forward and rejects illegal jumps', () => {
    const state = freshState()
    beginSpecialTeams(state, KICK.KICKOFF)
    advanceSTPhase(state, ST_PHASE.KICKING)
    expect(state.specialTeams.phase).toBe(ST_PHASE.KICKING)
    expect(() => advanceSTPhase(state, ST_PHASE.SETUP)).toThrow()
    advanceSTPhase(state, ST_PHASE.RESOLVED)
    expect(state.specialTeams.phase).toBe(ST_PHASE.RESOLVED)
  })
})

describe('server-authoritative input ([8][11][12][13])', () => {
  it('a directional input rotates the arrow, refills power, and starts the timer', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.power = 0.5   // partially drained so the refill is observable

    expect(state.specialTeams.started).toBe(false)
    expect(applyKickInput(state, 0, { aim: 'right' })).toBe(true)
    expect(state.specialTeams.angle).toBeCloseTo(0.1)    // [12] one step right
    expect(state.specialTeams.power).toBeCloseTo(0.52)   // [10] +2%
    expect(state.specialTeams.started).toBe(true)        // [8] first input starts the timer

    applyKickInput(state, 0, { aim: 'left' })
    expect(state.specialTeams.angle).toBeCloseTo(0)       // back to center
  })

  it('caps the aim at ±30° (normalized ±1)', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    for (let i = 0; i < 20; i++) applyKickInput(state, 0, { aim: 'right' })
    expect(state.specialTeams.angle).toBe(1)              // [13] clamped at the cap
  })

  it('refills power by 2% per input, capped at full', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.3
    applyKickInput(state, 0, { aim: 'left' })
    applyKickInput(state, 0, { aim: 'right' })
    expect(state.specialTeams.power).toBeCloseTo(0.34)    // 0.3 + 2×0.02
    state.specialTeams.power = 0.99
    applyKickInput(state, 0, { aim: 'left' })
    expect(state.specialTeams.power).toBe(1)              // capped
  })

  it('rejects a non-directional / unknown input', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    expect(applyKickInput(state, 0, {})).toBe(false)
    expect(applyKickInput(state, 0, { aim: 'up' })).toBe(false)
  })

  it('[21] toggles punt backspin without touching power/aim or starting the timer', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    expect(applyKickInput(state, 0, { backspin: true })).toBe(true)
    expect(state.specialTeams.backspin).toBe(true)
    expect(state.specialTeams.started).toBe(false)   // backspin is a setup choice, not a timer-starter
    applyKickInput(state, 0, { backspin: false })
    expect(state.specialTeams.backspin).toBe(false)
  })

  it('[21] backspin is rejected on a non-punt kick', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    expect(applyKickInput(state, 0, { backspin: true })).toBe(false)
  })

  it('rejects input from the receiving team', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    expect(applyKickInput(state, 1, { aim: 'left' })).toBe(false)
    expect(state.specialTeams.angle).toBe(0)
  })

  it('rejects input once the kick is away (not in SETUP)', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    advanceSTPhase(state, ST_PHASE.KICKING)
    expect(applyKickInput(state, 0, { aim: 'left' })).toBe(false)
  })

  it('rejects input on an automatic kick (kickoff is not player-controlled)', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.KICKOFF, { kickingSlot: 0 })
    expect(applyKickInput(state, 0, { aim: 'left' })).toBe(false)
  })
})

describe('serialization', () => {
  it('returns null when no kick is active', () => {
    expect(serializeSpecialTeams(freshState(), 0)).toBeNull()
  })

  it('is viewer-relative and reports the kicking-interface state', () => {
    const state = freshState(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    applyKickInput(state, 0, { aim: 'left' })

    const kicker   = serializeSpecialTeams(state, 0)
    const receiver = serializeSpecialTeams(state, 1)
    expect(kicker.kicking).toBe(true)
    expect(receiver.kicking).toBe(false)
    expect(kicker.kickType).toBe(KICK.PUNT)
    expect(kicker.label).toBe('Punt')
    expect(kicker.returnable).toBe(true)
    expect(kicker.playerControlled).toBe(true)
    expect(kicker.angle).toBeCloseTo(-0.1)   // one step left
    expect(kicker.power).toBe(1)             // not yet drained (full, capped)
    expect(kicker.started).toBe(true)
    expect(kicker.phase).toBe(ST_PHASE.SETUP)
  })
})
