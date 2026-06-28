import { describe, it, expect, jest, afterEach } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { initGame, getGame, deleteGame } from '../game/gameState.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { runPlayClock } from '../game/systems/playClock.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

// [play-clock] The first play of a DRIVE gets a 40 s play clock (time to set the formation); every
// other play gets 25 s. A drive starts on any possession change (set via notifyRoleSwap → newDrive).

function mockIo() {
  return { to() { return { emit() {} } } }
}
function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}
function room(roomId) {
  createRoom(roomId, 'sockA')
  joinRoom(roomId, 'sockB')
}

// ── newDrive trigger (synchronous, set during the play-ending handler) ────────────

describe('newDrive flag — set on a possession change only', () => {
  it('a normal in-bounds tackle does NOT start a new drive', () => {
    const roomId = 'pc-tackle'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10,
      possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null, ballX: 26, newDrive: false,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 24, y: 60 }]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 24, y: 60 })
    processQueue(roomId, state, mockIo())
    expect(state.newDrive).toBe(false)
  })

  it('a turnover on downs starts a new drive', () => {
    const roomId = 'pc-tod'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 60, down: 4, distance: 5,
      possession: 0, pendingStaminaRecovery: 0, deadBallSpot: null, ballX: 26, newDrive: false,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 62 }]),  // 2-yd gain, short of 5
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 62 })
    processQueue(roomId, state, mockIo())
    expect(state.possession).toBe(1)     // possession flipped
    expect(state.newDrive).toBe(true)
  })

  it('a touchdown starts a new drive (for the receiving team)', () => {
    const roomId = 'pc-td'; room(roomId)
    const state = {
      roomId, phase: PHASE.LIVE, direction: 1, yardLine: 95, down: 1, distance: 5,
      possession: 0, score: [0, 0], pendingStaminaRecovery: 0, ballX: 26, newDrive: false,
      interceptionReturn: false, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 26, y: 110 }]),
      defensePlayers: new Map(),
    }
    enqueue(roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1', x: 26, y: 110 })
    processQueue(roomId, state, mockIo())
    expect(state.newDrive).toBe(true)
  })
})

// ── beginNextPlay consumes newDrive to pick the play-clock value ──────────────────

describe('play-clock reset for the next snap', () => {
  afterEach(() => { jest.useRealTimers() })

  function runNextPlay(roomId, mutate) {
    jest.useFakeTimers()
    const state = initGame(roomId, 0)   // registered in the game map so beginNextPlay finds it
    Object.assign(state, {
      phase: PHASE.LIVE, direction: 1, yardLine: 50, down: 1, distance: 10, possession: 0,
      deadBallSpot: null, tackleEnqueued: false,
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 24, y: 60 }]),
      defensePlayers: new Map(),
    })
    mutate(state)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: state.offensePlayers.get('rb1').x, y: state.offensePlayers.get('rb1').y })
    processQueue(roomId, state, mockIo())
    jest.runOnlyPendingTimers()   // fire beginNextPlay's scheduled reset
    return getGame(roomId)
  }

  it('a normal play resets the play clock to 25', () => {
    const roomId = 'pc-reset-normal'; room(roomId)
    const state = runNextPlay(roomId, () => {})   // gain, no turnover → not a new drive
    expect(state.phase).toBe(PHASE.PRE_SNAP)
    expect(state.playClock).toBe(RULES.PLAY_CLOCK_SECONDS)   // 25
    deleteGame(roomId)
  })

  it('the first play of a new drive resets the play clock to 40', () => {
    const roomId = 'pc-reset-drive'; room(roomId)
    // 4th & 5 with a 2-yard gain → turnover on downs → new drive
    const state = runNextPlay(roomId, (s) => {
      s.down = 4; s.distance = 5; s.offensePlayers.get('rb1').y = 52
    })
    expect(state.playClock).toBe(RULES.PLAY_CLOCK_NEW_DRIVE)   // 40
    deleteGame(roomId)
  })
})

describe('[delay of game] play-clock expiry', () => {
  it('applies a 5-yard penalty, replays the SAME down, and resets the play clock to 25', () => {
    const roomId = 'pc-dog'; room(roomId)
    const state = {
      roomId, phase: PHASE.PRE_SNAP, direction: 1, yardLine: 30, down: 1, distance: 10,
      possession: 0, score: [0, 0], clock: 300, quarter: 1, ballX: 26,
      playClock: 0.04, playClockRunning: true, newDrive: true,
      // already-placed formations (absolute Y; LOS at 10+30 = 40 for direction 1)
      offensePlayers: makeMap([{ id: 'rb1', label: 'RB', x: 24, y: 34 }]),
      defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 24, y: 47 }]),
    }
    runPlayClock(state, mockIo(), 0.05)   // play clock hits 0 → delay of game
    expect(state.yardLine).toBe(25)        // [1st & 10 → 1st & 15] LOS back 5
    expect(state.distance).toBe(15)        // distance +5
    expect(state.down).toBe(1)             // same down replayed
    expect(state.playClock).toBe(RULES.PLAY_CLOCK_SECONDS)   // reset to 25
    expect(state.playClockRunning).toBe(true)
    expect(state.newDrive).toBe(false)     // no longer the fresh-drive window
    // the stored formations slide back with the LOS (−5 yds in absolute Y) so the snap lines up
    expect(state.offensePlayers.get('rb1').y).toBe(29)
    expect(state.defensePlayers.get('cb1').y).toBe(42)
  })

})
