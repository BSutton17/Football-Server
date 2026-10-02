import { describe, it, expect } from '@jest/globals'
import { enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { createRoom, joinRoom, leaveRoom } from '../game/roomManager.js'
import { PHASE } from '../game/stateMachine.js'
import { routeTraits } from '../game/utils/routeGeometry.js'
import { advanceForwardProgress } from '../game/systems/movement.js'

// ── [forward progress] A curl or comeback is spotted where it was caught ─────
//
// Asked for: "for these routes the ball is downed where they caught it, not where they were tackled
// unless they begin moving upfield again."
//
// ⚠️ THE ENGINE WAS ACTIVELY CARRYING HIM BACKWARDS, so this is not a rounding matter. The momentum
// window in onPassComplete exists to keep a receiver's route heading for a beat after the catch — "back
// on a curl", in its own words — and the spot was wherever contact happened at the end of that. A
// receiver who caught the ball on the sticks could be marked short of them having done nothing wrong.
//
// The rule as implemented is the real one: the ball is spotted at the furthest point his progress
// reached. "Unless they begin moving upfield again" then falls out of it rather than needing a case of
// its own — once he passes the catch point the mark follows him.

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

// A curl: a stem upfield and then a leg that surrenders depth.
const CURL = { givesUpDepth: true }
// A dig: it breaks across the field without giving any depth back.
const DIG = { givesUpDepth: false }

let room = 0
function liveState(traits, over = {}) {
  const roomId = `fp-${room++}`
  leaveRoom('fpA'); leaveRoom('fpB')
  createRoom(roomId, 'fpA'); joinRoom(roomId, 'fpB')
  return {
    roomId, phase: PHASE.LIVE, direction: 1, yardLine: 25, down: 1, distance: 10,
    possession: 0, score: [0, 0], pendingStaminaRecovery: 0, deadBallSpot: null,
    interceptionReturn: false, tackleEnqueued: false, ballCarrierId: null,
    catchSpot: null, progressSpot: null, statsWasPass: false, clockStopped: false,
    offensePlayers: makeMap([
      { id: 'qb1', label: 'QB', x: 26, y: LOS_Y - 5 },
      { id: 'wr1', label: 'WR', x: 40, y: LOS_Y + 12, routeTraits: traits },
    ]),
    defensePlayers: makeMap([{ id: 'cb1', label: 'CB', x: 41, y: LOS_Y + 12 }]),
    ...over,
  }
}

// Catch at `caughtY`, then contact at `tackledY`. Returns the yard line the ball ends up on.
function catchThenTackle(traits, caughtY, tackledY, { driveUpfieldTo = null } = {}) {
  const state = liveState(traits)
  const io = mockIo()
  enqueue(state.roomId, EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 40, y: caughtY })
  processQueue(state.roomId, state, io)

  // If he gets upfield of the catch before contact, the mark has to follow him. `runMovement` calls
  // this on every live tick; it is called directly here because the full movement system wants a whole
  // game state (fatigue maps, blocking, the lot) and stubbing all of it would test the stub.
  if (driveUpfieldTo != null) {
    state.offensePlayers.get('wr1').y = driveUpfieldTo
    advanceForwardProgress(state)
  }

  enqueue(state.roomId, EVENT.TACKLE, { carrierId: 'wr1', x: 40, y: tackledY })
  processQueue(state.roomId, state, io)
  return state
}

describe('which routes earn it', () => {
  const traitsFor = (waypoints, startY = LOS_Y) =>
    routeTraits(waypoints, startY, LOS_Y, 1, 40, 26)

  it('a curl does — the last leg gives up depth', () => {
    // Twelve yards upfield, then back to eight.
    expect(traitsFor([{ x: 40, y: LOS_Y + 12 }, { x: 40, y: LOS_Y + 8 }]).givesUpDepth).toBe(true)
  })

  it('a straight go does not', () => {
    expect(traitsFor([{ x: 40, y: LOS_Y + 12 }, { x: 40, y: LOS_Y + 24 }]).givesUpDepth).toBe(false)
  })

  it('a dig does not — it crosses without surrendering depth', () => {
    expect(traitsFor([{ x: 40, y: LOS_Y + 12 }, { x: 20, y: LOS_Y + 12 }]).givesUpDepth).toBe(false)
  })

  // ⚠️ AND A RETURN DOES NOT, which is the whole reason this is its own trait rather than `breaksBack`.
  // A return breaks out and then back inside toward the passer at the same depth: it reads as breaking
  // back, but there is no backward momentum to forgive, and forgiving it would hand every one of them a
  // free yard or two.
  it('a return does not, although it does break back', () => {
    const t = traitsFor([{ x: 48, y: LOS_Y + 12 }, { x: 34, y: LOS_Y + 12 }])
    expect(t.breaksBack).toBe(true)
    expect(t.givesUpDepth).toBe(false)
  })

  it('a route nobody runs does not', () => {
    expect(routeTraits([], LOS_Y, LOS_Y, 1, 40, 26).givesUpDepth).toBe(false)
  })
})

describe('where the ball is spotted', () => {
  it('at the catch, when the curl carried him backwards into contact', () => {
    // Caught 12 yards downfield, dragged back to 9 by his own momentum.
    const s = catchThenTackle(CURL, LOS_Y + 12, LOS_Y + 9)
    expect(s.yardLine).toBeCloseTo(37, 6)        // the catch, not the tackle
    expect(s.deadBallSpot.y).toBeCloseTo(LOS_Y + 12, 6)
  })

  it('at the tackle, when he was brought down upfield of the catch', () => {
    const s = catchThenTackle(CURL, LOS_Y + 12, LOS_Y + 16)
    expect(s.yardLine).toBeCloseTo(41, 6)
  })

  // "…unless they begin moving upfield again."
  it('at the furthest point he reached, when he turned upfield and was then driven back', () => {
    const s = catchThenTackle(CURL, LOS_Y + 12, LOS_Y + 14, { driveUpfieldTo: LOS_Y + 19 })
    expect(s.yardLine).toBeCloseTo(44, 6)        // the 19, not the catch and not the tackle
  })

  it('at the tackle on a route that gave up no depth, however far back he was dragged', () => {
    const s = catchThenTackle(DIG, LOS_Y + 12, LOS_Y + 9)
    expect(s.yardLine).toBeCloseTo(34, 6)        // unchanged behaviour: the contact spot
  })

  // ⚠️ A SAFETY IS THE SAME RULE, NOT AN EXCEPTION TO IT. Caught at his own 2 and driven into the end
  // zone is a two-yard gain, not two points for the other side.
  it('no safety when the catch was out of the end zone and the contact was in it', () => {
    const state = liveState(CURL, { yardLine: 2, direction: 1 })
    const io = mockIo()
    enqueue(state.roomId, EVENT.PASS_COMPLETE, { receiverId: 'wr1', x: 40, y: 14 })  // the 4
    processQueue(state.roomId, state, io)
    enqueue(state.roomId, EVENT.TACKLE, { carrierId: 'wr1', x: 40, y: 8 })           // in the end zone
    processQueue(state.roomId, state, io)

    expect(state.score).toEqual([0, 0])
    expect(state.yardLine).toBeCloseTo(4, 6)
  })
})

describe('the mark does not outlive the play', () => {
  it('is cleared once the ball is spotted, so a spot cannot reach the next play', () => {
    const s = catchThenTackle(CURL, LOS_Y + 12, LOS_Y + 9)
    expect(s.progressSpot).toBeNull()
  })
})
