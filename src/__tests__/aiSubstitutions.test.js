import { describe, it, expect } from '@jest/globals'
import {
  SUB, SUB_POSITIONS, assignSubPlans, subOutAt, createSubSystem, byDepth,
  SECOND_HALF_BREAK_FLOOR, RETURN_MIN, RETURN_MAX,
} from '../ai/substitutions.js'
import { YELLOW_AT, RED_AT } from '../game/systems/stamina.js'
import { buildFormation } from '../ai/offense.js'
import { selectPlayers } from '../ai/defense.js'
import { syntheticRoster } from '../ai/roster.js'
import { makeRng } from '../game/utils/rng.js'

// A situation: 1st and 10 in the 1st quarter unless told otherwise.
const sit = (over = {}) => ({ down: 1, quarter: 1, clock: 300, quarterSeconds: 300, fatigue: {}, ...over })

describe('a plan per position, drawn at game start', () => {
  it('gives every skill position one of the three tiers', () => {
    const plans = assignSubPlans(makeRng(1))
    expect(Object.keys(plans).sort()).toEqual([...SUB_POSITIONS].sort())
    for (const tier of Object.values(plans)) expect(Object.values(SUB)).toContain(tier)
  })

  it('differs between games — it is a draw, not a constant', () => {
    const seen = new Set()
    for (let s = 1; s <= 40; s++) seen.add(JSON.stringify(assignSubPlans(makeRng(s))))
    expect(seen.size).toBeGreaterThan(10)
  })
})

describe('when each tier takes a player off', () => {
  it('Grind it out: only in the red, whatever the situation', () => {
    expect(subOutAt(SUB.GRIND, sit())).toBe(RED_AT)
    expect(subOutAt(SUB.GRIND, sit({ quarter: 3 }))).toBe(RED_AT)
    expect(subOutAt(SUB.GRIND, sit({ down: 3 }))).toBe(RED_AT)
  })

  it('Keep \'em fresh: on entering the yellow, no matter what', () => {
    expect(subOutAt(SUB.FRESH, sit())).toBe(YELLOW_AT)
    expect(subOutAt(SUB.FRESH, sit({ down: 3 }))).toBe(YELLOW_AT)
    expect(subOutAt(SUB.FRESH, sit({ down: 4 }))).toBe(YELLOW_AT)
    expect(subOutAt(SUB.FRESH, sit({ quarter: 2, clock: 20 }))).toBe(YELLOW_AT)
    expect(subOutAt(SUB.FRESH, sit({ quarter: 4 }))).toBe(YELLOW_AT)
  })

  it('Have a break: on entering the yellow in the 1st half', () => {
    expect(subOutAt(SUB.BREAK, sit())).toBe(YELLOW_AT)
  })

  it('…but not on a crucial play — a 3rd-down stop or a 4th-down conversion — only the red then', () => {
    expect(subOutAt(SUB.BREAK, sit({ down: 3 }))).toBe(RED_AT)
    expect(subOutAt(SUB.BREAK, sit({ down: 4 }))).toBe(RED_AT)
  })

  it('…and not towards the end of a half', () => {
    expect(subOutAt(SUB.BREAK, sit({ quarter: 2, clock: 60 }))).toBe(RED_AT)
    expect(subOutAt(SUB.BREAK, sit({ quarter: 4, clock: 60 }))).toBe(RED_AT)
    expect(subOutAt(SUB.BREAK, sit({ quarter: 2, clock: 200 }))).toBe(YELLOW_AT)   // not yet
    expect(subOutAt(SUB.BREAK, sit({ quarter: 1, clock: 20 }))).toBe(YELLOW_AT)    // a quarter, not a half
  })

  it('in the 2nd half, somewhere between the start of the yellow and halfway through it', () => {
    expect(subOutAt(SUB.BREAK, sit({ quarter: 3 }), 52)).toBe(52)
    expect(SECOND_HALF_BREAK_FLOOR).toBe((YELLOW_AT + RED_AT) / 2)
  })
})

describe('the bench', () => {
  const roster = syntheticRoster('ai0')
  const wr1 = 'ai0_wr1'
  // The plan for every position forced to one tier.
  const systemWith = (tier, seed = 3) => {
    const subs = createSubSystem(makeRng(seed))
    for (const pos of SUB_POSITIONS) subs.plans[pos] = tier
    return subs
  }

  it('sits a player down when he crosses his tier\'s line', () => {
    const subs = systemWith(SUB.BREAK)
    subs.update(roster, sit({ fatigue: { [wr1]: 62 } }))
    expect(subs.bench.has(wr1)).toBe(false)
    subs.update(roster, sit({ fatigue: { [wr1]: 58 } }))
    expect(subs.bench.has(wr1)).toBe(true)
  })

  it('Have a break keeps him on for 3rd down; Keep \'em fresh does not', () => {
    const breaking = systemWith(SUB.BREAK)
    breaking.update(roster, sit({ down: 3, fatigue: { [wr1]: 50 } }))
    expect(breaking.bench.has(wr1)).toBe(false)
    const fresh = systemWith(SUB.FRESH)
    fresh.update(roster, sit({ down: 3, fatigue: { [wr1]: 50 } }))
    expect(fresh.bench.has(wr1)).toBe(true)
  })

  it('Grind it out plays him into the yellow and only sits him in the red', () => {
    const subs = systemWith(SUB.GRIND)
    subs.update(roster, sit({ fatigue: { [wr1]: 40 } }))
    expect(subs.bench.has(wr1)).toBe(false)
    subs.update(roster, sit({ fatigue: { [wr1]: 29 } }))
    expect(subs.bench.has(wr1)).toBe(true)
  })

  it('⚠️ THE BETTER PLAYER COMES BACK at 80–85%, and not before', () => {
    const subs = systemWith(SUB.FRESH)
    subs.update(roster, sit({ fatigue: { [wr1]: 55 } }))
    const back = subs.bench.get(wr1)
    expect(back).toBeGreaterThanOrEqual(RETURN_MIN)
    expect(back).toBeLessThanOrEqual(RETURN_MAX)
    subs.update(roster, sit({ fatigue: { [wr1]: 79 } }))
    expect(subs.bench.has(wr1)).toBe(true)
    subs.update(roster, sit({ fatigue: { [wr1]: 86 } }))
    expect(subs.bench.has(wr1)).toBe(false)
  })

  it('never benches anyone who has not played — no stamina reported means fresh', () => {
    const subs = systemWith(SUB.FRESH)
    subs.update(roster, sit())
    expect(subs.bench.size).toBe(0)
  })

  it('leaves the quarterback and the linemen alone — they are not the AI\'s to place', () => {
    const subs = systemWith(SUB.FRESH)
    const withQb = [...roster, { id: 'ai0_qb1', position: 'QB', ovr: 90 }]
    subs.update(withQb, sit({ fatigue: { ai0_qb1: 10 } }))
    expect(subs.bench.has('ai0_qb1')).toBe(false)
  })
})

describe('the lineup the builders see', () => {
  const roster = syntheticRoster('ai0')

  it('puts the backup on the field in place of a sitting starter', () => {
    const subs = createSubSystem(makeRng(5))
    subs.plans.CB = SUB.FRESH
    const k = sit({ fatigue: { ai0_cb1: 40 } })
    const onField = selectPlayers(subs.lineup(roster, k), { CB: 2, S: 2, LB: 3 })
    const corners = onField.filter(p => p.position === 'CB').map(p => p.id)
    expect(corners).not.toContain('ai0_cb1')
    expect(corners).toEqual(['ai0_cb2', 'ai0_cb3'])
  })

  it('⚠️ A SITTER STILL PLAYS IF THE FORMATION NEEDS EVERY MAN — never a man short', () => {
    const subs = createSubSystem(makeRng(5))
    subs.plans.RB = SUB.FRESH
    // Both backs tired; a formation with two backs still gets two.
    const k = sit({ fatigue: { ai0_rb1: 40, ai0_rb2: 50 } })
    const onField = selectPlayers(subs.lineup(roster, k), { RB: 2 })
    expect(onField.map(p => p.id).sort()).toEqual(['ai0_rb1', 'ai0_rb2'])
  })

  it('among sitters who must play, the freshest goes first', () => {
    const sitters = [
      { id: 'a', ovr: 90, benched: true, stamina: 40 },
      { id: 'b', ovr: 70, benched: true, stamina: 55 },
      { id: 'c', ovr: 60, benched: false, stamina: 90 },
    ]
    expect([...sitters].sort(byDepth).map(p => p.id)).toEqual(['c', 'b', 'a'])
  })

  it('the offense fills its spots the same way', () => {
    const subs = createSubSystem(makeRng(5))
    subs.plans.WR = SUB.FRESH
    const k = sit({ fatigue: { ai0_wr1: 45 } })
    // Trips: three receivers out of a roster of four, so the fourth comes on for the tired first.
    const players = buildFormation({ formationId: 'trips', conceptId: 'mesh' }, k,
      { losY: 25, ballX: 26.67, roster: subs.lineup(roster, k), rng: makeRng(1) })
    const wrs = players.filter(p => p.label === 'WR').map(p => p.id).sort()
    expect(wrs).toEqual(['ai0_wr2', 'ai0_wr3', 'ai0_wr4'])
  })
})
