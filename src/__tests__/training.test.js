import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame, runPlay, inspectFormation, applySituation } from '../training/game.js'
import { buildSlate, smallSlate, hashSlate, HASH_SPOTS } from '../training/slate.js'
import { observe, OBSERVATION_SIZE, OBSERVATION_FIELDS, observationSpecHash } from '../training/observation.js'
import { decode, decodePersonnel, legalShells, ACTION_SIZE, actionSpecHash } from '../training/action.js'
import { scorePlay, scoreSlate, finalFitness } from '../training/fitness.js'
import { createGenome, connectFully, createInnovationRegistry, createRng } from '../neat/neat.js'
import { createKnowledge, applyEvent } from '../ai/knowledge.js'
import { syntheticRoster } from '../ai/roster.js'
import { SHELL_IDS } from '../ai/playbook/coverages.js'
import { COVERAGE_ON_FIELD } from '../ai/defense.js'

// [training] The harness and the schemas. The point of most of these is that a training run can
// fail SILENTLY — a broken observation, a mis-decoded action or a mis-read outcome produces a
// number that looks fine and means nothing. Each of these pins one of those.

// ⚠️ The blocks that tested the per-play trainer (`train.js`), the narrow-action-space brain and
// the checkpoint-identity guard were removed with those modules. Training is now series-scored
// co-evolution — see coevolve.test.js. What remains here still applies: the AI-vs-AI harness, the
// slate, the observation and action layouts, and the fitness guards.
describe('AI vs AI', () => {
  it('runs a play with nobody watching', () => {
    const ctx = createTrainingGame({ seed: 11 })
    try {
      const play = runPlay(ctx, { down: 1, distance: 10, yardLine: 25, ballX: 26.665, possession: 0 })
      expect(play.ticks).toBeGreaterThan(0)
      expect(play.outcome).not.toBe('no_snap')
      expect(Number.isFinite(play.yards)).toBe(true)
    } finally { destroyTrainingGame(ctx) }
  }, 20000)

  it('produces a legal formation on every hash', () => {
    for (const ballX of HASH_SPOTS) {
      const ctx = createTrainingGame({ seed: 21 })
      try {
        const play = runPlay(ctx, { down: 2, distance: 7, yardLine: 40, ballX, possession: 0 })
        expect({ ballX: ballX.toFixed(1), problems: play.problems }).toEqual({ ballX: ballX.toFixed(1), problems: [] })
      } finally { destroyTrainingGame(ctx) }
    }
  }, 30000)

  it('is clean backed up against its own goal line, and on the goal line', () => {
    // Both ends found real bugs: placement inside the offense's own end zone was refused outright,
    // and a deep zone landmark past the back of the end zone was refused too — which silently
    // turned a safety into a pass rusher.
    for (const yardLine of [3, 6, 95, 98]) {
      const ctx = createTrainingGame({ seed: 31 })
      try {
        const play = runPlay(ctx, { down: 1, distance: Math.min(10, 100 - yardLine), yardLine, ballX: 13.3, possession: 0 })
        expect({ yardLine, problems: play.problems }).toEqual({ yardLine, problems: [] })
      } finally { destroyTrainingGame(ctx) }
    }
  }, 30000)

  it('reads the outcome from play_result, not from events that do not exist', () => {
    // The engine has no `pass_complete`, `sack` or `interception` event — everything arrives on
    // `play_result`. Guessing at names made almost every play classify as "tackle".
    const seen = new Set()
    for (let i = 0; i < 24; i++) {
      const ctx = createTrainingGame({ seed: 100 + i })
      try {
        const p = runPlay(ctx, { down: 3, distance: 8, yardLine: 45, ballX: 26.665, possession: 0 })
        seen.add(p.outcome)
        expect(p.outcome).not.toBe('unknown')
      } finally { destroyTrainingGame(ctx) }
    }
    expect(seen.size).toBeGreaterThan(1)
  }, 40000)

  it('the integrity check actually catches a broken formation', () => {
    // A check that never fires is worthless, so prove it fires.
    const ctx = createTrainingGame({ seed: 41 })
    try {
      const state = applySituation(ctx.state, { down: 1, distance: 10, yardLine: 30, ballX: 26.665, possession: 0 })
      state.offensePlayers.set('ghost', { id: 'ghost', label: 'WR', x: 5, y: 60, vx: 0, vy: 0 })
      const problems = inspectFormation(state)
      expect(problems.length).toBeGreaterThan(0)
    } finally { destroyTrainingGame(ctx) }
  })
})

describe('the slate', () => {
  it('covers all three hashes', () => {
    const slate = buildSlate({ size: 30 })
    const hashes = new Set(slate.situations.map(s => s.ballX.toFixed(2)))
    expect(hashes.size).toBe(3)
  })

  it('is identical for the same generation and different across generations', () => {
    const a = buildSlate({ size: 12, generation: 3, seed: 99 })
    const b = buildSlate({ size: 12, generation: 3, seed: 99 })
    const c = buildSlate({ size: 12, generation: 4, seed: 99 })
    expect(b.hash).toBe(a.hash)
    expect(c.hash).not.toBe(a.hash)
  })

  it('never asks for more distance than there is field', () => {
    for (const s of buildSlate({ size: 200 }).situations) {
      expect({ id: s.id, ok: s.distance <= 100 - s.yardLine }).toEqual({ id: s.id, ok: true })
    }
  })

  it('hashes on content, so a changed situation changes the fingerprint', () => {
    const slate = smallSlate()
    const tampered = slate.situations.map((s, i) => (i === 0 ? { ...s, down: 4 } : s))
    expect(hashSlate(tampered)).not.toBe(slate.hash)
  })
})

describe('the observation', () => {
  function knowledge(over = {}) {
    const k = createKnowledge(1)
    Object.assign(k, { role: 'defense', down: 2, distance: 7, yardLine: 40, ballX: 26.665, quarter: 1, clock: 600, score: { own: 0, opp: 0 } }, over)
    for (const [id, label, x] of over.offense ?? [['wr1', 'WR', 8], ['wr2', 'WR', 45], ['te1', 'TE', 33], ['rb1', 'RB', 26]]) {
      applyEvent(k, 'player_placed', { id, x, y: k.yardLine, label, team: 'o' })
    }
    return k
  }
  const roster = syntheticRoster('t')

  it('is the declared length, always', () => {
    for (const over of [{}, { down: 4, distance: 1, yardLine: 97 }, { yardLine: 2 }, { quarter: 4, clock: 30 }]) {
      expect(observe(knowledge(over), { roster })).toHaveLength(OBSERVATION_SIZE)
    }
  })

  it('every value is finite and bounded', () => {
    for (const yardLine of [1, 25, 50, 75, 99]) {
      for (const v of observe(knowledge({ yardLine }), { roster })) {
        expect({ yardLine, ok: Number.isFinite(v) && v >= -1 && v <= 1 }).toEqual({ yardLine, ok: true })
      }
    }
  })

  it('the field table and the builder cannot drift apart', () => {
    expect(OBSERVATION_FIELDS).toHaveLength(OBSERVATION_SIZE)
  })

  it('distinguishes the situations it is supposed to', () => {
    const a = observe(knowledge({ down: 1, distance: 10 }), { roster })
    const b = observe(knowledge({ down: 3, distance: 1 }), { roster })
    expect(a).not.toEqual(b)

    const left = observe(knowledge({ ballX: 13.3 }), { roster })
    const right = observe(knowledge({ ballX: 40 }), { roster })
    expect(left).not.toEqual(right)   // the hash is visible to the network
  })

  it('carries nothing the defense is not entitled to', () => {
    // Knowledge has no field for a route or a play call, so an observation cannot contain one.
    const k = knowledge()
    expect(Object.keys(k)).not.toContain('playDesign')
    expect(Object.keys(k)).not.toContain('route')
  })

  it('pins its layout, so a saved genome cannot be silently misread', () => {
    expect(observationSpecHash()).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('the action', () => {
  const outputs = (fn) => Array.from({ length: ACTION_SIZE }, (_, i) => fn(i))

  it('always decodes to a real shell', () => {
    for (let t = 0; t < 40; t++) {
      const rng = createRng(t + 1)
      const d = decode(outputs(() => rng()))
      expect({ t, known: SHELL_IDS.includes(d.shellId) }).toEqual({ t, known: true })
    }
  })

  it('personnel always sums to exactly seven', () => {
    for (let t = 0; t < 60; t++) {
      const rng = createRng(t + 100)
      const p = decodePersonnel(outputs(() => rng()))
      expect({ t, sum: p.CB + p.S + p.LB }).toEqual({ t, sum: COVERAGE_ON_FIELD })
    }
  })

  it('respects the floors the design set', () => {
    for (let t = 0; t < 40; t++) {
      const rng = createRng(t + 300)
      const p = decodePersonnel(outputs(() => rng()))
      expect({ t, cb: p.CB >= 2, lb: p.LB >= 1, s: p.S >= 1 }).toEqual({ t, cb: true, lb: true, s: true })
    }
  })

  it('never asks for more players than the roster holds', () => {
    const available = { CB: 2, S: 1, LB: 2 }
    for (let t = 0; t < 30; t++) {
      const rng = createRng(t + 500)
      const p = decodePersonnel(outputs(() => rng()), available)
      expect({ t, cb: p.CB <= 2, s: p.S <= 1, lb: p.LB <= 2 }).toEqual({ t, cb: true, s: true, lb: true })
    }
  })

  it('masks off shells a short roster cannot field — and never masks off everything', () => {
    const full = legalShells({ CB: 4, S: 3, LB: 4 })
    const thin = legalShells({ CB: 2, S: 1, LB: 1 })
    expect(full.length).toBe(SHELL_IDS.length)
    expect(thin.length).toBeGreaterThan(0)
    expect(thin.length).toBeLessThan(full.length)
  })

  it('refuses an output vector of the wrong length rather than misreading it', () => {
    expect(() => decode([0.5, 0.5])).toThrow(/expected/)
  })
})

describe('fitness', () => {
  const play = (over = {}) => ({ ok: true, problems: [], yards: 5, turnover: false, outcome: 'tackle', sacked: false, ...over })

  it('scores against par, not against raw yardage', () => {
    const tight = scorePlay(play({ yards: 2 }), 6)     // allowed 2 where par was 6
    const loose = scorePlay(play({ yards: 9 }), 6)
    expect(tight.score).toBeGreaterThan(loose.score)
  })

  it('a play that could not run scores ZERO, not par', () => {
    // Otherwise "break the harness" is a viable strategy: a genome that reliably crashes the game
    // would collect an average score for doing nothing.
    const broken = scorePlay({ ok: false, problems: ['offense never set'] }, 6)
    expect(broken.score).toBe(0)
    expect(broken.invalid).toBe(true)
  })

  it('rewards turnovers but caps how much of a score they can be', () => {
    const withTo = scorePlay(play({ yards: 5, turnover: true }), 5)
    const without = scorePlay(play({ yards: 5 }), 5)
    expect(withTo.score).toBeGreaterThan(without.score)
    // …and the turnover term cannot dwarf everything else.
    expect(withTo.terms.turnover).toBeLessThanOrEqual(12)
  })

  it('punishes a touchdown by more than its yardage alone', () => {
    const td = scorePlay(play({ yards: 12, outcome: 'touchdown' }), 5)
    const same = scorePlay(play({ yards: 12 }), 5)
    expect(td.score).toBeLessThan(same.score)
  })

  it('zeroes a genome that cannot produce a legal call', () => {
    const plays = Array.from({ length: 9 }, (_, i) => (i < 5
      ? { ok: false, problems: ['no snap'], situationId: 's' + i }
      : { ...play(), situationId: 's' + i }))
    const r = scoreSlate(plays, {})
    expect(r.penalized).toBe(true)
    expect(finalFitness(r)).toBe(0)
  })

  it('is never negative — fitness sharing divides by species size', () => {
    const awful = scoreSlate(Array.from({ length: 6 }, (_, i) => ({ ...play({ yards: 60, outcome: 'touchdown' }), situationId: 's' + i })), {})
    expect(finalFitness(awful)).toBeGreaterThanOrEqual(0)
  })
})





// ── Par has to actually bind ([training]) ────────────────────────────────────
//
// THE BUG THIS PINS, which ran undetected for a full 250-generation run:
// situation ids are `g{generation}-s{i}` and the slate ROTATES by generation, but par was always
// measured on generation 0. Every lookup missed, `expected[id] ?? 0` supplied a par of zero, and
// every score in the run was raw yards allowed instead of yards-better-than-par. Nothing threw and
// nothing logged, which is exactly why it survived — so a total mismatch is now a hard error.
describe('par and the slate must describe the same situations', () => {
  const play = (id, yards) => ({
    ok: true, yards, outcome: 'tackle', turnover: false, sacked: false, problems: [], situationId: id,
  })

  it('throws when par and the plays share no situation at all', () => {
    const plays = [play('g7-s0', 5), play('g7-s1', 3)]
    const par = { 'g0-s0': 4, 'g0-s1': 6 }        // measured on the wrong generation
    expect(() => scoreSlate(plays, par)).toThrow(/par does not match this slate/)
  })

  it('names both id shapes, so the mismatch is obvious from the message alone', () => {
    expect(() => scoreSlate([play('g7-s0', 5)], { 'g0-s0': 4 }))
      .toThrow(/"g7-s0".*"g0-s0"/)
  })

  it('allows a PARTIAL match — a caller may legitimately score a subset', () => {
    const plays = [play('g3-s0', 5), play('unknown', 3)]
    expect(() => scoreSlate(plays, { 'g3-s0': 4 })).not.toThrow()
  })

  it('still allows an empty par, which means "no expectation"', () => {
    expect(() => scoreSlate([play('g3-s0', 5)], {})).not.toThrow()
  })

  it('par changes the score, so a zeroed par is not a harmless default', () => {
    // The heart of it: against real par, a play that allows exactly par is NEUTRAL. Against a
    // zeroed par the same play scores -5, which is what made failing to run a play (score 0) the
    // better outcome and inverted the harness-breaking guard.
    const plays = [play('g3-s0', 5)]
    const atPar = scoreSlate(plays, { 'g3-s0': 5 })
    const zeroed = scoreSlate(plays, {})
    expect(atPar.raw).toBeCloseTo(0, 6)
    expect(zeroed.raw).toBeCloseTo(-5, 6)
    expect(atPar.fitness).toBeGreaterThan(zeroed.fitness)
  })

  it('a play that could not run is no better than an average one once par is real', () => {
    const broken = { ok: false, problems: ['snap refused'], situationId: 'g3-s0' }
    const average = play('g3-s1', 6)
    const r = scoreSlate([broken, average], { 'g3-s0': 6, 'g3-s1': 6 })
    // Both contribute 0: breaking the harness buys nothing.
    expect(r.parts[0].score).toBe(0)
    expect(r.parts[1].score).toBeCloseTo(0, 6)
  })
})


// ── A killed run must not lose its champion ([training]) ────────────────────
//
// THE BUG: checkpoints saved `pop.snapshot()`, whose `champion` is the all-time best by TRAINING
// fitness. Training slates ROTATE every generation, so that champion is chosen across different
// exams — which train.js already calls unsound, because it crowns whoever drew the easiest slate.
// The real champion is picked on the FIXED holdout and lives only in train()'s own `best`.
//
// A run killed at generation 116 therefore left behind a genome scoring 15.00 on the holdout after
// reporting a best of 16.17. Hours of compute, and the one artefact worth keeping was the wrong one.
