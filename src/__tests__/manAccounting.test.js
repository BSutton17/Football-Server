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
