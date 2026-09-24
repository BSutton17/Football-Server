import { describe, it, expect } from '@jest/globals'
import {
  validateFormation, validatePlay, layoutAuthored, personnelOf, routeFor, slotsFor, slotLabel,
  validateShell, shellOptions, MAX_SKILL, SLOT_POOL,
} from '../ai/playbook/authored.js'
import { shadeWithLeverage, shadeFor } from '../ai/assignments.js'
import { SHADE } from '../ai/playbook/coverages.js'

// [authored] The hand-authored playbook: formations, plays and shells drawn in the dev sandbox
// instead of invented by a network.
//
// The property everything else depends on is that a play survives an edit to the formation it was
// built on. That works because routes are stored as OFFSETS against a stable SLOT key, never
// against a player id or an alignment role. These tests pin that down, because the day it stops
// being true every authored play silently points at the wrong grass.

const deuce = {
  name: 'Deuce',
  category: 'gun',
  spots: [
    { slot: 'WR1', dx: -14, depth: 0 },
    { slot: 'WR2', dx: -6, depth: 1 },
    { slot: 'WR3', dx: 14, depth: 0 },
    { slot: 'TE1', dx: 6, depth: 0 },
    { slot: 'RB1', dx: -3, depth: 6 },
  ],
}

const meshRight = {
  name: 'Mesh Right',
  formationId: 'deuce',
  playType: 'pass',
  assignments: {
    WR1: { kind: 'route', points: [{ dx: 0, dd: 5 }, { dx: 12, dd: 6 }] },
    WR3: { kind: 'route', points: [{ dx: 0, dd: 5 }, { dx: -12, dd: 6 }] },
    RB1: { kind: 'block' },
  },
}

describe('a formation the sandbox would save', () => {
  it('accepts a legal one', () => {
    expect(validateFormation(deuce)).toEqual({ ok: true, errors: [] })
  })

  it('derives personnel rather than trusting a stored count', () => {
    // A formation that CLAIMS two tight ends and lists one is a contradiction that should not be
    // expressible, so the count is computed from the spots every time.
    expect(personnelOf(deuce)).toEqual({ WR: 3, TE: 1, RB: 1 })
  })

  it('rejects a back stacked on the quarterback', () => {
    // ⚠️ The QB stands at (ballX, losY - 6). A back at dx 0 / depth 6 lands on top of him and the
    // two collide at the snap — the hand-written table shipped three formations doing this.
    const bad = { ...deuce, spots: [...deuce.spots.slice(0, 4), { slot: 'RB1', dx: 0, depth: 6 }] }
    const r = validateFormation(bad)
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/stacked on the quarterback/)
  })

  it('rejects more players at a position than the roster carries', () => {
    const bad = {
      ...deuce,
      spots: ['WR1', 'WR2', 'WR3', 'WR4', 'TE1'].map((slot, i) => ({ slot, dx: i * 3 - 6, depth: 0 })),
    }
    expect(validateFormation(bad).ok).toBe(true)      // 4 WR is exactly the pool
    const tooMany = {
      ...deuce,
      spots: ['TE1', 'TE2', 'TE3', 'WR1', 'WR2'].map((slot, i) => ({ slot, dx: i * 3 - 6, depth: 0 })),
    }
    expect(validateFormation(tooMany).ok).toBe(true)  // 3 TE is exactly the pool
    expect(SLOT_POOL).toEqual({ WR: 4, TE: 3, RB: 2 })
  })

  it('rejects the wrong number of skill players, a duplicate slot, and a negative depth', () => {
    expect(validateFormation({ ...deuce, spots: deuce.spots.slice(0, 4) }).errors.join(' '))
      .toMatch(new RegExp(`exactly ${MAX_SKILL}`))
    const dup = { ...deuce, spots: [...deuce.spots.slice(0, 4), { slot: 'WR1', dx: 9, depth: 0 }] }
    expect(dup.spots).toHaveLength(MAX_SKILL)
    expect(validateFormation(dup).errors.join(' ')).toMatch(/used twice/)
    const behind = { ...deuce, spots: [...deuce.spots.slice(0, 4), { slot: 'RB1', dx: -3, depth: -2 }] }
    expect(validateFormation(behind).errors.join(' ')).toMatch(/cannot be negative/)
  })
})

describe('putting an authored formation on the grass', () => {
  it('is field-position independent — the same formation from anywhere', () => {
    // dx is yards from the BALL'S HASH and depth is yards behind the line, so one authored
    // formation is correct from any spot on the field and from either hash.
    const a = layoutAuthored(deuce, { losY: 25, ballX: 20 })
    const b = layoutAuthored(deuce, { losY: 70, ballX: 33 })
    for (let i = 0; i < a.length; i++) {
      expect(a[i].x - 20).toBeCloseTo(b[i].x - 33)
      expect(25 - a[i].y).toBeCloseTo(70 - b[i].y)
    }
  })

  it('mirrors left/right when asked, and NOT by default', () => {
    // ⚠️ The hand-written table flips at random for free variety. An authored play was drawn a
    // specific way — "Mesh Right" mirrored is a different play — so flipping is opt-in.
    const straight = layoutAuthored(deuce, { losY: 40, ballX: 26.65 })
    const mirrored = layoutAuthored(deuce, { losY: 40, ballX: 26.65, mirror: true })
    expect(straight[0].x).toBeLessThan(26.65)
    expect(mirrored[0].x).toBeGreaterThan(26.65)
    expect(straight[0].y).toBeCloseTo(mirrored[0].y)
  })

  it('carries the slot through, which is what the routes key off', () => {
    expect(layoutAuthored(deuce, { losY: 40, ballX: 26.65 }).map(s => s.slot))
      .toEqual(['WR1', 'WR2', 'WR3', 'TE1', 'RB1'])
  })

  it('maps a slot to the label the roster fills', () => {
    expect(slotLabel('WR3')).toBe('WR')
    expect(slotLabel('RB1')).toBe('RB')
    expect(slotsFor()).toContain('TE3')
  })
})

describe('a play the sandbox would save', () => {
  it('accepts a legal one', () => {
    expect(validatePlay(meshRight, { deuce })).toEqual({ ok: true, errors: [] })
  })

  it('refuses a route on a slot the formation does not field', () => {
    const orphan = { ...meshRight, assignments: { ...meshRight.assignments, TE2: { kind: 'block' } } }
    expect(validatePlay(orphan, { deuce }).errors.join(' ')).toMatch(/not in formation/)
  })

  it('refuses routes on a run and a carrier on a pass', () => {
    expect(validatePlay({ ...meshRight, playType: 'run' }, { deuce }).errors.join(' '))
      .toMatch(/route on a run play/)
    const twoCarriers = {
      ...meshRight, playType: 'run',
      assignments: { RB1: { kind: 'carry' }, WR1: { kind: 'carry' } },
    }
    expect(validatePlay(twoCarriers, { deuce }).errors.join(' ')).toMatch(/one carrier/)
    const carryOnPass = { ...meshRight, assignments: { RB1: { kind: 'carry' } } }
    expect(validatePlay(carryOnPass, { deuce }).errors.join(' ')).toMatch(/cannot have a carrier/)
  })

  it('⚠️ takes a RUN as just "run" — no angle is stored', () => {
    // The user's rule: authoring one lane per play would mean drawing the same run four times, and
    // would freeze a decision only answerable once the defense has lined up. chooseRunAngle reads
    // the box at the line, which is what a real back reads.
    const insideZone = { name: 'Inside Zone', formationId: 'deuce', playType: 'run', assignments: {} }
    expect(validatePlay(insideZone, { deuce })).toEqual({ ok: true, errors: [] })

    // Storing one is refused outright, so a sandbox bug cannot quietly freeze the lane.
    expect(validatePlay({ ...insideZone, runAngle: 0.4 }, { deuce }).errors.join(' '))
      .toMatch(/does not store an angle/)
  })

  it('asks which back carries only when it is genuinely ambiguous', () => {
    // One back: nothing to say. Two: "run" does not name a carrier, so the sandbox must ask rather
    // than guess.
    const twoBacks = {
      ...deuce,
      spots: [...deuce.spots.slice(0, 3), { slot: 'RB1', dx: -3, depth: 6 }, { slot: 'RB2', dx: 3, depth: 6 }],
    }
    const run = { name: 'Split Zone', formationId: 'f', playType: 'run', assignments: {} }
    expect(validatePlay(run, { f: twoBacks }).errors.join(' ')).toMatch(/2 backs.*mark which one carries/)
    const named = { ...run, assignments: { RB2: { kind: 'carry' } } }
    expect(validatePlay(named, { f: twoBacks }).ok).toBe(true)
  })

  it('refuses an unknown formation instead of guessing', () => {
    expect(validatePlay({ ...meshRight, formationId: 'nope' }, { deuce }).ok).toBe(false)
  })
})

describe('⚠️ THE PROPERTY THE WHOLE DESIGN RESTS ON', () => {
  it('EDITING A FORMATION MOVES THE PLAYS WITH IT — it does not erase them', () => {
    // The user's requirement, and the reason routes are offsets against a slot rather than field
    // coordinates against a player. Move WR1 eight yards and his route follows him unchanged.
    const moved = {
      ...deuce,
      spots: deuce.spots.map(s => (s.slot === 'WR1' ? { ...s, dx: -6, depth: 2 } : s)),
    }
    expect(validateFormation(moved).ok).toBe(true)
    // The play still validates against the edited formation...
    expect(validatePlay(meshRight, { deuce: moved }).ok).toBe(true)
    // ...and the route itself is untouched, because it never referred to where he was standing.
    expect(routeFor(meshRight, 'WR1')).toEqual([{ dx: 0, dd: 5 }, { dx: 12, dd: 6 }])

    // What DID change is where that route now starts, which is the only thing that should.
    const before = layoutAuthored(deuce, { losY: 40, ballX: 26.65 }).find(s => s.slot === 'WR1')
    const after = layoutAuthored(moved, { losY: 40, ballX: 26.65 }).find(s => s.slot === 'WR1')
    expect(after.x - before.x).toBeCloseTo(8)
  })

  it('mirrors a route with its formation so art and simulation agree', () => {
    expect(routeFor(meshRight, 'WR1', { mirror: true })).toEqual([{ dx: -0, dd: 5 }, { dx: -12, dd: 6 }])
  })

  it('returns no route for a blocker', () => {
    expect(routeFor(meshRight, 'RB1')).toBeNull()
  })
})

describe('authored defensive shells', () => {
  const cover1 = {
    name: 'Cover 1 Press',
    kind: 'man',
    jobs: [
      { job: 'deep', positions: ['S'], depth: 15, spot: 'middle' },
      { job: 'man', positions: ['CB', 'S', 'LB'] },
      { job: 'spy', positions: ['LB'] },
    ],
  }

  it('accepts a legal one', () => {
    expect(validateShell(cover1)).toEqual({ ok: true, errors: [] })
  })

  it('refuses vocabulary expandShell would not understand', () => {
    // ⚠️ The vocabulary is DERIVED from the shipped shells. A validator that drifts from the
    // expander accepts shells that then play as nonsense.
    expect(validateShell({ ...cover1, jobs: [{ job: 'blitzzz', positions: ['LB'] }] }).errors.join(' '))
      .toMatch(/unknown job/)
    expect(validateShell({ ...cover1, jobs: [{ job: 'under', positions: ['LB'], zone: 'banana' }] }).errors.join(' '))
      .toMatch(/unknown zone/)
    expect(validateShell({ ...cover1, jobs: [{ job: 'deep', positions: ['QB'], spot: 'third' }] }).errors.join(' '))
      .toMatch(/unknown position/)
  })

  it('refuses a shell where nobody covers anybody', () => {
    // Legal JSON, instant touchdown.
    const allRush = { ...cover1, jobs: [{ job: 'rush', positions: ['LB'] }, { job: 'spy', positions: ['LB'] }] }
    expect(validateShell(allRush).errors.join(' ')).toMatch(/nobody is covering anyone/)
  })

  it('requires an underneath zone to say which zone it is', () => {
    expect(validateShell({ ...cover1, jobs: [{ job: 'under', positions: ['LB'], depth: 8 }] }).errors.join(' '))
      .toMatch(/needs a zone type/)
  })
})

describe('leverage — the one thing the AI decides for itself', () => {
  it('gives a man shell three options and a zone shell one', () => {
    // ⚠️ The column set of the payoff matrix. Per-defender shading would be 4^5 = 1,024 variants
    // per shell, which no matrix can hold; this is three.
    const shells = {
      c1: { name: 'Cover 1', kind: 'man', jobs: [{ job: 'man', positions: ['CB'] }] },
      c3: { name: 'Cover 3', kind: 'zone', jobs: [{ job: 'deep', positions: ['S'] }] },
    }
    const opts = shellOptions(shells)
    expect(opts.filter(o => o.shellId === 'c1').map(o => o.leverage)).toEqual(['auto', 'in', 'out'])
    // A zone shell has no man defenders to shade, so three leverages would be three IDENTICAL
    // columns — wasted simulation and duplicate strategies in the matrix.
    expect(opts.filter(o => o.shellId === 'c3')).toEqual([{ shellId: 'c3', leverage: 'auto' }])
  })

  it('honours a shell that pins its own leverage', () => {
    const shells = { press: { name: 'Press Bail', kind: 'man', forcedLeverage: 'out', jobs: [{ job: 'man', positions: ['CB'] }] } }
    expect(shellOptions(shells)).toEqual([{ shellId: 'press', leverage: 'out' }])
  })

  it('⚠️ NEVER lets a chosen leverage override the deep-help safety rule', () => {
    // shadeFor refuses anything but UNDER with no help behind — "never get beaten deep". If a
    // leverage could override that, the AI could pick inside leverage with no safety and concede
    // touchdowns for it. Repair the illegal choice; never merely score it badly.
    const cb = { label: 'CB' }
    const wr = { label: 'WR', x: 45 }
    expect(shadeWithLeverage(cb, wr, { hasDeepHelp: false, ballX: 26.65 }, 'in')).toBe(SHADE.UNDER)
    expect(shadeWithLeverage(cb, wr, { hasDeepHelp: false, ballX: 26.65 }, 'out')).toBe(SHADE.UNDER)
    // A back releasing is a short threat whatever the call says.
    expect(shadeWithLeverage({ label: 'LB' }, { label: 'RB', x: 30 }, { hasDeepHelp: true, ballX: 26.65 }, 'in'))
      .toBe(SHADE.UNDER)
  })

  it('applies the leverage when it is safe to, and defers to the heuristic on auto', () => {
    const cb = { label: 'CB' }
    const wr = { label: 'WR', x: 45 }
    const ctx = { hasDeepHelp: true, ballX: 26.65 }
    expect(shadeWithLeverage(cb, wr, ctx, 'in')).toBe(SHADE.IN)
    expect(shadeWithLeverage(cb, wr, ctx, 'out')).toBe(SHADE.OUT)
    expect(shadeWithLeverage(cb, wr, ctx, 'auto')).toBe(shadeFor(cb, wr, ctx))
  })
})
