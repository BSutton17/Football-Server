import { describe, it, expect } from '@jest/globals'
import { coolingPlays, noteRecommended, noteSelected, RECOMMENDED_COOLDOWN, SELECTED_COOLDOWN } from '../ai/playcall/cooldown.js'
import { recommendOffense } from '../ai/playcall/recommend.js'
import { makeRng } from '../game/utils/rng.js'

const fresh = () => ({ snapCount: 0, playCooldown: [{}, {}] })
// Run n snaps, asking at each pre-snap whether the play is cooling.
function coolingFor(state, slot, id, snaps) {
  const out = []
  for (let i = 0; i < snaps; i++) {
    state.snapCount++
    out.push(coolingPlays(state, slot).has(id))
  }
  return out
}

describe('"Once a play is recommended, it cannot be recommended again for 5 plays"', () => {
  it('sits out the next five plays exactly, and is back on the sixth', () => {
    const state = fresh()
    noteRecommended(state, 0, ['mesh'])
    expect(coolingFor(state, 0, 'mesh', 6)).toEqual([true, true, true, true, true, false])
    expect(RECOMMENDED_COOLDOWN).toBe(5)
  })
})

describe('"If a play is selected it cannot be recommended again for 7 plays"', () => {
  it('sits out the next seven plays exactly', () => {
    const state = fresh()
    noteRecommended(state, 0, ['mesh'])
    noteSelected(state, 0, 'mesh')
    expect(coolingFor(state, 0, 'mesh', 8)).toEqual([true, true, true, true, true, true, true, false])
    expect(SELECTED_COOLDOWN).toBe(7)
  })

  it('a later recommendation never shortens a selection\'s cooldown', () => {
    const state = fresh()
    noteSelected(state, 0, 'mesh')
    noteRecommended(state, 0, ['mesh'])
    expect(coolingFor(state, 0, 'mesh', 8).filter(Boolean)).toHaveLength(7)
  })
})

describe('kept per player', () => {
  it('one seat\'s cooldowns never touch the other\'s menu', () => {
    const state = fresh()
    noteSelected(state, 0, 'mesh')
    expect(coolingPlays(state, 1).has('mesh')).toBe(false)
  })

  it('carries through a change of possession — the count is plays, by either team', () => {
    const state = fresh()
    noteRecommended(state, 0, ['mesh'])
    // Three snaps on offense, then two on defense after a punt: still cooling until all five are run.
    expect(coolingFor(state, 0, 'mesh', 5).every(Boolean)).toBe(true)
  })
})

describe('the shortlist leaves cooling plays out', () => {
  const book = {
    formations: { f1: { name: 'F1' }, f2: { name: 'F2' }, f3: { name: 'F3' }, f4: { name: 'F4' } },
    plays: Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id, i) => [id, {
      name: id, playType: 'pass', formationId: `f${(i % 4) + 1}`, assignments: {},
    }])),
  }
  const situation = { down: 1, distance: 10, yardLine: 25 }

  it('never offers a play that is cooling', () => {
    const exclude = new Set(['a', 'b', 'c', 'd'])
    for (let s = 1; s <= 30; s++) {
      const ids = recommendOffense(book, situation, { rng: makeRng(s), exclude }).map(p => p.id)
      for (const id of ids) expect(exclude.has(id)).toBe(false)
    }
  })

  it('a repeat beats an empty menu when everything is cooling', () => {
    const exclude = new Set(Object.keys(book.plays))
    expect(recommendOffense(book, situation, { rng: makeRng(1), exclude }).length).toBeGreaterThan(0)
  })
})
