import { describe, it, expect } from '@jest/globals'
import {
  situationKey, distanceBand, fieldZone, downBucket, runLean, depthLean, allSituations,
} from '../ai/playcall/situation.js'
import {
  chooseOffensivePlay, chooseDefensiveShell, priorWeights, playDepth, offenseLookOf,
} from '../ai/playcall/select.js'
import {
  shouldFlip, crowding, keepInToBlock, applyKeepIn, adjustOffense, blockersFor,
} from '../ai/playbook/adjustOffense.js'

const BALL_MID = 26.665

const route = (dd, dx = 0) => ({ kind: 'route', points: [{ dx, dd }] })
const pass = (id, deepest) => ({ id, name: id, playType: 'pass', assignments: { WR1: route(deepest) } })
const run = (id) => ({ id, name: id, playType: 'run', assignments: {} })

// A realistic passing formation: one run, several passes, like GUN BUNCH.
const plays = [run('inside'), pass('quick', 5), pass('mesh', 8), pass('shot', 25), pass('deep', 22)]

const rigged = (seq) => { let i = 0; return () => seq[i++ % seq.length] }

function distribution(situation, n = 4000) {
  const counts = {}
  const rng = () => Math.random()
  for (let i = 0; i < n; i++) {
    const p = chooseOffensivePlay(plays, situation, { rng })
    counts[p.id] = (counts[p.id] ?? 0) + 1
  }
  return Object.fromEntries(Object.entries(counts).map(([k, v]) => [k, v / n]))
}

describe('the situation a play is called in', () => {
  it('splits distance where the calling actually changes', () => {
    expect(distanceBand(1).id).toBe('short')
    expect(distanceBand(2).id).toBe('short')
    expect(distanceBand(3).id).toBe('medium')
    expect(distanceBand(10).id).toBe('long')
    expect(distanceBand(18).id).toBe('verylong')
  })

  it('treats the two ends of the field as their own games', () => {
    expect(fieldZone(8).id).toBe('backedup')
    expect(fieldZone(50).id).toBe('normal')
    expect(fieldZone(88).id).toBe('redzone')
    expect(fieldZone(98).id).toBe('goalline')
  })

  it('⚠️ PUTS THIRD AND FOURTH DOWN IN ONE BUCKET', () => {
    // A team going for it on fourth is in exactly the situation it was in on third — one play to
    // get the distance. Separating them would halve the evidence behind both.
    expect(downBucket(3)).toBe(downBucket(4))
    expect(downBucket(1)).not.toBe(downBucket(2))
  })

  it('gives every bucket a distinct key, and there are not too many of them', () => {
    const all = allSituations()
    expect(new Set(all).size).toBe(all.length)
    expect(all.length).toBeLessThan(60)   // small enough to actually solve
  })
})

describe('⚠️ THE SAME FORMATION IS CALLED DIFFERENTLY BY SITUATION', () => {
  it('runs the ball far more on 3rd and 1 than on 3rd and 12', () => {
    // The user's point: play calling is not uniform. Out of ONE formation with one run and four
    // passes, short yardage should still be a running down.
    const short = distribution({ down: 3, distance: 1, yardLine: 50 })
    const long = distribution({ down: 3, distance: 12, yardLine: 50 })
    expect(short.inside).toBeGreaterThan(long.inside * 2)
  })

  it('⚠️ DOES NOT THROW DEEP ON 4TH AND GOAL FROM THE 2', () => {
    // The example the user gave. The end zone is two yards away and the route needs twenty.
    const goalline = distribution({ down: 4, distance: 2, yardLine: 98 })
    const open = distribution({ down: 1, distance: 10, yardLine: 40 })
    const deepShare = (d) => (d.shot ?? 0) + (d.deep ?? 0)
    expect(deepShare(goalline)).toBeLessThan(deepShare(open) / 2)
  })

  it('leans on the deep ball when a lot of yards are needed', () => {
    const verylong = distribution({ down: 3, distance: 18, yardLine: 40 })
    const shortyds = distribution({ down: 1, distance: 2, yardLine: 40 })
    expect((verylong.shot ?? 0) + (verylong.deep ?? 0))
      .toBeGreaterThan((shortyds.shot ?? 0) + (shortyds.deep ?? 0))
  })

  it('⚠️ LEANS, NEVER FORBIDS — every play stays possible everywhere', () => {
    // A defense that could rely on "they never throw deep here" would be reading the prior rather
    // than the offense.
    for (const sit of [
      { down: 4, distance: 1, yardLine: 99 },
      { down: 1, distance: 10, yardLine: 25 },
      { down: 3, distance: 20, yardLine: 5 },
    ]) {
      const d = distribution(sit, 3000)
      for (const p of plays) expect(d[p.id] ?? 0).toBeGreaterThan(0)
    }
  })

  it('⚠️ MEASURES DEPTH AS THE MEAN ROUTE, not the deepest one', () => {
    // Measuring by the deepest called almost everything a deep shot: a mesh concept with one go
    // route to clear out the middle scored the same as four verticals. The clear-out is not where
    // the ball is going.
    expect(playDepth(pass('x', 22))).toBe(22)
    expect(playDepth(run('y'))).toBe(0)
    const clearOut = {
      id: 'mesh', playType: 'pass',
      assignments: { WR1: route(25), WR2: route(5), WR3: route(6), TE1: route(4) },
    }
    expect(playDepth(clearOut)).toBeLessThan(15)
  })

  it('weights a run up in short yardage', () => {
    const short = priorWeights(plays, { down: 3, distance: 1, yardLine: 50 })[0]
    const long = priorWeights(plays, { down: 3, distance: 15, yardLine: 50 })[0]
    expect(short).toBeGreaterThan(long)
    expect(runLean({ down: 3, distance: 1, yardLine: 50 })).toBeGreaterThan(1)
    expect(depthLean({ yardLine: 98, distance: 2 })).toBeLessThan(0.2)
  })
})

describe('a solved table is used where one exists', () => {
  const sit = { down: 1, distance: 10, yardLine: 50 }
  const key = situationKey(sit)

  it('follows the solved distribution', () => {
    const solved = { [key]: { mesh: 1 } }
    const picks = new Set()
    for (let i = 0; i < 200; i++) picks.add(chooseOffensivePlay(plays, sit, { solved }).id)
    // The mixing floor keeps others alive, but mesh should dominate overwhelmingly.
    let mesh = 0
    for (let i = 0; i < 2000; i++) if (chooseOffensivePlay(plays, sit, { solved }).id === 'mesh') mesh++
    expect(mesh / 2000).toBeGreaterThan(0.9)
  })

  it('⚠️ FALLS BACK TO THE PRIOR FOR A BUCKET NOBODY SOLVED, rather than to nothing', () => {
    const solved = { 'some|other|bucket': { mesh: 1 } }
    expect(chooseOffensivePlay(plays, sit, { solved })).toBeTruthy()
  })

  it('⚠️ FALLS BACK WHEN A TABLE KNOWS NONE OF THESE PLAYS', () => {
    // A play authored after a solve has no entry. Treating a missing entry as zero would silently
    // retire every new play.
    const solved = { [key]: { somethingElse: 1 } }
    expect(chooseOffensivePlay(plays, sit, { solved })).toBeTruthy()
  })
})

describe('⚠️ THE DEFENSE PICKS AFTER SEEING THE FORMATION', () => {
  const shells = [
    { id: 'base', personnel: { CB: 2, S: 2, LB: 3 } },
    { id: 'nickel', personnel: { CB: 3, S: 2, LB: 2 } },
    { id: 'dime', personnel: { CB: 4, S: 2, LB: 1 } },
  ]
  const shareOf = (look, id, n = 3000) => {
    let hit = 0
    for (let i = 0; i < n; i++) {
      if (chooseDefensiveShell(shells, { down: 1, distance: 10, yardLine: 50 }, look).id === id) hit++
    }
    return hit / n
  }

  it('matches personnel: more receivers brings more defensive backs', () => {
    expect(shareOf({ wr: 4 }, 'dime')).toBeGreaterThan(shareOf({ wr: 2 }, 'dime'))
    expect(shareOf({ wr: 2 }, 'base')).toBeGreaterThan(shareOf({ wr: 4 }, 'base'))
  })

  it('still mixes — the right personnel is not one fixed answer', () => {
    const nickel = shareOf({ wr: 3 }, 'nickel')
    expect(nickel).toBeGreaterThan(0.3)
    expect(nickel).toBeLessThan(0.95)
  })

  it('reads the look off the formation, never off the play', () => {
    const look = offenseLookOf({
      id: 'trips',
      spots: [{ slot: 'WR1' }, { slot: 'WR2' }, { slot: 'WR3' }, { slot: 'TE1' }, { slot: 'RB1' }],
    })
    expect(look).toMatchObject({ wr: 3, te: 1, rb: 1 })
  })
})

describe('⚠️ FLIPPING THE FORMATION FOR THE FIELD', () => {
  // Everybody to the left, like GUN BUNCH QUADS OFFSET.
  const leftHeavy = {
    spots: [
      { slot: 'WR1', dx: -20 }, { slot: 'WR2', dx: -16 }, { slot: 'WR3', dx: -12 },
      { slot: 'TE1', dx: -6 }, { slot: 'RB1', dx: 2 },
    ],
  }
  const balanced = {
    spots: [{ slot: 'WR1', dx: -14 }, { slot: 'WR2', dx: 14 }, { slot: 'RB1', dx: 0 }],
  }

  it('flips a left-heavy set when the ball is on the left hash', () => {
    expect(shouldFlip(leftHeavy, 12)).toBe(true)
  })

  it('leaves it alone when there is already room', () => {
    expect(shouldFlip(leftHeavy, 40)).toBe(false)
  })

  it('⚠️ NEVER FLIPS A SYMMETRIC SET — it would achieve nothing and jump the picture around', () => {
    expect(shouldFlip(balanced, 12)).toBe(false)
    expect(shouldFlip(balanced, 40)).toBe(false)
  })

  it('measures crowding as yards of overhang past the sideline', () => {
    expect(crowding(leftHeavy, 40)).toBe(0)
    expect(crowding(leftHeavy, 12)).toBeGreaterThan(0)
    // And mirroring is what relieves it.
    expect(crowding(leftHeavy, 12, { mirror: true })).toBeLessThan(crowding(leftHeavy, 12))
  })
})

describe('⚠️ KEEPING SOMEBODY IN TO BLOCK', () => {
  const formation = {
    spots: [{ slot: 'WR1' }, { slot: 'WR2' }, { slot: 'WR3' }, { slot: 'TE1' }, { slot: 'RB1' }],
  }
  const play = {
    id: 'mesh', playType: 'pass',
    assignments: {
      WR1: route(8), WR2: route(12), WR3: route(6), TE1: route(5), RB1: route(3),
    },
  }

  it('counts the five linemen plus anybody already blocking', () => {
    expect(blockersFor(play)).toBe(5)
    expect(blockersFor({ ...play, assignments: { ...play.assignments, RB1: { kind: 'block' } } })).toBe(6)
  })

  it('does nothing against a four-man rush', () => {
    expect(keepInToBlock(play, formation, { rushers: 4 })).toBeNull()
  })

  it('⚠️ KEEPS A BACK IN WHEN THERE ARE MORE RUSHERS THAN BLOCKERS', () => {
    // Six rushers against five linemen is a free run at the quarterback no matter how good the
    // protection is.
    expect(keepInToBlock(play, formation, { rushers: 6 })).toBe('RB1')
  })

  it('takes the back before the tight end', () => {
    expect(keepInToBlock(play, formation, { rushers: 7 })).toBe('RB1')
  })

  it('⚠️ NEVER BLOCKS THE LAST RECEIVER — that is a sack with extra steps', () => {
    const lonely = { id: 'x', playType: 'pass', assignments: { RB1: route(3) } }
    expect(applyKeepIn(lonely, 'RB1').assignments.RB1.kind).toBe('route')
  })

  it('leaves a run play alone', () => {
    expect(keepInToBlock({ id: 'r', playType: 'run', assignments: {} }, formation, { rushers: 7 })).toBeNull()
  })

  it('does both adjustments together without changing which play it is', () => {
    const out = adjustOffense(play, { spots: [{ slot: 'WR1', dx: -20 }, { slot: 'RB1', dx: 2 }] },
      { ballX: 12, rushers: 6 })
    expect(out.mirror).toBe(true)
    expect(out.play.id).toBe('mesh')          // still the same play
    expect(out.keptIn).toBe('RB1')
  })
})
