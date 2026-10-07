import { describe, it, expect } from '@jest/globals'
import { chooseSpotlight, maybeSpotlight, noteHadBall, bothTeamsHaveHadBall } from '../game/statSpotlight.js'
import { createStats, recordRush, recordSack } from '../game/stats.js'
import { makeRng } from '../game/utils/rng.js'

// [spotlight] The requested rules, each checked as stated:
//   run  > 5 yds: 50% -> 75% runner / 25% tackler
//   pass > 8 yds: 60% -> 45% receiver / 45% passer / 10% tackler
//   sack: always, the sacker
//   and nothing until both teams have had the ball.

const rb = { id: 'rb1', slot: 0, label: 'RB' }
const wr = { id: 'wr1', slot: 0, label: 'WR' }
const qb = { id: 'qb1', slot: 0, label: 'QB' }
const lb = { id: 'lb1', slot: 1, label: 'LB' }

function shares(play, n = 40000) {
  const rng = makeRng(1234)
  const out = { none: 0 }
  for (let i = 0; i < n; i++) {
    const pick = chooseSpotlight(play, rng)
    const k = pick ? pick.role : 'none'
    out[k] = (out[k] ?? 0) + 1
  }
  for (const k of Object.keys(out)) out[k] /= n
  return out
}

describe('the thresholds are "more than"', () => {
  it('a 5-yard run and an 8-yard pass never show anything', () => {
    const rng = () => 0          // every roll would land
    expect(chooseSpotlight({ kind: 'run', yards: 5, carrier: rb, tackler: lb }, rng)).toBeNull()
    expect(chooseSpotlight({ kind: 'pass', yards: 8, carrier: wr, passer: qb, tackler: lb }, rng)).toBeNull()
    expect(chooseSpotlight({ kind: 'run', yards: 6, carrier: rb, tackler: lb }, rng)).not.toBeNull()
    expect(chooseSpotlight({ kind: 'pass', yards: 9, carrier: wr, passer: qb, tackler: lb }, rng)).not.toBeNull()
  })
})

describe('the odds', () => {
  it('run: 50% shown, of which 75% the runner and 25% the tackler', () => {
    const s = shares({ kind: 'run', yards: 12, carrier: rb, tackler: lb })
    expect(s.none).toBeCloseTo(0.5, 1)
    expect(s.rusher).toBeCloseTo(0.375, 1)
    expect(s.tackler).toBeCloseTo(0.125, 1)
  })

  it('pass: 60% shown, of which 45% receiver, 45% passer, 10% tackler', () => {
    const s = shares({ kind: 'pass', yards: 15, carrier: wr, passer: qb, tackler: lb })
    expect(s.none).toBeCloseTo(0.4, 1)
    expect(s.receiver).toBeCloseTo(0.27, 1)
    expect(s.passer).toBeCloseTo(0.27, 1)
    expect(s.tackler).toBeCloseTo(0.06, 1)
  })

  it('sack: always, and it is the sacker', () => {
    const s = shares({ kind: 'sack', sacker: lb }, 500)
    expect(s.sacker).toBe(1)
  })

  it('with nobody to call the tackler (out of bounds, a touchdown) it shows the ball carrier', () => {
    const rng = (() => { const seq = [0, 0.99]; let i = 0; return () => seq[i++ % 2] })()
    expect(chooseSpotlight({ kind: 'run', yards: 9, carrier: rb, tackler: null }, rng).role).toBe('rusher')
  })
})

describe('nothing until both teams have had the ball', () => {
  function game() {
    const state = { roomId: 'SPOT', seed: 7, possession: 0, yardLine: 40, stats: createStats() }
    recordSack(state.stats, { defender: lb, passer: qb, yards: -6 })
    recordRush(state.stats, { runner: rb, yards: 12 })
    return state
  }
  const io = () => { const sent = []; return { sent, to: () => ({ emit: (e, p) => sent.push({ e, p }) }) } }

  it('holds the sack graphic on the first drive, shows it once the other team has snapped', () => {
    const state = game(), out = io()
    noteHadBall(state)                                   // team 0 snapped
    expect(bothTeamsHaveHadBall(state)).toBe(false)
    expect(maybeSpotlight(state, out, { kind: 'sack', sacker: lb })).toBeNull()
    expect(out.sent).toEqual([])

    state.possession = 1; noteHadBall(state)              // team 1 has had it now
    const shown = maybeSpotlight(state, out, { kind: 'sack', sacker: lb })
    expect(shown).toMatchObject({ id: 'lb1', slot: 1, role: 'sacker', yardLine: 40 })
    expect(shown.line.sacks).toBe(1)
    expect(out.sent[0].e).toBe('stat_spotlight')
  })

  it('never throws into the play, whatever it is handed', () => {
    const state = game(); state.hadBall = [true, true]
    expect(() => maybeSpotlight(state, null, { kind: 'run', yards: 40 })).not.toThrow()
    expect(() => maybeSpotlight(state, io(), { kind: 'run', yards: 40, carrier: { id: 'ghost', slot: 0 } })).not.toThrow()
  })
})
