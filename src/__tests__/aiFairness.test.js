import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame, runPlay } from '../training/game.js'
import { skillFor, allowedShells, AI_SKILL } from '../ai/difficulty.js'
import { chooseShell } from '../ai/defense.js'
import { rankTargets } from '../ai/reads.js'
import { HIDES_OPENNESS, DIFFICULTY } from '../constants.js'
import { createRoom, getRoom, leaveRoomBySlot } from '../game/roomManager.js'

// [offline][difficulty] THE COMPUTER MUST NOT SEE MORE THAN A HUMAN IN ITS SEAT WOULD.
//
// aiBoundary.test.js proves that structurally, by reading the source: nothing in ai/ can reach the
// game state, so the picture can only be what was sent. This file proves the other half
// EMPIRICALLY, on the wire — because the structural argument says nothing about what the server
// CHOOSES to send, and medium and hard are defined by the server sending less.
//
// The specific promise: on medium and hard the offense is denied the receiver-openness read. That
// is the whole meaning of those difficulties for a human, and it has to bind the AI identically,
// or "hard" would quietly mean "the computer plays better AND it can see something you cannot".
//
// ⚠️ Both directions are asserted. A test that only checked "no openness on hard" would pass just
// as happily if openness had been deleted everywhere and the feature were dead.

function capture(ctx, slot) {
  // Tap the seat's inbox. This is the actual wire, so whatever is asserted here is what the AI was
  // physically handed — not what some later layer chose to read.
  const seen = []
  const inner = ctx.seats[slot].emit
  ctx.seats[slot].emit = (event, payload) => {
    if (event === 'positions_update') seen.push(payload)
    return inner(event, payload)
  }
  return seen
}

// Every pass catcher in every frame the seat received. Only catchers carry `ready`.
function receivers(frames) {
  return frames.flat().filter(p => p.ready != null)
}

// ⚠️ Several plays, not one. Openness only exists once a ROUTE HAS DECLARED, so a play the AI
// called as a run produces catchers with `ready: false` and no openness on every frame — on every
// difficulty, including easy. A single-play version of this test pinned a seed that happened to
// draw a run, and the easy control failed while the medium/hard assertions "passed" for entirely
// the wrong reason. Sampling a spread of situations guarantees some passes in the mix.
const SEEDS = [11, 23, 41, 67, 89, 103]

function playSome(difficulty) {
  const frames = []
  let applied = null
  for (const seed of SEEDS) {
    const ctx = createTrainingGame({ seed, difficulty })
    try {
      const offense = ctx.state.possession
      // ⚠️ `capture` returns a live array that runPlay fills. Spreading it into `frames` BEFORE the
      // play has run copies an empty array, and every assertion below then holds vacuously.
      const seen = capture(ctx, offense)
      runPlay(ctx, { possession: offense, down: 1, distance: 10, yardLine: 25, seed })
      frames.push(...seen)
      applied = ctx.state.difficulty
    } finally {
      destroyTrainingGame(ctx)
    }
  }
  return { frames, applied }
}

describe('the openness read reaches the computer on exactly the terms it reaches a human', () => {
  it('EASY: the computer on offense IS sent the read (the control)', () => {
    const { frames, applied } = playSome(DIFFICULTY.EASY)
    expect(applied).toBe(DIFFICULTY.EASY)

    const catchers = receivers(frames)
    expect(catchers.some(p => p.ready === true)).toBe(true)   // routes declared — passes in the mix
    expect(catchers.some(p => p.openness != null)).toBe(true)
  })

  for (const difficulty of [DIFFICULTY.MEDIUM, DIFFICULTY.HARD]) {
    it(`${difficulty.toUpperCase()}: the computer on offense is sent NO openness, on any frame`, () => {
      const { frames, applied } = playSome(difficulty)
      expect(applied).toBe(difficulty)
      expect(HIDES_OPENNESS.has(difficulty)).toBe(true)

      const catchers = receivers(frames)
      // …and the sample is not vacuous: these are the same situations that DO carry openness on
      // easy, so if the read were still being sent it would show up right here.
      expect(catchers.some(p => p.ready === true)).toBe(true)
      expect(catchers.filter(p => p.openness != null)).toEqual([])
    })
  }

  it('readiness still arrives on hard — it is the engine gate, not a hint', () => {
    // Without this the AI could never throw at all: an undeclared receiver is not a legal target
    // and a pass at one is almost always a drop. A human on hard is told the same thing, as a
    // brightness change rather than a color.
    const { frames } = playSome(DIFFICULTY.HARD)
    expect(receivers(frames).some(p => p.ready === true)).toBe(true)
  })
})

describe('difficulty handicaps the computer and never helps it', () => {
  it('the read noise can only move the AI opinion, never the read underneath it', () => {
    const k = {
      live: new Map([
        ['qb',  { id: 'qb',  team: 'o', carrier: true, x: 26, y: 20 }],
        ['wr1', { id: 'wr1', team: 'o', ready: true, x: 10, y: 32 }],
        ['wr2', { id: 'wr2', team: 'o', ready: true, x: 42, y: 32 }],
        ['cb1', { id: 'cb1', team: 'd', x: 10.5, y: 32.5 }],
      ]),
    }
    const clean = rankTargets(k)
    expect(clean.length).toBe(2)
    expect(clean.every(t => t.score === t.trueScore)).toBe(true)

    const noisy = rankTargets(k, { noise: 0.3, rng: () => 0.9 })
    // The underlying read is IDENTICAL — only what the AI thinks of it moved.
    const trueById = new Map(clean.map(t => [t.id, t.trueScore]))
    for (const t of noisy) expect(t.trueScore).toBeCloseTo(trueById.get(t.id), 10)
    expect(noisy.some(t => t.score !== t.trueScore)).toBe(true)
  })

  it('easy is restricted to the vanilla shells and can never call pressure', () => {
    const easy = skillFor(DIFFICULTY.EASY)
    expect(easy.shells).not.toContain('man_blitz_5')
    expect(easy.shells).not.toContain('zone_blitz_5')

    // Across every down and distance and every roll of the dice, easy still never produces a
    // pressure call — except 'prevent', which is a situation every tier is allowed to answer.
    const called = new Set()
    for (let down = 1; down <= 4; down++) {
      for (let distance = 1; distance <= 15; distance++) {
        for (let r = 0; r < 12; r++) {
          const k = {
            difficulty: DIFFICULTY.EASY, down, distance, yardLine: 25,
            quarter: 1, clock: 600, score: { own: 0, opp: 0 },
            opp: new Map([
              ['w1', { id: 'w1', label: 'WR', x: 8,  y: 25 }],
              ['w2', { id: 'w2', label: 'WR', x: 45, y: 25 }],
              ['t1', { id: 't1', label: 'TE', x: 30, y: 25 }],
              ['r1', { id: 'r1', label: 'RB', x: 26, y: 20 }],
            ]),
          }
          called.add(chooseShell(k, () => r / 12))
        }
      }
    }
    for (const id of called) {
      expect(easy.shells.includes(id) || id === 'prevent').toBe(true)
    }
    expect(called.size).toBeGreaterThan(1)      // it is choosing, not stuck on one call
  })

  it('hard is the unhandicapped tier — nothing degraded, the whole playbook available', () => {
    const hard = skillFor(DIFFICULTY.HARD)
    expect(hard.alignSlop).toBe(0)
    expect(hard.readNoise).toBe(0)
    expect(hard.shells).toEqual(expect.arrayContaining(['man_blitz_6', 'zone_blitz_5', 'tampa_2']))
  })

  it('the tiers are ordered — each is a strict handicap on the one above', () => {
    const [easy, medium, hard] = [DIFFICULTY.EASY, DIFFICULTY.MEDIUM, DIFFICULTY.HARD].map(skillFor)
    expect(easy.alignSlop).toBeGreaterThan(medium.alignSlop)
    expect(medium.alignSlop).toBeGreaterThan(hard.alignSlop)
    expect(easy.readNoise).toBeGreaterThan(medium.readNoise)
    expect(medium.readNoise).toBeGreaterThan(hard.readNoise)
    expect(easy.shells.length).toBeLessThan(hard.shells.length)
  })

  it('a tier left with no legal shell falls back to the full menu rather than placing nobody', () => {
    const impossible = { shells: ['nothing_real'] }
    expect(allowedShells(impossible, ['cover_2', 'cover_3'])).toEqual(['cover_2', 'cover_3'])
  })

  it('an unknown difficulty gets the gentlest opponent, not the harshest', () => {
    expect(skillFor(undefined)).toBe(AI_SKILL[DIFFICULTY.EASY])
    expect(skillFor('impossible')).toBe(AI_SKILL[DIFFICULTY.EASY])
  })
})

describe('the difficulty a room is created with is the difficulty it gets', () => {
  it('an OFFLINE automatic room keeps hard — it used to be silently downgraded to easy', () => {
    const r = createRoom('7101', 'sock', { mode: 'automatic', difficulty: 'hard', solo: true })
    expect(r.difficulty).toBe('hard')
    expect(getRoom('7101').difficulty).toBe('hard')
    leaveRoomBySlot('7101', 0)
  })

  it('an ONLINE automatic room is still always easy — the other human never agreed to less', () => {
    const r = createRoom('7102', 'sock', { mode: 'automatic', difficulty: 'hard' })
    expect(r.difficulty).toBe('easy')
    leaveRoomBySlot('7102', 0)
  })

  it('an online MANUAL room keeps its difficulty, exactly as before', () => {
    const r = createRoom('7103', 'sock', { mode: 'manual', difficulty: 'hard' })
    expect(r.difficulty).toBe('hard')
    leaveRoomBySlot('7103', 0)
  })
})
