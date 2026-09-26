import { describe, it, expect } from '@jest/globals'
import { loadPlaybook } from '../playbook/store.js'
import { layoutShellForClient, CLIENT_AUTO_DL } from '../ai/playcall/recommend.js'

// ⚠️ "THERE ARE SOMETIMES 12 PLAYERS ON THE FIELD, DURING NICKEL AND SOME 3-DL PLAYS."
//
// Five of the authored defensive formations are 3 DL plus EIGHT behind them — eleven on the
// server, where the front is built to match the shell. The CLIENT's front is a fixed four
// (`getDLPlayers`), so loading one of those shells put four linemen and eight defenders on the
// grass. Exactly the three-down fronts the report named.
//
// This runs against the REAL playbook rather than a fixture, because the whole bug was a mismatch
// between what was authored and what the client fields — a fixture would have agreed with itself.

const book = loadPlaybook()
const RECEIVERS = [
  { id: 'a', label: 'WR', x: 5, y: 40 },
  { id: 'b', label: 'WR', x: 48, y: 40 },
  { id: 'c', label: 'WR', x: 34, y: 40 },
  { id: 'd', label: 'TE', x: 20, y: 40 },
  { id: 'e', label: 'RB', x: 26, y: 34 },
]
const layout = (id) => layoutShellForClient(book, id, { losY: 40, ballX: 26.7, receivers: RECEIVERS })

describe('every shell fields exactly eleven on the client', () => {
  const ids = Object.keys(book.shells ?? {})

  it('has shells to check', () => {
    expect(ids.length).toBeGreaterThan(0)
  })

  it('⚠️ NEVER SENDS MORE THAN THE CLIENT CAN FIELD', () => {
    const over = ids.filter(id => CLIENT_AUTO_DL + (layout(id)?.spots.length ?? 0) !== 11)
    expect(over).toEqual([])
  })

  it('keeps the coverage intact — the body it gives up is a rusher wherever one exists', () => {
    // The extra auto lineman is already rushing, so a spare rusher costs the shell nothing.
    for (const id of ids) {
      const l = layout(id)
      const covering = l.spots.filter(s => s.job === 'man' || s.job === 'zone').length
      expect(covering).toBeGreaterThanOrEqual(5)
    }
  })

  it('still lands every zone on a real landmark', () => {
    for (const id of ids) {
      for (const s of layout(id).spots) {
        if (s.job === 'zone') expect(typeof s.zoneCenterX).toBe('number')
      }
    }
  })

  it('never returns a lineman — both sides place those themselves', () => {
    for (const id of ids) {
      expect(layout(id).spots.every(s => s.label !== 'DL')).toBe(true)
    }
  })
})
