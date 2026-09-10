// ── [quarter transition] The next play must not start behind the interstitial ──
//
// At the end of a quarter the play-ending event and CLOCK_EXPIRED land in the same queue batch.
// processQueue deliberately drops everything after a play ends, so onClockExpired never runs and
// the safety net inside beginNextPlay is what actually advances the quarter.
//
// That safety net used to advance the quarter and set the next play up in the same pass: both
// clients were told to hold a 5-second full-screen interstitial at the very instant the formation
// was wiped, the play clock started and PRE_SNAP began. For those five seconds the game was live
// underneath an overlay nobody could interact with — the defense could not place or adjust its
// line, which is why the DL looked broken and players appeared not to move.

import { describe, it, expect, beforeEach, jest } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { initGame, deleteGame, getGame } from '../game/gameState.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

const ROOM = 'quarter-transition'
let emitted = []
const io = { to: (t) => ({ emit: (e, p) => emitted.push({ t, e, p }) }) }

function endOfQuarter() {
  deleteGame(ROOM); emitted = []
  createRoom(ROOM, 'sockA'); joinRoom(ROOM, 'sockB')
  const s = initGame(ROOM, 0)
  s.roomId = ROOM; s.phase = PHASE.LIVE; s.quarter = 1; s.clock = 0
  s.playDesign = { playType: 'pass', players: [] }
  s.offensePlayers = new Map([['qb', { id:'qb', label:'QB', x:26, y:35 }]])
  s.defensePlayers = new Map([['dl1',{ id:'dl1',label:'DL', x:26, y:37 }]])
  s.ballCarrierId = 'qb'
  enqueue(ROOM, EVENT.TACKLE, { playerId: 'qb', x: 26, y: 35 })
  enqueue(ROOM, EVENT.CLOCK_EXPIRED, {})
  processQueue(ROOM, s, io)
  return s
}

describe('a quarter ending on the same tick the play ends', () => {
  beforeEach(() => { jest.useFakeTimers() })

  it('still advances the quarter exactly once', () => {
    endOfQuarter()
    jest.advanceTimersByTime(20000)
    expect(getGame(ROOM).quarter).toBe(2)
  })

  it('tells both clients to hold an interstitial', () => {
    endOfQuarter()
    jest.advanceTimersByTime(20000)
    const pt = emitted.filter(x => x.e === 'period_transition')
    expect(pt).toHaveLength(1)
    expect(pt[0].p.seconds).toBe(5)
  })

  it('does NOT start the next play behind that interstitial', () => {
    endOfQuarter()
    jest.advanceTimersByTime(2000)                 // the ordinary between-plays gap
    const pt = emitted.find(x => x.e === 'period_transition')
    expect(pt).toBeDefined()                       // the hold has been announced…
    expect(getGame(ROOM).phase).toBe(PHASE.DEAD)   // …and the play has NOT lined up yet
    jest.advanceTimersByTime(4999)                 // still inside the 5s hold
    expect(getGame(ROOM).phase).toBe(PHASE.DEAD)
  })

  it('lines the next play up once the hold has elapsed', () => {
    endOfQuarter()
    jest.advanceTimersByTime(2000 + 5000 + 10)
    expect(getGame(ROOM).phase).toBe(PHASE.PRE_SNAP)
  })

  it('gives the offense a full play clock, not one that ran behind the overlay', () => {
    endOfQuarter()
    jest.advanceTimersByTime(2000 + 5000 + 10)
    expect(getGame(ROOM).playClock).toBeGreaterThanOrEqual(25)
  })
})
