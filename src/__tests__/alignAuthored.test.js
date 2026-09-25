import { describe, it, expect } from '@jest/globals'
import { alignAuthored, readyToAlign, isBlitz } from '../ai/playbook/alignAuthored.js'

// [authored] Turning a drawn defense into the one it actually shows.
//
// The rules under test are the user's, and each one exists because the obvious alternative is
// wrong in a specific way:
//
//   • nothing is decided until the offense has SET  — otherwise the defense aligns to a formation
//     that is still being placed, and twitches as the rest walk out
//   • a man defender may come FORWARD, never backwards — the authored depth is a ceiling, and a
//     corner drawn at 5 who bails to 12 is playing a different call than the one chosen
//   • a zone SLIDES toward the formation, but only a little — a zone that chases completely is man
//     coverage with extra steps, and it vacates the area it was meant to hold

const BALL_X = 26.665
const LOS = 40

const formation = {
  category: '4-3',
  spots: [
    { slot: 'DL1', dx: -3.25, depth: 1 }, { slot: 'DL2', dx: -1.25, depth: 1 },
    { slot: 'DL3', dx: 1.25, depth: 1 }, { slot: 'DL4', dx: 3.25, depth: 1 },
    { slot: 'LB1', dx: -5, depth: 5 }, { slot: 'LB2', dx: 0, depth: 5 }, { slot: 'LB3', dx: 5, depth: 5 },
    { slot: 'CB1', dx: -14, depth: 7 }, { slot: 'CB2', dx: 14, depth: 7 },
    { slot: 'S1', dx: -8, depth: 13 }, { slot: 'S2', dx: 8, depth: 13 },
  ],
}

// Trips right: three receivers wide right, a tight end left, a back beside the quarterback.
const receivers = [
  { id: 'WR1', x: BALL_X - 16, y: LOS },
  { id: 'TE1', x: BALL_X + 6, y: LOS },
  { id: 'WR2', x: BALL_X + 12, y: LOS - 1 },
  { id: 'WR3', x: BALL_X + 18, y: LOS },
  { id: 'RB1', x: BALL_X - 3, y: LOS - 6 },
]

const rush = (slots) => Object.fromEntries(slots.map(s => [s, { job: 'rush' }]))
const manShell = (extraRushers = 0) => ({
  assignments: {
    ...rush(['DL1', 'DL2', 'DL3', 'DL4', ...(extraRushers ? ['LB2'] : [])]),
    CB1: { job: 'man' }, CB2: { job: 'man' },
    LB1: { job: 'man' }, LB3: { job: 'man' },
    ...(extraRushers ? {} : { LB2: { job: 'man' } }),
    S1: { job: 'zone', zone: 'deep', center: { dx: 0, depth: 16 } },
    S2: { job: 'man' },
  },
})
const zoneShell = () => ({
  assignments: {
    ...rush(['DL1', 'DL2', 'DL3', 'DL4']),
    CB1: { job: 'zone', zone: 'flat', center: { dx: -16, depth: 4 } },
    CB2: { job: 'zone', zone: 'flat', center: { dx: 16, depth: 4 } },
    LB1: { job: 'zone', zone: 'curl', center: { dx: -9, depth: 10 } },
    LB2: { job: 'zone', zone: 'hook', center: { dx: 0, depth: 8 } },
    LB3: { job: 'zone', zone: 'curl', center: { dx: 9, depth: 10 } },
    S1: { job: 'zone', zone: 'deep', center: { dx: -13, depth: 15 } },
    S2: { job: 'zone', zone: 'deep', center: { dx: 13, depth: 15 } },
  },
})

const align = (shell, opts = {}) =>
  alignAuthored({ formation, shell, receivers, ballX: BALL_X, losY: LOS, ready: true, ...opts })
const find = (rows, slot) => rows.find(r => r.slot === slot)

describe('⚠️ NOTHING IS DECIDED UNTIL THE OFFENSE HAS SET', () => {
  it('reads the engine’s own adjust window', () => {
    expect(readyToAlign({ offenseSet: true })).toBe(true)
    expect(readyToAlign({ offenseSet: false })).toBe(false)
    expect(readyToAlign(null)).toBe(false)
  })

  it('returns the DRAWN picture untouched while the offense is still walking out', () => {
    // Aligning early means aligning to a formation that does not exist yet, then twitching as the
    // rest arrive — which is exactly the visual mess this avoids.
    const rows = align(manShell(), { ready: false })
    for (const r of rows) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(r.x).toBeCloseTo(BALL_X + spot.dx)
      expect(r.y).toBeCloseTo(LOS + spot.depth)
    }
  })

  it('also does nothing when there is nobody to align to', () => {
    const rows = alignAuthored({ formation, shell: manShell(), receivers: [], ballX: BALL_X, losY: LOS })
    expect(find(rows, 'CB1').x).toBeCloseTo(BALL_X - 14)
  })
})

describe('man coverage travels to the receiver', () => {
  it('walks a corner out to whoever is split to his side', () => {
    const rows = align(manShell())
    const cb1 = find(rows, 'CB1')
    // Drawn at -14, the widest receiver left is at -16: he goes and gets him.
    expect(cb1.covers).toBe('WR1')
    expect(cb1.x).toBeCloseTo(BALL_X - 16)
  })

  it('covers every receiver, and nobody twice', () => {
    // Six man defenders against five receivers leaves one FREE — that is what the free safety in
    // Cover 1 is. What must never happen is a receiver going uncovered or two defenders on one.
    const rows = align(manShell())
    const taken = rows.filter(r => r.job === 'man').map(r => r.covers).filter(Boolean)
    expect(new Set(taken).size).toBe(taken.length)
    expect(new Set(taken)).toEqual(new Set(receivers.map(r => r.id)))
  })

  it('⚠️ PUTS THE CORNERS ON THE WIDE RECEIVERS, not on the back', () => {
    // The bug this caught: `dx` is an offset from the ball and was being compared to the absolute
    // hash, so every offset looked negative and every corner took the LEFTMOST receiver. The
    // result was a corner manned on the running back while linebackers chased the outside
    // receivers — the exact matchup matchMen exists to prevent.
    const rows = align(manShell())
    expect(find(rows, 'CB1').covers).toBe('WR1')   // widest left
    expect(find(rows, 'CB2').covers).toBe('WR3')   // widest right
    const backIsCoveredByALinebacker = rows
      .filter(r => r.covers === 'RB1')
      .every(r => r.label === 'LB' || r.label === 'S')
    expect(backIsCoveredByALinebacker).toBe(true)
  })

  it('⚠️ NEVER BACKWARDS — the authored depth is a ceiling', () => {
    // A corner drawn at 7 who bails to 12 is playing a different call than the one chosen, so
    // alignment is never allowed to add depth.
    const rows = align(manShell())
    for (const r of rows) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(r.depth).toBeLessThanOrEqual(spot.depth + 1e-9)
    }
  })

  it('will not sprint across the formation to reach somebody', () => {
    // A corner drawn at one number chasing a receiver on the far hash leaves the picture
    // unrecognisable, so travel is bounded.
    const far = [{ id: 'WR9', x: BALL_X + 24, y: LOS }]
    const rows = alignAuthored({ formation, shell: manShell(), receivers: far, ballX: BALL_X, losY: LOS })
    const cb1 = find(rows, 'CB1')
    expect(cb1.x).toBeLessThan(BALL_X + 24)
    expect(Math.abs(cb1.x - (BALL_X - 14))).toBeLessThanOrEqual(14 + 1e-9)
  })
})

describe('⚠️ PRESSING IS FOR A BLITZ', () => {
  it('knows a blitz from a four-man rush', () => {
    expect(isBlitz(manShell(0))).toBe(false)
    expect(isBlitz(manShell(1))).toBe(true)
  })

  it('presses the man defenders when extra rushers are coming', () => {
    // The user's example: a blitz wants the quick game late, so somebody jams it.
    const calm = align(manShell(0))
    const blitz = align(manShell(1))
    expect(find(calm, 'CB1').pressing).toBe(false)
    expect(find(blitz, 'CB1').pressing).toBe(true)
    expect(find(blitz, 'CB1').depth).toBeLessThan(find(calm, 'CB1').depth)
  })

  it('does not press a defender already drawn tighter than the press depth', () => {
    // Pressing is a MINIMUM of the two, never a move backwards to some canonical press spot.
    const tight = {
      ...formation,
      spots: formation.spots.map(s => (s.slot === 'CB1' ? { ...s, depth: 1 } : s)),
    }
    const rows = alignAuthored({ formation: tight, shell: manShell(1), receivers, ballX: BALL_X, losY: LOS })
    expect(find(rows, 'CB1').depth).toBe(1)
  })

  it('leaves the linemen alone either way', () => {
    const rows = align(manShell(1))
    expect(find(rows, 'DL1').x).toBeCloseTo(BALL_X - 3.25)
    expect(find(rows, 'DL1').depth).toBe(1)
  })
})

describe('zones slide toward the formation', () => {
  it('shifts toward where that side’s receivers actually are', () => {
    // Trips right sits at +6, +12 and +18 — a mean of +12. The corner drawn at +14 slides INWARD
    // to sit over them, which is the point: the zone should be over the route distribution rather
    // than over grass outside it.
    const rows = align(zoneShell())
    const cb2 = find(rows, 'CB2')
    expect(cb2.x).toBeLessThan(BALL_X + 14)
    expect(cb2.x).toBeCloseTo(BALL_X + 12, 1)
    expect(cb2.zoneCenter.dx).toBeLessThan(16)

    // And the left side, with one receiver out at -16, pulls the other way.
    expect(find(rows, 'CB1').x).toBeLessThan(BALL_X - 14)
  })

  it('⚠️ ONLY A LITTLE — a zone that chases completely is man coverage with extra steps', () => {
    const rows = align(zoneShell())
    for (const r of rows.filter(x => x.job === 'zone')) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(Math.abs(r.x - (BALL_X + spot.dx))).toBeLessThanOrEqual(4 + 1e-9)
    }
  })

  it('never changes a zone defender’s depth — that is the shell', () => {
    const rows = align(zoneShell())
    for (const r of rows.filter(x => x.job === 'zone')) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(r.depth).toBe(spot.depth)
      if (r.zoneCenter) {
        const authored = zoneShell().assignments[r.slot].center.depth
        expect(r.zoneCenter.depth).toBe(authored)
      }
    }
  })

  it('leaves a zone alone when nobody is on that side', () => {
    const allRight = receivers.filter(r => r.x >= BALL_X)
    const rows = alignAuthored({ formation, shell: zoneShell(), receivers: allRight, ballX: BALL_X, losY: LOS })
    expect(find(rows, 'CB1').x).toBeCloseTo(BALL_X - 14)
  })
})

describe('what it is NOT allowed to do', () => {
  it('never changes the CALL — only where people stand', () => {
    // Re-deciding coverage as receivers move would be re-deciding on information the offense
    // controls, which is how motion becomes a free way to read the defense.
    const shell = manShell()
    const rows = align(shell)
    for (const r of rows) {
      expect(r.job).toBe(shell.assignments[r.slot]?.job ?? 'rush')
      if (r.job === 'zone') expect(r.zone).toBe(shell.assignments[r.slot].zone)
    }
  })
})
