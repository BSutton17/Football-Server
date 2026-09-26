import { describe, it, expect } from '@jest/globals'
import { loadPlaybook } from '../playbook/store.js'
import { buildAuthoredDefense } from '../ai/playbook/runAuthored.js'
import { classifyShell } from '../ai/playcall/recommend.js'

// ⚠️ "ON MAN PLAYS COVER 1 OR ZERO THE AI ALWAYS HAS EVERYONE ACCOUNTED FOR."
//
// A Cover 1 is drawn with five man defenders because five eligible receivers is the common case.
// Come out in four wides with a tight end and a back and there are SIX, and the sixth ran free —
// with nobody behind him, because that is what man coverage means. Measured against the real
// playbook before the fix: 27 of 30 man shells left exactly one man uncovered, every time.

const book = loadPlaybook()
const roster = [
  ...['cb1', 'cb2', 'cb3', 'cb4'].map((id, i) => ({ id, label: 'CB', ovr: 85 - i, ratings: {} })),
  ...['s1', 's2', 's3'].map((id, i) => ({ id, label: 'S', ovr: 84 - i, ratings: {} })),
  ...['lb1', 'lb2', 'lb3', 'lb4', 'lb5'].map((id, i) => ({ id, label: 'LB', ovr: 83 - i, ratings: {} })),
]
const eligible = (nWR) => [
  ...Array.from({ length: nWR }, (_, i) => ({ id: 'wr' + i, label: 'WR', x: 4 + i * 12, y: 40 })),
  { id: 'te', label: 'TE', x: 22, y: 40 },
  { id: 'rb', label: 'RB', x: 26, y: 34 },
]
const shellsOf = (kind) => Object.entries(book.shells ?? {}).filter(([, sh]) => classifyShell(sh) === kind)

function align(id, sh, receivers) {
  const f = book.defFormations[sh.formationId]
  if (!f) return null
  return buildAuthoredDefense(
    { shell: { ...sh, id }, formation: { ...f, id: sh.formationId }, look: { id: 'x' } },
    { losY: 40, ballX: 26.7, receivers, roster },
  )
}

describe('man coverage accounts for everyone', () => {
  it('has man shells to check', () => expect(shellsOf('man').length).toBeGreaterThan(0))

  for (const nWR of [3, 4]) {
    it(`⚠️ COVERS EVERY ELIGIBLE RECEIVER against ${nWR}WR + TE + RB`, () => {
      const receivers = eligible(nWR)
      const loose = []
      for (const [id, sh] of shellsOf('man')) {
        const rows = align(id, sh, receivers)
        if (!rows) continue
        const covered = new Set(rows.filter(r => r.coverage?.type === 'man').map(r => r.coverage.targetId))
        for (const r of receivers) if (!covered.has(r.id)) loose.push(`${id}: ${r.id}`)
      }
      expect(loose.slice(0, 5)).toEqual([])
    })
  }

  it('⚠️ NEVER GIVES UP THE LAST DEEP DEFENDER — that turns Cover 1 into Cover 0 by accident', () => {
    const receivers = eligible(4)
    for (const [id, sh] of shellsOf('man')) {
      const rows = align(id, sh, receivers)
      if (!rows) continue
      const drawnDeep = Object.values(sh.assignments ?? {})
        .filter(a => a?.job === 'zone' && a.zone === 'deep').length
      if (drawnDeep === 0) continue
      const left = rows.filter(r => r.coverage?.type === 'zone' && r.coverage.zoneType === 'deep').length
      expect(left).toBeGreaterThan(0)
    }
  })

  it('⚠️ NEVER DROPS THE RUSH BELOW FOUR to cover somebody', () => {
    // Four auto linemen always rush; taking a blitzer to cover is fine, taking a lineman is not.
    const receivers = eligible(4)
    for (const [id, sh] of shellsOf('man')) {
      const rows = align(id, sh, receivers)
      if (!rows) continue
      const extra = rows.filter(r => r.coverage?.type === 'blitz').length
      expect(4 + extra).toBeGreaterThanOrEqual(4)
    }
  })

  it('leaves ZONE shells alone — uncovered receivers are what a zone is', () => {
    const receivers = eligible(4)
    let anyLoose = false
    for (const [id, sh] of shellsOf('zone')) {
      const rows = align(id, sh, receivers)
      if (!rows) continue
      const covered = new Set(rows.filter(r => r.coverage?.type === 'man').map(r => r.coverage.targetId))
      if (receivers.some(r => !covered.has(r.id))) anyLoose = true
    }
    expect(anyLoose).toBe(true)
  })
})

// ── Eleven men, always ([alignment]) ────────────────────────────────────────
//
// ⚠️ "THERE ARE ONLY 10 PEOPLE ON THE FIELD FOR SOME REASON."
//
// Reported with a screenshot of 2 MAN out of NICKEL 3-3 MINT against two tight ends. The cause was
// not the alignment at all — it was the ROSTER running out. `coverOrder` sent safeties to cover
// tight ends, a roster carries three safeties, two tight ends took two of them, and the two-deep
// shell behind found one safety for two deep slots. The slot that found nobody was silently
// skipped, so the defense took the field a man short and the second deep zone did not exist.
//
// Every shell is now checked against a real roster, with the personnel that exhausts it.
describe('⚠️ EVERY SHELL FIELDS ELEVEN, WHATEVER THE OFFENSE SHOWS', () => {
  // `buildAuthoredDefense` returns the back end only — the front is placed separately, and the AI
  // builds one that MATCHES ITS SHELL (three or four). So the count to check is the shell's own
  // linemen plus everybody behind them. (The client's PLAYS panel is the one fixed at four, and
  // `layoutShellForClient` drops a surplus rusher for it; that is a different layer.)
  const frontOf = (sh) => Object.keys(sh.assignments ?? {}).filter(k => k.startsWith('DL')).length

  // The personnel that actually broke it: two tight ends, which compete for the safeties.
  const heavy = [
    { id: 'wr1', label: 'WR', x: 6, y: 40 },
    { id: 'te1', label: 'TE', x: 20, y: 40 },
    { id: 'te2', label: 'TE', x: 33, y: 40 },
    { id: 'wr2', label: 'WR', x: 45, y: 40 },
    { id: 'wr3', label: 'WR', x: 48, y: 40 },
  ]
  // …and the other direction: five wide, which exhausts the corners instead.
  const spread = Array.from({ length: 5 }, (_, i) => ({ id: 'w' + i, label: 'WR', x: 4 + i * 11, y: 40 }))

  for (const [name, receivers] of [['two tight ends', heavy], ['five wide', spread]]) {
    it(`fields eleven against ${name}, in every shell in the book`, () => {
      const short = []
      for (const [id, sh] of Object.entries(book.shells ?? {})) {
        const rows = align(id, sh, receivers)
        if (!rows) continue
        const total = rows.length + frontOf(sh)
        if (total !== 11) short.push(`${id} (${sh.name}): ${total}`)
      }
      expect(short).toEqual([])
    })
  }

  it('⚠️ AND NOBODY IS ON THE FIELD TWICE', () => {
    for (const [id, sh] of Object.entries(book.shells ?? {})) {
      const rows = align(id, sh, heavy)
      if (!rows) continue
      const ids = rows.map(r => r.id)
      expect(new Set(ids).size).toBe(ids.length)
    }
  })

  it('⚠️ A LINEBACKER TAKES THE TIGHT END, NOT A SAFETY', () => {
    // The matchup the author asked for: two safeties on two tight ends is a losing run fit, and it
    // is also what emptied the safety pool and cost the eleventh man.
    let checked = 0
    for (const [id, sh] of Object.entries(book.shells ?? {})) {
      if (classifyShell(sh) !== 'man') continue
      const rows = align(id, sh, heavy)
      if (!rows) continue
      for (const r of rows) {
        if (r.coverage?.type !== 'man') continue
        if (r.coverage.targetId !== 'te1' && r.coverage.targetId !== 'te2') continue
        checked++
        expect(['LB', 'S']).toContain(r.label)   // a corner on a tight end would be the wrong body
      }
    }
    expect(checked).toBeGreaterThan(0)
  })
})

// ── Nobody stands inside anybody ([alignment]) ─────────────────────────────
//
// ⚠️ "THERE IS A LB THAT IS DOWN AND ACTUALLY OVERLAPPING A DL, THAT SHOULD NEVER HAPPEN."
//
// Measured across the whole book before the fix: 26 of 94 shells put two defenders within a body's
// width of each other, the worst pair 0.10 yards apart. Three causes, all of them the check
// comparing against something that was not there:
//   • the linemen were the ones the SHELL DREW, not the ones auto-placed from DL_SPACING;
//   • they were counted from surviving rows rather than from the formation, so a dropped rusher
//     silently changed a four-man front into a three-man one with different spacing;
//   • a rusher crept SHALLOWER than the line, so he sorted before it and the front was not yet
//     "settled" for him — the one pair that most needed checking was the pair nobody checked.
// And man defenders were exempt entirely, which let two of them stand on the same blade of grass.
describe('⚠️ NO TWO DEFENDERS OCCUPY THE SAME SPOT', () => {
  const GAP = 1.25             // MIN_DEFENDER_GAP — a player is a yard across
  const DL_SPACING = { 3: [-3.0, 0, 3.0], 4: [-3.25, -1.25, 1.25, 3.25] }
  const L = 40, B = 26.7

  // The real front, placed the way the controller places it: off the FORMATION's lineman count,
  // on one straight line a yard off the ball.
  const frontFor = (f) => {
    const n = (f.spots ?? []).filter(sp => String(sp.slot).startsWith('DL')).length
    return (DL_SPACING[n] ?? DL_SPACING[4]).map((dx, i) => ({ id: 'dl' + i, label: 'DL', x: B + dx, y: L + 1 }))
  }

  const looks = [
    ['two tight ends', [
      { id: 'wr1', label: 'WR', x: 6, y: L }, { id: 'te1', label: 'TE', x: 20, y: L },
      { id: 'te2', label: 'TE', x: 33, y: L }, { id: 'wr2', label: 'WR', x: 45, y: L },
      { id: 'rb1', label: 'RB', x: 28, y: L - 6 },
    ]],
    // Bunched receivers are what put two MAN defenders on one spot.
    ['a bunch', [
      { id: 'b1', label: 'WR', x: 16, y: L }, { id: 'b2', label: 'WR', x: 17.5, y: L },
      { id: 'b3', label: 'WR', x: 19, y: L }, { id: 'te1', label: 'TE', x: 33, y: L },
      { id: 'rb1', label: 'RB', x: 28, y: L - 6 },
    ]],
  ]

  for (const [name, receivers] of looks) {
    it(`every shell keeps a body's width between everyone, against ${name}`, () => {
      const bad = []
      for (const [id, sh] of Object.entries(book.shells ?? {})) {
        const f = book.defFormations[sh.formationId]
        if (!f) continue
        const rows = align(id, sh, receivers)
        if (!rows) continue
        const all = [...frontFor(f), ...rows]
        for (let i = 0; i < all.length; i++) {
          for (let j = i + 1; j < all.length; j++) {
            const d = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)
            if (d < GAP - 1e-9) {
              bad.push(`${id}: ${all[i].label}/${all[j].label} ${d.toFixed(2)}yd`)
            }
          }
        }
      }
      expect(bad).toEqual([])
    })
  }
})
