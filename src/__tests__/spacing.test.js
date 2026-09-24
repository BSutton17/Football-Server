import { describe, it, expect } from '@jest/globals'
import { countCrowdedDefenders } from '../training/game.js'
import { scorePlay } from '../training/fitness.js'

// [spacing] Two defenders on one patch of grass cover one patch of grass, and the field they left
// is the field the offense throws into.
//
// This is not hypothetical. The champion installed as hard mode averaged 3.6 overlapping pairs per
// snap and peaked at 10 — with seven coverage defenders, ten pairs is the whole secondary in one
// pile. Yardage alone never punished it: the cost arrives several plays later, through completions,
// far too noisily for selection to attribute it to the alignment that caused it.

const at = (id, x, y) => ({ id, x, y })

function stateWith(defenders) {
  return { defensePlayers: new Map(defenders.map(d => [d.id, d])) }
}

describe('counting bunched coverage', () => {
  it('sees a pile', () => {
    expect(countCrowdedDefenders(stateWith([
      at('cb1', 26, 40), at('cb2', 26.5, 40), at('s1', 27, 40.5),
    ]))).toBe(3)      // every pair overlaps
  })

  it('sees none when they are spread', () => {
    expect(countCrowdedDefenders(stateWith([
      at('cb1', 6, 40), at('cb2', 26, 40), at('s1', 46, 40),
    ]))).toBe(0)
  })

  // ⚠️ THE DOWN LINEMEN ARE EXCLUDED, and it is not a convenience. autoDefense places them at
  // fixed spots exactly 2.0 yards apart, so any threshold at or above that flags the standard front
  // on EVERY snap — a constant penalty teaches nothing and just shifts the whole fitness scale.
  // They are also not the brain's decision.
  it('ignores the auto-placed front, which is always 2 yards apart', () => {
    const front = [
      at('auto_dl1', 22.75, 36), at('auto_dl2', 24.75, 36),
      at('auto_dl3', 27.25, 36), at('auto_dl4', 29.25, 36),
    ]
    expect(countCrowdedDefenders(stateWith(front))).toBe(0)
    // …and it still counts coverage players standing in the same pile.
    expect(countCrowdedDefenders(stateWith([...front, at('cb1', 26, 44), at('cb2', 26.4, 44)]))).toBe(1)
  })

  it('allows a genuine double team — 2.2yd is bodies overlapping, not two men working an area', () => {
    // Real defenses bracket and double. Three yards apart is coverage, not a pile.
    expect(countCrowdedDefenders(stateWith([at('cb1', 26, 40), at('s1', 29, 40)]))).toBe(0)
  })
})

describe('the penalty', () => {
  const play = (crowded) => ({
    ok: true, yards: 5, outcome: 'tackle', turnover: false, sacked: false, problems: [], crowded,
  })

  it('costs the defense, and scales with the pile', () => {
    const clean = scorePlay(play(0), 5, { side: 'defense' }).score
    const some = scorePlay(play(2), 5, { side: 'defense' }).score
    const worse = scorePlay(play(4), 5, { side: 'defense' }).score
    expect(some).toBeLessThan(clean)
    expect(worse).toBeLessThan(some)
  })

  it('is CAPPED, so it can never become the objective', () => {
    // Shaping that outgrows the thing it is shaping produces a defense that spreads out beautifully
    // and covers nobody.
    const huge = scorePlay(play(50), 5, { side: 'defense' }).score
    const four = scorePlay(play(4), 5, { side: 'defense' }).score
    expect(huge).toBeGreaterThanOrEqual(four - 1)
    expect(scorePlay(play(0), 5, { side: 'defense' }).score - huge).toBeLessThanOrEqual(5)
  })

  it('does NOT become a bonus for the offense', () => {
    // Both sides are scored on the same play. If the defense's penalty leaked through the sign flip
    // it would pay the offense for the defense bunching, and both would chase the same artefact.
    const clean = scorePlay(play(0), 5, { side: 'offense' }).score
    const piled = scorePlay(play(8), 5, { side: 'offense' }).score
    expect(piled).toBe(clean)
  })

  it('is absent when a play carries no measurement', () => {
    // Older results, and any caller that does not measure spacing, must score exactly as before.
    const withField = scorePlay(play(0), 5, { side: 'defense' }).score
    const without = scorePlay({ ...play(0), crowded: undefined }, 5, { side: 'defense' }).score
    expect(without).toBe(withField)
  })
})
