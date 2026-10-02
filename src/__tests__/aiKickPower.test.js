import { describe, it, expect, beforeEach } from '@jest/globals'
import { beginSpecialTeams, applyKickInput, KICK, ST_PHASE, DECISION_SECONDS } from '../game/specialTeams.js'
import { createRoom, leaveRoom, getRoom } from '../game/roomManager.js'
import { specialTeamsAction } from '../ai/specialTeams.js'
import { createKnowledge, applyEvent } from '../ai/knowledge.js'
import { createTrainingGame, destroyTrainingGame } from '../training/game.js'
import { stepUntil } from '../headless/harness.js'
import { serializeGameState } from '../game/serialization.js'

// ⚠️ THE COMPUTER COULD NOT KICK AT ALL, AND TWICE THE SUSPECT WAS THE POWER METER.
//
// Reported as "the AI punts 22 yards", then as "still punting at the minimum" after a fix aimed
// squarely at the meter. The second report is the one that mattered: 22 yards is PUNT_FLOOR_MAX, the
// distance a punt travels at zero power, and scripts/kickLab.mjs showed the ball being struck at
// full-meter-minus-one-complete-drain on every single kick. The AI was firing NOTHING.
//
// The cause was in its knowledge, not in the kicking game: `decision` is cleared only by a
// `game_state`, and resolving the 4th-down menu into a punt or field goal sends a
// `special_teams_update` instead. So the answered menu stayed open and every wake-up for the rest of
// the kick re-answered it. Field goals were 0 for 20 from 37 and 49 yards for the same reason.
const ROOM = 'aikick'

function stateWith(kickingSlot) {
  return {
    roomId: ROOM, phase: 'pre_snap', direction: 1, yardLine: 35, down: 4, distance: 7,
    possession: kickingSlot, score: [0, 0], specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('a computer seat commits its strike; a human seat works the meter', () => {
  // Each case needs its own room with its own seat holder; leaveRoom clears the previous one.
  beforeEach(() => { leaveRoom('ai:aikick:0'); leaveRoom('socket-human-0') })

  it('honours power, aim and backspin from an AI seat in one input', () => {
    expect(createRoom(ROOM, 'ai:aikick:0', { solo: true })).toBeTruthy()
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.1          // as if the meter had drained away
    expect(applyKickInput(state, 0, { power: 0.82, angle: -0.4, backspin: true })).toBe(true)
    expect(state.specialTeams.power).toBeCloseTo(0.82, 2)
    expect(state.specialTeams.angle).toBeCloseTo(-0.4, 2)
    expect(state.specialTeams.backspin).toBe(true)
    // ⚠️ AND THE DRAIN MUST NOT UNDO IT — kickClock checks this flag. Without it we are straight back
    // to a 22-yard punt with the committed power sitting unused in the state.
    expect(state.specialTeams.__aiPowerSet).toBe(true)
    expect(state.specialTeams.started).toBe(true)
  })

  // ⚠️ ENFORCED ON THE SERVER, NOT TRUSTED TO THE CLIENT. The meter is the whole of the kicking game
  // for a player; a client that could name its own power or aim would skip it.
  it('refuses a stated power and aim from a human seat', () => {
    createRoom(ROOM, 'socket-human-0', {})
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.1
    applyKickInput(state, 0, { power: 0.95, angle: 0.9 })
    expect(state.specialTeams.power).toBeCloseTo(0.1, 2)
    expect(state.specialTeams.angle).toBeCloseTo(0, 2)
  })

  it('still lets a human tap for power the ordinary way', () => {
    createRoom(ROOM, 'socket-human-0', {})
    const state = stateWith(0)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.power = 0.5
    expect(applyKickInput(state, 0, { aim: 'right' })).toBe(true)
    expect(state.specialTeams.power).toBeGreaterThan(0.5)
  })
})

describe('what the computer commits to', () => {
  const kickView = (over = {}) => ({
    specialTeams: { kicking: true, phase: ST_PHASE.SETUP, kickType: KICK.PUNT, angle: 0, targetAngle: 0, ...over },
    yardLine: 35, aiKick: null,
  })

  // ⚠️ NOT A PERFECT METER. 100% every time is as wrong as 9% and more annoying: a human reached 75%
  // in a real game, so a computer pinned at full would out-kick every player every time.
  it('punts well short of perfect, with real spread', () => {
    const powers = []
    let r = 0
    const rng = () => ((r = (r * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
    for (let i = 0; i < 40; i++) {
      const action = specialTeamsAction(kickView(), rng)
      powers.push(action?.payload?.power)
    }
    expect(powers.filter(p => typeof p === 'number').length).toBe(40)
    const mean = powers.reduce((a, b) => a + b, 0) / powers.length
    expect(mean).toBeGreaterThan(0.7)
    expect(mean).toBeLessThan(0.92)
    // and it is not the same number every time
    expect(new Set(powers.map(p => p.toFixed(3))).size).toBeGreaterThan(5)
  })

  // ⚠️ ONE STRIKE PER KICK. The old policy returned a tap on every wake-up, which is what tied the
  // kick to the broadcast cadence. Having committed, there is nothing left for it to say.
  it('speaks once and then has nothing to add', () => {
    const k = kickView()
    expect(specialTeamsAction(k, () => 0.5)?.payload).toMatchObject({ power: expect.any(Number) })
    expect(specialTeamsAction(k, () => 0.5)).toBeNull()
  })

  // ⚠️ THE MAKE/MISS INTENT USED TO BE DECIDED AND THEN NEVER EXPRESSED. Rotating to the uprights
  // takes ten taps at AIM_STEP and the AI was firing none, so the aim reached the ball as nought and
  // every band in fieldGoalChance was computed and thrown away.
  it('aims at the uprights when it means to make a field goal', () => {
    const k = kickView({ kickType: KICK.FIELD_GOAL, targetAngle: 0.45, fieldGoalDistance: 30 })
    const action = specialTeamsAction(k, () => 0)      // rng 0 — inside any make chance
    expect(action.payload.angle).toBeCloseTo(0.45, 2)
  })

  it('aims deliberately wide when it means to miss one', () => {
    const k = kickView({ kickType: KICK.FIELD_GOAL, targetAngle: 0.45, fieldGoalDistance: 70 })
    const action = specialTeamsAction(k, () => 0.999)  // rng 1 — outside any make chance
    expect(Math.abs(action.payload.angle - 0.45)).toBeGreaterThan(0.5)
  })

  // The per-kick memory cannot live on the view: see the note in knowledge.js.
  it('keeps its field-goal intent across a view it is handed fresh each frame', () => {
    const k = kickView({ kickType: KICK.FIELD_GOAL, targetAngle: 0.45, fieldGoalDistance: 30 })
    specialTeamsAction(k, () => 0)
    expect(k.aiKick.intent).toBe('make')
    k.specialTeams = { ...k.specialTeams }        // as every special_teams_update does
    expect(k.aiKick.intent).toBe('make')
  })
})

describe('the answered menu closes', () => {
  // THE BUG, stated as a unit: the AI answers the 4th-down menu, the kicking interface comes up, and
  // nothing ever tells its knowledge the menu is gone — so it re-answers it for the whole kick.
  it('a kick on the field clears a decision the AI has already answered', () => {
    const k = createKnowledge({ slot: 1 })
    k.decision = { context: 'fourth_down', options: [{ id: 'punt', legal: true }] }
    applyEvent(k, 'special_teams_update', { kickType: KICK.PUNT, phase: ST_PHASE.SETUP, kicking: true, power: 1, angle: 0 })
    expect(k.decision).toBeNull()
    expect(k.specialTeams).not.toBeNull()
  })
})

// ── End to end, because every unit above passed while the punt was 21 yards ──
//
// The units test the pieces; this tests that the ball goes somewhere. It is the measurement from
// scripts/kickLab.mjs reduced to two kicks: the real menu, the real choice, the real kick clock and
// the real distance curve, with nothing stubbed.
describe('the ball actually travels', () => {
  const puntDistance = (seed) => {
    const ctx = createTrainingGame({ seed })
    try {
      const st = ctx.state
      st.down = 4; st.distance = 12; st.yardLine = 30; st.quarter = 1; st.clock = 200; st.score = [0, 0]
      st.decisionPending = true
      st.decisionTimer = DECISION_SECONDS
      getRoom(ctx.roomId).players.forEach((id, slot) => {
        if (id) ctx.io.to(id).emit('game_state', serializeGameState(st, slot))
      })
      expect(ctx.state.specialTeams?.kickType).toBe(KICK.PUNT)
      let last = null
      const ticks = stepUntil(ctx.roomId, ctx.io, s => !s.specialTeams || s.specialTeams.result, {
        maxTicks: 400,
        onTick: (s) => { if (s.specialTeams?.result) last = s.specialTeams.result },
      })
      return { distance: last?.distance ?? null, ticks }
    } finally { destroyTrainingGame(ctx) }
  }

  // 22 yards is the floor of the distance curve — what a punt travels at no power at all. Anything
  // near it means the computer never touched the kick.
  it.each([7701, 7714])('punts past the floor of the curve (seed %i)', (seed) => {
    const { distance } = puntDistance(seed)
    expect(distance).not.toBeNull()
    expect(distance).toBeGreaterThan(28)
  })

  // ⚠️ AND IT KICKS WHEN IT IS ASKED TO, NOT FIVE SECONDS LATER. The AI's first chance to act
  // arrives inside the call that answered the menu, where the re-entrancy guard swallows it. Miss
  // that one and its next wake-up is KICK_INACTIVITY_SECONDS later, when the engine starts the meter
  // on its behalf -- so the kick still goes, and every one takes eight and a half seconds of real
  // time with nothing happening on screen. The timer itself is 3.5s, so 100 ticks (5s) is clear of
  // one and well short of the other.
  it('does not idle out the inactivity timer first', () => {
    expect(puntDistance(7701).ticks).toBeLessThan(100)
  })
})
