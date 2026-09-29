import { describe, it, expect } from '@jest/globals'
import { chooseTempo, setTimeFor, tempoRunLean, snapsLeft, TEMPO } from '../ai/tempo.js'
import { leanRun } from '../ai/playcall/select.js'
import { AI_SET_LATEST, AI_SET_EARLIEST } from '../ai/timing.js'

// [tempo] ⚠️ "WHEN THE OFFENSE SNAPS THE BALL WILL NO LONGER BE RANDOM AND INSTEAD BE BASED OFF OF
// THESE PLAY CLOCK RULES."
//
// It used to pick a moment at random between 20 and 5 seconds left. That is a fine way to be
// unpredictable and a terrible way to be arbitrary: a team protecting a one-score lead with two
// minutes left snapped as quickly as a team down seventeen, and the clock was never managed.
//
// Everything below reduces to one question asked from the offense's side: does the clock running
// help us or hurt us?

// ⚠️ FIVE MINUTES IS A FULL QUARTER HERE, NOT A LATE-GAME READING. A quarter in this game is three
// to six minutes against the NFL's fifteen, so every threshold is a FRACTION of the quarter and
// every fixture has to say how long the quarter is. Written in NFL equivalents beside each one: at
// a 5:00 quarter the scale is 1:3, so 1:40 here is the NFL's 5:00.
const QUARTER = 300
// ⚠️ `{ offense, defense }` IS THE SHAPE THE ENGINE SENDS, and neither word means what it says:
// "offense" is THIS SEAT'S score whether it has the ball or not. Fixtures written with { own, opp }
// passed while the feature read zeros in the real game — see scoreMargin in knowledge.js.
const k = (over = {}) => ({ quarter: 4, clock: 90, quarterSeconds: QUARTER, score: { offense: 21, defense: 14 }, ...over })

describe('⚠️ DOES THE CLOCK RUNNING HELP US?', () => {
  it('leading late in the fourth: burn it', () => {
    expect(chooseTempo(k())).toBe(TEMPO.BURN)
    expect(chooseTempo(k({ score: { offense: 35, defense: 7 } }))).toBe(TEMPO.BURN)
  })

  it('trailing late in the fourth: go', () => {
    expect(chooseTempo(k({ score: { offense: 14, defense: 21 } }))).toBe(TEMPO.HURRY)   // 1:30 = NFL 4:30
  })

  it('⚠️ AND THE THRESHOLDS SCALE WITH THE QUARTER, not with the clock reading', () => {
    // The same part of the game, on a 3-minute quarter and a 6-minute one. An absolute rule would
    // call one of these late and the other early.
    const lead = { offense: 21, defense: 14 }
    expect(chooseTempo({ quarter: 4, quarterSeconds: 180, clock: 180 * 0.3, score: lead })).toBe(TEMPO.BURN)
    expect(chooseTempo({ quarter: 4, quarterSeconds: 360, clock: 360 * 0.3, score: lead })).toBe(TEMPO.BURN)
    // …and the opening of a quarter is the opening of a quarter at either length.
    expect(chooseTempo({ quarter: 4, quarterSeconds: 180, clock: 180 * 0.9, score: lead })).toBe(TEMPO.NORMAL)
    expect(chooseTempo({ quarter: 4, quarterSeconds: 360, clock: 360 * 0.9, score: lead })).toBe(TEMPO.NORMAL)
  })

  it('⚠️ NEITHER IN THE FIRST OR THIRD QUARTER — there is no deadline to hurry for', () => {
    // Burning clock early buys nothing and costs the drive you were protecting.
    for (const quarter of [1, 3]) {
      expect(chooseTempo(k({ quarter, clock: 30, score: { offense: 21, defense: 0 } }))).toBe(TEMPO.NORMAL)
      expect(chooseTempo(k({ quarter, clock: 30, score: { offense: 0, defense: 21 } }))).toBe(TEMPO.NORMAL)
    }
  })

  it('and not early in the fourth either', () => {
    expect(chooseTempo(k({ clock: 280 }))).toBe(TEMPO.NORMAL)   // the NFL's 14:00
  })

  it('⚠️ A LEAD IN THE SECOND QUARTER IS NOT A LEAD IN THE FOURTH', () => {
    // Running the first half out protects nothing — they get the ball after half time regardless.
    // The only thing worth doing is denying them one last possession, and only when it is late.
    expect(chooseTempo(k({ quarter: 2, clock: 180, score: { offense: 14, defense: 7 } }))).toBe(TEMPO.NORMAL)  // NFL 9:00
    expect(chooseTempo(k({ quarter: 2, clock: 40, score: { offense: 14, defense: 7 } }))).toBe(TEMPO.BURN)     // NFL 2:00
  })

  it('trailing badly hurries whatever the clock says, once the period matters', () => {
    expect(chooseTempo(k({ clock: 150, score: { offense: 7, defense: 28 } }))).toBe(TEMPO.HURRY)   // NFL 7:30
  })

  it('tied is ordinary until there is only one possession left in it', () => {
    expect(chooseTempo(k({ clock: 150, score: { offense: 14, defense: 14 } }))).toBe(TEMPO.NORMAL)  // NFL 7:30
    expect(chooseTempo(k({ clock: 30, score: { offense: 14, defense: 14 } }))).toBe(TEMPO.HURRY)    // NFL 1:30
  })

  it('survives a half-built knowledge object', () => {
    expect(chooseTempo(undefined)).toBe(TEMPO.NORMAL)
    expect(chooseTempo({})).toBe(TEMPO.NORMAL)
  })
})

describe('⚠️ WHEN THAT ACTUALLY PUTS THE BALL IN PLAY', () => {
  const draws = (tempo) => Array.from({ length: 40 }, (_, i) => setTimeFor(tempo, () => i / 40))

  it('burning sets LATE, hurrying sets EARLY', () => {
    const burn = draws(TEMPO.BURN)
    const hurry = draws(TEMPO.HURRY)
    expect(Math.max(...burn)).toBeLessThan(Math.min(...hurry))
  })

  it('every tempo stays inside the legal window', () => {
    for (const t of Object.values(TEMPO)) {
      for (const v of draws(t)) {
        expect(v).toBeGreaterThanOrEqual(AI_SET_EARLIEST)
        expect(v).toBeLessThanOrEqual(AI_SET_LATEST)
      }
    }
  })

  it('⚠️ STILL NOT A METRONOME — each tempo is a band, not a number', () => {
    for (const t of Object.values(TEMPO)) {
      const v = draws(t)
      expect(Math.max(...v)).toBeGreaterThan(Math.min(...v))
    }
  })
})

describe('⚠️ THE CLOCK LEANS THE CALL, IT DOES NOT REPLACE IT', () => {
  const plays = [
    { id: 'r1', playType: 'run' }, { id: 'r2', playType: 'run' },
    { id: 'p1', playType: 'pass' }, { id: 'p2', playType: 'pass' },
  ]
  const runMass = (probs) => plays.reduce((a, p, i) => a + (p.playType === 'run' ? probs[i] : 0), 0)

  it('burning runs it more, hurrying throws it more', () => {
    const base = [0.2, 0.2, 0.3, 0.3]
    expect(runMass(leanRun(plays, base, tempoRunLean(TEMPO.BURN)))).toBeGreaterThan(runMass(base))
    expect(runMass(leanRun(plays, base, tempoRunLean(TEMPO.HURRY)))).toBeLessThan(runMass(base))
  })

  it('…and normal tempo changes nothing at all', () => {
    expect(tempoRunLean(TEMPO.NORMAL)).toBe(1)
  })

  it('⚠️ MODESTLY — a defense that knows you must run is not one you can run on', () => {
    const base = [0.2, 0.2, 0.3, 0.3]
    const burned = runMass(leanRun(plays, base, tempoRunLean(TEMPO.BURN)))
    expect(burned).toBeLessThan(0.8)
  })

  it('the distribution still sums to one, and the order inside a type is untouched', () => {
    const base = [0.1, 0.3, 0.4, 0.2]
    const out = leanRun(plays, base, tempoRunLean(TEMPO.BURN))
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 9)
    expect(out[1] / out[0]).toBeCloseTo(base[1] / base[0], 9)   // r2 : r1
    expect(out[2] / out[3]).toBeCloseTo(base[2] / base[3], 9)   // p1 : p2
  })

  it('a formation with only one kind of play keeps all of its mass', () => {
    const runsOnly = [{ id: 'r1', playType: 'run' }, { id: 'r2', playType: 'run' }]
    const out = leanRun(runsOnly, [0.5, 0.5], 0.35)
    expect(out).toEqual([0.5, 0.5])
  })
})

describe('how many snaps there really are', () => {
  it('burning gets fewer snaps out of the same clock than hurrying', () => {
    expect(snapsLeft(120, TEMPO.BURN)).toBeLessThan(snapsLeft(120, TEMPO.HURRY))
  })
})
