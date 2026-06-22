import { describe, it, expect } from '@jest/globals'
import { runPassRush, rushAdvantage, isRusher, SHED_THRESHOLD } from '../game/systems/passRush.js'
import { getRatings } from '../data/ratings.js'

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], coverage = new Map(), playType = 'pass' } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    defenseCoverage: coverage,
    playDesign: { playType },
  }
}

// An engaged rusher with a given matchup. leverageScore from the defender's POV. engageElapsed
// defaults past ENGAGE_LOCK_TIME so these matchup tests exercise the win-meter, not the initial
// lock-up (which is covered by its own test below).
function engagedRusher(id, label, { engagedWithId = 'ol', leverageScore = 0, meter = 0, engageElapsed = 1.0 } = {}) {
  return { id, label, isEngaged: true, engagedWithId, leverageScore, rushWinMeter: meter, shedBlock: false, engageElapsed }
}

function blocker(id = 'ol', label = 'OL') {
  return { id, label }
}

// ── rushAdvantage ─────────────────────────────────────────────────────────────

describe('rushAdvantage', () => {
  it('is positive for an even matchup with neutral leverage (baseline fill)', () => {
    expect(rushAdvantage(80, 80, 0)).toBeGreaterThan(0)
  })

  it('increases as the rusher out-rates the blocker', () => {
    const even   = rushAdvantage(80, 80, 0)
    const strong = rushAdvantage(99, 60, 0)
    expect(strong).toBeGreaterThan(even)
  })

  it('drops toward/under zero for a weak rusher vs a strong blocker', () => {
    expect(rushAdvantage(30, 99, 0)).toBeLessThan(rushAdvantage(80, 80, 0))
  })

  it('is reduced by positive (offense) leverage — good protection slows the shed', () => {
    const neutral = rushAdvantage(82, 80, 0)
    const blocked = rushAdvantage(82, 80, 0.8)   // blocker holding inside leverage
    expect(blocked).toBeLessThan(neutral)
  })

  it('is increased when the rusher wins leverage (negative score)', () => {
    const neutral = rushAdvantage(82, 80, 0)
    const winning = rushAdvantage(82, 80, -0.8)  // rusher beat the angle
    expect(winning).toBeGreaterThan(neutral)
  })
})

// ── isRusher ──────────────────────────────────────────────────────────────────

describe('isRusher', () => {
  it('true for a defender with no coverage assignment (DL auto-rush)', () => {
    const state = makeState({ defense: [{ id: 'dl' }] })
    expect(isRusher(state, { id: 'dl' })).toBe(true)
  })

  it('true for a blitzing defender', () => {
    const coverage = new Map([['lb', { type: 'blitz' }]])
    const state = makeState({ coverage })
    expect(isRusher(state, { id: 'lb' })).toBe(true)
  })

  it('false for man / zone / spy defenders', () => {
    const coverage = new Map([
      ['cb', { type: 'man' }],
      ['s',  { type: 'zone' }],
      ['lb', { type: 'spy' }],
    ])
    const state = makeState({ coverage })
    expect(isRusher(state, { id: 'cb' })).toBe(false)
    expect(isRusher(state, { id: 's'  })).toBe(false)
    expect(isRusher(state, { id: 'lb' })).toBe(false)
  })
})

// ── Meter accumulation & shed ─────────────────────────────────────────────────

describe('runPassRush — meter accumulation', () => {
  it('fills the win meter while a rusher is engaged and winning', () => {
    const dl = engagedRusher('dl', 'DL')
    const state = makeState({ offense: [blocker()], defense: [dl] })

    runPassRush(state, null, DT)

    expect(dl.rushWinMeter).toBeGreaterThan(0)
    expect(dl.shedBlock).toBe(false)
  })

  it('sheds the block once the meter reaches the threshold', () => {
    const dl = engagedRusher('dl', 'DL', { meter: SHED_THRESHOLD - 0.001 })
    const state = makeState({ offense: [blocker()], defense: [dl] })

    runPassRush(state, null, DT)

    expect(dl.shedBlock).toBe(true)
    expect(dl.rushWinMeter).toBe(SHED_THRESHOLD)
  })

  it('an elite rusher vs a weak blocker sheds faster than an even matchup', () => {
    // Custom labels via direct ratings — use DL (passRush 82) vs OL (strength 80) baseline
    // and an elite synthetic rusher by feeding a high-passRush label substitute.
    const eliteDL = engagedRusher('dl1', 'DL', { engagedWithId: 'weakOL' })
    const evenDL  = engagedRusher('dl2', 'DL', { engagedWithId: 'strongOL' })

    // weakOL: low strength; strongOL: high strength (use real labels)
    const weakBlocker   = { id: 'weakOL', label: 'WR' }   // strength 44
    const strongBlocker = { id: 'strongOL', label: 'T' }  // strength 82

    const stateElite = makeState({ offense: [weakBlocker],   defense: [eliteDL] })
    const stateEven  = makeState({ offense: [strongBlocker], defense: [evenDL] })

    // Run several ticks
    for (let i = 0; i < 10; i++) {
      runPassRush(stateElite, null, DT)
      runPassRush(stateEven,  null, DT)
    }

    expect(eliteDL.rushWinMeter).toBeGreaterThan(evenDL.rushWinMeter)
  })

  it('does not let a freshly-engaged rusher win during the initial lock-up ([pass-rush ramp])', () => {
    // Engaged this instant (engageElapsed 0) and sitting just under the shed threshold: during the
    // lock the meter is frozen, so the rusher cannot fire off the ball and immediately win.
    const dl = engagedRusher('dl', 'DL', { meter: SHED_THRESHOLD - 0.001, engageElapsed: 0 })
    const state = makeState({ offense: [blocker()], defense: [dl] })

    runPassRush(state, null, DT)   // 0.05 s engaged — well inside the lock

    expect(dl.shedBlock).toBe(false)
    expect(dl.rushWinMeter).toBeCloseTo(SHED_THRESHOLD - 0.001, 5)   // frozen, not filling
  })

  it('decays the meter when the rusher is not engaged', () => {
    const dl = { id: 'dl', label: 'DL', isEngaged: false, rushWinMeter: 0.5, shedBlock: false }
    const state = makeState({ defense: [dl] })

    runPassRush(state, null, DT)

    expect(dl.rushWinMeter).toBeLessThan(0.5)
    expect(dl.rushWinMeter).toBeGreaterThanOrEqual(0)
  })

  it('meter never goes negative', () => {
    const dl = { id: 'dl', label: 'DL', isEngaged: false, rushWinMeter: 0.01, shedBlock: false }
    const state = makeState({ defense: [dl] })

    runPassRush(state, null, DT)
    runPassRush(state, null, DT)

    expect(dl.rushWinMeter).toBe(0)
  })

  it('a shed rusher stays shed on subsequent ticks', () => {
    const dl = engagedRusher('dl', 'DL', { meter: SHED_THRESHOLD })
    const state = makeState({ offense: [blocker()], defense: [dl] })

    runPassRush(state, null, DT)
    expect(dl.shedBlock).toBe(true)

    // Even if it somehow disengages, it stays shed
    dl.isEngaged = false
    runPassRush(state, null, DT)
    expect(dl.shedBlock).toBe(true)
  })
})

// ── Coverage defenders never shed-rush ────────────────────────────────────────

describe('runPassRush — coverage defenders excluded', () => {
  it('a man-coverage defender never accumulates meter or sheds', () => {
    const cb = { id: 'cb', label: 'CB', isEngaged: true, engagedWithId: 'ol', leverageScore: -0.5, rushWinMeter: 0.9, shedBlock: false }
    const coverage = new Map([['cb', { type: 'man' }]])
    const state = makeState({ offense: [blocker()], defense: [cb], coverage })

    runPassRush(state, null, DT)

    expect(cb.rushWinMeter).toBe(0)
    expect(cb.shedBlock).toBe(false)
  })
})

// ── Run plays disable shedding ────────────────────────────────────────────────

describe('runPassRush — run plays', () => {
  it('does nothing on a run play (no pocket to collapse)', () => {
    const dl = engagedRusher('dl', 'DL', { meter: 0.5 })
    const state = makeState({ offense: [blocker()], defense: [dl], playType: 'run' })

    runPassRush(state, null, DT)

    // Untouched — meter stays where it was, no shed
    expect(dl.rushWinMeter).toBe(0.5)
    expect(dl.shedBlock).toBe(false)
  })
})
