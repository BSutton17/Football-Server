import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { initGame, deleteGame } from '../game/gameState.js'
import { tick, stopGameLoop } from '../game/simulation.js'
import { markSoloRoom } from '../ai/timing.js'
import { beginStoppage, endStoppage, STOPPAGE } from '../game/pause.js'
import {
  chewRefusal, armChewClock, chewStep, clearChewClock,
  CHEW_STOP_AT, CHEW_MIN_PLAY_CLOCK, CHEW_SPEED,
} from '../game/chewClock.js'
import { PHASE } from '../game/stateMachine.js'

// [chew clock] An offense burning pre-snap time on purpose, fast-forwarded so it doesn't have to be
// watched in real time. The two things worth protecting are that no game time is invented and that
// it can't be used to hurry a human opponent.

const DT = 0.05

function chewable(over = {}) {
  return {
    solo: { defenseSet: false, countdown: null },
    phase: PHASE.PRE_SNAP,
    possession: 0,
    playClock: 25,
    playClockRunning: true,
    clock: 600,
    clockStopped: false,
    chewing: false,
    ...over,
  }
}

describe('[chew clock] who may arm it', () => {
  it('the offense in a solo room, pre-snap, with time on the play clock', () => {
    expect(chewRefusal(chewable(), 0)).toBeNull()
    expect(armChewClock(chewable(), 0)).toBe(true)
  })

  it('⚠️ NEVER IN AN ONLINE GAME — it would take the other player’s setup time', () => {
    // The same argument as the pre-snap Set Defense button (see ai/timing.js): before the offense
    // locks, the DEFENSE is still placing eleven men. Speeding the play clock up then is not one
    // team spending its own seconds.
    const online = chewable({ solo: null })
    expect(chewRefusal(online, 0)).toMatch(/offline/)
    expect(armChewClock(online, 0)).toBe(false)
    expect(online.chewing).toBeFalsy()
  })

  it('not the defense — it is not their clock to burn', () => {
    expect(chewRefusal(chewable(), 1)).toMatch(/offense/)
    expect(armChewClock(chewable(), 1)).toBe(false)
  })

  it('⚠️ NOT UNDER EIGHT SECONDS, AT ALL', () => {
    // The author's rule. Below this there is nothing worth skipping, and arming it that late is far
    // more likely to be a mis-tap that ends in delay of game.
    expect(chewRefusal(chewable({ playClock: CHEW_MIN_PLAY_CLOCK }), 0)).toBeNull()
    expect(chewRefusal(chewable({ playClock: CHEW_MIN_PLAY_CLOCK - 0.5 }), 0)).toMatch(/too little/)
    expect(chewRefusal(chewable({ playClock: 4 }), 0)).toMatch(/too little/)
  })

  it('not once the offense has set (the play clock is already frozen)', () => {
    expect(chewRefusal(chewable({ phase: PHASE.COUNTDOWN }), 0)).toBeTruthy()
    expect(chewRefusal(chewable({ playClockRunning: false }), 0)).toMatch(/not running/)
  })

  it('not during a kick, a 4th-down menu, or a conversion menu', () => {
    expect(chewRefusal(chewable({ specialTeams: { kickType: 'punt' } }), 0)).toMatch(/kick/)
    expect(chewRefusal(chewable({ decisionPending: true }), 0)).toMatch(/decision/)
    expect(chewRefusal(chewable({ conversionPending: true }), 0)).toMatch(/decision/)
  })

  it('not twice', () => {
    const state = chewable()
    expect(armChewClock(state, 0)).toBe(true)
    expect(armChewClock(state, 0)).toBe(false)
  })
})

describe('[chew clock] the fast-forward', () => {
  it('leaves the timestep alone when not chewing', () => {
    expect(chewStep(chewable(), DT)).toBe(DT)
    expect(chewStep(null, DT)).toBe(DT)
  })

  it('runs the clocks faster while there is room', () => {
    const state = chewable({ chewing: true })
    expect(chewStep(state, DT)).toBeCloseTo(DT * CHEW_SPEED)
  })

  // Runs the state forward the way the sim tick does, and reports the moment the chew ENDED. The
  // distinction matters: chewStep returns an ordinary DT on the tick it disarms, so the play clock
  // keeps counting down past the stop point at normal speed — which is correct, and is not the chew
  // overshooting.
  function chewToCompletion(state) {
    let ticks = 0
    while (ticks++ < 10000) {
      const wasChewing = state.chewing
      const step = chewStep(state, DT)
      if (wasChewing && !state.chewing) return { ticks, playClock: state.playClock, clock: state.clock }
      state.playClock = Math.max(0, state.playClock - step)
      state.clock -= step                       // the game clock gets the identical step
    }
    throw new Error('the chew never ended')
  }

  it('⚠️ LANDS EXACTLY ON THE STOP POINT AND DISARMS — never past it', () => {
    // Overshooting would leave the offense with under three seconds to set and snap, which is the
    // delay-of-game the stop point exists to avoid. At 8x the step is 0.4s, so an unclamped chew
    // would stop anywhere in 2.6–3.0.
    const end = chewToCompletion(chewable({ chewing: true }))
    expect(end.playClock).toBeCloseTo(CHEW_STOP_AT, 6)
  })

  it('stops on the nose from a play clock that is not a multiple of the fast step', () => {
    for (const start of [25, 40, 17.3, 8, 9.07]) {
      const end = chewToCompletion(chewable({ chewing: true, playClock: start }))
      expect(end.playClock).toBeCloseTo(CHEW_STOP_AT, 6)
    }
  })

  it('⚠️ BURNS THE SAME NUMBER OF SECONDS OFF BOTH CLOCKS', () => {
    // The correctness argument for the whole feature: fast-forwarding must not invent or skip game
    // time. Whatever comes off the play clock comes off the game clock, exactly as if the offense had
    // stood there and let it run.
    const end = chewToCompletion(chewable({ chewing: true, playClock: 25, clock: 600 }))
    const playBurned = 25 - end.playClock
    expect(playBurned).toBeCloseTo(25 - CHEW_STOP_AT, 6)
    expect(600 - end.clock).toBeCloseTo(playBurned, 6)
  })

  it('takes the real time a normal wait would, divided by the speed', () => {
    const end = chewToCompletion(chewable({ chewing: true }))
    const normalTicks = (25 - CHEW_STOP_AT) / DT
    expect(end.ticks).toBeLessThan(normalTicks / (CHEW_SPEED - 1))
  })

  it('clearing it stops the fast-forward mid-flight', () => {
    const state = chewable({ chewing: true })
    state.playClock -= chewStep(state, DT)
    clearChewClock(state)
    expect(chewStep(state, DT)).toBe(DT)
    expect(state.playClock).toBeGreaterThan(CHEW_STOP_AT)   // it stopped where it was
  })

  it('clearing a state with no chew (and no solo room) does not throw', () => {
    const plain = {}
    clearChewClock(plain)
    clearChewClock(null)
    expect(plain.chewing).toBe(false)
  })
})

describe('[chew clock] what the client is told', () => {
  // ⚠️ The snapshot deliberately answers a DIFFERENT question from the handler. `game_state` is sent
  // once per play; through pre-snap the client gets only clock ticks. So the two conditions that move
  // every tick are left to the client to apply against the clock it is already displaying, and
  // `ignoreLive` is what draws that line.
  it('the static conditions are still enforced in the snapshot', () => {
    expect(chewRefusal(chewable({ solo: null }), 0, { ignoreLive: true })).toMatch(/offline/)
    expect(chewRefusal(chewable(), 1, { ignoreLive: true })).toMatch(/offense/)
    expect(chewRefusal(chewable({ phase: PHASE.LIVE }), 0, { ignoreLive: true })).toBeTruthy()
    expect(chewRefusal(chewable({ specialTeams: {} }), 0, { ignoreLive: true })).toMatch(/kick/)
  })

  it('the play clock and an in-flight chew are left to the client', () => {
    expect(chewRefusal(chewable({ playClock: 2 }), 0, { ignoreLive: true })).toBeNull()
    expect(chewRefusal(chewable({ chewing: true }), 0, { ignoreLive: true })).toBeNull()
  })

  it('…but the handler’s own check never skips them', () => {
    expect(chewRefusal(chewable({ playClock: 2 }), 0)).toBeTruthy()
    expect(chewRefusal(chewable({ chewing: true }), 0)).toBeTruthy()
  })
})

// ── Through the real sim tick ────────────────────────────────────────────────
//
// The unit tests above prove the arithmetic. This proves the WIRING: that the pre-snap branch of the
// tick actually hands the scaled step to both clocks, and that a freeze cancels it. Everything the
// feature does lives in three lines of simulation.js, so those are the lines worth covering.

describe('[chew clock] driven by the real tick', () => {
  const ROOM = 'chew-tick'
  const noIo = { to: () => ({ emit: () => {} }) }

  beforeEach(() => deleteGame(ROOM))
  afterEach(() => { deleteGame(ROOM); stopGameLoop(ROOM) })

  function presnap() {
    const state = initGame(ROOM, 0)
    markSoloRoom(state)
    state.phase = PHASE.PRE_SNAP
    state.possession = 0
    state.clockStopped = false        // a running clock, i.e. after an in-bounds tackle
    state.playClock = 25
    state.playClockRunning = true
    return state
  }

  // One second of wall time, so the comparison is "how much clock went away per second".
  const runOneSecond = () => { for (let i = 0; i < 20; i++) tick(ROOM, noIo) }

  it('⚠️ ACTUALLY BURNS GAME CLOCK, AND FAR FASTER THAN STANDING THERE', () => {
    const idle = presnap()
    const clockBefore = idle.clock
    runOneSecond()
    const normalBurn = clockBefore - idle.clock
    expect(normalBurn).toBeCloseTo(1, 1)          // real time, as before this feature existed

    deleteGame(ROOM)
    const chew = presnap()
    armChewClock(chew, 0)
    const chewBefore = chew.clock
    runOneSecond()
    expect(chewBefore - chew.clock).toBeGreaterThan(normalBurn * 4)
  })

  it('both clocks come down together through the tick', () => {
    const state = presnap()
    armChewClock(state, 0)
    const c0 = state.clock, p0 = state.playClock
    runOneSecond()
    expect(p0 - state.playClock).toBeCloseTo(c0 - state.clock, 6)
  })

  it('ends at the stop point and then runs at normal speed again', () => {
    const state = presnap()
    armChewClock(state, 0)
    for (let i = 0; i < 20 * 10 && state.chewing; i++) tick(ROOM, noIo)
    expect(state.chewing).toBe(false)
    expect(state.playClock).toBeLessThanOrEqual(CHEW_STOP_AT)
    expect(state.playClock).toBeGreaterThan(CHEW_STOP_AT - 0.5)   // it stopped there, not at zero

    // …and one more second of ticking takes about one more second off, not eight.
    const after = state.clock
    runOneSecond()
    expect(after - state.clock).toBeCloseTo(1, 1)
  })

  it('⚠️ A FREEZE CANCELS IT — a timeout must not resume into a fast-forward', () => {
    // Calling a timeout is paying to STOP the clock. Resuming into a chew would burn the seconds the
    // timeout was spent to keep, which is the exact opposite of what the player asked for.
    const state = presnap()
    armChewClock(state, 0)
    beginStoppage(state, STOPPAGE.TIMEOUT, 5)
    tick(ROOM, noIo)
    expect(state.chewing).toBe(false)

    endStoppage(state)
    const before = state.clock
    runOneSecond()
    expect(before - state.clock).toBeCloseTo(1, 1)     // normal speed, not chewing
  })

  it('a stopped game clock chews only the play clock', () => {
    // After an incompletion or a change of possession the game clock is not running, so there is no
    // game time to burn — but skipping the wait is still worth doing.
    const state = presnap()
    state.clockStopped = true
    armChewClock(state, 0)
    const c0 = state.clock
    runOneSecond()
    expect(state.clock).toBe(c0)
    expect(state.playClock).toBeLessThan(25 - 4)
  })
})
