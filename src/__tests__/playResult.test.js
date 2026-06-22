import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'

// [224][225] play_result carries the data the client turns into a play-by-play notice:
// outcome, yardsGained, newPossession (turnovers), and the firstDown flag.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function mockIo() {
  const emits = []
  return { emits, to: (id) => ({ emit: (event, payload) => emits.push({ to: id, event, payload }) }) }
}

function liveState(roomId, over = {}) {
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 60, down: 2, distance: 8,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, ballCarrierId: null, clockStopped: false,
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

function playResults(io) {
  return io.emits.filter(e => e.event === 'play_result').map(e => e.payload)
}

describe('play_result firstDown flag ([224]/[225])', () => {
  it('is true when the play moves the chains', () => {
    const roomId = 'pr-fd'
    createRoom(roomId, 'sA'); joinRoom(roomId, 'sB')
    const io = mockIo()
    // LOS abs y = 70 (yardLine 60), 2nd & 8. Tackle at y=80 → 10-yard gain, past the marker.
    const s = liveState(roomId)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 80 })
    processQueue(roomId, s, io)

    const r = playResults(io)
    expect(r.length).toBeGreaterThan(0)
    expect(r[0].outcome).toBe('tackle')
    expect(r[0].firstDown).toBe(true)
    expect(r[0].yardsGained).toBe(10)
  })

  it('is false on a gain short of the marker', () => {
    const roomId = 'pr-short'
    createRoom(roomId, 'sA2'); joinRoom(roomId, 'sB2')
    const io = mockIo()
    const s = liveState(roomId)
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 74 })   // +4, short of 8
    processQueue(roomId, s, io)

    const r = playResults(io)
    expect(r[0].firstDown).toBe(false)
  })

  it('reports the TRUE per-play gain on a first down — not a constant ([first-down notice])', () => {
    // The notice "First down! +N" reads r.yardsGained verbatim, so N must equal the actual gain
    // (tackle spot − LOS), whatever the field position or direction. Regression for a report that
    // first downs always showed +13.
    const cases = [
      { dir: 1,  yardLine: 25, distance: 10, y: 48, expect: 13 },  // own 25, +13
      { dir: 1,  yardLine: 25, distance: 10, y: 46, expect: 11 },  // own 25, +11 (still a first down)
      { dir: 1,  yardLine: 40, distance: 10, y: 75, expect: 25 },  // midfield, long gain
      { dir: -1, yardLine: 30, distance: 10, y: 68, expect: 12 },  // going south: LOS abs 80, tackle 68 → +12
    ]
    for (const [i, c] of cases.entries()) {
      const roomId = `pr-gain-${i}`
      createRoom(roomId, `g${i}a`); joinRoom(roomId, `g${i}b`)
      const io = mockIo()
      const s  = liveState(roomId, { direction: c.dir, yardLine: c.yardLine, distance: c.distance, down: 1 })
      enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: c.y })
      processQueue(roomId, s, io)

      const r = playResults(io)[0]
      expect(r.firstDown).toBe(true)
      expect(r.yardsGained).toBe(c.expect)
    }
  })

  it('marks a turnover on downs via newPossession on the play_result', () => {
    const roomId = 'pr-tod'
    createRoom(roomId, 'sA3'); joinRoom(roomId, 'sB3')
    const io = mockIo()
    const s = liveState(roomId, { down: 4, distance: 8 })
    enqueue(roomId, EVENT.TACKLE, { carrierId: 'rb1', x: 26, y: 74 })   // +4, short on 4th
    processQueue(roomId, s, io)

    const r = playResults(io)
    // viewer slot 0 lost the ball → sees newPossession 'defense'
    const forA = io.emits.find(e => e.event === 'play_result' && e.to === 'sA3').payload
    expect(forA.newPossession).toBe('defense')
    expect(forA.firstDown).toBe(false)
  })
})
