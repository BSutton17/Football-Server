import { describe, it, expect } from '@jest/globals'
import { runMovement } from '../game/systems/movement.js'

// [run fix] A defensive lineman holds its gap on a run — it is the wall the back reads, and it must
// not abandon its lane to chase the ball the instant the ball moves. But holding a gap is not the
// same as standing still, and the first version of this code never let a lineman off the leash at
// all: the `line` branch steered at its gap landmark for the whole down and returned, so the
// `committed` check below it was unreachable and `RUN_PURSUIT_DELAY.line = 0` was dead.
//
// The result on the field: a back running straight through a lineman's gap was waved past, and a
// back who broke the line was never chased down from behind by anyone on the front.
//
// dir=+1, yardLine=25 → losY=35; the offense runs north (increasing y).

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], playType = 'run', ballCarrierId = null } = {}) {
  return {
    direction: 1,
    yardLine: 25,
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    defenseCoverage: new Map(),
    playerFatigue: new Map(),
    playDesign: { playType },
    ballCarrierId,
    catchSpot: null,
  }
}

const rb = (id, x, y, vy = 6) => ({ id, label: 'RB', x, y, vx: 0, vy, isEngaged: false })
const ol = (id, x, y = 35) => ({ id, label: 'OL', x, y, vx: 0, vy: 0, isEngaged: false, passBlockAnchorX: null, passBlockAnchorY: null })
const dl = (id, x, y = 35) => ({ id, label: 'DL', x, y, vx: 0, vy: 0, isEngaged: false })

// Distance from a defender to the carrier — the only thing that decides whether a tackle is
// possible, so it is what these tests measure.
const gapTo = (d, c) => Math.hypot(c.x - d.x, c.y - d.y)

function run(state, ticks) {
  for (let i = 0; i < ticks; i++) runMovement(state, null, DT)
}

describe('a defensive lineman attacks the ball when the run comes to him', () => {
  // ⚠️ These two are deliberately set up so the back is INSIDE the lineman's release range but on
  // the OPPOSITE SIDE from where the gap landmark points. A back placed straight in front of the
  // lineman proves nothing: `gapTargetX` flows toward the ball, so the old gap-holding code closed
  // on him by accident and the test passed against the bug it was written to catch.
  it('turns toward a back crossing his face, not toward the gap landmark', () => {
    // dl at x=31; the back is 2.5 yd away at x=29 and running further left. The gap landmark sits
    // at x≈32.4 — the old code drove him RIGHT, away from the ball.
    const back = rb('rb1', 29, 34, 1)
    back.vx = -4
    const d = dl('dl1', 31, 35.5)
    const state = makeState({ offense: [back], defense: [d], ballCarrierId: 'rb1' })

    run(state, 6)
    expect(d.vx).toBeLessThan(0)      // tracking the ball
    expect(d.x).toBeLessThan(31)      // …and he actually went that way
  })

  it('gets within tackling range of a back crossing his face', () => {
    const back = rb('rb1', 28.8, 34.2, 1.0)
    back.vx = -1.5
    const d = dl('dl1', 31, 35.5)
    const state = makeState({ offense: [back], defense: [d], ballCarrierId: 'rb1' })

    // 1.5 yd is the contact radius tackleDetection uses; the lineman has to actually arrive.
    let closest = Infinity
    for (let i = 0; i < 40; i++) {
      runMovement(state, null, DT)
      closest = Math.min(closest, gapTo(d, back))
    }
    expect(closest).toBeLessThanOrEqual(1.5)
  })

  it('chases from behind once the ball is past him', () => {
    // Broken through: the back is 6 yards downfield, well outside DL_BALL_RANGE. Holding the gap
    // here defends nothing — the wall has already been beaten.
    const back = rb('rb1', 32, 41)
    const d    = dl('dl1', 30, 35)
    const state = makeState({ offense: [back], defense: [d], ballCarrierId: 'rb1' })

    run(state, 10)
    // Downfield, after the runner — the one direction the old code would never send him.
    expect(d.y).toBeGreaterThan(35)
    expect(d.vy).toBeGreaterThan(0)
  })
})

describe('…but he still holds the gap while the ball is behind the line', () => {
  it('drives into the backfield rather than chasing a back who has not pressed his gap', () => {
    // Deep and wide: the back is 10 yards away laterally and still behind the LOS, so this
    // lineman's job is the lane, not the ball.
    const back = rb('rb1', 42, 30)
    const d    = dl('dl1', 30, 35)
    const state = makeState({ offense: [back], defense: [d], ballCarrierId: 'rb1' })

    run(state, 10)
    // He penetrates (y falls toward the offense's side) and does not go tearing across the
    // formation after the ball.
    expect(d.y).toBeLessThan(35)
    expect(Math.abs(d.x - 30)).toBeLessThan(4)
  })

  it('a lineman engaged with a blocker gives chase at blocked speed, not free speed', () => {
    const back    = rb('rb1', 30, 34)
    const blocked = dl('blk', 30, 35.5)
    const free    = dl('fre', 36, 35.5)
    blocked.isEngaged = true
    const backFree = rb('rb2', 36, 34)
    const state = makeState({
      offense: [back, backFree, ol('ol1', 30)],
      defense: [blocked, free],
      ballCarrierId: 'rb1',
    })

    run(state, 8)
    // Both released toward the ball; the engaged one simply cannot get there as fast.
    expect(Math.hypot(blocked.vx, blocked.vy)).toBeLessThan(Math.hypot(free.vx, free.vy))
  })
})

describe('the pass game is untouched', () => {
  it('a lineman on a pass play is still a rusher, not a run defender', () => {
    const back = rb('rb1', 30, 33)
    const d    = dl('dl1', 30, 35.5)
    // No ballCarrierId and playType 'pass' → findBallCarrier returns null, so none of the run-fit
    // code runs at all and the rush owns the lineman.
    const state = makeState({ offense: [back], defense: [d], playType: 'pass' })

    run(state, 6)
    expect(d.runDefRole).toBeUndefined()
  })
})
