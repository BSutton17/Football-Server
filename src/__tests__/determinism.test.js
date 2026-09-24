import { describe, it, expect, afterEach } from '@jest/globals'
import { initGame, deleteGame, getGame } from '../game/gameState.js'
import { initLivePhase } from '../game/systems/init.js'
import { transition, PHASE } from '../game/stateMachine.js'
import { createFakeIo, runPlayToWhistle, fingerprint, stepTicks } from '../headless/harness.js'
import { makeRng, rngOf, isSeeded } from '../game/utils/rng.js'
import { enqueue, EVENT } from '../game/eventQueue.js'
import { resolvePass } from '../game/utils/passOutcome.js'

// [determinism] The point of the whole seeding exercise: the SAME seed must produce the SAME play,
// tick for tick. Without that an AI's fitness score is measuring luck, a training run cannot be
// resumed from a checkpoint, and a bug reported from an offline game cannot be reproduced.
//
// These tests run two games side by side from identical seeds and assert their fingerprints never
// diverge — then assert that a DIFFERENT seed actually does change something, so the first result
// isn't just proving the sim is accidentally deterministic anyway.

const ROOMS = []
function room(id) { ROOMS.push(id); return id }
afterEach(() => { for (const id of ROOMS.splice(0)) deleteGame(id) })

// A minimal but real play: five linemen, a QB, a back, two receivers against a four-man front and
// four defenders in coverage. Enough for sacks, tackles, pancakes and a pass to all be reachable.
function playDesign(losRelY) {
  const players = []
  const push = (id, label, x, y, team) => players.push({ id, label, x, y, team })
  ;[22, 24.5, 26.5, 28.5, 31].forEach((x, i) => push(`ol${i}`, 'OL', x, losRelY, 'o'))
  push('qb1', 'QB', 26.5, losRelY - 5, 'o')
  push('rb1', 'RB', 26.5, losRelY - 7, 'o')
  push('wr1', 'WR', 8,  losRelY, 'o')
  push('wr2', 'WR', 45, losRelY, 'o')
  return { playType: 'pass', runAngle: 0, players }
}

function startPlay(roomId, seed) {
  const state = initGame(roomId, 0, { seed })
  state.playDesign = playDesign(state.yardLine)
  for (const p of state.playDesign.players) {
    state.offensePlayers.set(p.id, {
      id: p.id, label: p.label, x: p.x,
      y: 10 + p.y, vx: 0, vy: 0, isEngaged: false,
    })
  }
  const losY = 10 + state.yardLine
  ;[23, 25.5, 27.5, 30].forEach((x, i) =>
    state.defensePlayers.set(`dl${i}`, { id: `dl${i}`, label: 'DL', x, y: losY + 1.5, vx: 0, vy: 0, isEngaged: false }))
  ;[['cb1', 8, 7], ['cb2', 45, 7], ['s1', 20, 14], ['lb1', 30, 5]].forEach(([id, x, d]) =>
    state.defensePlayers.set(id, { id, label: id.slice(0, 2).toUpperCase(), x, y: losY + d, vx: 0, vy: 0, isEngaged: false }))

  initLivePhase(state)
  // The phase machine only allows PRE_SNAP → COUNTDOWN → LIVE, the same route a real snap takes.
  transition(state, PHASE.COUNTDOWN)
  transition(state, PHASE.LIVE)
  return state
}

// Throws to a receiver through the real event queue, which is what makes resolvePass roll.
function throwTo(roomId, io, receiverId) {
  const state = getGame(roomId)
  const r = state.offensePlayers.get(receiverId)
  state.targetReceiverId = receiverId
  enqueue(roomId, EVENT.THROW, { receiverId, x: r.x, y: r.y })
  stepTicks(roomId, io, 1)
  return getGame(roomId)
}

// How many times the sim drew from the generator. Wraps the stream without changing what it
// yields, so a counted game plays exactly like an uncounted one.
function countDraws(state) {
  const inner = state.rng
  const counter = { n: 0 }
  state.rng = Object.assign(() => { counter.n++; return inner() }, {
    seeded: true, seed: inner.seed, getState: inner.getState, setState: inner.setState,
  })
  return counter
}

describe('a seeded game is replayable', () => {
  it('the same seed resolves a pass the same way, and the stream really is consumed', () => {
    const ioA = createFakeIo(), ioB = createFakeIo()
    const a = startPlay(room('8001'), 20260922)
    const b = startPlay(room('8002'), 20260922)
    expect(isSeeded(a)).toBe(true)

    const drawsA = countDraws(a)
    countDraws(b)

    stepTicks('8001', ioA, 25)
    stepTicks('8002', ioB, 25)
    throwTo('8001', ioA, 'wr1')
    throwTo('8002', ioB, 'wr1')

    // Guards the vacuous version of this test: if nothing rolled, it proves nothing.
    expect(drawsA.n).toBeGreaterThan(0)
    expect(fingerprint(getGame('8002'))).toBe(fingerprint(getGame('8001')))
  })

  it('different seeds give different streams, so outcomes can differ', () => {
    // Asserted on the STREAM, not on one play's outcome: a pass has three outcomes and two seeds
    // landing on the same one is ordinary luck, not a failure of seeding.
    const a = startPlay(room('8003'), 1)
    const b = startPlay(room('8004'), 999999)
    const rollsA = Array.from({ length: 20 }, () => a.rng())
    const rollsB = Array.from({ length: 20 }, () => b.rng())
    expect(rollsB).not.toEqual(rollsA)
  })

  it('replaying one seed reproduces a whole sequence of pass outcomes', () => {
    const run = (id) => {
      const state = startPlay(room(id), 555)
      // The same call onThrow makes, rolled off the game's own stream.
      return Array.from({ length: 24 }, () =>
        resolvePass({ openness: 0.5, qbAccuracy: 80, receiverCatch: 80 }, rngOf(state)).outcome)
    }
    const first = run('8006')
    expect(run('8007')).toEqual(first)
    // …and it is a real mixture, not 24 identical results that would match by accident.
    expect(new Set(first).size).toBeGreaterThan(1)
  })

  it('an unseeded game still runs — production behaviour is unchanged', () => {
    const io = createFakeIo()
    const state = startPlay(room('8005'), null)
    expect(isSeeded(state)).toBe(false)
    expect(state.rng).toBeNull()
    const { ticks } = runPlayToWhistle('8005', io)
    expect(ticks).toBeGreaterThan(0)
  })
})

describe('the generator itself', () => {
  it('is reproducible and stays in range', () => {
    const a = makeRng(7), b = makeRng(7)
    const rolls = Array.from({ length: 500 }, () => a())
    expect(rolls.map(() => b())).toEqual(rolls)
    expect(rolls.every(v => v >= 0 && v < 1)).toBe(true)
  })

  it('resumes mid-stream from its saved state — how a training run checkpoints', () => {
    const live = makeRng(7)
    for (let i = 0; i < 50; i++) live()
    const saved = live.getState()

    const restored = makeRng(1)
    restored.setState(saved)
    expect(Array.from({ length: 20 }, () => restored())).toEqual(Array.from({ length: 20 }, () => live()))
  })

  it('rngOf prefers an explicit override, then the game, then Math.random', () => {
    expect(rngOf({ rng: () => 0.5 }, () => 0.25)()).toBe(0.25)
    expect(rngOf({ rng: () => 0.5 })()).toBe(0.5)
    expect(typeof rngOf(undefined)).toBe('function')
  })

  it('never hands back a degenerate stream, whatever the seed', () => {
    for (const seed of [0, -1, 1, 2 ** 32, 0.5]) {
      const r = makeRng(seed)
      const first = Array.from({ length: 10 }, () => r())
      expect({ seed, ok: first.every(v => v >= 0 && v < 1) }).toEqual({ seed, ok: true })
      expect({ seed, varied: new Set(first).size > 1 }).toEqual({ seed, varied: true })
    }
  })
})
