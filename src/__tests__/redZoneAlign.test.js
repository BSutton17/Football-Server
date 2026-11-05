import { describe, it, expect } from '@jest/globals'
import { readFileSync } from 'node:fs'
import { alignAuthored, redZoneSqueeze } from '../ai/playbook/alignAuthored.js'

// [red zone] "When the AI is in the redzone on defense, they are playing way too far off. Safeties are deep
// in the endzone when everyone should be closer to the line while respecting alignment since nothing can
// beat them over the top."

const formation = {
  spots: [
    { slot: 'DL1', dx: -3.25, depth: 1 }, { slot: 'DL2', dx: -1.25, depth: 1 },
    { slot: 'DL3', dx: 1.25, depth: 1 }, { slot: 'DL4', dx: 3.25, depth: 1 },
    { slot: 'LB1', dx: -5, depth: 5 }, { slot: 'LB2', dx: 0, depth: 5 }, { slot: 'LB3', dx: 5, depth: 5 },
    { slot: 'CB1', dx: -14, depth: 7 }, { slot: 'CB2', dx: 14, depth: 7 },
    { slot: 'S1', dx: -8, depth: 13 }, { slot: 'S2', dx: 8, depth: 13 },
  ],
}
const cover2 = {
  assignments: {
    CB1: { job: 'zone', zone: 'flat', center: { dx: -16, depth: 4 } },
    CB2: { job: 'zone', zone: 'flat', center: { dx: 16, depth: 4 } },
    LB1: { job: 'zone', zone: 'curl', center: { dx: -9, depth: 10 } },
    LB2: { job: 'zone', zone: 'hook', center: { dx: 0, depth: 8 } },
    LB3: { job: 'zone', zone: 'curl', center: { dx: 9, depth: 10 } },
    S1: { job: 'zone', zone: 'deep', center: { dx: -13, depth: 15 } },
    S2: { job: 'zone', zone: 'deep', center: { dx: 13, depth: 15 } },
  },
}
const cover1 = {
  assignments: {
    CB1: { job: 'man' }, CB2: { job: 'man' }, LB1: { job: 'man' }, LB2: { job: 'man' }, LB3: { job: 'man' },
    S1: { job: 'zone', zone: 'deep', center: { dx: 0, depth: 16 } },
    S2: { job: 'man' },
  },
}
const receiversAt = (losY) => [
  { id: 'a', label: 'WR', x: 6, y: losY - 1 }, { id: 'b', label: 'WR', x: 46, y: losY - 1 },
  { id: 'c', label: 'WR', x: 38, y: losY - 1 }, { id: 'd', label: 'TE', x: 20, y: losY - 1 },
  { id: 'e', label: 'RB', x: 26, y: losY - 6 },
]
const align = (losY, shell = cover2, ready = true) =>
  alignAuthored({ formation, shell, receivers: receiversAt(losY), ballX: 26.67, losY, ready })
const row = (rows, slot) => rows.find(r => r.slot === slot)

describe('[red zone] everyone comes up with the field', () => {
  it('⚠️ FROM THE 10 A SAFETY IS IN FRONT OF THE GOAL LINE, NOT IN THE END ZONE (he stood at 103)', () => {
    const s = row(align(90), 'S1')
    expect(s.y).toBeLessThan(100)
    expect(s.depth).toBeCloseTo(8.5, 5)
  })

  it('⚠️ AND HE IS NOT SENT TO THE BACK OF IT: the drop stops three yards in', () => {
    for (const losY of [80, 90, 95, 98]) {
      const s = row(align(losY), 'S1')
      expect(losY + s.zoneCenter.depth).toBeLessThanOrEqual(103 + 1e-9)
    }
  })

  it('on the goal line the deep man is still only a few yards off', () => {
    const s = row(align(98), 'S1')
    expect(s.depth).toBeCloseTo(4.5, 5)
  })

  it('⚠️ IT SQUEEZES MORE THE CLOSER THE BALL GETS', () => {
    const depths = [80, 85, 90, 95, 98].map(losY => row(align(losY), 'S1').depth)
    for (let i = 1; i < depths.length; i++) expect(depths[i]).toBeLessThan(depths[i - 1])
  })

  it('⚠️ THE ALIGNMENT IS RESPECTED: same order front to back, same jobs, same sides', () => {
    for (const losY of [80, 85, 90, 95]) {
      const rows = align(losY)
      // The safeties are still the deepest men on the field, whatever else has come up.
      for (const r of rows) if (r.label !== 'S') expect(r.depth).toBeLessThan(row(rows, 'S1').depth)
      expect(row(rows, 'S1').job).toBe('zone')
      expect(row(rows, 'S1').zone).toBe('deep')
      // Scaled by one factor, so the second level moves in proportion rather than piling up.
      const { body } = redZoneSqueeze(formation.spots, cover2.assignments, losY)
      expect(row(rows, 'S1').depth).toBeCloseTo(13 * body, 5)
    }
  })

  it('and so do the drops: underneath zones stay underneath the deep ones', () => {
    for (const losY of [85, 90, 95, 98]) {
      const rows = align(losY)
      expect(row(rows, 'LB1').zoneCenter.depth).toBeLessThan(row(rows, 'S1').zoneCenter.depth)
      expect(row(rows, 'CB1').zoneCenter.depth).toBeLessThan(row(rows, 'LB1').zoneCenter.depth)
    }
  })

  it('the linemen hold the line, and nobody is squeezed onto it', () => {
    const rows = align(99)
    expect(row(rows, 'DL1').depth).toBe(1)
    for (const r of rows) if (r.label !== 'DL') expect(r.depth).toBeGreaterThanOrEqual(1.5)
  })

  it('⚠️ THE OPEN FIELD DOES NOT CHANGE AT ALL', () => {
    for (const losY of [25, 40, 60, 75]) {
      expect(redZoneSqueeze(formation.spots, cover2.assignments, losY)).toEqual({ body: 1, landmark: 1 })
      expect(row(align(losY), 'S1').depth).toBe(13)
    }
  })

  it('it is already there before the offense sets, so nobody jumps when it does', () => {
    expect(row(align(90, cover2, false), 'S1').depth).toBeCloseTo(8.5, 5)
    expect(row(align(90, cover2, false), 'S1').zoneCenter.depth).toBeLessThan(15)
  })

  it('⚠️ THE MAN OVER THE TOP STILL COUNTS AS HELP. Cover 1 must not turn into Cover 0 at the 10', () => {
    // With deep help a man defender may shade anything; with none, every one of them is `over`.
    const shades = align(90, cover1).filter(r => r.job === 'man' && r.covers).map(r => r.shade)
    expect(shades.some(s => s !== 'over')).toBe(true)
    expect(align(90, cover1).map(r => r.shade)).toEqual(align(60, cover1).map(r => r.shade))
  })

  it('nobody ends up standing on anybody', () => {
    for (const losY of [85, 90, 95, 98, 99]) {
      const rows = align(losY)
      for (let i = 0; i < rows.length; i++) {
        for (let j = i + 1; j < rows.length; j++) {
          expect(Math.hypot(rows[i].x - rows[j].x, rows[i].y - rows[j].y)).toBeGreaterThanOrEqual(1.2)
        }
      }
    }
  })

  it('⚠️ EVERY SHELL IN THE REAL PLAYBOOK, FROM THE 10: no body in the end zone, every drop near the goal', () => {
    const book = JSON.parse(readFileSync(new URL('../ai/playbook/authored.json', import.meta.url), 'utf8'))
    const forms = Object.values(book.defFormations)
    const shells = Object.values(book.shells)
    expect(forms.length).toBeGreaterThan(5)
    let checked = 0
    for (const f of forms) {
      for (const shell of shells) {
        const rows = alignAuthored({ formation: f, shell, receivers: receiversAt(90), ballX: 26.67, losY: 90, ready: true })
        for (const r of rows) {
          expect(r.y).toBeLessThanOrEqual(100)
          if (r.zoneCenter) expect(90 + r.zoneCenter.depth).toBeLessThanOrEqual(103 + 1e-9)
        }
        checked++
      }
    }
    expect(checked).toBeGreaterThan(20)
  })
})
