import { describe, it, expect } from '@jest/globals'
import {
  alignAuthored, readyToAlign, isBlitz, pairMan, decideShade, enforceNoCrossing,
} from '../ai/playbook/alignAuthored.js'

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
// ⚠️ LABELS MATTER. The matchup rule is "corners on receivers, linebackers on the tight end
// and the back", so a fixture without labels cannot exercise it — it falls through to the
// out-of-options pass, which pairs by pure proximity and looks like a bug in the code.
const receivers = [
  { id: 'WR1', x: BALL_X - 16, y: LOS, label: 'WR' },
  { id: 'TE1', x: BALL_X + 6, y: LOS, label: 'TE' },
  { id: 'WR2', x: BALL_X + 12, y: LOS - 1, label: 'WR' },
  { id: 'WR3', x: BALL_X + 18, y: LOS, label: 'WR' },
  { id: 'RB1', x: BALL_X - 3, y: LOS - 6, label: 'RB' },
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
const SHADES = ['none', 'in', 'out', 'over', 'under']

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
    // Drawn at -14, the widest receiver left is at -16: he goes and gets him — and stands a yard
    // to the side his shade says he is taking away, rather than nose to nose.
    expect(cb1.covers).toBe('WR1')
    expect(Math.abs(cb1.x - (BALL_X - 16))).toBeCloseTo(1, 1)
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
    const far = [{ id: 'WR9', x: BALL_X + 24, y: LOS, label: 'WR' }]
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
    // The ZONE is what moved toward them. The defender's own spot is additionally subject to the
    // no-crossing pass, which may hold him out from a neighbour.
    expect(find(rows, 'CB2').zoneCenter.dx).toBeLessThan(16)
    expect(find(rows, 'CB1').zoneCenter.dx).toBeLessThan(-16 + 1e-9)
  })

  it('⚠️ ONLY A LITTLE — a zone that chases completely is man coverage with extra steps', () => {
    const rows = align(zoneShell())
    for (const r of rows.filter(x => x.job === 'zone')) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(Math.abs(r.x - (BALL_X + spot.dx))).toBeLessThanOrEqual(4 + 1e-9)
    }
  })

  it('never sends a zone defender BACKWARDS, and never deepens the zone itself', () => {
    // A corner in a shallow zone may come forward onto the receiver aligned in it — that is the
    // rule. What he may never do is drop off, which would quietly deepen the coverage that was
    // called. The ZONE's own depth belongs to the shell and is untouched either way.
    const rows = align(zoneShell())
    for (const r of rows.filter(x => x.job === 'zone')) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(r.depth).toBeLessThanOrEqual(spot.depth + 1e-9)
      if (r.zoneCenter) {
        expect(r.zoneCenter.depth).toBe(zoneShell().assignments[r.slot].center.depth)
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

describe('⚠️ CORNERS ON RECEIVERS, LINEBACKERS ON THE TIGHT END AND THE BACK', () => {
  const man = (slots) => slots.map(([slot, dx]) => ({ slot, dx }))

  it('puts each corner on the widest receiver to HIS side', () => {
    const pairs = pairMan(man([['CB1', -14], ['CB2', 14]]), receivers, BALL_X)
    expect(pairs.get('CB1').id).toBe('WR1')
    expect(pairs.get('CB2').id).toBe('WR3')
  })

  it('gives the tight end and the back to linebackers', () => {
    const pairs = pairMan(man([['CB1', -14], ['CB2', 14], ['LB1', -5], ['LB2', 0]]), receivers, BALL_X)
    expect([pairs.get('LB1').label, pairs.get('LB2').label].sort()).toEqual(['RB', 'TE'])
  })

  it('⚠️ TAKES A BAD MATCHUP OVER LEAVING SOMEBODY UNCOVERED', () => {
    // Three receivers and only linebackers to cover them. A linebacker on a receiver is a losing
    // matchup; an uncovered receiver is a touchdown.
    const wrs = receivers.filter(r => r.label === 'WR')
    const pairs = pairMan(man([['LB1', -5], ['LB2', 0], ['LB3', 5]]), wrs, BALL_X)
    expect(new Set([...pairs.values()].map(r => r.id)).size).toBe(3)
  })

  it('leaves a spare defender free rather than doubling somebody', () => {
    const pairs = pairMan(man([['CB1', -14], ['CB2', 14], ['S1', -8]]), receivers.slice(0, 2), BALL_X)
    const taken = [...pairs.values()].map(r => r.id)
    expect(new Set(taken).size).toBe(taken.length)
  })
})

describe('⚠️ SHADING IS DECIDED PER DEFENDER', () => {
  const wide = { id: 'w', x: BALL_X + 18, y: LOS, label: 'WR' }
  const tight = { id: 't', x: BALL_X + 3, y: LOS, label: 'WR' }
  const back = { id: 'b', x: BALL_X - 3, y: LOS - 6, label: 'RB' }
  const ctx = { hasDeepHelp: true, ballX: BALL_X }

  // ⚠️ FLIPPING THESE TWO COST 0.30 YARDS A PLAY. Taking the outside away from a wide receiver is
  // defensible football and did fix comebacks against a star, but measured over ~1,600 plays it
  // opened everything working back inside — and there is far more of that. The comeback is handled
  // by the half-time `outsideBias` instead, on evidence about the opponent in front of you.
  it('takes away the inside on a wide receiver — the sideline is the help outside', () => {
    expect(decideShade({}, wide, ctx)).toBe('in')
  })

  it('takes away the outside on a tight one — the traffic inside is the help', () => {
    expect(decideShade({}, tight, ctx)).toBe('out')
  })

  it('plays a releasing back underneath, whoever is on him', () => {
    expect(decideShade({}, back, ctx)).toBe('under')
  })

  it('⚠️ REFUSES ANYTHING BUT UNDER WITH NOBODY OVER THE TOP', () => {
    for (const r of [wide, tight, back]) {
      expect(decideShade({}, r, { ...ctx, hasDeepHelp: false })).toBe('under')
    }
  })

  it('honours a shell that pins its leverage — but not over the safety rule', () => {
    expect(decideShade({}, wide, { ...ctx, forced: 'out' })).toBe('out')
    expect(decideShade({}, wide, { ...ctx, forced: 'out', hasDeepHelp: false })).toBe('under')
  })

  it('stands NEAR his receiver, never nose to nose', () => {
    const rows = align(manShell())
    const cb1 = find(rows, 'CB1')
    expect(SHADES).toContain(cb1.shade)
    const target = receivers.find(r => r.id === cb1.covers)
    const off = Math.abs(cb1.x - target.x)
    expect(off).toBeLessThanOrEqual(1.01)
  })
})

describe('⚠️ A RUSHER MAY SHOW HIMSELF, UP TO FOUR YARDS', () => {
  it('creeps a blitzing linebacker toward the line', () => {
    const rows = align(manShell(1))
    const lb = find(rows, 'LB2')
    expect(lb.job).toBe('rush')
    expect(lb.depth).toBeLessThan(5)
    expect(5 - lb.depth).toBeLessThanOrEqual(4 + 1e-9)
  })

  it('leaves the linemen exactly where they were drawn', () => {
    const rows = align(manShell(1))
    for (const r of rows.filter(x => x.label === 'DL')) {
      const spot = formation.spots.find(s => s.slot === r.slot)
      expect(r.depth).toBe(spot.depth)
      expect(r.x).toBeCloseTo(BALL_X + spot.dx)
    }
  })
})

describe('⚠️ ZONES NEVER CROSS EACH OTHER', () => {
  it('keeps the drawn left-to-right order after everyone has slid', () => {
    const rows = align(zoneShell()).filter(r => r.job === 'zone')
    const drawn = [...rows].sort((a, b) => a.dx - b.dx).map(r => r.slot)
    const after = [...rows].sort((a, b) => a.x - b.x).map(r => r.slot)
    expect(after).toEqual(drawn)
  })

  it('pushes a zone out rather than letting it pass its neighbour', () => {
    const rows = [
      { slot: 'A', job: 'zone', dx: -4, x: 10 },
      { slot: 'B', job: 'zone', dx: 4, x: 8 },   // has slid past A
    ]
    enforceNoCrossing(rows)
    expect(rows.find(r => r.slot === 'B').x).toBeGreaterThan(rows.find(r => r.slot === 'A').x)
  })

  it('leaves a lone zone alone', () => {
    const rows = [{ slot: 'A', job: 'zone', dx: 0, x: 10 }]
    expect(enforceNoCrossing(rows)[0].x).toBe(10)
  })
})

// ── Reported from a real game: trips to one side ([alignment]) ──────────────
//
// ⚠️ "THERE IS ONE CB FOR 3 WR. THERE IS A CORNER IN THE BOX MANNED UP WITH A MAN ALL THE WAY
// ACROSS THE FIELD AND ANOTHER CB AT THE TOP WHO IS 15 YARDS OFF. THIS PLAY IS TERRIBLE, THERE WILL
// BE 2 WR WIDE OPEN BECAUSE OF ALIGNMENT."
//
// A balanced man shell against three receivers bunched to one side. Three separate faults combined:
//
//   • the matcher assigned each corner "the widest receiver on his own side" one at a time, so the
//     BACKSIDE corner — with nobody on his side at all — was handed a receiver on the far hash;
//   • MAX_MAN_TRAVEL then stopped him fourteen yards short, leaving him standing in the box;
//   • and the safety's depth exemption kept a third defender thirteen yards off his man.
//
// The shape below is that formation. What it asserts is not a particular assignment but the thing
// the report was actually about: everybody in man coverage is standing near the man he has.
describe('⚠️ TRIPS TO ONE SIDE — everybody in man is NEAR his man', () => {
  const B = 26.8
  const L = 25

  // Balanced shell, two corners, three receivers to the left: the case that broke it.
  const tripsFormation = {
    category: '3-4',
    spots: [
      { slot: 'DL1', dx: -3, depth: 1 }, { slot: 'DL2', dx: 0, depth: 1 }, { slot: 'DL3', dx: 3, depth: 1 },
      { slot: 'LB1', dx: -5.6, depth: 0.8 }, { slot: 'LB2', dx: -2.5, depth: 4.8 },
      { slot: 'LB3', dx: 5.5, depth: 0.8 }, { slot: 'LB4', dx: 2.9, depth: 5.1 },
      { slot: 'CB1', dx: -16, depth: 6 }, { slot: 'CB2', dx: 16, depth: 6 },
      { slot: 'S1', dx: -8, depth: 13 }, { slot: 'S2', dx: 8, depth: 13 },
    ],
  }
  const tripsShell = {
    assignments: {
      DL1: { job: 'rush' }, DL2: { job: 'rush' }, DL3: { job: 'rush' },
      LB1: { job: 'rush' }, LB3: { job: 'rush' },
      CB1: { job: 'man' }, CB2: { job: 'man' }, S2: { job: 'man' },
      LB2: { job: 'man' }, LB4: { job: 'man' },
      S1: { job: 'zone', zone: 'deep', center: { dx: 0, depth: 20 } },
    },
  }
  const trips = [
    { id: 'wr_wide',  x: 4.9,  y: L, label: 'WR' },
    { id: 'wr_slot',  x: 9.3,  y: L, label: 'WR' },
    { id: 'wr_inner', x: 13.7, y: L, label: 'WR' },
    { id: 'te',       x: 32.0, y: L, label: 'TE' },
    { id: 'rb',       x: 29.8, y: L - 6, label: 'RB' },
  ]
  const rows = alignAuthored({
    formation: tripsFormation, shell: tripsShell, receivers: trips, ballX: B, losY: L, ready: true,
  })
  const manRows = rows.filter(r => r.job === 'man' && r.covers)
  const gap = (r) => Math.abs(r.x - trips.find(t => t.id === r.covers).x)

  it('⚠️ NOBODY IS COVERING SOMEBODY FROM ACROSS THE FORMATION', () => {
    // The reported alignment had a corner 15.1 yards from his man and a safety 11.5 from his.
    for (const r of manRows) {
      expect({ slot: r.slot, covers: r.covers, gap: Math.round(gap(r)) })
        .toMatchObject({ gap: expect.any(Number) })
      expect(gap(r)).toBeLessThan(3)
    }
  })

  it('every receiver is covered, and nobody twice', () => {
    const covered = manRows.map(r => r.covers)
    expect(new Set(covered).size).toBe(covered.length)
    expect(new Set(covered)).toEqual(new Set(trips.map(t => t.id)))
  })

  it('⚠️ THE CORNERS HAVE THE OUTSIDE RECEIVERS, even though both had to travel', () => {
    const cbs = manRows.filter(r => r.slot.startsWith('CB')).map(r => r.covers)
    expect(cbs).toContain('wr_wide')
    expect(cbs).toContain('wr_inner')
  })

  it('the tight end and the back still go to linebackers', () => {
    const lb = manRows.filter(r => r.slot.startsWith('LB')).map(r => r.covers).sort()
    expect(lb).toEqual(['rb', 'te'])
  })

  it('⚠️ THE SAFETY MANNED UNDER SINGLE-HIGH HELP PLAYS TIGHT, not thirteen yards off', () => {
    // The cushion is bought with the whole field at his back. With a deep safety already there he is
    // buying nothing, and standing off is just a receiver open before the snap.
    const s2 = rows.find(r => r.slot === 'S2')
    expect(s2.job).toBe('man')
    expect(s2.depth).toBeLessThanOrEqual(5)
  })

  it('⚠️ THE SINGLE-HIGH DEEP ZONE HOLDS THE MIDDLE', () => {
    // It shades toward three receivers; it does not follow them. The reported landmark was twelve
    // yards off centre, which is how the back half gets thrown behind on the other side.
    const s1 = rows.find(r => r.slot === 'S1')
    expect(s1.zone).toBe('deep')
    expect(Math.abs(s1.zoneCenterX - B)).toBeLessThanOrEqual(3)
  })

  it('the blitz still brings five', () => {
    expect(rows.filter(r => r.job === 'rush')).toHaveLength(5)
  })
})

// ── Reported from a real game: congested zones ([alignment]) ───────────────
//
// ⚠️ "LOOK HOW CONGESTED THE ZONES ARE. WE HAVE MULTIPLE PEOPLE BASICALLY GUARDING THE SAME AREA."
//
// Cover 4 with the ball on a hash. The authored deep landmarks in this playbook ARE field
// divisions — read them off and they are ±13.3 for two-deep (halves), ±17.8 and 0 for three
// (thirds), ±20 and ±6.7 for four (quarters), all measured from the middle of a 53.33-yard field.
// They were being resolved against the BALL, so on a hash the whole structure slid eight yards and
// two quarters ended up on top of each other by one sideline with seventeen yards of the other
// side unaccounted for.
describe('⚠️ DEEP ZONES DIVIDE THE FIELD, NOT THE BALL', () => {
  const LEFT_HASH = 53.33 * 0.35     // 18.67 — where most snaps actually happen
  const FIELD_MID = 53.33 / 2
  const L = 45

  const quarters = {
    category: '5-3',
    spots: [
      { slot: 'DL1', dx: -2.6, depth: 1 }, { slot: 'DL2', dx: -0.2, depth: 1.1 },
      { slot: 'DL3', dx: 2.2, depth: 1.1 }, { slot: 'DL4', dx: 4.8, depth: 1.2 },
      { slot: 'CB1', dx: -16.3, depth: 7 }, { slot: 'CB2', dx: 16.2, depth: 7 },
      { slot: 'S1', dx: -8, depth: 9.1 }, { slot: 'S2', dx: 8, depth: 9 },
      { slot: 'LB1', dx: -5.2, depth: 1 }, { slot: 'LB2', dx: -2.5, depth: 4.3 },
      { slot: 'LB3', dx: 2.2, depth: 4.3 },
    ],
  }
  const cover4 = {
    assignments: {
      DL1: { job: 'rush' }, DL2: { job: 'rush' }, DL3: { job: 'rush' }, DL4: { job: 'rush' },
      CB1: { job: 'zone', zone: 'deep', center: { dx: -20, depth: 14 } },
      CB2: { job: 'zone', zone: 'deep', center: { dx: 20, depth: 14 } },
      S1:  { job: 'zone', zone: 'deep', center: { dx: -6.7, depth: 14 } },
      S2:  { job: 'zone', zone: 'deep', center: { dx: 6.7, depth: 14 } },
      LB1: { job: 'zone', zone: 'hook', center: { dx: -15.8, depth: 6.2 } },
      LB2: { job: 'zone', zone: 'curl', center: { dx: 0, depth: 8 } },
      LB3: { job: 'zone', zone: 'hook', center: { dx: 16.2, depth: 6 } },
    },
  }
  const wide = [
    { id: 'wr1', x: 7.9,  y: L, label: 'WR' },
    { id: 'te1', x: 13.5, y: L, label: 'TE' },
    { id: 'te2', x: 23.8, y: L, label: 'TE' },
    { id: 'wr2', x: 37.3, y: L, label: 'WR' },
    { id: 'rb1', x: 21.0, y: L - 6, label: 'RB' },
  ]
  const at = (ballX) => alignAuthored({
    formation: quarters, shell: cover4, receivers: wide, ballX, losY: L, ready: true,
  }).filter(r => r.zone === 'deep').map(r => r.zoneCenterX).sort((a, b) => a - b)

  it('⚠️ FOUR DEEP LANDMARKS SPAN THE FIELD EVEN WITH THE BALL ON A HASH', () => {
    const deep = at(LEFT_HASH)
    expect(deep).toHaveLength(4)
    // Ball-relative, these came out at roughly 0, 12, 25 and 39 — everything left, nothing right.
    expect(deep[0]).toBeGreaterThan(2)
    expect(deep[3]).toBeGreaterThan(40)
  })

  it('⚠️ NOBODY IS STANDING IN SOMEBODY ELSE’S QUARTER', () => {
    const deep = at(LEFT_HASH)
    for (let i = 1; i < deep.length; i++) expect(deep[i] - deep[i - 1]).toBeGreaterThan(8)
  })

  it('⚠️ THE STRUCTURE SHIFTS AS A UNIT — its shape is identical on either hash', () => {
    // Each man sliding toward his own side is what closes the gaps. A secondary rotates; it does
    // not compress. The spacing must therefore be the same wherever the ball is.
    const gapsOf = (v) => v.slice(1).map((x, i) => +(x - v[i]).toFixed(3))
    const left = gapsOf(at(LEFT_HASH))
    const mid = gapsOf(at(FIELD_MID))
    const right = gapsOf(at(53.33 * 0.65))
    expect(left).toEqual(mid)
    expect(right).toEqual(mid)
  })

  it('it still shades toward the formation, just not far', () => {
    const deep = at(FIELD_MID)
    // Drawn at the quarters off field centre; allowed to lean, never to chase.
    for (const [i, drawn] of [FIELD_MID - 20, FIELD_MID - 6.7, FIELD_MID + 6.7, FIELD_MID + 20].entries()) {
      expect(Math.abs(deep[i] - drawn)).toBeLessThanOrEqual(2 + 1e-9)
    }
  })

  it('a quarter with nobody in it is still covered', () => {
    // Everybody to one side used to leave the backside deep defender on his ball-relative spot.
    const allLeft = wide.filter(r => r.x < 18)
    const deep = alignAuthored({
      formation: quarters, shell: cover4, receivers: allLeft, ballX: LEFT_HASH, losY: L, ready: true,
    }).filter(r => r.zone === 'deep').map(r => r.zoneCenterX).sort((a, b) => a - b)
    expect(deep[3]).toBeGreaterThan(40)
  })
})
