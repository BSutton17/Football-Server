import { describe, it, expect } from '@jest/globals'
import { createController } from '../ai/controller.js'
import { estimateOpenness, rankTargets, orderKey, developedFraction } from '../ai/reads.js'
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
function liveOffense({ mode = 'automatic', difficulty = 'medium', down = 3, distance = 12 } = {}) {
  const situation = (phase, playClock) => ({
    phase, role: 'offense', down, distance, yardLine: LOS,
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

// ── He waits for the play to exist ([qb]) ───────────────────────────────────
//
// Both halves of the fix for "the QB is still throwing very fast and not letting plays develop",
// measured paired on identical seeds in MANUAL mode, which is the mode the game is played in:
//
//     3rd & 8    +1.08 ± 0.38 yds   conversions 26% -> 44%   sacks 3% -> 6%
//     3rd & 12   +1.21 ± 0.43 yds   conversions 24% -> 31%   sacks 6% -> 8%
//     1st & 10   +0.26 ± 0.09 yds   (the gate alone; the minimum hold does not apply)
//
// and the behaviour itself, from scripts/releaseLab.mjs: receivers declared at the moment of release
// 3.11 -> 4.18, and throws going out with two or fewer in existence 42% -> 10%.
describe('the quarterback waits for the play to develop', () => {
  // One receiver broken open at once, three still running. This is the shape that produced the
  // complaint: the first short route declares, reads WIDE open because nobody is near him, and the ball
  // is gone at 0.8s while the rest of the play has not happened.
  // ⚠️ THE COVERAGE HERE IS MARGINAL ON PURPOSE, four yards off, and that is the whole point of the
  // test. A receiver with SIX yards of space is thrown to at frame 13 either way and should be: this
  // gate exists to stop the marginal early throw, not every early throw. Swept across the separations:
  //
  //     defender    0.5-3 yds   never thrown, either arm (he is covered)
  //     defender    4 yds       frame 17 -> 27  with the gate
  //     defender    4.5 yds     frame 16 -> 22
  //     defender    6+ yds      frame 13, unchanged (wide open, take it)
  const oneReady = () => ([
    { id: 'qb',  team: 'o', x: 26, y: LOS - 6, state: 'ball', qb: true },
    { id: 'rb0', team: 'o', x: 18, y: LOS + 2,  ready: true },
    { id: 'wr0', team: 'o', x: 44, y: LOS + 9,  ready: false },
    { id: 'wr1', team: 'o', x: 8,  y: LOS + 11, ready: false },
    { id: 'te0', team: 'o', x: 34, y: LOS + 7,  ready: false },
    { id: 'cb0', team: 'd', x: 22, y: LOS + 2 },        // four yards off the only declared receiver
  ])
  const allReady = () => oneReady().map(p => (p.ready === false ? { ...p, ready: true } : p))

  const framesUntilThrow = (gateOff, frame, n = 20) => {
    const prev = process.env.QB_DEVELOP_GATE
    if (gateOff) process.env.QB_DEVELOP_GATE = '0'
    else delete process.env.QB_DEVELOP_GATE
    try {
      const { socket, ai } = liveOffense({ down: 1, distance: 10 })
      for (let i = 0; i < n; i++) ai.onEvent('positions_update', frame())
      return socket.of('throw_to_receiver').length
    } finally {
      if (prev === undefined) delete process.env.QB_DEVELOP_GATE
      else process.env.QB_DEVELOP_GATE = prev
    }
  }

  it('holds a marginal throw that it used to make, while only one receiver has broken', () => {
    expect(framesUntilThrow(true, oneReady)).toBeGreaterThan(0)   // without the gate, the ball is gone
    expect(framesUntilThrow(false, oneReady)).toBe(0)             // with it, he is still looking
  })

  // A receiver with real space is thrown to at once, gate or no gate. Waiting on a man who is already
  // open is not patience, it is a sack.
  it('still takes a wide-open man immediately', () => {
    const open = () => oneReady().map(p => (p.id === 'cb0' ? { ...p, x: 30 } : p))
    expect(framesUntilThrow(false, open, 16)).toBeGreaterThan(0)
  })

  it('…and throws once the rest of the play arrives', () => {
    const { socket, ai } = liveOffense({ down: 1, distance: 10 })
    for (let i = 0; i < 18; i++) ai.onEvent('positions_update', oneReady())
    for (let i = 0; i < 18; i++) ai.onEvent('positions_update', allReady())
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
  })

  // ⚠️ AND IT MUST NOT BE A DEADLOCK. If the routes never come open the bar has to fall anyway, or a
  // quarterback stands still for ever on a play where nobody gets free. `t` is its own floor for
  // exactly this, and past his patience time counts in full.
  it('gives up waiting once his patience is spent, even if nobody else breaks', () => {
    const { socket, ai } = liveOffense({ down: 1, distance: 10 })
    for (let i = 0; i < 120; i++) ai.onEvent('positions_update', oneReady())
    expect(socket.of('throw_to_receiver').length + socket.of('throwaway').length).toBeGreaterThan(0)
  })
})

// ── He throws to a man who is actually OPEN ([qb]) ──────────────────────────
//
// ⚠️ THE CATCH MODEL IS A STEP, AND THE READ WAS CONTINUOUS. At OPENNESS_OPEN and above a throw is
// caught 95% of the time; anywhere from 0.33 to 0.66 it is 45% — so an 0.55 window and an 0.64 window
// are THE SAME THROW, and the gap between 0.64 and 0.66 is fifty points of completion. Scoring targets
// on continuous openness meant optimising a number the engine cannot see.
//
// Measured over a real game: on 38% of his throws an open man was available and he found him, but only
// 35% of his throws went to one at all. He was not missing open men — he was releasing when there were
// none, because 0.60 looked good enough against a continuous bar.
//
// Paired, manual, two holdout seed sets: 3rd & 8 +0.64 ± 0.29 yds / +4.4pp, 3rd & 12 +0.96 ± 0.32 /
// +3.2pp, 2nd & 8 +0.40 ± 0.13. Incompletions fell 22% → 17% and interceptions 3% → 2%, sacks flat.
describe('early on, the target has to clear the open step', () => {
  const LOS2 = LOS
  // One declared receiver, covered at the given separation, and nobody else. The AI's own estimate of
  // openness is separation-based, so the distance is the dial.
  const lone = (sep) => () => ([
    { id: 'qb',  team: 'o', x: 26, y: LOS2 - 6, state: 'ball', qb: true },
    { id: 'wr0', team: 'o', x: 44, y: LOS2 + 14, ready: true },
    { id: 'cb0', team: 'd', x: 44 + sep, y: LOS2 + 14 },
  ])

  const threwBy = (frames, sep, gateOff = false) => {
    const prev = process.env.QB_OPEN_UNTIL
    if (gateOff) process.env.QB_OPEN_UNTIL = '0'
    try {
      const { socket, ai } = liveOffense({ down: 1, distance: 10, difficulty: 'hard' })
      for (let i = 0; i < frames; i++) ai.onEvent('positions_update', lone(sep)())
      return socket.of('throw_to_receiver').length
    } finally {
      if (prev === undefined) delete process.env.QB_OPEN_UNTIL
      else process.env.QB_OPEN_UNTIL = prev
    }
  }

  // ⚠️ THE SEPARATIONS STRADDLE THE STEP ON THE AI'S OWN SCALE, which is what matters here: its
  // estimate is separation / OPEN_SEPARATION, and OPEN_SEPARATION is six. So 3.5 yards reads 0.58 (the
  // 45% band) and 4.5 reads 0.75 (open). Four yards is 0.667 -- just OVER the line -- which is what the
  // first version of this test picked, and it failed for being right about the engine and wrong about
  // the arithmetic.
  it('holds a throw that would land in the 45% band', () => {
    expect(threwBy(20, 3.5, true)).toBeGreaterThan(0)   // without the gate the ball goes
    expect(threwBy(20, 3.5)).toBe(0)                    // with it he keeps looking
  })

  it('takes a man who clears it at once', () => {
    expect(threwBy(20, 4.5)).toBeGreaterThan(0)
  })

  // ⚠️ AND IT LETS GO LATE, or it would be sacks. Past the relax point a 45% throw beats a sack.
  it('settles for the covered man once the play is spent', () => {
    expect(threwBy(120, 3.5)).toBeGreaterThan(0)
  })
})

describe('the minimum hold is longer when a short throw cannot convert', () => {
  // Everybody open, so the only thing deciding when the ball goes is the floor.
  const wideOpen = () => ([
    { id: 'qb',  team: 'o', x: 26, y: LOS - 6, state: 'ball', qb: true },
    { id: 'rb0', team: 'o', x: 18, y: LOS + 2, ready: true },
    { id: 'wr0', team: 'o', x: 44, y: LOS + 9, ready: true },
  ])

  // ⚠️ A SCREEN STILL HAS TO GO EARLY, which is why this is conditioned on the down needing real yards
  // rather than applied to every snap.
  it('lets it go early on 1st and 10', () => {
    const { socket, ai } = liveOffense({ down: 1, distance: 10 })
    for (let i = 0; i < 16; i++) ai.onEvent('positions_update', wideOpen())   // 0.8s
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
  })

  it('and on 3rd and 2, where a short throw is the whole job', () => {
    const { socket, ai } = liveOffense({ down: 3, distance: 2 })
    for (let i = 0; i < 16; i++) ai.onEvent('positions_update', wideOpen())
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
  })

  // On 3rd and 8 a ball out at 0.8s cannot convert whatever happens to it.
  it('but not on 3rd and 8 — and then it does', () => {
    const { socket, ai } = liveOffense({ down: 3, distance: 8 })
    for (let i = 0; i < 16; i++) ai.onEvent('positions_update', wideOpen())   // 0.8s
    expect(socket.of('throw_to_receiver')).toHaveLength(0)
    for (let i = 0; i < 16; i++) ai.onEvent('positions_update', wideOpen())   // past 1.2s
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
  })
})

describe('manual rooms', () => {
  // ⚠️ THIS USED TO ASSERT THE OPPOSITE: that it had NOT thrown, because a moving board was not a
  // legal window. The freeze rule is lifted for AI seats now -- it stops a HUMAN firing into moving
  // traffic, and did the reverse to the computer, leaving it two or three chances to act against
  // roughly forty-seven in automatic. 59% of the sacks it took in manual came on plays where a
  // receiver reached 0.6 openness. See validation.js: mayThrowWhileMoving.
  it('throws on a moving board rather than waiting for a freeze', () => {
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', frame())
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
  })

  it('still works the GO button, so the mode keeps its rhythm', () => {
    // Nobody open: it should be running the board rather than sitting on a dead freeze.
    const smothered = () => ([
      { id: 'qb', team: 'o', x: 26, y: LOS - 6, state: 'ball', qb: true },
      { id: 'wr1', team: 'o', x: 44, y: LOS + 10, ready: true },
      { id: 'cb0', team: 'd', x: 44.1, y: LOS + 10.1 },
    ])
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'medium' })
    for (let i = 0; i < 40; i++) ai.onEvent('positions_update', smothered())
    expect(socket.of('go_release').length).toBeGreaterThan(0)
  })

  // ⚠️ THE MANUAL RE-RANK DISCARDED THE WHOLE CONVERSION PREFERENCE, and nothing noticed because
  // every other test of it calls rankTargets directly. This path re-sorts on where each receiver is
  // HEADING, and it sorted on the score alone -- so "go for the first down rather than the checkdown"
  // worked in automatic and did nothing in the mode the game is actually played in. Both sorts go
  // through orderKey now, and this is the test that would have caught it.
  it('still prefers the first down over the shorter throw after the anticipation re-rank', () => {
    // 3rd and 12 from the 40, so the sticks are at 52. One receiver alone at SIX yards -- the throw
    // that was the complaint -- and one past the marker with a defender two yards off him. The deep
    // one is deliberately the LOWER-scoring of the two (0.36 against 0.51), so the only thing that can
    // put him first is the tier.
    //
    // ⚠️ HARD, SO THE READ CARRIES NO NOISE. On medium the 0.12 of readNoise can push the covered
    // receiver under the tier floor, and the test then passes or fails on the seed.
    const sticksVsShort = () => ([
      { id: 'qb',  team: 'o', x: 26, y: LOS - 6, state: 'ball', qb: true },
      { id: 'rb0', team: 'o', x: 18, y: LOS + 6,  ready: true },        // nobody within ten yards
      { id: 'wr0', team: 'o', x: 44, y: LOS + 13, ready: true },        // past the sticks, covered
      { id: 'cb0', team: 'd', x: 46.1, y: LOS + 13.4 },
    ])
    const { socket, ai } = liveOffense({ mode: 'manual', difficulty: 'hard' })
    for (let i = 0; i < 90; i++) ai.onEvent('positions_update', sticksVsShort())
    ai.onEvent('manual_frozen', {})
    expect(socket.of('throw_to_receiver').length).toBeGreaterThan(0)
    expect(socket.of('throw_to_receiver')[0].payload).toBe('wr0')
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

  it('⚠️ BITES ON AN EARLY DOWN TOO, BUT GENTLY', () => {
    // It used to be gated to 3rd and 4th, so on 1st and 10 a completion at the line of scrimmage
    // was worth exactly as much as one past the marker — and the first body to come open two yards
    // downfield got the ball. A checkdown on 1st and 10 is still a perfectly good football play,
    // which is why the floor is higher here than on a down that ends the drive.
    const early = rankTargets(field(1, 15)).filter(t => t.shortOfSticks)
    expect(early.length).toBeGreaterThan(0)
    for (const t of early) {
      expect(t.score).toBeLessThan(t.trueScore)
      expect(t.score).toBeGreaterThan(t.trueScore * 0.65)   // gentler than the 0.40 of 3rd down
    }
  })

  it('…and harder on a down that must convert', () => {
    const atLos = (down) => {
      const t = rankTargets(field(down, 15)).filter(x => x.shortOfSticks)
      return t.length ? Math.min(...t.map(x => x.score / x.trueScore)) : 1
    }
    expect(atLos(3)).toBeLessThan(atLos(1))
  })

  it('does nothing on 3rd and 1, where everyone is past the sticks', () => {
    for (const t of rankTargets(field(3, 1))) expect(t.shortOfSticks).toBe(false)
  })
})

// ── Going for the first down instead of the checkdown ([qb]) ────────────────
//
// Asked for: "make the QB prefer to pick up a first down, especially on 3rd down, instead of just
// throwing checkdowns. In fact checkdowns should usually be the last thing the QB considers."
//
// ⚠️ THE OBVIOUS READING OF THAT COMPLAINT WAS WRONG, and measuring first is the only reason the fix
// works. He was not favouring the back in the flat: of 48 throws on 3rd and 8, a true checkdown (three
// yards or less) was 8% of them, and the mean throw was 6.2 air yards — 6, 6, 6, over and over, which
// is the depth a route sits at when it first DECLARES. He was releasing before anyone could reach the
// marker. The ordering was barely the problem; the linear discount was, because six yards of an
// eight-yard need kept 85% of its value and cleared the bar instantly.
//
// Measured paired on identical seeds, two separate holdout seed sets, and in BOTH modes:
//
//     automatic  3rd & 8    +15.3pp converted  +1.22 ± 0.39 yds   sacks 1% -> 4%
//     automatic  3rd & 12   +10.0pp converted  +2.16 ± 0.44 yds   sacks 10% -> 10%
//     manual     3rd & 8    +12.4pp converted  +1.00 ± 0.42 yds   sacks 0% -> 3%
//     manual     3rd & 12    +6.0pp converted  +0.76 ± 0.31 yds   sacks 6% -> 5%
//
// and the behaviour itself: on 3rd and 8 the mean throw went 5.8 -> 7.1 air yards, throws past the
// sticks 13% -> 31%, checkdowns 10% -> 2%. On 3rd and 12, checkdowns went to nought.
describe('the read is tiered: conversion first, checkdown last', () => {
  // 3rd & 12 from the 30, so the sticks are at 42. A wide-open back at the line, a moderately open
  // receiver short of the marker, and a tighter one past it.
  const tierField = (down, distance, overrides = {}) => {
    const live = new Map([
      ['qb',   { id: 'qb',  team: 'o', qb: true, x: 26, y: 27 }],
      ['rb',   { id: 'rb',  team: 'o', ready: true, x: 20, y: 31, openness: overrides.rb ?? 0.98 }],
      ['mid',  { id: 'mid', team: 'o', ready: true, x: 10, y: 38, openness: overrides.mid ?? 0.60 }],
      ['conv', { id: 'conv', team: 'o', ready: true, x: 40, y: 45, openness: overrides.conv ?? 0.40 }],
    ])
    return { down, distance, yardLine: 30, live }
  }

  it('takes the first down over a more open man who cannot convert', () => {
    const ranked = rankTargets(tierField(3, 12))
    expect(ranked[0].id).toBe('conv')
    expect(ranked[0].tier).toBe(2)
  })

  it('puts the checkdown last, behind a receiver it is more open than', () => {
    const ranked = rankTargets(tierField(3, 12))
    expect(ranked[ranked.length - 1].id).toBe('rb')
    expect(ranked.find(t => t.id === 'rb').tier).toBe(0)
  })

  // ⚠️ A TIER HAS TO BE EARNED, OR THIS JUST THROWS INTERCEPTIONS. A blanketed man past the marker is
  // a turnover, not a conversion.
  it('will not promote a receiver who is smothered, however deep he is', () => {
    const ranked = rankTargets(tierField(3, 12, { conv: 0.05 }))
    expect(ranked[0].id).not.toBe('conv')
    expect(ranked.find(t => t.id === 'conv').tier).toBe(0)
  })

  it('does nothing on 3rd and 1, where converting and checking down are the same throw', () => {
    const ranked = rankTargets(tierField(3, 1))
    expect(ranked[0].id).toBe('rb')          // everybody converts, so openness decides outright
    for (const t of ranked) expect(t.tier).toBe(2)
  })

  // ⚠️ THE MANUAL RE-RANK THREW ALL OF THIS AWAY. controller.js re-sorts on where each receiver is
  // HEADING in a manual room, and it sorted on the score alone — so the preference was live in every
  // mode except the one the game is played in. Both sorts go through orderKey now.
  it('orders by tier first and openness within it, through one shared key', () => {
    // The converter is deliberately the LOWER-SCORING of the two here, so what is being shown is the
    // tier doing the work rather than the discount happening to be enough on its own.
    const ranked = rankTargets(tierField(3, 12, { conv: 0.35 }))
    for (let i = 1; i < ranked.length; i++) {
      expect(orderKey(ranked[i - 1])).toBeGreaterThanOrEqual(orderKey(ranked[i]))
    }
    const rb = ranked.find(t => t.id === 'rb')
    const conv = ranked.find(t => t.id === 'conv')
    // The checkdown is the MORE open of the two and still sorts below it.
    expect(rb.score).toBeGreaterThan(conv.score)
    expect(orderKey(rb)).toBeLessThan(orderKey(conv))
  })
})

// ── Letting the play develop ([qb]) ─────────────────────────────────────────
//
// Reported after a full game: "the QB is still throwing very fast and not letting plays develop."
// The report said exactly how fast. Averaged over the computer's pass plays, by board time:
//
//     time       0.5s   0.8s   1.05s   1.4s   1.6s
//     declared   0.14   0.93   ~1.3    2.16   2.64
//
// He released at a MEDIAN of 1.05s, with about one and a third receivers in existence as targets, and
// on 7 of 13 throws there were two or fewer. ⚠️ SO HE WAS NOT CHOOSING THE SHORT MAN OVER THE FIRST
// DOWN — there was nobody else to choose, which is also why the tiering above could not help: it
// reorders the declared, and almost nobody had declared.
describe('how much of the play exists yet', () => {
  const field = (ready) => ({
    live: new Map([
      ['qb', { id: 'qb', team: 'o', qb: true, x: 26, y: 30 }],
      ...ready.map((r, i) => [`w${i}`, { id: `w${i}`, team: 'o', ready: r, x: 10 + i * 8, y: 40 }]),
      ['cb', { id: 'cb', team: 'd', x: 20, y: 42 }],
    ]),
  })

  it('is nought at the snap and one once everybody has broken', () => {
    expect(developedFraction(field([false, false, false, false]))).toBe(0)
    expect(developedFraction(field([true, true, true, true]))).toBe(1)
  })

  it('counts only pass catchers — not the passer, not the defense', () => {
    expect(developedFraction(field([true, false]))).toBeCloseTo(0.5, 5)
  })

  // A run play has no catchers carrying `ready`; dividing by nothing must not report "undeveloped" and
  // hold a quarterback who has no read to wait for.
  it('reports a developed play when there is nobody to wait for', () => {
    expect(developedFraction({ live: new Map() })).toBe(1)
  })
})

describe('how hard a throw short of the sticks is discounted', () => {
  const at = (id, y, openness) => ({ id, team: 'o', x: 26, y, ready: true, openness })
  // 3rd & 8 from the 40: the sticks are at 48 and the six-yard throw lands at 46.
  const sixYards = (decay = 0) => {
    const live = new Map([
      ['qb', { id: 'qb', team: 'o', qb: true, x: 26, y: 38 }],
      ['six', at('six', 46, 0.95)],
    ])
    return rankTargets({ down: 3, distance: 8, yardLine: 40, live }, { decay }).find(t => t.id === 'six')
  }

  // ⚠️ THE NUMBER THAT WAS THE BUG. Linearly, six of eight yards kept 0.40 + 0.6*0.75 = 85% of its
  // value: 0.81 against a bar it cleared at once. Curved it keeps about 61%.
  it('a six-yard throw on 3rd and 8 no longer scores like a conversion', () => {
    const t = sixYards()
    expect(t.score / t.trueScore).toBeLessThan(0.7)
    // …and it is not crushed to nothing either — a sack is worse than six yards.
    expect(t.score / t.trueScore).toBeGreaterThan(0.45)
  })

  it('still barely touches a throw that nearly gets there', () => {
    const live = new Map([
      ['qb', { id: 'qb', team: 'o', qb: true, x: 26, y: 38 }],
      ['near', at('near', 47.5, 0.8)],
    ])
    const t = rankTargets({ down: 3, distance: 8, yardLine: 40, live }).find(x => x.id === 'near')
    expect(t.score / t.trueScore).toBeGreaterThan(0.85)
  })

  // ⚠️ AND IT LETS GO LATE, WHICH IS WHAT KEEPS IT FROM BEING SACKS. The curve on its own took the
  // sack rate on 3rd and 12 from 11% to 23% over 300 held-out plays: he held out for twelve yards
  // nobody was going to cover. `decay` is the controller's own measure of how much play is left.
  it('gives up the demand entirely once the play is spent', () => {
    const early = sixYards(0)
    const late = sixYards(1)
    expect(late.score).toBeGreaterThan(early.score)
    expect(late.score).toBeCloseTo(late.trueScore, 5)
  })

  it('holds the demand through the early part of the play rather than fading from the snap', () => {
    // Fading from the snap gave back four fifths of the conversions: +2.3pp instead of +10.7pp.
    expect(sixYards(0.3).score).toBeCloseTo(sixYards(0).score, 5)
  })

  it('leaves early downs alone — the curve and the fade are for downs that must convert', () => {
    const live = new Map([
      ['qb', { id: 'qb', team: 'o', qb: true, x: 26, y: 38 }],
      ['six', at('six', 46, 0.95)],
    ])
    const sit = { down: 1, distance: 8, yardLine: 40, live }
    expect(rankTargets(sit, { decay: 0 }).find(t => t.id === 'six').score)
      .toBeCloseTo(rankTargets(sit, { decay: 1 }).find(t => t.id === 'six').score, 5)
  })
})
