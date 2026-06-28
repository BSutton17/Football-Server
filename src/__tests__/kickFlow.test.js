import { describe, it, expect } from '@jest/globals'
import { beginSpecialTeams, applyKickInput, serializeSpecialTeams, KICK, ST_PHASE, KICK_TIMER_SECONDS, PUNT_RETURN,
  fgBlockRegion, fgBlockProbability, FG_BLOCK } from '../game/specialTeams.js'
import { runKickClock } from '../game/systems/kickClock.js'
import { runConversionClock } from '../game/systems/decisionClock.js'
import { runClock } from '../game/systems/clock.js'
import { enqueue, processQueue, EVENT, resolvePuntReturn, resolveFieldGoalBlock, resolveConversion } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [Special Teams][6][7][8][9] The kicking interface: a full power meter that drains over the 3.5s
// timer (started by input or the 5s inactivity window), then the unified engine resolves the kick.

function mockIo() {
  return { to() { return { emit() {} } } }
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}
function kickState(roomId, kickType, { yardLine = 40 } = {}) {
  return {
    roomId, phase: PHASE.PRE_SNAP, direction: 1, yardLine, down: 4, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, tackleEnqueued: false, specialTeams: null,
    offensePlayers: new Map(), defensePlayers: new Map(),
  }
}

describe('[7] kick initialization', () => {
  it('begins with a full power meter, centered aim, and the timer idle', () => {
    const state = kickState('ki', KICK.FIELD_GOAL); room('ki')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    const st = state.specialTeams
    expect(st.power).toBe(1)
    expect(st.angle).toBe(0)
    expect(st.started).toBe(false)
    expect(st.kickTimer).toBeCloseTo(KICK_TIMER_SECONDS)
  })
})

describe('[8] kick timer', () => {
  it('auto-starts the kick after the 5s inactivity window', () => {
    const state = kickState('kt-auto', KICK.FIELD_GOAL); room('kt-auto')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    const st = state.specialTeams
    st.inactivityTimer = 0.04
    runKickClock(state, mockIo(), 0.05)   // inactivity expires → started
    expect(st.started).toBe(true)
    expect(st.power).toBe(1)              // power only drains once started
  })

  it('does not drain power before the kick starts', () => {
    const state = kickState('kt-idle', KICK.PUNT); room('kt-idle')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    runKickClock(state, mockIo(), 0.05)   // still idle (inactivity ticking)
    expect(state.specialTeams.power).toBe(1)
    expect(state.specialTeams.started).toBe(false)
  })
})

describe('[9][10] power meter drains continuously once started, refilled by taps', () => {
  it('halfway through the timer with no taps the meter is ~half full', () => {
    const state = kickState('pm', KICK.PUNT); room('pm')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    const st = state.specialTeams
    st.started = true
    const half = KICK_TIMER_SECONDS / 2
    let elapsed = 0
    while (elapsed < half) { runKickClock(state, mockIo(), 0.05); elapsed += 0.05 }
    expect(st.power).toBeCloseTo(0.5, 1)
    expect(st.phase).toBe(ST_PHASE.SETUP)   // not executed yet
  })

  it('a directional tap fights the drain back up (+2%)', () => {
    const state = kickState('pm-tap', KICK.PUNT); room('pm-tap')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    const st = state.specialTeams
    st.started = true; st.power = 0.5
    applyKickInput(state, 0, { aim: 'right' })
    expect(st.power).toBeCloseTo(0.52)
  })
})

// Execution now fires only when the 3.5s timer expires; we set the timer near zero and tick once.
function fireKick(state) {
  state.specialTeams.started   = true
  state.specialTeams.kickTimer = 0.04
  runKickClock(state, mockIo(), 0.05)
}

// [28] An in-field punt now waits for the receiving team's choice. For tests that just want the punt
// resolved, fire it and (if a menu armed) make the choice. A fixed rng keeps the bounce/return
// deterministic (0.5 → a mid-range, no-touchdown outcome).
function firePunt(state, choice = PUNT_RETURN.LET_IT_BOUNCE, rng = () => 0.5) {
  fireKick(state)
  if (state.specialTeams?.returnPending) resolvePuntReturn(state, mockIo(), choice, rng)
}

describe('[6][8] kick execution', () => {
  it('a short field goal at full power is good → +3 and kickoff', () => {
    const state = kickState('ex-fg-make', KICK.FIELD_GOAL, { yardLine: 90 }); room('ex-fg-make')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 1   // full power, dead center → made
    fireKick(state)
    expect(state.score[0]).toBe(3)
    expect(state.possession).toBe(1)     // kickoff to the other team
    expect(state.yardLine).toBe(30)      // receiving team's own 30 ([5])
  })

  it('a long field goal at low power is no good → turnover at the spot, no points', () => {
    const state = kickState('ex-fg-miss', KICK.FIELD_GOAL, { yardLine: 51 }); room('ex-fg-miss')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.4   // distance ~46 < required 66 → short
    fireKick(state)
    expect(state.score[0]).toBe(0)
    expect(state.possession).toBe(1)
    // [45] opponent takes over at the spot of the kick (holder 7 yds back): 100 − (51 − 7) = 56
    expect(state.yardLine).toBe(56)
  })

  it('[45] a missed field goal from deep in the red zone comes out to the 20', () => {
    const state = kickState('fg-miss-20', KICK.FIELD_GOAL, { yardLine: 95 }); room('fg-miss-20')
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.angle = 1; state.specialTeams.power = 0.2   // hard wide → miss (wide), not short
    fireKick(state)
    expect(state.possession).toBe(1)
    // spot of the kick = 100 − (95 − 7) = 12 → inside the 20 → floored to the own 20
    expect(state.yardLine).toBe(20)
  })

  it('a punt hands possession to the other team downfield', () => {
    const state = kickState('ex-punt', KICK.PUNT, { yardLine: 30 }); room('ex-punt')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.5   // ~47 yd punt
    firePunt(state)
    expect(state.possession).toBe(1)
    expect(state.yardLine).toBeGreaterThan(0)
  })
})

describe('[28][29] punt return decision', () => {
  function inFieldPunt(roomId) {
    const state = kickState(roomId, KICK.PUNT, { yardLine: 30 }); room(roomId)
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.5   // ~47 yd punt, lands in the field
    fireKick(state)
    return state
  }

  it('an in-field punt arms the receiving team menu instead of resolving immediately', () => {
    const state = inFieldPunt('rd-arm')
    expect(state.specialTeams.returnPending).toBe(true)
    expect(state.possession).toBe(0)                    // possession not yet handed over
    // the menu is shown to the RECEIVING team (slot 1), not the kicker (slot 0)
    expect(serializeSpecialTeams(state, 1).returnDecision).not.toBeNull()
    expect(serializeSpecialTeams(state, 0).returnDecision).toBeNull()
  })

  it('[29] a punt that lands in the end zone skips the menu and is an immediate touchback', () => {
    const state = kickState('rd-tb', KICK.PUNT, { yardLine: 65 }); room('rd-tb')   // deep in opp territory
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 1     // booms it into the end zone
    fireKick(state)
    expect(state.specialTeams.returnPending).toBeFalsy()           // no menu — illegal to return
    expect(state.possession).toBe(1)
    expect(state.yardLine).toBe(20)                                // receiving team's own 20
  })

  it('[30] Fair Catch ends the play exactly at the landing spot — no roll, no return', () => {
    const fc = inFieldPunt('rd-fc')
    const airLanding = Math.round(fc.specialTeams.result.previewLandingYardLine)
    resolvePuntReturn(fc, mockIo(), PUNT_RETURN.FAIR_CATCH)
    expect(fc.possession).toBe(1)
    expect(fc.yardLine).toBe(airLanding)                          // exactly the catch spot, no bounce/return
  })

  it('[33] Let It Bounce rolls the ball forward (deeper) past the catch spot', () => {
    const fc = inFieldPunt('rd-lb-fc'); resolvePuntReturn(fc, mockIo(), PUNT_RETURN.FAIR_CATCH)
    const lb = inFieldPunt('rd-lb');    resolvePuntReturn(lb, mockIo(), PUNT_RETURN.LET_IT_BOUNCE, () => 1)  // max roll
    // a forward roll toward the receiving goal → the bounce spot is DEEPER (lower) than the catch
    expect(lb.yardLine).toBeLessThan(fc.yardLine)
  })

  it('[35] a backspin bounce spots the ball shorter than a flat bounce (both effects combine)', () => {
    const flat = inFieldPunt('rd-i-flat')
    resolvePuntReturn(flat, mockIo(), PUNT_RETURN.LET_IT_BOUNCE, () => 0.5)   // 6.5 yd forward roll
    // same punt + rng, but the kicker put backspin on it → the bounce is checked back
    const spin = kickState('rd-i-spin', KICK.PUNT, { yardLine: 30 }); room('rd-i-spin')
    beginSpecialTeams(spin, KICK.PUNT, { kickingSlot: 0 })
    spin.specialTeams.angle = 0; spin.specialTeams.power = 0.5; spin.specialTeams.backspin = true
    fireKick(spin)
    resolvePuntReturn(spin, mockIo(), PUNT_RETURN.LET_IT_BOUNCE, () => 0.5)   // 6.5 − 5.5 = 1.0 yd net
    // backspin pulls the ball back → the receiving team takes over with BETTER field position (higher YL)
    expect(spin.yardLine).toBeGreaterThan(flat.yardLine)
  })

  it('[31] Return advances the ball past the catch spot toward the opponent', () => {
    const ret = inFieldPunt('rd-ret')
    const fc  = inFieldPunt('rd-ret2'); resolvePuntReturn(fc, mockIo(), PUNT_RETURN.FAIR_CATCH)
    resolvePuntReturn(ret, mockIo(), PUNT_RETURN.RETURN, () => 0.5)   // mid return, no TD
    expect(ret.yardLine).toBeGreaterThan(fc.yardLine)             // gained yards on the return
  })

  it('[32][51] a breakaway Return is a punt-return touchdown → +6 and the conversion menu', () => {
    const ret = inFieldPunt('rd-td')
    resolvePuntReturn(ret, mockIo(), PUNT_RETURN.RETURN, () => 0)    // rng→0 forces the TD roll
    expect(ret.score[1]).toBe(6)                                  // receiving team (slot 1) scores 6
    expect(ret.conversionPending).toBe(true)                      // their extra-point / 2-pt try
    expect(ret.possession).toBe(1)                                // scorer keeps the ball for the try
  })

  it('the timer auto-picks the default (Fair Catch) when the menu expires', () => {
    const state = inFieldPunt('rd-timeout')
    state.specialTeams.returnTimer = 0.04
    runKickClock(state, mockIo(), 0.05)                            // timer expires → auto-resolve
    expect(state.specialTeams.returnPending).toBe(false)          // decision made
    expect(state.phase).toBe(PHASE.DEAD)                           // play resolved
    expect(state.possession).toBe(1)
  })
})

describe('[38] punt touchback spotting + drive reset', () => {
  it('an air touchback spots the receiving offense at its own 20 and resets the drive', () => {
    const state = kickState('tb-air', KICK.PUNT, { yardLine: 65 }); room('tb-air')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 1     // booms it into the end zone
    fireKick(state)
    expect(state.possession).toBe(1)        // receiving team takes over
    expect(state.yardLine).toBe(20)         // own 20
    expect(state.down).toBe(1)              // fresh set of downs
    expect(state.distance).toBe(10)
    expect(state.clockStopped).toBe(true)   // clock stops on the change of possession
    expect(state.newDrive).toBe(true)       // → 40s play clock on the first snap of the drive
  })

  it('a bounced punt converted to a touchback ([37]) also spots at the own 20', () => {
    const state = kickState('tb-bounce', KICK.PUNT, { yardLine: 58 }); room('tb-bounce')
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.15  // lands in-field but near the goal
    fireKick(state)
    expect(state.specialTeams.returnPending).toBe(true)           // in-field → menu armed
    resolvePuntReturn(state, mockIo(), PUNT_RETURN.LET_IT_BOUNCE, () => 1)   // max roll → trickles in → TB
    expect(state.possession).toBe(1)
    expect(state.yardLine).toBe(20)
    expect(state.down).toBe(1)
  })
})

describe('[48] field goal block zones', () => {
  it('center is green, mid-bar is yellow, the edges are red', () => {
    expect(fgBlockRegion(0.5)).toBe('green')
    expect(fgBlockRegion(0.3)).toBe('yellow')
    expect(fgBlockRegion(0.7)).toBe('yellow')
    expect(fgBlockRegion(0.05)).toBe('red')
    expect(fgBlockRegion(0.95)).toBe('red')
  })

  it('the bar splits ~3% green / 60% yellow / 37% red', () => {
    expect(FG_BLOCK.GREEN_HALF * 2).toBeCloseTo(0.03)
    expect((FG_BLOCK.YELLOW_HALF - FG_BLOCK.GREEN_HALF) * 2).toBeCloseTo(0.60)
    expect((0.5 - FG_BLOCK.YELLOW_HALF) * 2).toBeCloseTo(0.37)
  })

  it('probabilities: green guaranteed, yellow 5%, red none', () => {
    expect(fgBlockProbability('green')).toBe(1)
    expect(fgBlockProbability('yellow')).toBe(0.05)
    expect(fgBlockProbability('red')).toBe(0)
  })
})

describe('[49][50] field goal block resolution (server-authoritative)', () => {
  function fgSetup(roomId) {
    const state = kickState(roomId, KICK.FIELD_GOAL, { yardLine: 70 }); room(roomId)
    beginSpecialTeams(state, KICK.FIELD_GOAL, { kickingSlot: 0 })
    state.specialTeams.started = true   // [46] the kicker's timer is running
    return state
  }

  it('a green-zone tap blocks it → turnover on downs, play dead', () => {
    const state = fgSetup('fgb-green')
    resolveFieldGoalBlock(state, mockIo(), 0.5, () => 0.99)   // green = guaranteed regardless of roll
    expect(state.specialTeams.blockAttempted).toBe(true)
    expect(state.specialTeams.blocked).toBe(true)
    expect(state.possession).toBe(1)            // ball goes to the defense
    expect(state.phase).toBe(PHASE.DEAD)
  })

  it('a red-zone tap can never block → the kick plays on', () => {
    const state = fgSetup('fgb-red')
    resolveFieldGoalBlock(state, mockIo(), 0.02, () => 0)    // red = 0% even at the best roll
    expect(state.specialTeams.blockAttempted).toBe(true)
    expect(state.specialTeams.blocked).toBe(false)
    expect(state.possession).toBe(0)            // no turnover
    expect(state.phase).toBe(PHASE.PRE_SNAP)    // still aiming
  })

  it('yellow blocks only on a roll under 5%', () => {
    const hit  = fgSetup('fgb-yh'); resolveFieldGoalBlock(hit,  mockIo(), 0.3, () => 0.01)
    const miss = fgSetup('fgb-ym'); resolveFieldGoalBlock(miss, mockIo(), 0.3, () => 0.5)
    expect(hit.possession).toBe(1)
    expect(miss.possession).toBe(0)
  })

  it('only one attempt per kick — a later tap is ignored', () => {
    const state = fgSetup('fgb-once')
    resolveFieldGoalBlock(state, mockIo(), 0.02, () => 0)    // red, consumes the attempt
    resolveFieldGoalBlock(state, mockIo(), 0.5,  () => 0)    // would be a green block, but ignored
    expect(state.possession).toBe(0)
  })
})

describe('[specialists] the kicking team\'s real Punter/Kicker drives the kick', () => {
  function puntSpot(roomId, teams) {
    const state = kickState(roomId, KICK.PUNT, { yardLine: 30 }); room(roomId)
    if (teams) state.teams = teams
    beginSpecialTeams(state, KICK.PUNT, { kickingSlot: 0 })
    state.specialTeams.angle = 0; state.specialTeams.power = 0.5
    firePunt(state, PUNT_RETURN.FAIR_CATCH)   // [30] fair catch → spot is the air landing, isolating the leg
    return state.yardLine   // receiving team's spot (lower = pinned deeper = a longer punt)
  }

  it('a strong-legged punter (DAL Bryan Anger 97) out-punts the default', () => {
    const dal     = puntSpot('sp-dal', ['DAL', 'SEA'])   // punter power 97
    const dflt     = puntSpot('sp-none', null)            // no team → default 75
    expect(dal).toBeLessThan(dflt)
  })
})

describe('[20][51][52] extra point then kickoff — receiving team at its own 30, no return', () => {
  it('a TD → extra point from the opp 25 (centered) → kick → kickoff to the other team at the 30', () => {
    const roomId = 'ko'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 95, down: 1, distance: 5,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0, specialTeams: null,
      interceptionReturn: false, tackleEnqueued: false, ballX: 26,
      conversionPending: false, conversionTimer: 0, twoPointActive: null,
      offensePlayers: new Map([['rb1', { id: 'rb1', label: 'RB', x: 26, y: 111 }]]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1', x: 26, y: 111 })
    processQueue(roomId, state, mockIo())
    expect(state.score[0]).toBe(6)                // [51] six, then the try
    expect(state.conversionPending).toBe(true)

    state.phase = PHASE.PRE_SNAP                   // (beginNextPlay would bring us out of DEAD here)
    // [52] choose the extra point → FG system from the opponent's 25, ball centered
    resolveConversion(state, mockIo(), 'extra_point')
    expect(state.specialTeams.kickType).toBe(KICK.EXTRA_POINT)
    expect(state.yardLine).toBe(75)               // opponent's 25 (own 75)
    expect(state.ballX).toBeCloseTo(53.33 / 2)    // centered, regardless of the TD spot

    // fire the kick → the scoring team kicks off to the other team at their own 30
    state.specialTeams.angle = 0; state.specialTeams.power = 1
    fireKick(state)
    expect(state.possession).toBe(1)              // receiving team is the one that was scored on
    expect(state.yardLine).toBe(30)               // their own 30
    expect(state.specialTeams.kickType).toBe(KICK.KICKOFF)
    expect(state.specialTeams.playerControlled).toBe(false)   // automatic — no input, no return
  })
})

describe('[51][52] extra point & two-point conversion outcomes', () => {
  function tdState(roomId, scoringSlot = 0) {
    room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 98, down: 1, distance: 2,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0, specialTeams: null,
      interceptionReturn: false, tackleEnqueued: false, ballX: 26,
      conversionPending: false, conversionTimer: 0, twoPointActive: null,
      offensePlayers: new Map([['rb1', { id: 'rb1', label: 'RB', x: 26, y: 111 }]]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot, carrierId: 'rb1', x: 26, y: 111 })
    processQueue(roomId, state, mockIo())
    state.phase = PHASE.PRE_SNAP   // (beginNextPlay brings us out of DEAD with the menu up)
    return state
  }

  it('[52] a made extra point adds 1 (7 total)', () => {
    const state = tdState('xp-made')
    resolveConversion(state, mockIo(), 'extra_point')
    state.specialTeams.angle = 0; state.specialTeams.power = 1   // centered, full power → good
    fireKick(state)
    expect(state.score[0]).toBe(7)   // 6 + 1
  })

  it('[55] choosing the 2-pt try snaps from the opponent 3 — a scrimmage play, not a kick', () => {
    const state = tdState('2pt-setup')
    resolveConversion(state, mockIo(), 'two_point')
    expect(state.twoPointActive).toBe(0)
    expect(state.yardLine).toBe(97)           // opponent's 3
    expect(state.distance).toBe(3)            // goal-to-go from the 3
    expect(state.specialTeams).toBeNull()     // normal offensive play flow, no kick
  })

  it('[53] a blocked extra point scores nothing and kicks off (NOT a turnover on downs)', () => {
    const state = tdState('xp-block')
    resolveConversion(state, mockIo(), 'extra_point')
    state.specialTeams.started = true                         // kicker's timer is running
    resolveFieldGoalBlock(state, mockIo(), 0.5, () => 0)      // green = guaranteed block
    expect(state.score[0]).toBe(6)                            // no extra point added
    expect(state.specialTeams.kickType).toBe(KICK.KICKOFF)   // kicked off, not turned over
    expect(state.possession).toBe(1)                          // receiving team
  })

  it('[57] the game clock does not run during a two-point try', () => {
    const state = { roomId: 'clk2pt', clock: 120, twoPointActive: 0 }
    runClock(state, mockIo(), 1)
    expect(state.clock).toBe(120)             // untimed try — clock untouched
  })

  it('[51] reaching the end zone on a 2-pt try scores 2 (8 total) and kicks off', () => {
    const state = tdState('2pt-good')
    resolveConversion(state, mockIo(), 'two_point')
    state.phase = PHASE.LIVE
    state.ballCarrierId  = 'rb1'
    state.offensePlayers = new Map([['rb1', { id: 'rb1', label: 'RB', x: 26, y: 111 }]])
    enqueue('2pt-good', EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1', x: 26, y: 111 })
    processQueue('2pt-good', state, mockIo())
    expect(state.score[0]).toBe(8)   // 6 + 2
    expect(state.twoPointActive).toBeNull()
    expect(state.specialTeams.kickType).toBe(KICK.KICKOFF)
  })

  it('[51] the post-TD menu defaults to the extra point on timeout', () => {
    const state = tdState('conv-timeout')
    state.conversionTimer = 0.04
    runConversionClock(state, mockIo(), 0.05)
    expect(state.conversionPending).toBe(false)
    expect(state.specialTeams.kickType).toBe(KICK.EXTRA_POINT)   // auto-picked the XP
  })
})
