import { describe, it, expect } from '@jest/globals'
import { createController } from '../ai/controller.js'
import { estimateOpenness, rankTargets } from '../ai/reads.js'
import { createKnowledge, applyEvent } from '../ai/knowledge.js'

// [offline] The quarterback has to actually throw the ball.
//
// He did not, in the first real game played against this AI: two plays, two sacks, the ball never
// leaving his hand. Two independent causes, either of which alone is fatal:
//
//   1. The room was MEDIUM difficulty, and `HIDES_OPENNESS` withholds the openness score from the
//      offense on medium and hard. The throw gate compared `openness >= 0.55`, `openness` was
//      undefined, and the comparison was false forever.
//
//   2. The room was MANUAL, where a throw is legal ONLY while the board is frozen — and the AI
//      never released GO, so the board never froze and the window never opened.
//
// These tests pin both, and are written against the CONTROLLER rather than the helpers so they
// cover the wiring as well as the arithmetic.

const LOS = 40

// A socket-shaped stub that records what the AI fires.
function stubSocket() {
  const fired = []
  return {
    fired,
    fire(event, payload) { fired.push({ event, payload }); return true },
    of(event) { return fired.filter(f => f.event === event) },
    last(event) { const m = this.of(event); return m.length ? m[m.length - 1].payload : null },
    clear() { fired.length = 0 },
  }
}

const ROSTER = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'wr' + i, position: 'WR', ovr: 90 - i })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: 'te' + i, position: 'TE', ovr: 85 - i })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: 'rb' + i, position: 'RB', ovr: 88 - i })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'cb' + i, position: 'CB', ovr: 84 - i })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: 's' + i, position: 'S', ovr: 82 - i })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: 'lb' + i, position: 'LB', ovr: 83 - i })),
]

// Puts a controller into a live PASS play as the offense, in the given room settings.
//
// The play type is the AI's own choice, so the seed is searched until it calls a pass — a run
// returns from onLive immediately (correctly: a run has no throw), and a test that happened to
// land on one would silently assert nothing.
function liveOffense({ mode = 'automatic', difficulty = 'medium' } = {}) {
  const situation = (phase, playClock) => ({
    phase, role: 'offense', down: 3, distance: 12, yardLine: LOS,
    clock: 600, playClock, quarter: 1, score: { own: 0, opp: 0 }, mode, difficulty, playSerial: 1,
  })

  for (let seed = 1; seed < 60; seed++) {
    const socket = stubSocket()
    const ai = createController({ socket, slot: 1, roster: ROSTER, seed })
    ai.onEvent('game_state', situation('pre_snap', 30))
    if (ai.lastCall?.playType !== 'pass') continue

    // Force the set out (it is normally held until the play clock reaches its chosen moment).
    ai.onEvent('play_clock_update', { playClock: 4 })
    // ⚠️ The snap is `ball_snapped` and NOTHING ELSE. The server does not send a game_state when a
    // play goes live — the next one arrives after the whistle. An earlier version of this helper
    // faked a live game_state, which is a state the server never produces, and so the tests passed
    // against a controller that could not throw in a real game.
    ai.onEvent('ball_snapped', { manual: mode === 'manual' })
    socket.clear()
    return { socket, ai }
  }
  throw new Error('no seed produced a pass call')
}

// A frame of live positions: one wide-open receiver, one smothered, the passer, and coverage.
// `openness` is supplied only when the difficulty would send it.
function frame({ withOpenness = false, openReady = true } = {}) {
  const p = [
    { id: 'qb', team: 'o', x: 26, y: LOS - 6, state: 'ball' },
    { id: 'wr0', team: 'o', x: 8, y: LOS + 12, ready: openReady },     // alone
    { id: 'wr1', team: 'o', x: 44, y: LOS + 10, ready: true },         // blanketed
    { id: 'cb0', team: 'd', x: 44.4, y: LOS + 10.3 },
    { id: 'cb1', team: 'd', x: 30, y: LOS + 6 },
    { id: 's0', team: 'd', x: 26, y: LOS + 20 },
  ]
  if (withOpenness) {
    p[1].openness = 0.85
    p[2].openness = 0.12
  }
  return p
}

describe('reading the field without being told', () => {
  it('scores a receiver with nobody near him as open', () => {
    const defenders = [{ x: 40, y: LOS + 2 }]
    const qb = { x: 26, y: LOS - 6 }
    expect(estimateOpenness({ x: 8, y: LOS + 12 }, defenders, qb)).toBeGreaterThan(0.8)
  })

  it('scores a blanketed receiver as covered', () => {
    const defenders = [{ x: 44.4, y: LOS + 10.3 }]
    const qb = { x: 26, y: LOS - 6 }
    expect(estimateOpenness({ x: 44, y: LOS + 10 }, defenders, qb)).toBeLessThan(0.2)
  })

  it('a defender standing in the throwing lane closes an otherwise open receiver', () => {
    const qb = { x: 26, y: LOS - 6 }
    const receiver = { x: 26, y: LOS + 12 }
    const clear = estimateOpenness(receiver, [{ x: 45, y: LOS }], qb)
    const blocked = estimateOpenness(receiver, [{ x: 26, y: LOS + 3 }], qb)
    expect(clear).toBeGreaterThan(0.8)
    expect(blocked).toBeLessThan(0.25)
  })

  it('defers to the server score when there is one, and estimates when there is not', () => {
    const k = createKnowledge(1)
    k.role = 'offense'
    applyEvent(k, 'positions_update', frame({ withOpenness: true }))
    const [best] = rankTargets(k)
    expect(best.id).toBe('wr0')
    expect(best.estimated).toBe(false)
    expect(best.score).toBe(0.85)

    const k2 = createKnowledge(1)
    k2.role = 'offense'
    applyEvent(k2, 'positions_update', frame({ withOpenness: false }))
    const [best2] = rankTargets(k2)
    expect(best2.id).toBe('wr0')
    expect(best2.estimated).toBe(true)
    expect(best2.score).toBeGreaterThan(0.6)
  })

  it('never offers a receiver who has not declared his route', () => {
    const k = createKnowledge(1)
    k.role = 'offense'
    applyEvent(k, 'positions_update', frame({ openReady: false }))
    expect(rankTargets(k).map(t => t.id)).not.toContain('wr0')
  })
})

describe('automatic rooms', () => {
  it('throws on medium, where the server sends no openness at all', () => {
    const { socket, ai } = liveOffense({ mode: 'automatic', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', frame({ withOpenness: false }))
    const throws = socket.of('throw_to_receiver')
    expect(throws.length).toBeGreaterThan(0)
    expect(throws[0].payload).toBe('wr0')
  })

  it('throws on easy too, using the score it is given', () => {
    const { socket, ai } = liveOffense({ mode: 'automatic', difficulty: 'easy' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', frame({ withOpenness: true }))
    expect(socket.of('throw_to_receiver')[0]?.payload).toBe('wr0')
  })

  it('throws once, not once per tick', () => {
    const { socket, ai } = liveOffense()
    for (let i = 0; i < 120; i++) ai.onEvent('positions_update', frame())
    expect(socket.of('throw_to_receiver')).toHaveLength(1)
  })

  it('will not throw at a covered receiver early, but settles for one late', () => {
    const covered = () => ([
      { id: 'qb', team: 'o', x: 26, y: LOS - 6, state: 'ball' },
      { id: 'wr1', team: 'o', x: 44, y: LOS + 10, ready: true },
      { id: 'cb0', team: 'd', x: 45.8, y: LOS + 11 },
    ])
    const { socket, ai } = liveOffense()
    for (let i = 0; i < 5; i++) ai.onEvent('positions_update', covered())
    expect(socket.of('throw_to_receiver')).toHaveLength(0)   // still waiting for something better

    for (let i = 0; i < 90; i++) ai.onEvent('positions_update', covered())
    expect(socket.of('throw_to_receiver')).toHaveLength(1)   // …but the rush is coming
  })
})

describe('manual rooms', () => {
  it('releases GO so the board can freeze — the window a throw needs', () => {
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', frame())
    expect(socket.of('go_release').length).toBeGreaterThan(0)
    // …and it has NOT thrown yet, because in manual a moving board is not a legal window.
    expect(socket.of('throw_to_receiver')).toHaveLength(0)
  })

  it('throws while frozen', () => {
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', frame())
    ai.onEvent('manual_frozen', {})
    expect(socket.of('throw_to_receiver')[0]?.payload).toBe('wr0')
  })

  it('starts the board again when nobody is open, rather than standing there', () => {
    const smothered = () => ([
      { id: 'qb', team: 'o', x: 26, y: LOS - 6, state: 'ball' },
      { id: 'wr1', team: 'o', x: 44, y: LOS + 10, ready: true },
      { id: 'cb0', team: 'd', x: 44.1, y: LOS + 10.1 },
      { id: 'cb1', team: 'd', x: 26, y: LOS + 3 },
    ])
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', smothered())
    ai.onEvent('manual_frozen', {})
    expect(socket.of('throw_to_receiver')).toHaveLength(0)
    expect(socket.of('go_press').length).toBeGreaterThan(0)
  })

  it('knows the play is live from ball_snapped alone', () => {
    // The regression this whole file exists for: with only game_state to go on, the AI's phase sat
    // on 'countdown' for the entire play and every live decision was unreachable.
    const socket = stubSocket()
    const ai = createController({ socket, slot: 1, roster: ROSTER, seed: 4 })
    ai.onEvent('game_state', {
      phase: 'pre_snap', role: 'offense', down: 3, distance: 12, yardLine: LOS,
      clock: 600, playClock: 30, quarter: 1, score: { own: 0, opp: 0 },
      mode: 'automatic', difficulty: 'medium', playSerial: 1,
    })
    expect(ai.knowledge.phase).toBe('pre_snap')
    ai.onEvent('ball_snapped', { manual: false })
    expect(ai.knowledge.phase).toBe('live')
  })

  it('takes the manual flag from the server, not from the room mode', () => {
    // A manual ROOM still runs its RUN plays the ordinary way, so the room mode is the wrong
    // question — only the server knows whether THIS play is GO-driven.
    const socket = stubSocket()
    const ai = createController({ socket, slot: 1, roster: ROSTER, seed: 4 })
    ai.onEvent('ball_snapped', { manual: false })
    expect(ai.knowledge.manualPlay).toBe(false)
    ai.onEvent('ball_snapped', { manual: true })
    expect(ai.knowledge.manualPlay).toBe(true)
  })

  it('does not release GO on a designed run — a run plays itself out', () => {
    const socket = stubSocket()
    const ai = createController({ socket, slot: 1, roster: ROSTER, seed: 3 })
    ai.onEvent('game_state', {
      phase: 'pre_snap', role: 'offense', down: 1, distance: 1, yardLine: LOS,
      clock: 600, playClock: 4, quarter: 1, score: { own: 0, opp: 0 },
      mode: 'manual', difficulty: 'easy', playSerial: 1,
    })
    // Short yardage from a heavy look is a run call; if this seed picked otherwise, skip.
    if (ai.lastCall?.playType !== 'run') return
    ai.onEvent('ball_snapped', { manual: false })   // a run is never GO-driven, even in a manual room
    socket.clear()
    for (let i = 0; i < 60; i++) ai.onEvent('positions_update', frame())
    expect(socket.of('go_release')).toHaveLength(0)
  })
})

describe('⚠️ ON THIRD DOWN, OPEN IS NOT THE SAME AS USEFUL', () => {
  // Ranking purely by openness meant that on 3rd and 15 the wide-open checkdown at four yards beat
  // the covered receiver at sixteen every time: the quarterback took the completion and the drive
  // ended anyway. Measured over 191 snaps of 3rd and 14, the sticks read took it from 3.04 yds/play
  // and a 2% conversion rate to 5.78 and 11%.
  const at = (id, y, openness) => ({ id, team: 'o', x: 26, y, ready: true, openness })
  const field = (down, distance) => {
    const live = new Map()
    live.set('qb', { id: 'qb', team: 'o', x: 26, y: 34, carrier: true })
    for (const p of [at('check', 44, 0.85), at('mid', 50, 0.55), at('deep', 57, 0.40)]) live.set(p.id, p)
    return { down, distance, yardLine: 40, live }
  }

  it('discounts a catch that cannot convert', () => {
    const ranked = rankTargets(field(3, 15))
    const check = ranked.find(t => t.id === 'check')
    expect(check.shortOfSticks).toBe(true)
    expect(check.score).toBeLessThan(check.trueScore * 0.7)
  })

  it('⚠️ SCALES WITH HOW FAR SHORT, not merely short at all', () => {
    // A flat discount treated a ten-yard catch on 3rd and 12 like a two-yard one, and the passer
    // stopped throwing it at all — wrong twice over, since it makes 4th and 2 instead of 4th and 10
    // and a sack is worse than either.
    const ranked = rankTargets(field(3, 15))
    const near = ranked.find(t => t.id === 'mid')
    const far = ranked.find(t => t.id === 'check')
    expect(near.score / near.trueScore).toBeGreaterThan(far.score / far.trueScore)
  })

  it('leaves a receiver past the sticks alone', () => {
    const deep = rankTargets(field(3, 15)).find(t => t.id === 'deep')
    expect(deep.shortOfSticks).toBe(false)
    expect(deep.score).toBeCloseTo(deep.trueScore, 5)
  })

  it('does nothing on a down that does not end the drive', () => {
    for (const t of rankTargets(field(1, 15))) {
      expect(t.shortOfSticks).toBe(false)
      expect(t.score).toBeCloseTo(t.trueScore, 5)
    }
  })

  it('does nothing on 3rd and 1, where everyone is past the sticks', () => {
    for (const t of rankTargets(field(3, 1))) expect(t.shortOfSticks).toBe(false)
  })
})
