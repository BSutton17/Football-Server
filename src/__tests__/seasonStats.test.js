import { describe, it, expect } from '@jest/globals'
import { makeRng } from '../game/utils/rng.js'
import { createStats, recordRush, recordSack, recordCompletion, recordPassYards, recordAttempt } from '../game/stats.js'
import { maybeSpotlight, chooseSpotlight, releaseSpotlight, SPOTLIGHT } from '../game/statSpotlight.js'
import { snapshotGame, hydrateGame } from '../game/snapshot.js'
import { simGame, expectedPoints } from '../season/simGame.js'
import { TEAM, TEAMS } from '../season/teams.js'
import { ROSTER, PLAYER, rosterPlayer, careersFor } from '../season/rosters.js'
import { simBoxScore } from '../season/boxScore.js'
import {
  boxFromEngine, bookPlayedGame, votingLines, totalsForGame, passerRating, simulatedBox, ledgerOf, emptyLedger,
} from '../season/seasonStats.js'
import { computeAwards } from '../season/awards.js'
import {
  createSeason, currentUserGame, simCurrent, beginGame, recordUserGame, seasonView, upgradeSeason, SCREEN, recordOf,
} from '../season/season.js'
import schedule2026 from '../season/data/schedule2026.js'

const fullSeason = (teamId = 'KC', seed = 42) => createSeason({
  id: `s${seed}`, userId: 'u', slot: 0, teamId,
  settings: { mode: 'automatic', difficulty: 'easy', quarterMinutes: 5 },
  schedule: schedule2026, seed,
})

function throughRegularSeason(season) {
  let guard = 0
  while (season.phase === 'regular' && guard++ < 25) simCurrent(season)
  return season
}

describe('[sim] the better team is more likely to win, and not certain to', () => {
  const best = TEAMS.reduce((a, b) => (b.ovr > a.ovr ? b : a))
  const worst = TEAMS.reduce((a, b) => (b.ovr < a.ovr ? b : a))

  function winRate(a, b, n = 6000) {
    const rng = makeRng(11)
    let w = 0
    for (let i = 0; i < n; i++) {
      const g = simGame(a, b, { neutral: true }, rng)
      if (g.homeScore > g.awayScore) w++
    }
    return w / n
  }

  it('⚠️ THE WIDEST GAP IN THE LEAGUE IS A BIG FAVORITE, NEVER A CERTAINTY', () => {
    const rate = winRate(best, worst)
    expect(rate).toBeGreaterThan(0.78)
    expect(rate).toBeLessThan(0.93)
  })

  it('win rate climbs with the OVR gap', () => {
    const byOvr = [...TEAMS].sort((a, b) => b.ovr - a.ovr)
    const close = winRate(byOvr[0], byOvr[3])
    const wide = winRate(byOvr[0], byOvr[31])
    expect(close).toBeGreaterThan(0.5)
    expect(wide).toBeGreaterThan(close + 0.1)
  })

  it('⚠️ A BETTER OFFENSE AVERAGES MORE, AND A WORSE DEFENSE GIVES UP MORE', () => {
    const strong = { offOvr: 92, defOvr: 90 }, weak = { offOvr: 74, defOvr: 74 }
    expect(expectedPoints(strong, weak)).toBeGreaterThan(expectedPoints(weak, weak) + 5)
    expect(expectedPoints(strong, weak)).toBeGreaterThan(expectedPoints(strong, strong) + 5)

    const rng = makeRng(5)
    let good = 0, bad = 0
    const n = 4000
    for (let i = 0; i < n; i++) {
      good += simGame({ offOvr: 92, defOvr: 80 }, { offOvr: 80, defOvr: 74 }, { neutral: true }, rng).homeScore
      bad += simGame({ offOvr: 74, defOvr: 80 }, { offOvr: 80, defOvr: 92 }, { neutral: true }, rng).homeScore
    }
    expect(good / n).toBeGreaterThan(bad / n + 10)
  })
})

describe('[season stats] a simulated box score adds up like a real one', () => {
  const rng = makeRng(77)
  const noForm = () => 1
  const boxes = Array.from({ length: 200 }, () => {
    const a = TEAMS[Math.floor(rng() * 32)], b = TEAMS[Math.floor(rng() * 32)]
    const home = a.id === b.id ? TEAMS[(TEAMS.indexOf(a) + 1) % 32] : a
    const r = simGame(home, b, {}, rng)
    return { home, away: b, r, lines: simBoxScore(ROSTER[home.id], ROSTER[b.id], r, noForm, rng) }
  })

  const teamSum = (lines, teamId, field) => ROSTER[teamId].all.reduce((n, p) => n + (lines[p.id]?.[field] ?? 0), 0)

  it('⚠️ THE TOUCHDOWNS ARE EXACTLY THE SCORE\'S', () => {
    for (const { home, away, r, lines } of boxes) {
      for (const [team, tds] of [[home.id, r.homeTds], [away.id, r.awayTds]]) {
        const scored = teamSum(lines, team, 'rushTD') + teamSum(lines, team, 'recTD')
        expect(scored).toBe(tds)
        expect(teamSum(lines, team, 'recTD')).toBe(lines[ROSTER[team].qb.id].passTD ?? 0)
      }
    }
  })

  it('⚠️ THE RECEIVERS HAVE THE PASSER\'S YARDS AND CATCHES, EXACTLY', () => {
    for (const { home, lines } of boxes) {
      const qb = lines[ROSTER[home.id].qb.id]
      expect(teamSum(lines, home.id, 'recYards')).toBe(qb.passYards)
      expect(teamSum(lines, home.id, 'receptions')).toBe(qb.completions)
      expect(qb.completions).toBeLessThanOrEqual(qb.attempts)
    }
  })

  it('every sack and pick is one defender\'s and charged to the other club\'s passer', () => {
    for (const { home, away, lines } of boxes) {
      expect(teamSum(lines, away.id, 'sacks')).toBe(lines[ROSTER[home.id].qb.id].sacksTaken ?? 0)
      expect(teamSum(lines, away.id, 'interceptions')).toBe(lines[ROSTER[home.id].qb.id].interceptionsThrown ?? 0)
      // A sack is a tackle for loss by definition, as the engine's own box score has it.
      expect(teamSum(lines, away.id, 'tfl')).toBeGreaterThanOrEqual(teamSum(lines, away.id, 'sacks'))
    }
  })

  it('a team that scores more moves the ball more', () => {
    let highPts = 0, highN = 0, lowPts = 0, lowN = 0
    for (const { home, r, lines } of boxes) {
      const yds = lines[ROSTER[home.id].qb.id].passYards
      if (r.homeScore >= 30) { highPts += yds; highN++ } else if (r.homeScore <= 13) { lowPts += yds; lowN++ }
    }
    expect(highPts / highN).toBeGreaterThan(lowPts / lowN)
  })

  it('⚠️ WRITING A GAME AGAIN GIVES THE SAME LINES, so a crash cannot change anybody\'s year', () => {
    const season = fullSeason()
    simCurrent(season)
    const game = season.games.find(g => g.status === 'final')
    expect(simulatedBox(season, game)).toEqual(simulatedBox(season, game))
  })
})

describe('[season stats] a season\'s numbers', () => {
  const season = throughRegularSeason(fullSeason())
  const { regular } = season.stats

  it('look like the league\'s, at the top and across it', () => {
    const top = (f) => Math.max(...Object.values(regular).map(l => l[f] ?? 0))
    expect(top('passYards')).toBeGreaterThan(3800)
    expect(top('passYards')).toBeLessThan(5600)
    expect(top('rushYards')).toBeGreaterThan(1200)
    expect(top('rushYards')).toBeLessThan(2500)
    expect(top('recYards')).toBeGreaterThan(1200)
    expect(top('recYards')).toBeLessThan(2400)
    expect(top('sacks')).toBeGreaterThan(14)
    expect(top('sacks')).toBeLessThan(40)
    expect(top('interceptions')).toBeGreaterThan(4)
    expect(top('interceptions')).toBeLessThan(18)
  })

  it('every starting quarterback played the whole year', () => {
    for (const t of TEAMS) {
      const { w, l, t: ties } = recordOf(season, t.id)
      expect(regular[ROSTER[t.id].qb.id].g).toBe(w + l + ties)
      expect(w + l + ties).toBe(17)
    }
  })

  it('⚠️ THE LEDGER STAYS ON THE SERVER: the view carries only what screens draw', () => {
    const view = seasonView(season)
    expect(view.stats).toBeUndefined()
    expect(view.leaders.find(t => t.id === 'passYards').rows[0].value).toBeGreaterThan(3000)
    expect(view.teamStats.some(p => p.pos === 'QB')).toBe(true)
    expect(JSON.stringify(view.leaders).length).toBeLessThan(12000)
  })
})

describe('[season stats] a played game', () => {
  const qb = (team, slot) => ({ id: 'auto_qb', slot, name: 'QB', label: 'QB', team })

  it('⚠️ `auto_qb` IS EACH CLUB\'S OWN QUARTERBACK, not one line shared between them', () => {
    const stats = createStats()
    recordAttempt(stats, { passer: qb('KC', 0), target: null })
    recordPassYards(stats, { passer: qb('KC', 0), receiver: null, yards: 40 })
    recordAttempt(stats, { passer: qb('DEN', 1), target: null })
    recordPassYards(stats, { passer: qb('DEN', 1), receiver: null, yards: 7 })
    recordSack(stats, { defender: { id: 'auto_dl2', slot: 1, label: 'DL' }, passer: qb('KC', 0), yards: -5 })

    const { box, snaps } = boxFromEngine(stats, ['KC', 'DEN'])
    expect(box[ROSTER.KC.qb.id].passYards).toBe(35)
    expect(box[ROSTER.DEN.qb.id].passYards).toBe(7)
    expect(box[ROSTER.DEN.dl[1].id].sacks).toBe(1)
    expect(snaps).toBe(3)                      // two attempts and a sack
    expect(rosterPlayer('KC', 'ghost')).toBeNull()
  })

  it('leaves out anybody who is not on the roster rather than guessing', () => {
    const stats = createStats()
    recordRush(stats, { runner: { id: 'mock_rb', slot: 0 }, yards: 80 })
    expect(boxFromEngine(stats, ['KC', 'DEN']).box).toEqual({})
  })

  it('⚠️ THE PLAYER SEES WHAT REALLY HAPPENED; ONLY THE VOTERS SEE IT AT A FULL GAME\'S PACE', () => {
    const season = fullSeason()
    const game = currentUserGame(season)
    const id = ROSTER.KC.rb[0].id
    bookPlayedGame(season, game, { box: { [id]: { g: 1, carries: 10, rushYards: 100 } }, snaps: 50 })   // 50 of 125 snaps
    expect(ledgerOf(season).regular[id]).toEqual({ g: 1, carries: 10, rushYards: 100 })
    const voters = votingLines(season)[id]
    expect(voters.rushYards).toBe(250)
    expect(voters.carries).toBe(25)
    expect(voters.g).toBe(1)                   // a game is still one game
  })

  it('a game as long as a real one is not adjusted, and neither is a playoff game', () => {
    const season = fullSeason()
    const id = ROSTER.KC.rb[0].id
    bookPlayedGame(season, season.games[0], { box: { [id]: { g: 1, rushYards: 100 } }, snaps: 130 })
    expect(votingLines(season)[id].rushYards).toBe(100)
    bookPlayedGame(season, { round: 1 }, { box: { [id]: { g: 1, rushYards: 50 } }, snaps: 40 })
    expect(votingLines(season)[id].rushYards).toBe(100)
    expect(ledgerOf(season).post[id].rushYards).toBe(50)
  })

  it('a played game goes in the ledger through the ordinary finish', () => {
    const season = fullSeason()
    const game = currentUserGame(season)
    beginGame(season, game.id)
    const id = ROSTER.KC.rb[0].id
    recordUserGame(season, game.id, { us: 21, them: 7, usTds: 3, themTds: 1, box: { box: { [id]: { g: 1, carries: 9, rushYards: 77 } }, snaps: 100 } })
    expect(season.stats.regular[id].rushYards).toBeGreaterThanOrEqual(77)
  })

  it('the year so far is ready for the graphic, keyed as the game keys its players', () => {
    const season = fullSeason()
    for (let i = 0; i < 6; i++) simCurrent(season)
    const totals = totalsForGame(season, ['KC', 'DEN'])
    expect(totals['0:auto_qb']).toEqual(season.stats.regular[ROSTER.KC.qb.id])
    expect(totals['1:auto_qb']).toEqual(season.stats.regular[ROSTER.DEN.qb.id])
    expect(totals[`1:${ROSTER.DEN.wr[0].id}`]).toBeTruthy()
  })
})

describe('[spotlight] a defender only appears for a play he won', () => {
  const rb = { id: 'rb1', slot: 0, label: 'RB' }, wr = { id: 'wr1', slot: 0, label: 'WR' }
  const qb = { id: 'qb1', slot: 0, label: 'QB' }, lb = { id: 'lb1', slot: 1, label: 'LB' }

  it('⚠️ NEVER ON A BIG RUN OR A BIG CATCH, however many times it is rolled', () => {
    const rng = makeRng(9)
    for (let i = 0; i < 5000; i++) {
      const run = chooseSpotlight({ kind: 'run', yards: 30, carrier: rb, tackler: lb }, rng)
      const pass = chooseSpotlight({ kind: 'pass', yards: 30, carrier: wr, passer: qb, tackler: lb }, rng)
      expect(run?.who.id ?? 'rb1').toBe('rb1')
      expect(['wr1', 'qb1']).toContain(pass?.who.id ?? 'wr1')
    }
  })

  it('⚠️ ALWAYS ON AN INTERCEPTION, and it is the man who got it', () => {
    expect(chooseSpotlight({ kind: 'interception', interceptor: lb }, () => 0.999)).toEqual({ who: lb, role: 'interceptor' })
    expect(chooseSpotlight({ kind: 'interception', interceptor: null })).toBeNull()
  })

  it('still on a sack and a tackle for loss', () => {
    expect(chooseSpotlight({ kind: 'sack', sacker: lb }, () => 0.999).role).toBe('sacker')
    expect(chooseSpotlight({ kind: 'run', yards: -2, carrier: rb, tackler: lb }, () => 0).who).toBe(lb)
  })
})

describe('[spotlight] the season graphic', () => {
  const rb = { id: 'kc_rb1', slot: 0, label: 'RB' }

  function gameAt(week, totals = { '0:kc_rb1': { carries: 100, rushYards: 500, rushTD: 4 } }) {
    const state = {
      roomId: 'S', seed: 7, possession: 0, yardLine: 40, stats: createStats(), hadBall: [true, true],
      season: { week, totals },
    }
    recordRush(state.stats, { runner: rb, yards: 12 })
    return state
  }
  const sack = { kind: 'run', yards: 12, carrier: rb }

  function scopes(week, n = 6000) {
    const state = gameAt(week)
    state.seed = 123
    const counts = { game: 0, season: 0, none: 0 }
    const out = []
    for (let i = 0; i < n; i++) {
      state.pendingSpotlight = null
      const p = maybeSpotlight(state, {}, sack)
      if (p) { counts[p.scope]++; out.push(p) } else counts.none++
    }
    return { counts, out }
  }

  it('⚠️ THROUGH WEEK 5 IT IS ALWAYS THE GAME', () => {
    expect(scopes(5).counts.season).toBe(0)
    expect(scopes(1).counts.season).toBe(0)
  })

  it('⚠️ AFTER WEEK 5, ONE GRAPHIC IN FOUR IS THE SEASON', () => {
    const { counts } = scopes(6)
    expect(counts.season / (counts.season + counts.game)).toBeCloseTo(SPOTLIGHT.SEASON_CHANCE, 1)
  })

  it('all through the playoffs, which have no week', () => {
    const { counts } = scopes(null)
    expect(counts.season / (counts.season + counts.game)).toBeCloseTo(SPOTLIGHT.SEASON_CHANCE, 1)
  })

  it('⚠️ THE SEASON LINE INCLUDES TODAY', () => {
    const { out } = scopes(9)
    const shown = out.find(p => p.scope === 'season')
    expect(shown.line.carries).toBe(101)
    expect(shown.line.rushYards).toBe(512)
    expect(shown.line.rushTD).toBe(4)
    const today = out.find(p => p.scope === 'game')
    expect(today.line.rushYards).toBe(12)
  })

  it('never in an ordinary game', () => {
    const state = gameAt(9)
    state.season = undefined
    for (let i = 0; i < 2000; i++) {
      const p = maybeSpotlight(state, {}, sack)
      if (p) expect(p.scope).toBe('game')
    }
  })

  it('a first-year man with nothing on his year yet still gets a graphic', () => {
    const state = gameAt(9, {})
    for (let i = 0; i < 400; i++) {
      const p = maybeSpotlight(state, {}, sack)
      if (p?.scope === 'season') { expect(p.line.rushYards).toBe(12); return }
    }
    throw new Error('never rolled the season')
  })

  it('reaches both screens the same way as any other', () => {
    const state = gameAt(9)
    const sent = []
    const io = { to: () => ({ emit: (e, p) => sent.push({ e, p }) }) }
    while (!state.pendingSpotlight) maybeSpotlight(state, io, sack)
    releaseSpotlight(state, io)
    expect(sent[0].e).toBe('stat_spotlight')
    expect(['game', 'season']).toContain(sent[0].p.scope)
  })

  it('⚠️ THE SEASON BLOCK IS NOT WRITTEN ON EVERY PLAY, and a resume keeps the fresh one', () => {
    const totals = { '0:kc_rb1': { rushYards: 500 } }
    const state = { ...gameAt(9, totals), roomId: 'A', phase: 'dead' }
    const json = snapshotGame(state)
    expect(json).not.toContain('500')
    expect(JSON.parse(json).state.season).toBeUndefined()
    const fresh = { roomId: 'B', season: { week: 9, totals } }
    expect(hydrateGame(fresh, json)).toBe(true)
    expect(fresh.season.totals).toBe(totals)
    expect(fresh.roomId).toBe('B')
  })
})

describe('[awards]', () => {
  const season = throughRegularSeason(fullSeason('KC', 2026))
  const byId = Object.fromEntries(season.awards.map(a => [a.id, a]))

  it('⚠️ EVERY PLAYER AWARD THE NFL GIVES ON THE FIELD, AND NO COACH', () => {
    expect(Object.keys(byId).sort()).toEqual([
      'cpoy', 'deacon_jones', 'dpoy', 'droy', 'fedex_air', 'fedex_ground', 'jim_brown', 'mvp', 'opoy', 'oroy', 'protector',
    ])
    expect(JSON.stringify(season.awards).toLowerCase()).not.toContain('coach')
  })

  it('⚠️ GIVEN BEFORE THE PLAYOFFS START, and they play no part', () => {
    const s = fullSeason('KC', 55)
    let guard = 0
    while (s.phase === 'regular' && guard++ < 25) {
      const g = currentUserGame(s)
      if (!g) { simCurrent(s); continue }
      beginGame(s, g.id)
      recordUserGame(s, g.id, { us: 45, them: 0, usTds: 6 })
    }
    expect(s.phase).toBe('playoffs')
    expect(s.awards).toHaveLength(11)
    expect(s.playoffs.games.every(g => g.status !== 'final')).toBe(true)
    expect(s.stats.post).toEqual({})
    expect(s.screens.map(x => x.type)).toEqual([SCREEN.AWARDS, SCREEN.MADE_PLAYOFFS])
  })

  it('⚠️ MISSING THE PLAYOFFS DOES NOT MISS THE AWARDS', () => {
    const s = fullSeason('KC', 7)
    let guard = 0
    while (s.phase === 'regular' && guard++ < 25) {
      const g = currentUserGame(s)
      if (!g) { simCurrent(s); continue }
      beginGame(s, g.id)
      recordUserGame(s, g.id, { us: 0, them: 45, themTds: 6 })
    }
    expect(s.finish).toBe('missed')
    expect(s.awards.length).toBe(11)
    expect(s.screens.map(x => x.type)).toEqual([SCREEN.AWARDS, SCREEN.MISSED_PLAYOFFS])
  })

  it('⚠️ THE AP BALLOT: 50 WRITERS RANKING FIVE, 10-5-3-2-1', () => {
    for (const id of ['mvp', 'opoy', 'dpoy']) {
      const { finalists, voters } = byId[id]
      expect(voters).toBe(50)
      expect(finalists).toHaveLength(5)
      expect(finalists.reduce((n, f) => n + f.first, 0)).toBeLessThanOrEqual(50)
      expect(finalists[0].points).toBeLessThanOrEqual(500)
      for (let i = 1; i < finalists.length; i++) expect(finalists[i - 1].points).toBeGreaterThanOrEqual(finalists[i].points)
    }
  })

  it('the MVP is a quarterback on a winning team, as it has been since 2012', () => {
    for (const seed of [1, 2, 3, 4, 5, 6]) {
      const s = throughRegularSeason(fullSeason('KC', seed))
      const mvp = s.awards.find(a => a.id === 'mvp').winner
      expect(mvp.pos).toBe('QB')
      expect(recordOf(s, mvp.teamId).w).toBeGreaterThan(8)
    }
  })

  it('the defensive and offensive awards go to that side of the ball', () => {
    expect(['DL', 'LB', 'CB', 'S']).toContain(byId.dpoy.winner.pos)
    expect(['DL', 'LB', 'CB', 'S']).toContain(byId.droy.winner.pos)
    expect(['QB', 'RB', 'WR', 'TE']).toContain(byId.opoy.winner.pos)
    expect(['QB', 'RB', 'WR', 'TE']).toContain(byId.oroy.winner.pos)
    expect(byId.protector.winner.pos).toBe('OL')
    expect(byId.fedex_air.winner.pos).toBe('QB')
    expect(byId.fedex_ground.winner.pos).toBe('RB')
  })

  it('⚠️ ROOKIE OF THE YEAR GOES ONLY TO ROOKIES', () => {
    const { rookies } = careersFor(season.year)
    for (const id of ['oroy', 'droy']) {
      for (const f of byId[id].finalists) expect(rookies.has(f.id)).toBe(true)
    }
  })

  it('⚠️ COMEBACK GOES ONLY TO A VETERAN WHO MISSED MOST OF LAST YEAR, and says so', () => {
    const { rookies, prevGames } = careersFor(season.year)
    for (const f of byId.cpoy.finalists) {
      expect(rookies.has(f.id)).toBe(false)
      expect(prevGames[f.id]).toBeLessThanOrEqual(8)
      expect(f.note).toMatch(/2025/)
    }
  })

  it('⚠️ THE STAT TITLES ARE THE STAT LEADERS, on the real numbers', () => {
    const top = (f) => Math.max(...Object.values(season.stats.regular).map(l => l[f] ?? 0))
    expect(season.stats.regular[byId.deacon_jones.winner.id].sacks).toBe(top('sacks'))
    expect(season.stats.regular[byId.jim_brown.winner.id].rushYards).toBe(top('rushYards'))
  })

  it('a tied stat title is shared', () => {
    const s = fullSeason('KC', 5)
    s.stats = emptyLedger()
    s.stats.regular[ROSTER.KC.dl[0].id] = { sacks: 15 }
    s.stats.regular[ROSTER.DEN.dl[0].id] = { sacks: 15 }
    const award = computeAwards(s).find(a => a.id === 'deacon_jones')
    expect(award.sharedWith).toHaveLength(1)
    expect([award.winner.id, award.sharedWith[0].id].sort()).toEqual([ROSTER.DEN.dl[0].id, ROSTER.KC.dl[0].id].sort())
  })

  it('⚠️ A WINNER\'S CARD SHOWS HIS REAL NUMBERS, NOT THE ADJUSTED ONES VOTERS READ', () => {
    const s = throughRegularSeason(fullSeason('KC', 31))
    const id = ROSTER.KC.qb.id
    // Voters see a huge year; his card must not.
    s.stats.pace[id] = { passYards: 50000, passTD: 300, attempts: 900, completions: 800 }
    s.awards = computeAwards(s)
    const air = s.awards.find(a => a.id === 'fedex_air')
    const his = air.finalists.find(f => f.id === id)
    expect(his.chips.find(c => c.label === 'YDS').value).toBe(Math.round(s.stats.regular[id].passYards))
  })

  it('a card has a record and a seed when there is one', () => {
    expect(byId.mvp.winner.record).toMatch(/^\d+-\d+/)
    expect(byId.mvp.winner.chips.length).toBeGreaterThan(2)
    expect(passerRating({ attempts: 400, completions: 280, passYards: 3600, passTD: 30, interceptionsThrown: 8 })).toBeCloseTo(114.6, 0)
  })

  it('a year the league\'s rookies are not known for leaves those awards out rather than guessing', () => {
    const s = createSeason({ id: 'x', userId: 'u', slot: 0, teamId: 'KC', settings: {}, schedule: { ...schedule2026, year: 2031 }, seed: 9 })
    throughRegularSeason(s)
    const ids = s.awards.map(a => a.id)
    expect(ids).not.toContain('oroy')
    expect(ids).not.toContain('cpoy')
    expect(ids).toContain('mvp')
  })

  it('⚠️ THE SAME SAVE GIVES THE SAME WINNERS', () => {
    const again = throughRegularSeason(fullSeason('KC', 2026))
    expect(again.awards.map(a => a.winner.id)).toEqual(season.awards.map(a => a.winner.id))
  })

  it('every winner is a real player on his real club', () => {
    for (const a of season.awards) {
      expect(PLAYER[a.winner.id].teamId).toBe(a.winner.teamId)
      expect(TEAM[a.winner.teamId]).toBeTruthy()
    }
  })
})

describe('[seasons] a save from before stats and awards', () => {
  it('⚠️ HAS ITS GAMES WRITTEN IN, and is not interrupted by a ceremony it missed', () => {
    const s = throughRegularSeason(fullSeason('KC', 88))
    s.screens = []
    delete s.stats
    delete s.awards
    expect(upgradeSeason(s)).toBe(true)
    expect(s.stats.regular[ROSTER.KC.qb.id].g).toBe(17)
    expect(s.awards).toHaveLength(11)
    expect(s.screens).toEqual([])
    expect(upgradeSeason(s)).toBe(false)     // once
  })

  it('one still in the regular season just gets its stats', () => {
    const s = fullSeason('KC', 89)
    for (let i = 0; i < 4; i++) simCurrent(s)
    delete s.stats
    delete s.awards
    upgradeSeason(s)
    expect(s.stats.regular[ROSTER.KC.qb.id]).toBeTruthy()
    expect(s.awards ?? null).toBeNull()
  })
})
