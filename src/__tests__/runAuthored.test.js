import { describe, it, expect } from '@jest/globals'
import {
  hasAuthoredOffense, hasAuthoredDefense, callAuthoredOffense, buildAuthoredOffense,
  callAuthoredDefense, buildAuthoredDefense, formationLookId,
} from '../ai/playbook/runAuthored.js'

// [authored] The bridge that finally lets the engine snap an authored play.

const BALL_X = 26.665
const LOS = 40

const formation = {
  name: 'Trips Rt', category: 'gun',
  spots: [
    { slot: 'WR1', dx: -14, depth: 0 }, { slot: 'WR2', dx: 8, depth: 1 },
    { slot: 'WR3', dx: 14, depth: 0 }, { slot: 'TE1', dx: 5, depth: 0 },
    { slot: 'RB1', dx: -3, depth: 6 },
  ],
}
const defFormation = {
  name: 'Nickel', category: 'nickel',
  spots: [
    { slot: 'DL1', dx: -3.25, depth: 1 }, { slot: 'DL2', dx: -1.25, depth: 1 },
    { slot: 'DL3', dx: 1.25, depth: 1 }, { slot: 'DL4', dx: 3.25, depth: 1 },
    { slot: 'LB1', dx: -4, depth: 5 }, { slot: 'LB2', dx: 4, depth: 5 },
    { slot: 'CB1', dx: -16, depth: 6 }, { slot: 'CB2', dx: 16, depth: 6 },
    { slot: 'CB3', dx: -8, depth: 5 },
    { slot: 'S1', dx: -8, depth: 14 }, { slot: 'S2', dx: 8, depth: 14 },
  ],
}

const book = {
  formations: { trips: formation },
  plays: {
    mesh: {
      name: 'Mesh', formationId: 'trips', playType: 'pass',
      assignments: {
        WR1: { kind: 'route', points: [{ dx: 0, dd: 5 }, { dx: 12, dd: 6 }] },
        WR3: { kind: 'route', points: [{ dx: 0, dd: 5 }, { dx: -12, dd: 6 }] },
        TE1: { kind: 'route', points: [{ dx: 3, dd: 7 }] },
        WR2: { kind: 'route', points: [{ dx: -2, dd: 12 }] },
        RB1: { kind: 'block' },
      },
    },
    inside: { name: 'Inside', formationId: 'trips', playType: 'run', assignments: {} },
  },
  defFormations: { nickel: defFormation },
  shells: {
    cover3: {
      name: 'Cover 3', formationId: 'nickel', kind: 'zone',
      assignments: {
        CB1: { job: 'zone', zone: 'deep', center: { dx: -17, depth: 15 } },
        CB2: { job: 'zone', zone: 'deep', center: { dx: 17, depth: 15 } },
        S1: { job: 'zone', zone: 'deep', center: { dx: 0, depth: 16 } },
        S2: { job: 'zone', zone: 'hook', center: { dx: 0, depth: 8 } },
        CB3: { job: 'zone', zone: 'flat', center: { dx: -14, depth: 4 } },
        LB1: { job: 'zone', zone: 'curl', center: { dx: -9, depth: 10 } },
        LB2: { job: 'rush' },
      },
    },
    man1: {
      name: 'Cover 1', formationId: 'nickel', kind: 'man',
      assignments: {
        CB1: { job: 'man' }, CB2: { job: 'man' }, CB3: { job: 'man' },
        LB1: { job: 'man' }, LB2: { job: 'man' },
        S1: { job: 'zone', zone: 'deep', center: { dx: 0, depth: 16 } },
        S2: { job: 'spy' },
      },
    },
  },
}

const roster = [
  ...['wr1', 'wr2', 'wr3', 'wr4'].map((id, i) => ({ id, label: 'WR', ovr: 90 - i, ratings: {} })),
  ...['te1', 'te2'].map((id, i) => ({ id, label: 'TE', ovr: 85 - i, ratings: {} })),
  ...['rb1', 'rb2'].map((id, i) => ({ id, label: 'RB', ovr: 84 - i, ratings: {} })),
  ...['cb1', 'cb2', 'cb3', 'cb4'].map((id, i) => ({ id, label: 'CB', ovr: 88 - i, ratings: {} })),
  ...['s1', 's2', 's3'].map((id, i) => ({ id, label: 'S', ovr: 83 - i, ratings: {} })),
  ...['lb1', 'lb2', 'lb3', 'lb4'].map((id, i) => ({ id, label: 'LB', ovr: 82 - i, ratings: {} })),
]

const k = { down: 1, distance: 10, yardLine: LOS }
const receivers = [
  { id: 'wr1', x: BALL_X - 14, y: LOS, label: 'WR' },
  { id: 'wr2', x: BALL_X + 8, y: LOS - 1, label: 'WR' },
  { id: 'wr3', x: BALL_X + 14, y: LOS, label: 'WR' },
  { id: 'te1', x: BALL_X + 5, y: LOS, label: 'TE' },
  { id: 'rb1', x: BALL_X - 3, y: LOS - 6, label: 'RB' },
]

describe('knowing whether there is anything authored to run', () => {
  it('says no for an empty playbook', () => {
    expect(hasAuthoredOffense({})).toBe(false)
    expect(hasAuthoredDefense({})).toBe(false)
  })

  it('says yes once there is', () => {
    expect(hasAuthoredOffense(book)).toBe(true)
    expect(hasAuthoredDefense(book)).toBe(true)
  })
})

describe('calling and building an authored offense', () => {
  it('picks a play and the formation it belongs to', () => {
    const call = callAuthoredOffense(book, k, { ballX: BALL_X })
    expect(['mesh', 'inside']).toContain(call.play.id)
    expect(call.formation.id).toBe('trips')
  })

  it('puts five skill players on the field, filled from the roster by rating', () => {
    const call = callAuthoredOffense(book, k, { ballX: BALL_X })
    const players = buildAuthoredOffense(call, { losY: LOS, ballX: BALL_X, roster })
    expect(players).toHaveLength(5)
    expect(players.map(p => p.label).sort()).toEqual(['RB', 'TE', 'WR', 'WR', 'WR'])
    expect(players.find(p => p.label === 'RB').id).toBe('rb1')   // best available
  })

  it('⚠️ SENDS THE DRAWN SHAPE, not a route name', () => {
    // The hand-written concepts pick from a fixed table; an authored play carries what somebody
    // actually drew, as offsets from wherever that slot lines up.
    const call = { play: book.plays.mesh, formation: { ...formation, id: 'trips' }, mirror: false }
    const players = buildAuthoredOffense(call, { losY: LOS, ballX: BALL_X, roster })
    const wr = players.find(p => p.slot === 'WR1')
    expect(wr.drawnRoute).toEqual([{ dx: 0, dd: 5 }, { dx: 12, dd: 6 }])
    expect(wr.route).toBeUndefined()
  })

  it('⚠️ GIVES A BLOCKER NO ROUTE AT ALL, not an empty one', () => {
    // The engine reads "has a drawn route" as "is running it" — an empty array would send him
    // nowhere at full speed.
    const call = { play: book.plays.mesh, formation: { ...formation, id: 'trips' }, mirror: false }
    const players = buildAuthoredOffense(call, { losY: LOS, ballX: BALL_X, roster })
    const rb = players.find(p => p.slot === 'RB1')
    expect(rb.drawnRoute).toBeUndefined()
    expect(rb.route).toBe('block')
  })

  it('gives a run play nobody a route', () => {
    const call = { play: book.plays.inside, formation: { ...formation, id: 'trips' }, mirror: false }
    const players = buildAuthoredOffense(call, { losY: LOS, ballX: BALL_X, roster })
    expect(players.every(p => !p.drawnRoute)).toBe(true)
  })

  it('⚠️ MIRRORS THE ROUTES WITH THE FORMATION, or the art and the play disagree', () => {
    const straight = buildAuthoredOffense(
      { play: book.plays.mesh, formation: { ...formation, id: 'trips' }, mirror: false },
      { losY: LOS, ballX: BALL_X, roster })
    const flipped = buildAuthoredOffense(
      { play: book.plays.mesh, formation: { ...formation, id: 'trips' }, mirror: true },
      { losY: LOS, ballX: BALL_X, roster })
    const s = straight.find(p => p.slot === 'WR1')
    const f = flipped.find(p => p.slot === 'WR1')
    expect(f.x - BALL_X).toBeCloseTo(-(s.x - BALL_X))
    expect(f.drawnRoute[1].dx).toBeCloseTo(-s.drawnRoute[1].dx)
  })

  it('flips a LOPSIDED set when the ball is crushed against a sideline', () => {
    // Trips Rt above is near enough symmetric — a receiver at -14 and another at +14 — so
    // mirroring it relieves nothing and correctly does not happen. Flipping is only ever worth it
    // when the formation actually leans one way.
    const leftHeavy = {
      formations: { quads: { name: 'Quads Lt', category: 'gun', spots: [
        { slot: 'WR1', dx: -20, depth: 0 }, { slot: 'WR2', dx: -16, depth: 1 },
        { slot: 'WR3', dx: -12, depth: 0 }, { slot: 'TE1', dx: -6, depth: 0 },
        { slot: 'RB1', dx: 2, depth: 6 },
      ] } },
      plays: { go: { name: 'Go', formationId: 'quads', playType: 'pass',
        assignments: { WR1: { kind: 'route', points: [{ dx: 0, dd: 12 }] } } } },
    }
    expect(callAuthoredOffense(leftHeavy, k, { ballX: 8 }).mirror).toBe(true)
    expect(callAuthoredOffense(leftHeavy, k, { ballX: 40 }).mirror).toBe(false)
  })

  it('keeps a back in against heavy pressure — when one is actually released', () => {
    // Mesh above already blocks with the back, so it fields SIX blockers and a 5.8-rusher
    // expectation needs nobody else. A play that releases everybody is the case that matters.
    const allOut = {
      formations: { trips: formation },
      plays: { flood: { name: 'Flood', formationId: 'trips', playType: 'pass', assignments: {
        WR1: { kind: 'route', points: [{ dx: 0, dd: 14 }] },
        WR2: { kind: 'route', points: [{ dx: 0, dd: 8 }] },
        WR3: { kind: 'route', points: [{ dx: 0, dd: 5 }] },
        TE1: { kind: 'route', points: [{ dx: 0, dd: 6 }] },
        RB1: { kind: 'route', points: [{ dx: 0, dd: 3 }] },
      } } },
    }
    const heavy = { protectBias: 0.6, boxBias: 0, underneathBias: 0 }
    expect(callAuthoredOffense(allOut, k, { ballX: BALL_X, adjust: heavy }).keptIn).toBe('RB1')
    // And against an ordinary four-man rush, everybody releases.
    const calm = { protectBias: 0, boxBias: 0, underneathBias: 0 }
    expect(callAuthoredOffense(allOut, k, { ballX: BALL_X, adjust: calm }).keptIn).toBeNull()
  })
})

describe('calling and building an authored defense', () => {
  it('describes the look from who is on the field, not from a playbook entry', () => {
    // The defense sees players, not an authored formation.
    expect(formationLookId(receivers)).toBe('3wr1te1rb')
  })

  it('picks a shell and the formation it belongs to', () => {
    const call = callAuthoredDefense(book, k, { ballX: BALL_X, receivers })
    expect(['cover3', 'man1']).toContain(call.shell.id)
    expect(call.formation.id).toBe('nickel')
  })

  it('⚠️ PLACES SEVEN, NOT ELEVEN — the linemen are the engine’s', () => {
    // They are in the authored formation so it can be seen whole in the sandbox; on the field they
    // are auto-placed and are not ours to position or assign.
    const call = callAuthoredDefense(book, k, { ballX: BALL_X, receivers })
    const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
    expect(players).toHaveLength(7)
    expect(players.every(p => p.label !== 'DL')).toBe(true)
  })

  it('gives every placed defender an assignment', () => {
    const call = { shell: book.shells.cover3, formation: { ...defFormation, id: 'nickel' } }
    const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
    expect(players.every(p => p.coverage?.type)).toBe(true)
  })

  it('turns a zone into a zone with a landmark', () => {
    const call = { shell: book.shells.cover3, formation: { ...defFormation, id: 'nickel' } }
    const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
    const deep = players.find(p => p.coverage.zoneType === 'deep')
    expect(deep.coverage.type).toBe('zone')
    expect(Number.isFinite(deep.coverage.zoneCenterY)).toBe(true)
  })

  it('turns man into man ON A REAL RECEIVER, with his shade', () => {
    const call = { shell: book.shells.man1, formation: { ...defFormation, id: 'nickel' } }
    const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
    const man = players.filter(p => p.coverage.type === 'man')
    expect(man.length).toBeGreaterThan(0)
    for (const d of man) {
      expect(receivers.some(r => r.id === d.coverage.targetId)).toBe(true)
    }
  })

  it('turns a rusher into a blitz and a spy into a spy', () => {
    const call = { shell: book.shells.man1, formation: { ...defFormation, id: 'nickel' } }
    const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
    expect(players.some(p => p.coverage.type === 'spy')).toBe(true)
    const rush = buildAuthoredDefense(
      { shell: book.shells.cover3, formation: { ...defFormation, id: 'nickel' } },
      { losY: LOS, ballX: BALL_X, receivers, roster })
    expect(rush.some(p => p.coverage.type === 'blitz')).toBe(true)
  })

  it('⚠️ NEVER LEAVES A PLACED DEFENDER WITHOUT A JOB', () => {
    // The engine rushes anyone it has no assignment for, so a missing one silently opens a hole
    // where that defender was standing.
    for (const shellId of ['cover3', 'man1']) {
      const call = { shell: book.shells[shellId], formation: { ...defFormation, id: 'nickel' } }
      const players = buildAuthoredDefense(call, { losY: LOS, ballX: BALL_X, receivers, roster })
      expect(players.every(p => p.coverage && p.coverage.type)).toBe(true)
    }
  })
})
