import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame } from '../training/game.js'
import { enqueue, processQueue, startNextPlay, EVENT } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'

// [stale event] A throw books its catch for the next tick. When a sack or a tackle ended the play in the
// meantime, the catch stayed in the queue and went off on the first tick of the NEXT play. By then the ball had
// often changed hands, so the "carrier" was a receiver who was not on the field. Nobody can tackle a player who
// is not there, so the play never ended and the game was frozen for good.

describe('[stale event] nothing from the last play reaches the next one', () => {
  it('a catch left in the queue does not fire on the next snap', () => {
    const ctx = createTrainingGame({ seed: 5 })
    try {
      const s = ctx.state
      s.phase = PHASE.DEAD
      s.ballCarrierId = null
      enqueue(ctx.roomId, EVENT.PASS_COMPLETE, { receiverId: 'someone_from_the_last_play', x: 20, y: 40 })

      startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }
      expect(s.phase).toBe(PHASE.PRE_SNAP)

      s.phase = PHASE.LIVE
      processQueue(ctx.roomId, s, ctx.io)
      expect(s.ballCarrierId).toBeNull()
    } finally { destroyTrainingGame(ctx) }
  })

  it('an event booked during the new play still goes off', () => {
    const ctx = createTrainingGame({ seed: 6 })
    try {
      const s = ctx.state
      s.phase = PHASE.DEAD
      startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }

      s.phase = PHASE.LIVE
      s.offensePlayers.set('wr', { id: 'wr', x: 20, y: 40, vx: 0, vy: 0, label: 'WR' })
      enqueue(ctx.roomId, EVENT.PASS_COMPLETE, { receiverId: 'wr', x: 20, y: 40 })
      processQueue(ctx.roomId, s, ctx.io)
      expect(s.ballCarrierId).toBe('wr')
    } finally { destroyTrainingGame(ctx) }
  })
})
