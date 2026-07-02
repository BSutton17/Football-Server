import { describe, it, expect } from '@jest/globals'
import { beginStoppage, endStoppage, isStopped, stoppageReason, tickStoppage, STOPPAGE } from '../game/pause.js'
import { initGame, getGame } from '../game/gameState.js'
import { validateCallTimeout } from '../game/validation.js'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { RULES } from '../constants.js'

// ── [69] Pause / stoppage framework ────────────────────────────────────────────

describe('stoppage framework ([69])', () => {
  it('begins, reports, and ends a stoppage', () => {
    const s = {}
    expect(isStopped(s)).toBe(false)
    beginStoppage(s, STOPPAGE.TIMEOUT, 6)
    expect(isStopped(s)).toBe(true)
    expect(stoppageReason(s)).toBe('timeout')
    endStoppage(s)
    expect(isStopped(s)).toBe(false)
    expect(stoppageReason(s)).toBeNull()
  })

  it('counts a timed stoppage down and reports elapsed when it hits zero', () => {
    const s = {}
    beginStoppage(s, STOPPAGE.TIMEOUT, 0.1)
    expect(tickStoppage(s, 0.05)).toBe(true)    // 0.05 left — still frozen
    expect(tickStoppage(s, 0.05)).toBe(false)   // elapsed — caller resumes
  })

  it('an open-ended stoppage (null duration) stays active until ended explicitly', () => {
    const s = {}
    beginStoppage(s, STOPPAGE.INJURY, null)
    expect(tickStoppage(s, 100)).toBe(true)
    expect(tickStoppage(s, 100)).toBe(true)
    endStoppage(s)
    expect(tickStoppage(s, 1)).toBe(false)
  })
})

// ── [70] Timeout tracking ────────────────────────────────────────────────────

describe('timeout tracking ([70])', () => {
  it('a new game starts each team with three timeouts and no stoppage', () => {
    const s = initGame('to-init', 0)
    expect(s.timeouts).toEqual([RULES.TIMEOUTS_PER_HALF, RULES.TIMEOUTS_PER_HALF])
    expect(s.stoppage).toBeNull()
  })

  it('resets both teams to three timeouts at halftime', () => {
    const roomId = 'to-half'
    createRoom(roomId, 'a'); joinRoom(roomId, 'b')
    const io = { sockets: { sockets: new Map() }, to: () => ({ emit: () => {} }) }
    const s = getGame(roomId) ?? initGame(roomId, 0)
    Object.assign(s, {
      phase: PHASE.LIVE, quarter: 2, clock: 0, possession: 0, openingPossession: 0,
      timeouts: [1, 0], direction: 1, yardLine: 50, down: 1, distance: 10,
    })
    enqueue(roomId, EVENT.CLOCK_EXPIRED, {})
    processQueue(roomId, s, io)

    expect(s.quarter).toBe(3)
    expect(s.timeouts).toEqual([RULES.TIMEOUTS_PER_HALF, RULES.TIMEOUTS_PER_HALF])
  })
})

// ── [70] call_timeout validation ───────────────────────────────────────────────

function mockSocket(roomId, role = 'offense') {
  return { id: 'sock', data: { roomId, role } }
}

describe('validateCallTimeout ([70])', () => {
  it('allows a timeout during pre-snap with no other stoppage', () => {
    initGame('to-ok', 0)   // phase defaults to PRE_SNAP
    expect(validateCallTimeout(mockSocket('to-ok'))).toBeNull()
  })

  it('rejects a timeout outside pre-snap', () => {
    const s = initGame('to-live', 0)
    s.phase = PHASE.LIVE
    expect(validateCallTimeout(mockSocket('to-live'))).toMatch(/phase/)
  })

  it('rejects a second timeout while one is already in progress', () => {
    const s = initGame('to-busy', 0)
    beginStoppage(s, STOPPAGE.TIMEOUT, 6)
    expect(validateCallTimeout(mockSocket('to-busy'))).toMatch(/already in progress/)
  })
})
