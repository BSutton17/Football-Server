import { describe, it, expect } from '@jest/globals'
import {
  createStats, recordAttempt, recordCompletion, recordPassYards, recordRush, recordTackle,
  recordSack, recordInterception, recordTouchdown, topPerformers, teamTotals, impactScore,
  statLine, serializeStats,
} from '../game/stats.js'

// [stats] The box score behind the halftime and final screens.

const QB = { id: 'qb1', slot: 0, name: 'Burrow', label: 'QB' }
const WR = { id: 'wr1', slot: 0, name: 'Chase', label: 'WR' }
const RB = { id: 'rb1', slot: 0, name: 'Brown', label: 'RB' }
const CB = { id: 'cb1', slot: 1, name: 'Sneed', label: 'CB' }
const LB = { id: 'lb1', slot: 1, name: 'Wilson', label: 'LB' }

// A completed pass, start to finish, the way the engine reports it: attempt, then catch, then the
// yardage once the tackle settles it.
function completion(stats, yards, tackler = CB) {
  recordAttempt(stats, { passer: QB, target: WR })
  recordCompletion(stats, { passer: QB, receiver: WR })
  recordPassYards(stats, { passer: QB, receiver: WR, yards })
  if (tackler) recordTackle(stats, { tackler })
}

describe('what gets counted', () => {
  it('credits a completion to the passer AND the receiver', () => {
    const s = createStats()
    completion(s, 18)
    expect(s.players.get('qb1')).toMatchObject({ attempts: 1, completions: 1, passYards: 18 })
    expect(s.players.get('wr1')).toMatchObject({ targets: 1, receptions: 1, recYards: 18 })
  })

  it('⚠️ COUNTS YARDS AFTER THE CATCH as passing yards, which is how football counts them', () => {
    // The engine settles the whole gain at the tackle, not the distance the ball flew, and both
    // the passer and the receiver get all of it.
    const s = createStats()
    completion(s, 60)
    expect(s.players.get('qb1').passYards).toBe(60)
    expect(s.players.get('wr1').recYards).toBe(60)
  })

  it('counts an incompletion as an attempt and nothing else', () => {
    const s = createStats()
    recordAttempt(s, { passer: QB, target: WR })
    expect(s.players.get('qb1')).toMatchObject({ attempts: 1, completions: 0, passYards: 0 })
    expect(s.players.get('wr1')).toMatchObject({ targets: 1, receptions: 0 })
  })

  it('⚠️ DOES NOT COUNT A SACK AS A PASS ATTEMPT, and charges the yards to the passer', () => {
    const s = createStats()
    recordSack(s, { defender: LB, passer: QB, yards: -7 })
    expect(s.players.get('qb1')).toMatchObject({ attempts: 0, sacksTaken: 1, passYards: -7 })
    expect(s.players.get('lb1').sacks).toBe(1)
  })

  it('credits a run to the carrier', () => {
    const s = createStats()
    recordRush(s, { runner: RB, yards: 12 })
    recordRush(s, { runner: RB, yards: -2 })
    expect(s.players.get('rb1')).toMatchObject({ carries: 2, rushYards: 10 })
  })

  it('credits a touchdown by HOW the ball was got, not by position', () => {
    // A receiver who took a handoff scored a rushing touchdown.
    const s = createStats()
    recordTouchdown(s, { scorer: WR, passer: QB, viaPass: false })
    expect(s.players.get('wr1')).toMatchObject({ rushTD: 1, recTD: 0 })
    // And the quarterback gets no line at all — he was not involved in a handoff, so inventing a
    // row of zeroes for him would put a player who did nothing into the box score.
    expect(s.players.get('qb1')).toBeUndefined()

    recordTouchdown(s, { scorer: WR, passer: QB, viaPass: true })
    expect(s.players.get('wr1').recTD).toBe(1)
    expect(s.players.get('qb1').passTD).toBe(1)
  })

  it('charges an interception to the passer and credits the defender', () => {
    const s = createStats()
    recordInterception(s, { defender: CB, passer: QB })
    expect(s.players.get('cb1').interceptions).toBe(1)
    expect(s.players.get('qb1').interceptionsThrown).toBe(1)
  })

  it('⚠️ NEVER CHANGES A PLAYER’S TEAM once it is recorded', () => {
    // Offense and defense swap every possession; team membership does not. Keyed by slot instead
    // of by player, every stat would land on whichever side happened to have the ball.
    const s = createStats()
    recordRush(s, { runner: RB, yards: 5 })
    recordTackle(s, { tackler: { ...RB, slot: 1 } })   // same id arriving with the wrong team
    expect(s.players.get('rb1').slot).toBe(0)
  })
})

describe('⚠️ A DEFENDER CAN BE ONE OF THE BEST PLAYERS', () => {
  it('ranks a big defensive game above a quiet offensive one', () => {
    // The whole point of the feature: a list that could only ever show skill players would be
    // useless on half the snaps.
    const s = createStats()
    completion(s, 20, null)                                   // a modest passing play
    recordInterception(s, { defender: CB, passer: QB })
    recordSack(s, { defender: CB, passer: QB, yards: -8 })
    for (let i = 0; i < 6; i++) recordTackle(s, { tackler: CB })

    const top = topPerformers(s, 3)
    expect(top[0].id).toBe('cb1')
    expect(top[0].summary).toMatch(/6 tkl/)
    expect(top[0].summary).toMatch(/1 INT/)
  })

  it('ranks a huge passing day at the top when there is one', () => {
    const s = createStats()
    for (let i = 0; i < 12; i++) completion(s, 30, null)
    recordTouchdown(s, { scorer: WR, passer: QB, viaPass: true })
    recordTouchdown(s, { scorer: WR, passer: QB, viaPass: true })
    recordInterception(s, { defender: CB, passer: QB })
    const ids = topPerformers(s, 3).map(p => p.id)
    expect(ids).toContain('wr1')
    expect(ids).toContain('qb1')
  })

  it('⚠️ LEAVES OUT ANYONE WHO DID NOTHING rather than padding to three', () => {
    const s = createStats()
    recordRush(s, { runner: RB, yards: 4 })
    recordAttempt(s, { passer: QB, target: WR })     // an incompletion: nothing to show
    const top = topPerformers(s, 3)
    expect(top).toHaveLength(1)
    expect(top[0].id).toBe('rb1')
  })

  it('is stable when two players tie', () => {
    const s = createStats()
    recordTackle(s, { tackler: CB })
    recordTackle(s, { tackler: LB })
    expect(topPerformers(s, 2).map(p => p.id)).toEqual(topPerformers(s, 2).map(p => p.id))
  })

  it('an interception costs the passer', () => {
    const clean = createStats(); completion(clean, 40, null)
    const picked = createStats(); completion(picked, 40, null)
    recordInterception(picked, { defender: CB, passer: QB })
    expect(impactScore(picked.players.get('qb1'))).toBeLessThan(impactScore(clean.players.get('qb1')))
  })
})

describe('team totals', () => {
  it('adds up the yards each side gained', () => {
    const s = createStats()
    completion(s, 25, null)
    completion(s, 15, null)
    recordRush(s, { runner: RB, yards: 10 })
    const t = teamTotals(s, 0)
    expect(t).toMatchObject({ passYards: 40, rushYards: 10, totalOffense: 50 })
  })

  it('⚠️ DOES NOT DOUBLE-COUNT A COMPLETION', () => {
    // The passer and the receiver are both credited the same yards, so summing both would report
    // every passing game at twice its size.
    const s = createStats()
    completion(s, 30, null)
    expect(teamTotals(s, 0).passYards).toBe(30)
  })

  it('counts a sack against the passing total', () => {
    const s = createStats()
    completion(s, 20, null)
    recordSack(s, { defender: LB, passer: QB, yards: -9 })
    expect(teamTotals(s, 0).passYards).toBe(11)
  })

  it('credits a takeaway to the team that TOOK it', () => {
    const s = createStats()
    recordInterception(s, { defender: CB, passer: QB })
    expect(teamTotals(s, 1).takeaways).toBe(1)
    expect(teamTotals(s, 0).takeaways).toBe(0)
  })

  it('keeps the two teams apart', () => {
    const s = createStats()
    recordRush(s, { runner: RB, yards: 10 })
    recordRush(s, { runner: { id: 'rb2', slot: 1, name: 'Other', label: 'RB' }, yards: 70 })
    expect(teamTotals(s, 0).rushYards).toBe(10)
    expect(teamTotals(s, 1).rushYards).toBe(70)
  })
})

describe('what goes over the wire', () => {
  it('carries the top three and both teams', () => {
    const s = createStats()
    completion(s, 30, null)
    recordRush(s, { runner: RB, yards: 12 })
    recordInterception(s, { defender: CB, passer: QB })
    const wire = serializeStats(s)
    expect(wire.top.length).toBeLessThanOrEqual(3)
    expect(wire.teams).toHaveLength(2)
    expect(wire.teams[0].totalOffense).toBe(42)
  })

  it('gives every listed player something to read', () => {
    const s = createStats()
    completion(s, 30, null)
    for (const p of serializeStats(s).top) {
      expect(p.summary.length).toBeGreaterThan(0)
      expect(p.name).toBeTruthy()
    }
  })
})

describe('⚠️ A BOX SCORE IS A NICETY AND MUST NEVER BREAK A PLAY', () => {
  it('shrugs off a missing box score', () => {
    // Not every game state is built by initGame — tests and special-teams paths make their own.
    expect(() => recordRush(undefined, { runner: RB, yards: 5 })).not.toThrow()
    expect(topPerformers(undefined)).toEqual([])
    expect(teamTotals(undefined, 0).totalOffense).toBe(0)
  })

  it('⚠️ SHRUGS OFF A NULL PLAYER, which is not the same as a missing one', () => {
    // There is no passer on a run and no tackler when somebody runs out of bounds. A default
    // parameter only fills in for undefined, so null used to throw on destructuring.
    const s = createStats()
    expect(() => recordTackle(s, { tackler: null })).not.toThrow()
    expect(() => recordPassYards(s, { passer: null, receiver: WR, yards: 9 })).not.toThrow()
    expect(() => recordTouchdown(s, { scorer: RB, passer: null, viaPass: false })).not.toThrow()
    expect(s.players.get('wr1').recYards).toBe(9)
  })

  it('ignores a player with no id at all', () => {
    const s = createStats()
    recordRush(s, { runner: { slot: 0 }, yards: 5 })
    expect(s.players.size).toBe(0)
  })
})

describe('the summary line', () => {
  it('reads like a box score for a passer', () => {
    const s = createStats()
    for (let i = 0; i < 3; i++) completion(s, 10, null)
    recordAttempt(s, { passer: QB, target: WR })
    expect(statLine(s.players.get('qb1'))).toBe('3/4, 30 yds')
  })

  it('shows a defender what he actually did, with no empty yardage', () => {
    const s = createStats()
    recordTackle(s, { tackler: LB })
    recordSack(s, { defender: LB, passer: QB, yards: -6 })
    expect(statLine(s.players.get('lb1'))).toBe('1 tkl · 1 sack')
  })
})

describe('⚠️ EACH TEAM GETS ITS OWN THREE', () => {
  // A single ranked three is usually three players from whichever side had the better half, so the
  // other team's best game goes unmentioned entirely. The halftime screen shows both.
  const p = (id, name, label, slot) => ({ id, name, label, slot })

  function twoSidedGame() {
    const box = createStats()
    // Slot 0 had the better half.
    recordPassYards(box, { passer: p('qb0', 'Passer Zero', 'QB', 0), receiver: p('wr0', 'Wideout Zero', 'WR', 0), yards: 220 })
    recordRush(box, { runner: p('rb0', 'Back Zero', 'RB', 0), yards: 70 })
    recordRush(box, { runner: p('rb0b', 'Back Zero B', 'RB', 0), yards: 40 })
    // Slot 1 did less, but still has a best player.
    recordTackle(box, { tackler: p('lb1', 'Backer One', 'LB', 1) })
    recordTackle(box, { tackler: p('lb1', 'Backer One', 'LB', 1) })
    recordInterception(box, { defender: p('lb1', 'Backer One', 'LB', 1), passer: p('qb0', 'Passer Zero', 'QB', 0) })
    return box
  }

  it('splits the leaders by team', () => {
    const { byTeam } = serializeStats(twoSidedGame())
    expect(byTeam).toHaveLength(2)
    expect(byTeam[0].length).toBeGreaterThan(0)
    expect(byTeam[0].every(x => x.slot === 0)).toBe(true)
    expect(byTeam[1].every(x => x.slot === 1)).toBe(true)
  })

  it('⚠️ SHOWS EACH SIDE ITS OWN BEST PLAYER', () => {
    const { byTeam } = serializeStats(twoSidedGame())
    expect(byTeam[1].length).toBeGreaterThan(0)
    expect(byTeam[1][0].name).toBe('Backer One')
  })

  it('still reports the outright leaders for anything that wants them', () => {
    expect(serializeStats(twoSidedGame()).top.length).toBeGreaterThan(0)
  })

  it('gives an empty list for a team that has done nothing', () => {
    const box = createStats()
    recordRush(box, { runner: p('rb0', 'Only Runner', 'RB', 0), yards: 12 })
    expect(serializeStats(box).byTeam[1]).toEqual([])
  })

  it('caps each side at three', () => {
    const box = createStats()
    for (let i = 0; i < 6; i++) recordRush(box, { runner: p('r' + i, 'Runner ' + i, 'RB', 0), yards: 20 + i })
    expect(serializeStats(box).byTeam[0].length).toBeLessThanOrEqual(3)
  })
})
