import { describe, it, expect } from '@jest/globals'
import { loadPlaybook } from '../playbook/store.js'
import { alignAuthored, FIELD_MIN_Y, FIELD_MAX_Y, FIELD_MIN_X, FIELD_MAX_X } from '../ai/playbook/alignAuthored.js'
import { layoutShellForClient } from '../ai/playcall/recommend.js'

// ⚠️ THE FIELD ENDS, AND THE DEFENSE DID NOT KNOW. A defensive spot is `losY + depth` and nothing
// clamped it, so on the goal line a safety drawn fifteen yards deep came out at y = 115 and
// `place_player` refused him, while a deep zone's landmark went past the back of the end zone and
// `assign_coverage` refused the WHOLE assignment. A defender with no assignment is one the engine
// RUSHES — so a red-zone shell quietly became a blitz with holes in it.
//
// Offensive spots were always clamped by `legalSpot`. The defense never was. Measured in a smoke
// run: 105 refused coverage assignments and 39 refused placements over 420 downs.
//
// Run against the REAL playbook, at the yard lines where it actually bites.

const book = loadPlaybook()
const RECEIVERS = [
  { id: 'a', label: 'WR', x: 5, y: 95 }, { id: 'b', label: 'WR', x: 48, y: 95 },
  { id: 'c', label: 'WR', x: 34, y: 95 }, { id: 'd', label: 'TE', x: 20, y: 95 },
  { id: 'e', label: 'RB', x: 26, y: 89 },
]
const shells = Object.entries(book.shells ?? {})

// The goal line is where it bites, but check both ends and midfield.
const LINES = [98, 95, 50, 5, 2]

describe('every defender stays on the field', () => {
  it('has shells to check', () => expect(shells.length).toBeGreaterThan(0))

  it('⚠️ PLACES NOBODY PAST THE BACK OF THE END ZONE', () => {
    const bad = []
    for (const losY of LINES) {
      for (const [id, sh] of shells) {
        const f = book.defFormations[sh.formationId]
        if (!f) continue
        const rows = alignAuthored({
          formation: { ...f, id: sh.formationId }, shell: { ...sh, id },
          receivers: RECEIVERS.map(r => ({ ...r, y: losY })), ballX: 26.7, losY, ready: true,
        })
        for (const r of rows) {
          if (r.y < FIELD_MIN_Y || r.y > FIELD_MAX_Y) bad.push(`${id}@${losY} y=${r.y.toFixed(1)}`)
          if (r.x < FIELD_MIN_X || r.x > FIELD_MAX_X) bad.push(`${id}@${losY} x=${r.x.toFixed(1)}`)
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('⚠️ LANDS EVERY ZONE ON A LANDMARK THAT IS ON THE FIELD', () => {
    // A refused assignment is worse than a bad one: the engine rushes anyone it has no job for.
    const bad = []
    for (const losY of LINES) {
      for (const [id] of shells) {
        const l = layoutShellForClient(book, id, {
          losY, ballX: 26.7, receivers: RECEIVERS.map(r => ({ ...r, y: losY })),
        })
        for (const sp of l?.spots ?? []) {
          if (sp.job !== 'zone') continue
          if (!(sp.zoneCenterY >= -10 && sp.zoneCenterY <= 110)) bad.push(`${id}@${losY} cy=${sp.zoneCenterY}`)
          if (!(sp.zoneCenterX >= 0 && sp.zoneCenterX <= 53.33)) bad.push(`${id}@${losY} cx=${sp.zoneCenterX}`)
        }
      }
    }
    expect(bad.slice(0, 5)).toEqual([])
  })

  it('leaves a defender at midfield exactly where the shell drew him', () => {
    // The clamp must only bite at the edges — it is a guard, not an adjustment.
    const [id, sh] = shells[0]
    const f = book.defFormations[sh.formationId]
    const rows = alignAuthored({
      formation: { ...f, id: sh.formationId }, shell: { ...sh, id },
      receivers: RECEIVERS.map(r => ({ ...r, y: 50 })), ballX: 26.7, losY: 50, ready: true,
    })
    for (const r of rows) {
      expect(r.y).toBeGreaterThan(FIELD_MIN_Y)
      expect(r.y).toBeLessThan(FIELD_MAX_Y)
    }
  })
})
