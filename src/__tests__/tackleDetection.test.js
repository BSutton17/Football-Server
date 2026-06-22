import { describe, it, expect } from '@jest/globals'
import { runTackleDetection, tackleBreakChance } from '../game/systems/tackleDetection.js'

// TACKLE_RADIUS = PLAYER.CONTACT_RADIUS = 1.5 yd (bodies overlap when centers ≤ 1.5 apart).
// The carrier is whoever findBallCarrier returns: an explicit ballCarrierId, or the RB on a
// run play.

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], playType = 'run', ballCarrierId = null, tackleEnqueued = false } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    playDesign:     { playType },
    ballCarrierId,
    tackleEnqueued,
    roomId:         'TEST_ROOM',
  }
}

const rb = (x = 26, y = 50) => ({ id: 'rb', label: 'RB', x, y })
// Defender a given straight-line distance north of the carrier.
const defAt = (dist, id = 'd1') => ({ id, label: 'LB', x: 26, y: 50 + dist })

describe('overlap tackle detection ([161])', () => {
  it('ends the play when a defender overlaps the ball carrier', () => {
    const state = makeState({ offense: [rb()], defense: [defAt(1.0)] })  // 1.0 < 1.5
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
  })

  it('does not tackle when the nearest defender is beyond the overlap radius', () => {
    const state = makeState({ offense: [rb()], defense: [defAt(1.6)] })  // 1.6 > 1.5
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(false)
  })

  it('tackles exactly at the overlap radius (touching counts)', () => {
    const state = makeState({ offense: [rb()], defense: [defAt(1.5)] })
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
  })

  it('tackles a receiver carrying the ball after the catch (explicit carrier)', () => {
    const wr = { id: 'wr', label: 'WR', x: 30, y: 60 }
    const def = { id: 'cb', label: 'CB', x: 30.5, y: 60.5 }   // ~0.7 yd away → overlap
    const state = makeState({ offense: [wr], defense: [def], playType: 'pass', ballCarrierId: 'wr' })
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
  })

  it('does nothing while the ball is not loose (pocket pass — no carrier)', () => {
    // Pass play, no ballCarrierId → findBallCarrier returns null (the rush handles the QB).
    const qb = { id: 'qb', label: 'QB', x: 26, y: 33 }
    const def = { id: 'dl', label: 'DL', x: 26, y: 33 }   // right on the QB
    const state = makeState({ offense: [qb], defense: [def], playType: 'pass' })
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(false)
  })

  it('only fires once per play (guarded by tackleEnqueued)', () => {
    const state = makeState({ offense: [rb()], defense: [defAt(0.5)] })
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
    // A subsequent tick must not reset or re-process.
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
  })

  it('is symmetric to field direction (overlap is positional)', () => {
    // dir is irrelevant to overlap; a southbound carrier is tackled the same way.
    const state = makeState({ offense: [rb(26, 70)], defense: [{ id: 'd1', label: 'LB', x: 26, y: 69 }] })
    runTackleDetection(state, null, 0.05, () => 1)   // high roll → never breaks the tackle
    expect(state.tackleEnqueued).toBe(true)
  })
})

// ── Run power: breaking tackles ([run power]) ───────────────────────────────────

describe('tackleBreakChance', () => {
  it('scales the per-attempt base by run power (99 → full, 0 → none)', () => {
    expect(tackleBreakChance(99, 0)).toBeCloseTo(0.55)
    expect(tackleBreakChance(99, 1)).toBeCloseTo(0.40)
    expect(tackleBreakChance(99, 2)).toBeCloseTo(0.10)
    expect(tackleBreakChance(0,  0)).toBe(0)
    expect(tackleBreakChance(99, 3)).toBe(0)   // no break after the third attempt
    expect(tackleBreakChance(50, 0)).toBeCloseTo(0.55 * 50 / 99)
  })
})

describe('runTackleDetection — breaking a tackle', () => {
  it('a low roll breaks the tackle: the play stays live, speed is halved, brokenTackles increments', () => {
    const carrier = { id: 'rb', label: 'RB', x: 26, y: 50, vx: 0, vy: 8 }
    const state = makeState({ offense: [carrier], defense: [defAt(0.5)] })
    runTackleDetection(state, null, 0.05, () => 0)   // low roll → breaks

    expect(state.tackleEnqueued).toBe(false)   // play continues
    expect(carrier.brokenTackles).toBe(1)
    expect(carrier.vy).toBeCloseTo(4)          // momentum halved
    expect(carrier.tackleBreakCooldown).toBeGreaterThan(0)
  })

  it('is immune to a new tackle during the post-break cooldown', () => {
    const carrier = { id: 'rb', label: 'RB', x: 26, y: 50, vx: 0, vy: 8, brokenTackles: 1, tackleBreakCooldown: 0.3 }
    const state = makeState({ offense: [carrier], defense: [defAt(0.5)] })
    runTackleDetection(state, null, 0.05, () => 0)

    expect(state.tackleEnqueued).toBe(false)   // cooldown blocks the tackle
    expect(carrier.tackleBreakCooldown).toBeCloseTo(0.25)
  })
})
