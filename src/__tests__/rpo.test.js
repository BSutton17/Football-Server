import { describe, it, expect } from '@jest/globals'
import { runRpo, resetRpo, rpoReadOpen, cancelRpo, RPO_READ_WINDOW } from '../game/systems/rpo.js'
import { runMovement } from '../game/systems/movement.js'
import { isManualPlay } from '../game/manual.js'
import { GAME_MODE } from '../constants.js'

// [rpo] A pass for the first second, a run after that if nobody throws. The three rules that
// define it: the back meshes and waits, the line never works downfield, and the window is measured
// in LIVE PLAY time so a manual-mode freeze can't burn it.
//
// dir=+1, yardLine=25 → losY=35; the offense runs north.

const DT = 0.05
const LOS = 35

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], playType = 'rpo', mode = GAME_MODE.AUTOMATIC } = {}) {
  const s = {
    roomId: 'rpo-test',
    direction: 1,
    yardLine: 25,
    mode,
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    defenseCoverage: new Map(),
    playerFatigue: new Map(),
    playDesign: { playType, runAngle: 0 },
    ballCarrierId: null,
    targetReceiverId: null,
    activeThrow: null,
    catchSpot: null,
  }
  resetRpo(s)
  return s
}

const emits = []
const io = { to: () => ({ emit: (event, payload) => emits.push({ event, payload }) }) }

const qb = () => ({ id: 'qb1', label: 'QB', x: 26, y: LOS - 2, vx: 0, vy: 0, isEngaged: false })
const rb = () => ({ id: 'rb1', label: 'RB', x: 26, y: LOS - 5, vx: 0, vy: 0, isEngaged: false })
const ol = (id, x) => ({ id, label: 'OL', x, y: LOS, vx: 0, vy: 0, isEngaged: false, passBlockAnchorX: null, passBlockAnchorY: null })
const dl = (id, x, y) => ({ id, label: 'DL', x, y, vx: 0, vy: 0, isEngaged: false })

// Run the window forward by `seconds` of LIVE play. Counts whole ticks rather than accumulating a
// float, which otherwise drifts into an extra tick and makes the boundary assertions lie.
function advance(state, seconds) {
  const ticks = Math.round(seconds / DT)
  for (let i = 0; i < ticks; i++) runRpo(state, io, DT)
}

describe('rpo — the read window', () => {
  it('stays open for the first second and then hands off', () => {
    const state = makeState({ offense: [qb(), rb()] })

    expect(rpoReadOpen(state)).toBe(true)
    advance(state, RPO_READ_WINDOW - 0.1)
    expect(rpoReadOpen(state)).toBe(true)
    expect(state.ballCarrierId).toBeNull()

    advance(state, 0.2)
    expect(rpoReadOpen(state)).toBe(false)
    expect(state.ballCarrierId).toBe('rb1')
  })

  it('announces the handoff so the offense stops being offered a throw', () => {
    emits.length = 0
    const state = makeState({ offense: [qb(), rb()] })
    advance(state, RPO_READ_WINDOW + 0.1)
    expect(emits).toContainEqual({ event: 'rpo_handoff', payload: { carrierId: 'rb1' } })
  })

  it('a throw closes the window — the ball can never be handed off behind it', () => {
    const state = makeState({ offense: [qb(), rb()] })
    advance(state, 0.5)
    cancelRpo(state)
    advance(state, 2)
    expect(state.ballCarrierId).toBeNull()
    expect(rpoReadOpen(state)).toBe(false)
  })

  it('does nothing on a plain run or pass', () => {
    for (const playType of ['run', 'pass']) {
      const state = makeState({ offense: [qb(), rb()], playType })
      expect(state.rpo).toBeNull()
      advance(state, 3)
      expect(state.ballCarrierId).toBeNull()
    }
  })
})

describe('rpo — the mesh', () => {
  it('the back holds his spot while the read is live', () => {
    const state = makeState({ offense: [qb(), rb()] })
    const back = state.offensePlayers.get('rb1')
    const y0 = back.y

    for (let i = 0; i < 10; i++) { runRpo(state, io, DT); runMovement(state, null, DT) }

    expect(rpoReadOpen(state)).toBe(true)
    expect(Math.abs(back.y - y0)).toBeLessThan(0.2)
  })

  it('…and takes off once the ball is handed to him', () => {
    const state = makeState({ offense: [qb(), rb()] })
    const back = state.offensePlayers.get('rb1')

    for (let i = 0; i < 40; i++) { runRpo(state, io, DT); runMovement(state, null, DT) }

    expect(state.ballCarrierId).toBe('rb1')
    expect(back.vy).toBeGreaterThan(0)
  })

  it('the QB reads from the mesh rather than dropping eight yards', () => {
    const rpoState  = makeState({ offense: [qb(), rb()] })
    const passState = makeState({ offense: [qb(), rb()], playType: 'pass' })

    for (let i = 0; i < 20; i++) {
      runRpo(rpoState, io, DT); runMovement(rpoState, null, DT)
      runMovement(passState, null, DT)
    }

    const rpoDepth  = LOS - rpoState.offensePlayers.get('qb1').y
    const passDepth = LOS - passState.offensePlayers.get('qb1').y
    expect(rpoDepth).toBeLessThan(passDepth)
  })
})

describe('rpo — the line never works downfield', () => {
  it('a run blocker with nobody to block holds at the line instead of climbing', () => {
    const rpoState = makeState({ offense: [qb(), rb(), ol('ol1', 26)] })
    const runState = makeState({ offense: [qb(), rb(), ol('ol1', 26)], playType: 'run' })

    for (let i = 0; i < 30; i++) {
      runRpo(rpoState, io, DT); runMovement(rpoState, null, DT)
      runMovement(runState, null, DT)
    }

    const rpoOl = rpoState.offensePlayers.get('ol1')
    const runOl = runState.offensePlayers.get('ol1')
    expect(rpoOl.y).toBeLessThanOrEqual(LOS + 1.2)   // capped at RPO_LINE_DEPTH
    expect(runOl.y).toBeGreaterThan(rpoOl.y)          // a called run releases to the second level
  })

  it('but still blocks a man on the line', () => {
    const state = makeState({ offense: [qb(), rb(), ol('ol1', 26)], defense: [dl('dl1', 26, LOS + 1.5)] })

    runRpo(state, io, DT)
    runMovement(state, null, DT)

    expect(state.offensePlayers.get('ol1').blockAssignmentId).toBe('dl1')
    expect(state.offensePlayers.get('ol1').vy).toBeGreaterThan(0)
  })
})

describe('rpo — manual mode', () => {
  it('arms the GO hold loop, so the window only runs while GO is held', () => {
    const manual = makeState({ offense: [qb(), rb()], mode: GAME_MODE.MANUAL })
    expect(isManualPlay(manual)).toBe(true)

    // A frozen tick never reaches runRpo at all (simulation.js returns early on a stoppage), so
    // holding the freeze for any length of time leaves the window exactly where it was.
    const before = manual.rpo.elapsed
    expect(before).toBe(0)
    advance(manual, 0.5)
    expect(manual.rpo.elapsed).toBeCloseTo(0.5, 5)
    expect(rpoReadOpen(manual)).toBe(true)
  })

  it('a manual RUN still plays itself out as before', () => {
    const run = makeState({ offense: [qb(), rb()], playType: 'run', mode: GAME_MODE.MANUAL })
    expect(isManualPlay(run)).toBe(false)
  })
})
