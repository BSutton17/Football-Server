import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'

// PASS_COMPLETE handling ([181] completion, [182] catch-spot tracking). The handler only
// mutates state (it doesn't emit or schedule the next play), so it's safe to drive directly
// through processQueue with a null io.

function makeState(roomId) {
  return {
    roomId,
    phase: PHASE.LIVE,
    offensePlayers: new Map([['wr1', { id: 'wr1', label: 'WR', x: 30, y: 55, vx: 0, vy: 8 }]]),
    defensePlayers: new Map(),
    ballCarrierId: null,
    targetReceiverId: 'wr1',
    activeThrow: { receiverId: 'wr1', x: 30, y: 55 },
    catchSpot: null,
  }
}

describe('PASS_COMPLETE handling', () => {
  it('makes the receiver the ball carrier immediately ([181])', () => {
    const state = makeState('pc-1')
    enqueue('pc-1', EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 30, y: 55 })
    processQueue('pc-1', state, null)

    expect(state.ballCarrierId).toBe('wr1')
    expect(state.targetReceiverId).toBeNull()
    expect(state.activeThrow).toBeNull()
    expect(state.phase).toBe(PHASE.LIVE)   // play continues — not dead
  })

  it('records the exact catch location ([182])', () => {
    const state = makeState('pc-2')
    enqueue('pc-2', EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 31.4, y: 56.2 })
    processQueue('pc-2', state, null)

    expect(state.catchSpot).toEqual({ x: 31.4, y: 56.2 })
  })
})
