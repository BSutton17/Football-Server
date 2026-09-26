import { describe, it, expect } from '@jest/globals'
import {
  createTendencies, observePlay, summarize, adjustmentsFor, describeAdjustments,
  expectedRushers, shellFit, prefersUnderneath, NEUTRAL,
} from '../ai/playcall/tendencies.js'
import { decideShade } from '../ai/playbook/alignAuthored.js'
import { keepInToBlock } from '../ai/playbook/adjustOffense.js'

// [halftime] Watching how the opponent has actually played, and leaning against it after the half.

const OFF = 0, DEF = 1
const watch = (tend, n, play) => {
  for (let i = 0; i < n; i++) observePlay(tend, { offenseSlot: OFF, defenseSlot: DEF, ...play })
}
const adjFor = (tend, opponentSlot) => adjustmentsFor(tend, { opponentSlot })

describe('⚠️ IT ONLY EVER WATCHES WHAT ALREADY HAPPENED', () => {
  it('records a play after it resolves, never before', () => {
    // The standing rule is untouched: nobody sees a play call in advance. Noticing that the last
    // twenty snaps were runs is not cheating — it is the entire skill of watching film.
    const t = createTendencies()
    watch(t, 10, { playType: 'run', rushers: 4 })
    expect(summarize(t, OFF).plays).toBe(10)
  })

  it('keeps the two teams apart', () => {
    const t = createTendencies()
    watch(t, 12, { playType: 'run', rushers: 4 })
    expect(summarize(t, OFF).runRate).toBeGreaterThan(NEUTRAL.runRate)
    expect(summarize(t, DEF).runRate).toBe(NEUTRAL.runRate)   // never had the ball
  })
})

describe('⚠️ A SMALL SAMPLE IS NOT A TENDENCY', () => {
  it('barely moves on three plays', () => {
    // Three runs in a row is noise. Reacting to it is how a defense gets beaten by the fourth call.
    const t = createTendencies()
    watch(t, 3, { playType: 'run', rushers: 4 })
    expect(adjFor(t, OFF).boxBias).toBeLessThan(0.15)
  })

  it('moves a long way on thirty', () => {
    const t = createTendencies()
    watch(t, 30, { playType: 'run', rushers: 4 })
    expect(adjFor(t, OFF).boxBias).toBeGreaterThan(0.4)
  })

  it('⚠️ GROWS SMOOTHLY, rather than switching on at some play count', () => {
    // A hard cut-off would leave the defense blind, blind, blind, then suddenly certain. Each
    // additional run should move the needle a little further and never jump.
    const t = createTendencies()
    const seen = []
    for (let i = 0; i < 24; i++) {
      watch(t, 1, { playType: 'run', rushers: 4 })
      seen.push(adjFor(t, OFF).boxBias)
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i]).toBeGreaterThanOrEqual(seen[i - 1] - 1e-9)   // monotone
      expect(seen[i] - seen[i - 1]).toBeLessThan(0.1)              // and never a jump
    }
  })

  it('says nothing at all about an opponent it has not seen', () => {
    const adj = adjFor(createTendencies(), OFF)
    expect(adj.boxBias).toBeCloseTo(0)
    expect(adj.underneathBias).toBeCloseTo(0)
    expect(adj.protectBias).toBeCloseTo(0)
    expect(describeAdjustments(adj)).toEqual([])
  })

  it('says nothing about an ordinary opponent either', () => {
    // A team running 45% of the time is not run-heavy, it is normal.
    const t = createTendencies()
    watch(t, 20, { playType: 'run', rushers: 4 })
    watch(t, 24, { playType: 'pass', routeDepth: 11, rushers: 4 })
    expect(Math.abs(adjFor(t, OFF).boxBias)).toBeLessThan(0.12)
  })
})

describe('the three adjustments the user asked for', () => {
  it('⚠️ RUN HEAVY -> STACK THE BOX', () => {
    const t = createTendencies()
    watch(t, 26, { playType: 'run', rushers: 4 })
    const adj = adjFor(t, OFF)
    expect(adj.boxBias).toBeGreaterThan(0.2)
    expect(describeAdjustments(adj)).toContain('They are running it — stacking the box')

    // And the shell weighting follows: more coming, fewer parked deep.
    const heavy = { assignments: { a: { job: 'rush' }, b: { job: 'rush' }, c: { job: 'rush' }, d: { job: 'rush' }, e: { job: 'rush' } } }
    const soft = {
      assignments: {
        a: { job: 'rush' }, b: { job: 'rush' }, c: { job: 'rush' }, d: { job: 'rush' },
        e: { job: 'zone', zone: 'deep' }, f: { job: 'zone', zone: 'deep' },
        g: { job: 'zone', zone: 'deep' }, h: { job: 'zone', zone: 'deep' },
      },
    }
    expect(shellFit(heavy, adj)).toBeGreaterThan(shellFit(soft, adj))
  })

  it('⚠️ SHORT ROUTES -> SHADE UNDERNEATH', () => {
    const t = createTendencies()
    watch(t, 30, { playType: 'pass', routeDepth: 5, rushers: 4 })
    const adj = adjFor(t, OFF)
    expect(adj.underneathBias).toBeGreaterThan(0.2)
    expect(prefersUnderneath(adj)).toBe(true)
    expect(describeAdjustments(adj)).toContain('They live underneath — squeezing the short game')

    // And the shade actually changes: a wide receiver normally gets inside leverage.
    const wide = { id: 'w', x: 44, y: 40, label: 'WR' }
    const ctx = { hasDeepHelp: true, ballX: 26.665 }
    // Baseline leverage on a wide receiver is OUTSIDE now — the deep help is inside him. What
    // this test is actually about is that the half-time read overrides whatever that baseline is.
    expect(decideShade({}, wide, ctx)).toBe('out')
    expect(decideShade({}, wide, { ...ctx, preferUnderneath: true })).toBe('under')
  })

  it('⚠️ THEY BLITZ -> KEEP THE BACK IN', () => {
    const t = createTendencies()
    watch(t, 28, { playType: 'pass', routeDepth: 10, rushers: 6 })
    const adj = adjFor(t, DEF)
    expect(adj.protectBias).toBeGreaterThan(0.2)
    expect(describeAdjustments(adj)).toContain('They blitz — keeping help in to block')

    // And the protection follows, without anybody telling it about blitzing directly.
    const formation = { spots: [{ slot: 'WR1' }, { slot: 'TE1' }, { slot: 'RB1' }] }
    const play = {
      playType: 'pass',
      assignments: {
        WR1: { kind: 'route', points: [{ dx: 0, dd: 9 }] },
        TE1: { kind: 'route', points: [{ dx: 0, dd: 6 }] },
        RB1: { kind: 'route', points: [{ dx: 0, dd: 3 }] },
      },
    }
    expect(expectedRushers(adj)).toBeGreaterThan(5)
    expect(keepInToBlock(play, formation, { rushers: expectedRushers(adj) })).toBe('RB1')
    // Against a defense that has only ever rushed four, nobody stays in.
    const calm = createTendencies()
    for (let i = 0; i < 28; i++) observePlay(calm, { offenseSlot: OFF, defenseSlot: DEF, playType: 'pass', routeDepth: 10, rushers: 4 })
    expect(keepInToBlock(play, formation, { rushers: expectedRushers(adjFor(calm, DEF)) })).toBeNull()
  })

  it('leans the OTHER way for the opposite tendency', () => {
    const t = createTendencies()
    watch(t, 30, { playType: 'pass', routeDepth: 22, rushers: 4 })
    const adj = adjFor(t, OFF)
    expect(adj.boxBias).toBeLessThan(0)
    expect(adj.underneathBias).toBeLessThan(0)
    expect(describeAdjustments(adj)).toContain('They are throwing it — dropping more into coverage')
  })
})

describe('⚠️ IT IS A LEAN, NEVER A RULE', () => {
  it('never zeroes a shell, however lopsided the evidence', () => {
    // An adjustment that could rule something out would be beaten by doing the opposite once.
    const t = createTendencies()
    watch(t, 200, { playType: 'run', rushers: 4 })
    const adj = adjFor(t, OFF)
    const deepShell = {
      assignments: {
        a: { job: 'zone', zone: 'deep' }, b: { job: 'zone', zone: 'deep' },
        c: { job: 'zone', zone: 'deep' }, d: { job: 'zone', zone: 'deep' },
      },
    }
    expect(shellFit(deepShell, adj)).toBeGreaterThan(0)
  })

  it('caps how far any tendency can move anything', () => {
    const t = createTendencies()
    watch(t, 500, { playType: 'run', rushers: 6 })
    const adj = adjFor(t, OFF)
    for (const v of [adj.boxBias, adj.underneathBias, adj.protectBias]) {
      expect(Math.abs(v)).toBeLessThanOrEqual(0.6 + 1e-9)
    }
  })

  it('⚠️ NEVER OUTRANKS NOT GETTING BEATEN DEEP', () => {
    // With nobody over the top it is UNDER regardless — but that is the safety rule doing it, and
    // it holds whatever the halftime read says.
    const wide = { id: 'w', x: 44, y: 40, label: 'WR' }
    expect(decideShade({}, wide, { hasDeepHelp: false, ballX: 26.665, preferUnderneath: false }))
      .toBe('under')
  })
})

describe('the short-game read is measured over PASSES', () => {
  it('does not call a running team a short-passing team', () => {
    // A team that runs constantly has not thereby become a short-passing team; with only a handful
    // of throws there is barely any evidence about how they throw.
    const t = createTendencies()
    watch(t, 28, { playType: 'run', rushers: 4 })
    watch(t, 2, { playType: 'pass', routeDepth: 4, rushers: 4 })
    expect(Math.abs(adjFor(t, OFF).underneathBias)).toBeLessThan(0.2)
    // While the run read, which has plenty of evidence, is strong.
    expect(adjFor(t, OFF).boxBias).toBeGreaterThan(0.3)
  })
})
