import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { createStats, lineOf, teamTotals } from '../game/stats.js'
import { PHASE } from '../game/stateMachine.js'

// ── [stats] A touchdown is still yardage ────────────────────────────────────
//
// ⚠️ A SCORING PLAY CREDITED NO YARDS AT ALL. Reported from the stats screen: "I think it doesn't log
// yards if you score a touchdown on that play."
//
// The yardage is settled in `onTackle` — that is where the spot is known, so that is where the gain is
// credited. A touchdown does not go through `onTackle`. `onTouchdown` counted the score and nothing
// else, so an 80-yard touchdown catch added a reception, six points, and ZERO receiving yards; a
// 40-yard touchdown run added no rushing yards and not even a carry.
//
// It is the worst play to lose, too: touchdowns are the longest gains in the box score, so the leaders
// and the impact ranking were being computed with every scoring play missing.

const LOS_Y = 35          // direction 1, so yardLine 25 sits at y = 35 and upfield is +y

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function mockIo() {
  const emits = []
  return { emits, to: (socketId) => ({ emit: (event, payload) => emits.push({ socketId, event, payload }) }) }
}

let room = 0
function scoringState(over = {}) {
  const roomId = `td-${room++}`
  leaveRoom('tdA'); leaveRoom('tdB')
  createRoom(roomId, 'tdA'); joinRoom(roomId, 'tdB')
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 25, down: 1, distance: 10,
    possession: 0, score: [0, 0], stats: createStats(), pendingStaminaRecovery: 0,
    deadBallSpot: null, interceptionReturn: false, tackleEnqueued: false,
    catchSpot: null, progressSpot: null, clockStopped: false,
    statsWasPass: false, statsPasser: null, passCompletedThisPlay: false,
    twoPointActive: null, conversionPending: false,
    offensePlayers: makeMap([
      { id: 'qb1', label: 'QB', slot: 0, name: 'Burrow', x: 26, y: LOS_Y - 5 },
      { id: 'wr1', label: 'WR', slot: 0, name: 'Chase', x: 40, y: LOS_Y + 20 },
      { id: 'rb1', label: 'RB', slot: 0, name: 'Brown', x: 26, y: LOS_Y + 20 },
    ]),
    defensePlayers: makeMap([{ id: 'cb1', label: 'CB', slot: 1, name: 'Sneed', x: 41, y: LOS_Y + 20 }]),
    ...over,
  }
}

describe('a touchdown credits the yards it gained', () => {
  // From the 25, so the play is worth 75 yards.
  it('a touchdown CATCH credits the passer and the receiver', () => {
    const s = scoringState()
    const io = mockIo()
    s.statsPasser = s.offensePlayers.get('qb1')

    enqueue(s.roomId, EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 40, y: LOS_Y + 20 })
    processQueue(s.roomId, s, io)
    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'wr1' })
    processQueue(s.roomId, s, io)

    expect(lineOf(s.stats, 'wr1', 0).recYards).toBe(75)
    expect(lineOf(s.stats, 'qb1', 0).passYards).toBe(75)
    // …and the things that already worked still do.
    expect(lineOf(s.stats, 'wr1', 0).receptions).toBe(1)
    expect(lineOf(s.stats, 'wr1', 0).recTD).toBe(1)
    expect(lineOf(s.stats, 'qb1', 0).passTD).toBe(1)
  })

  it('a touchdown RUN credits the carry as well as the yards', () => {
    const s = scoringState()
    const io = mockIo()

    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1' })
    processQueue(s.roomId, s, io)

    expect(lineOf(s.stats, 'rb1', 0).rushYards).toBe(75)
    expect(lineOf(s.stats, 'rb1', 0).carries).toBe(1)
    expect(lineOf(s.stats, 'rb1', 0).rushTD).toBe(1)
  })

  it('so the team totals include the scoring plays', () => {
    const s = scoringState()
    const io = mockIo()
    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1' })
    processQueue(s.roomId, s, io)
    expect(teamTotals(s.stats, 0).rushYards).toBe(75)
  })

  it('measures from the line of scrimmage, wherever that is', () => {
    const s = scoringState({ yardLine: 97 })
    const io = mockIo()
    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1' })
    processQueue(s.roomId, s, io)
    expect(lineOf(s.stats, 'rb1', 0).rushYards).toBe(3)
  })

  // ⚠️ A DEFENSIVE RETURN IS NOT OFFENSIVE YARDAGE. The intercepting team scored; the offense that
  // threw it gained nothing, and crediting 75 rushing yards to a cornerback would be worse than the
  // bug being fixed.
  it('credits nothing to the offense on a defensive return touchdown', () => {
    const s = scoringState()
    const io = mockIo()
    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 1, carrierId: 'cb1' })
    processQueue(s.roomId, s, io)

    expect(teamTotals(s.stats, 0).rushYards).toBe(0)
    expect(teamTotals(s.stats, 0).passYards).toBe(0)
    expect(lineOf(s.stats, 'cb1', 1)?.rushYards ?? 0).toBe(0)
  })

  // ⚠️ A TWO-POINT CONVERSION IS NOT A TOUCHDOWN AND NOT YARDAGE. Reaching the end zone on a try is
  // worth two points and nothing in the box score — real football counts neither.
  it('credits nothing on a two-point conversion', () => {
    const s = scoringState({ twoPointActive: 0, yardLine: 97 })
    const io = mockIo()
    enqueue(s.roomId, EVENT.TOUCHDOWN, { scoringSlot: 0, carrierId: 'rb1' })
    processQueue(s.roomId, s, io)

    expect(lineOf(s.stats, 'rb1', 0)?.rushYards ?? 0).toBe(0)
    expect(lineOf(s.stats, 'rb1', 0)?.rushTD ?? 0).toBe(0)
  })
})
