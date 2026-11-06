import { describe, it, expect } from '@jest/globals'
import { makeRng } from '../game/utils/rng.js'
import { seasonYearFor, superBowlNumeral } from '../season/calendar.js'
import { recordsFrom, strengthOfSchedule, fetchSchedule } from '../season/schedule.js'
import { simGame, expectedPoints } from '../season/simGame.js'
import { buildTable, pickBest, conferenceSeeds, divisionOrder, standingsView } from '../season/standings.js'
import { TEAM, TEAMS, teamsIn } from '../season/teams.js'
import {
  createSeason, currentUserGame, simCurrent, beginGame, recordUserGame, acknowledgeScreen, seasonView,
  recordOf, SCREEN,
} from '../season/season.js'
import schedule2026 from '../season/data/schedule2026.js'

describe('[seasons] the calendar', () => {
  const at = (s) => new Date(s)

  it('⚠️ TURNS OVER ON SEPTEMBER 1ST in the league\'s time zone, not UTC', () => {
    expect(seasonYearFor(at('2027-08-31T12:00:00-04:00'))).toBe(2026)
    expect(seasonYearFor(at('2027-09-01T00:30:00-04:00'))).toBe(2027)
    // Already the 1st in London, still August in New York.
    expect(seasonYearFor(at('2027-09-01T02:00:00Z'))).toBe(2026)
  })

  it('January is still last year\'s season', () => {
    expect(seasonYearFor(at('2027-01-15T12:00:00Z'))).toBe(2026)
    expect(seasonYearFor(at('2026-11-05T12:00:00Z'))).toBe(2026)
  })

  it('names the Super Bowl', () => {
    expect(superBowlNumeral(2026)).toBe('LXI')
    expect(superBowlNumeral(2025)).toBe('LX')
    expect(superBowlNumeral(2028)).toBe('LXIII')
  })
})

describe('[seasons] the schedule', () => {
  it('the bundled schedule is the whole real thing', () => {
    expect(schedule2026.year).toBe(2026)
    expect(schedule2026.games).toHaveLength(272)
    const counts = {}
    for (const g of schedule2026.games) {
      counts[g.home] = (counts[g.home] ?? 0) + 1
      counts[g.away] = (counts[g.away] ?? 0) + 1
      expect(TEAM[g.home]).toBeTruthy()
      expect(TEAM[g.away]).toBeTruthy()
    }
    for (const t of TEAMS) expect(counts[t.id]).toBe(17)
  })

  it('strength of schedule is the league\'s: opponents\' record last year, rank 1 the hardest', () => {
    const games = [{ home: 'BUF', away: 'MIA' }, { home: 'KC', away: 'BUF' }, { home: 'MIA', away: 'NYJ' }]
    const last = { BUF: { w: 12, l: 5, t: 0 }, MIA: { w: 3, l: 14, t: 0 }, KC: { w: 15, l: 2, t: 0 }, NYJ: { w: 5, l: 12, t: 0 } }
    const sos = strengthOfSchedule(games, last)
    expect(sos.BUF).toMatchObject({ w: 18, l: 16 })   // Miami and Kansas City, one game each
    expect(sos.KC.rank).toBe(1)                        // only played 12-5 Buffalo
    expect(sos.NYJ.w).toBe(3)
  })

  it('every club has a strength of schedule in the bundled copy', () => {
    for (const t of TEAMS) expect(schedule2026.sos[t.id]?.rank).toBeGreaterThan(0)
  })

  it('reads a finished season\'s results for the records', () => {
    const r = recordsFrom([
      { home: 'A', away: 'B', homeScore: 20, awayScore: 10, final: true },
      { home: 'B', away: 'A', homeScore: 10, awayScore: 10, final: true },
      { home: 'A', away: 'B', homeScore: 0, awayScore: 0, final: false },
    ])
    expect(r.A).toEqual({ w: 1, l: 0, t: 1 })
    expect(r.B).toEqual({ w: 0, l: 1, t: 1 })
  })

  it('refuses a partial feed rather than building a broken season', async () => {
    const fetcher = async () => ({ ok: true, json: async () => ({ events: [] }) })
    await expect(fetchSchedule(2026, fetcher)).rejects.toThrow(/expected 272/)
  })
})

describe('[seasons] simulating a game', () => {
  it('home field is worth something, and nothing on a neutral field', () => {
    const a = TEAM.KC, b = TEAM.BUF
    expect(expectedPoints(a, b, { home: true })).toBeGreaterThan(expectedPoints(a, b))
    expect(expectedPoints(a, b, { home: true, neutral: true })).toBe(expectedPoints(a, b))
  })

  it('produces scores that look like football', () => {
    const rng = makeRng(99)
    let total = 0, homeWins = 0, ties = 0, blowouts = 0, n = 4000, spreadSq = 0
    for (let i = 0; i < n; i++) {
      const home = TEAMS[Math.floor(rng() * 32)], away = TEAMS[Math.floor(rng() * 32)]
      const g = simGame(home, away, {}, rng)
      total += g.homeScore + g.awayScore
      if (g.homeScore > g.awayScore) homeWins++
      if (g.homeScore === g.awayScore) ties++
      const margin = g.homeScore - g.awayScore
      spreadSq += margin * margin
      if (Math.abs(margin) > 35) blowouts++
    }
    expect(total / n).toBeGreaterThan(38)
    expect(total / n).toBeLessThan(52)              // the NFL's game total is in the mid-forties
    expect(homeWins / n).toBeGreaterThan(0.5)
    expect(homeWins / n).toBeLessThan(0.62)
    expect(ties / n).toBeLessThan(0.02)
    expect(blowouts / n).toBeLessThan(0.05)
    expect(Math.sqrt(spreadSq / n)).toBeGreaterThan(10)   // the NFL's margin spread is around fourteen
    expect(Math.sqrt(spreadSq / n)).toBeLessThan(18)
  })

  it('⚠️ A PLAYOFF GAME NEVER ENDS LEVEL', () => {
    const rng = makeRng(3)
    for (let i = 0; i < 3000; i++) {
      const g = simGame(TEAM.KC, TEAM.BUF, { playoff: true }, rng)
      expect(g.homeScore).not.toBe(g.awayScore)
    }
  })

  it('the better team wins more, and not every time', () => {
    const rng = makeRng(5)
    const best = TEAMS.reduce((a, b) => (b.ovr > a.ovr ? b : a))
    const worst = TEAMS.reduce((a, b) => (b.ovr < a.ovr ? b : a))
    let wins = 0
    for (let i = 0; i < 2000; i++) {
      const g = simGame(best, worst, {}, rng)
      if (g.homeScore > g.awayScore) wins++
    }
    expect(wins / 2000).toBeGreaterThan(0.6)
    expect(wins / 2000).toBeLessThan(0.93)
  })
})

// A results helper: `w` beats `l`.
const game = (w, l, ws = 20, ls = 10) => ({ status: 'final', home: w, away: l, hs: ws, as: ls, htd: 2, atd: 1 })

describe('[seasons] the official tie-breakers', () => {
  it('two clubs in a division: head-to-head first', () => {
    const table = buildTable([game('BUF', 'KC'), game('MIA', 'NYJ'), game('BUF', 'MIA'), game('MIA', 'BUF'), game('MIA', 'NE', 30, 0)])
    // Buffalo and Miami split, so head-to-head cannot settle them; division record is next.
    const pick = pickBest(['BUF', 'MIA'], table, 'division', makeRng(1))
    expect(pick).toBe('MIA')
  })

  it('a clean head-to-head win decides it before anything else', () => {
    const table = buildTable([game('BUF', 'MIA'), game('MIA', 'NE', 50, 0), game('MIA', 'NYJ', 50, 0), game('NE', 'BUF', 50, 0), game('NYJ', 'BUF', 50, 0)])
    expect(pickBest(['BUF', 'MIA'], table, 'division', makeRng(1))).toBe('BUF')
  })

  it('⚠️ THREE CLUBS FROM DIFFERENT DIVISIONS: head-to-head counts only as a SWEEP', () => {
    // KC beat BUF, BUF beat BAL, BAL beat KC: nobody swept. It must fall through to conference record,
    // where BAL is best.
    const games = [game('KC', 'BUF'), game('BUF', 'BAL'), game('BAL', 'KC'), game('BAL', 'NE'), game('BAL', 'MIA')]
    expect(pickBest(['KC', 'BUF', 'BAL'], buildTable(games), 'conference', makeRng(1))).toBe('BAL')
  })

  it('…and a real sweep wins it', () => {
    const games = [game('KC', 'BUF'), game('KC', 'BAL'), game('BAL', 'NE', 50, 0), game('BUF', 'NE', 50, 0), game('NE', 'KC', 50, 0)]
    expect(pickBest(['KC', 'BUF', 'BAL'], buildTable(games), 'conference', makeRng(1))).toBe('KC')
  })

  it('a dead level tie falls to the coin, and the same coin every time', () => {
    const table = buildTable([])
    const a = pickBest(['KC', 'DEN'], table, 'division', makeRng(7))
    const b = pickBest(['KC', 'DEN'], table, 'division', makeRng(7))
    expect(a).toBe(b)
    expect(['KC', 'DEN']).toContain(a)
  })

  it('division order is everyone in the division, once', () => {
    const order = divisionOrder('AFC', 'East', buildTable([game('NE', 'BUF')]), makeRng(1))
    expect(order).toHaveLength(4)
    expect(new Set(order)).toEqual(new Set(['BUF', 'MIA', 'NE', 'NYJ']))
    expect(order[0]).toBe('NE')
  })
})

// A played-through season, all simulated. `pick` chooses the team, or which team to win as.
function fullSeason(teamId = 'KC', seed = 11) {
  const season = createSeason({
    id: 'test', userId: 'u', slot: 0, teamId, schedule: schedule2026, seed,
    settings: { mode: 'automatic', difficulty: 'easy', quarterMinutes: 5 },
  })
  return season
}

describe('[projected] the bracket after Week 8', () => {
  const afterWeeks = (n, seed = 11) => {
    const s = fullSeason('KC', seed)
    for (let i = 0; i < n; i++) expect(simCurrent(s).ok).toBe(true)
    return s
  }

  it('is not there until Week 8 is in', () => {
    expect(seasonView(fullSeason()).projectedPlayoffs).toBeNull()
    expect(seasonView(afterWeeks(7)).projectedPlayoffs).toBeNull()
  })

  it('appears after Week 8, with seven seeds a conference and the league\'s matchups', () => {
    const p = seasonView(afterWeeks(8)).projectedPlayoffs
    expect(p.throughWeek).toBe(8)
    for (const conf of ['AFC', 'NFC']) {
      expect(p.seeds[conf]).toHaveLength(7)
      expect(new Set(p.seeds[conf]).size).toBe(7)
      for (const id of p.seeds[conf]) expect(TEAM[id].conference).toBe(conf)
      const games = p.games.filter(g => g.conf === conf)
      expect(games.map(g => [g.homeSeed, g.awaySeed])).toEqual([[2, 7], [3, 6], [4, 5]])
      for (const g of games) {
        expect(g.home).toBe(p.seeds[conf][g.homeSeed - 1])
        expect(g.away).toBe(p.seeds[conf][g.awaySeed - 1])
      }
      // The top seed is on the bye, in no game.
      expect(games.some(g => g.home === p.seeds[conf][0] || g.away === p.seeds[conf][0])).toBe(false)
    }
  })

  it('the first four are division winners by the current table', () => {
    const s = afterWeeks(10)
    const p = seasonView(s).projectedPlayoffs
    const winners = new Set(p.seeds.AFC.slice(0, 4).map(id => TEAM[id].division))
    expect(winners.size).toBe(4)
  })

  it('reads the same every time it is opened in a week, and moves on as games are played', () => {
    const s = afterWeeks(9)
    const once = seasonView(s).projectedPlayoffs
    expect(seasonView(s).projectedPlayoffs).toEqual(once)
    expect(once.throughWeek).toBe(9)
    expect(seasonView(afterWeeks(10)).projectedPlayoffs.throughWeek).toBe(10)
  })

  it('makes way for the real bracket, and the real one seeds by the same rules', () => {
    const s = afterWeeks(17)
    const last = seasonView(s).projectedPlayoffs
    expect(last.throughWeek).toBe(17)
    expect(simCurrent(s).ok).toBe(true)              // Week 18
    const view = seasonView(s)
    expect(view.playoffs).not.toBeNull()
    expect(view.projectedPlayoffs).toBeNull()
  })
})

function simToEnd(season) {
  let guard = 0
  while (season.phase !== 'complete' && guard++ < 40) expect(simCurrent(season).ok).toBe(true)
  return season
}

describe('[seasons] a whole season', () => {
  it('runs from Week 1 to a Super Bowl champion, 272 games plus 13', () => {
    const s = simToEnd(fullSeason())
    expect(s.phase).toBe('complete')
    expect(s.games.every(g => g.status === 'final')).toBe(true)
    expect(s.playoffs.games).toHaveLength(13)
    expect(s.playoffs.games.every(g => g.status === 'final')).toBe(true)
    expect(TEAM[s.playoffs.champion]).toBeTruthy()
  })

  it('every club plays seventeen games and the wins add up', () => {
    const s = simToEnd(fullSeason())
    const table = buildTable(s.games)
    let w = 0, l = 0
    for (const t of TEAMS) {
      const r = table[t.id]
      expect(r.w + r.l + r.t).toBe(17)
      w += r.w; l += r.l
    }
    expect(w).toBe(l)
  })

  it('records look like the NFL: nobody is 17-0 every year, and somebody is bad', () => {
    let best = 0, worst = 17
    for (let seed = 1; seed <= 12; seed++) {
      const table = buildTable(simToEnd(fullSeason('KC', seed)).games)
      for (const t of TEAMS) { best = Math.max(best, table[t.id].w); worst = Math.min(worst, table[t.id].w) }
    }
    expect(best).toBeGreaterThanOrEqual(12)
    expect(best).toBeLessThan(18)
    expect(worst).toBeLessThanOrEqual(5)
  })

  it('⚠️ SEEDS ARE FOUR DIVISION WINNERS, THEN THREE WILD CARDS', () => {
    const s = simToEnd(fullSeason())
    const table = buildTable(s.games)
    for (const conf of ['AFC', 'NFC']) {
      const seeds = s.playoffs.seeds[conf]
      expect(seeds).toHaveLength(7)
      expect(new Set(seeds).size).toBe(7)
      for (const id of seeds) expect(TEAM[id].conference).toBe(conf)
      // The first four are from four different divisions.
      expect(new Set(seeds.slice(0, 4).map(id => TEAM[id].division)).size).toBe(4)
      // Each division's winner has at least as good a record as everyone below them in it.
      for (const id of seeds.slice(0, 4)) {
        for (const rival of teamsIn(conf, TEAM[id].division)) {
          const pct = (r) => (r.w + r.t / 2) / 17
          expect(pct(table[id])).toBeGreaterThanOrEqual(pct(table[rival.id]))
        }
      }
      expect(conferenceSeeds(conf, table, makeRng(1))).toHaveLength(7)
    }
  })

  it('the bracket is right: 2v7, 3v6, 4v5, the 1 seed rests, the best left hosts the worst left', () => {
    const s = simToEnd(fullSeason())
    for (const conf of ['AFC', 'NFC']) {
      const seeds = s.playoffs.seeds[conf]
      const round = (n) => s.playoffs.games.filter(g => g.round === n && g.conf === conf)

      const wc = round(1)
      expect(wc).toHaveLength(3)
      expect(wc.map(g => [g.homeSeed, g.awaySeed])).toEqual([[2, 7], [3, 6], [4, 5]])
      expect(wc.flatMap(g => [g.home, g.away])).not.toContain(seeds[0])

      const div = round(2)
      expect(div).toHaveLength(2)
      expect(div[0].homeSeed).toBe(1)                     // the 1 seed comes in here
      const seedsLeft = [div[0].homeSeed, div[0].awaySeed, div[1].homeSeed, div[1].awaySeed]
      expect(div[0].awaySeed).toBe(Math.max(...seedsLeft))   // and plays the lowest left
      for (const g of [...wc, ...div]) expect(g.homeSeed).toBeLessThan(g.awaySeed)

      const title = round(3)
      expect(title).toHaveLength(1)
      expect(title[0].homeSeed).toBeLessThan(title[0].awaySeed)
    }
  })

  it('⚠️ THE SUPER BOWL IS NEUTRAL, the AFC designated home in an odd-numbered game', () => {
    const s = simToEnd(fullSeason())
    const sb = s.playoffs.games.find(g => g.round === 4)
    expect(sb.neutral).toBe(true)
    expect(TEAM[sb.home].conference).toBe('AFC')   // LXI is odd
    expect(TEAM[sb.away].conference).toBe('NFC')
  })

  it('home and away follow the real schedule', () => {
    const s = fullSeason()
    const real = schedule2026.games.find(g => g.week === 1)
    const here = s.games.find(g => g.id === real.id)
    expect(here.home).toBe(real.home)
    expect(here.away).toBe(real.away)
  })
})

describe('[seasons] what the player can and cannot do', () => {
  const teamWithBye = 'KC'

  it('a bye week has no game, and simulating moves on', () => {
    const s = fullSeason(teamWithBye)
    let guard = 0
    while (currentUserGame(s) && guard++ < 18) simCurrent(s)
    expect(currentUserGame(s)).toBeNull()
    const week = s.week
    expect(simCurrent(s).ok).toBe(true)
    expect(s.week).toBe(week + 1)
  })

  it('finishing a played game simulates the rest of the week', () => {
    const s = fullSeason()
    const g = currentUserGame(s)
    beginGame(s, g.id)
    recordUserGame(s, g.id, { us: 27, them: 13, usTds: 3, themTds: 1 })
    expect(s.week).toBe(2)
    expect(s.games.filter(x => x.week === 1).every(x => x.status === 'final')).toBe(true)
    const recorded = s.games.find(x => x.id === g.id)
    expect(recorded.by).toBe('user')
    expect(recordOf(s).w).toBe(1)
  })

  it('⚠️ A FINISHED GAME CANNOT BE REPLAYED', () => {
    const s = fullSeason()
    const g = currentUserGame(s)
    beginGame(s, g.id)
    recordUserGame(s, g.id, { us: 3, them: 30 })
    expect(beginGame(s, g.id).error).toBeTruthy()
    expect(recordUserGame(s, g.id, { us: 99, them: 0 }).error).toBeTruthy()
    expect(recordOf(s).l).toBe(1)
  })

  it('⚠️ A GAME IN PROGRESS CANNOT BE SWAPPED FOR A SIMULATED RESULT', () => {
    const s = fullSeason()
    const g = currentUserGame(s)
    beginGame(s, g.id)
    expect(simCurrent(s).error).toBeTruthy()
    expect(s.week).toBe(1)
  })

  it('only the current game may be started', () => {
    const s = fullSeason()
    const later = s.games.find(x => x.week === 5)
    expect(beginGame(s, later.id).error).toBeTruthy()
  })

  it('⚠️ A PLAYOFF GAME THAT SOMEHOW ENDS LEVEL IS REFUSED, not advanced on', () => {
    const s = fullSeason()
    s.phase = 'playoffs'
    s.playoffs = {
      seeds: { AFC: ['KC'], NFC: [] }, round: 1, champion: null, conferenceChampions: {},
      games: [{ id: 'p1-x', round: 1, conf: 'AFC', home: 'KC', away: 'BUF', status: 'scheduled' }],
    }
    s.activeGameId = 'p1-x'
    expect(recordUserGame(s, 'p1-x', { us: 10, them: 10 }).error).toBeTruthy()
  })
})

describe('[seasons] how a season ends', () => {
  // Plays every game as a blowout win, or a blowout loss, to steer the outcome.
  function playAll(season, { winAll }) {
    let guard = 0
    while (season.phase !== 'complete' && guard++ < 40) {
      const g = currentUserGame(season)
      if (!g) { simCurrent(season); continue }
      beginGame(season, g.id)
      recordUserGame(season, g.id, winAll ? { us: 45, them: 0, usTds: 6 } : { us: 0, them: 45, themTds: 6 })
    }
    return season
  }
  const screensOf = (s) => s.screens.map(x => x.type)

  it('⚠️ WINNING OUT: congratulations at each step, then the Lombardi', () => {
    const s = playAll(fullSeason('KC'), { winAll: true })
    expect(s.finish).toBe('champion')
    expect(s.playoffs.champion).toBe('KC')
    expect(screensOf(s)).toEqual([SCREEN.AWARDS, SCREEN.MADE_PLAYOFFS, SCREEN.CONFERENCE_CHAMPION, SCREEN.SUPER_BOWL_CHAMPION])
    expect(s.screens[2].conference).toBe('AFC')
    expect(s.screens[1].seed).toBe(1)
    expect(s.screens[1].bye).toBe(true)
  })

  it('⚠️ LOSING OUT: the season is over, and the playoffs still finish without them', () => {
    const s = playAll(fullSeason('KC'), { winAll: false })
    expect(s.finish).toBe('missed')
    expect(screensOf(s)).toEqual([SCREEN.AWARDS, SCREEN.MISSED_PLAYOFFS])
    expect(s.phase).toBe('complete')
    expect(s.playoffs.champion).not.toBe('KC')
    expect(s.playoffs.champion).toBeTruthy()
  })

  it('⚠️ LOSING IN THE PLAYOFFS ENDS IT: no more games for the player, a champion crowned anyway', () => {
    const s = fullSeason('KC')
    let guard = 0
    while (s.phase === 'regular' && guard++ < 25) {
      const g = currentUserGame(s)
      if (!g) { simCurrent(s); continue }
      beginGame(s, g.id)
      recordUserGame(s, g.id, { us: 45, them: 0 })
    }
    expect(s.phase).toBe('playoffs')
    if (!currentUserGame(s)) simCurrent(s)      // the bye
    const g = currentUserGame(s)
    beginGame(s, g.id)
    recordUserGame(s, g.id, { us: 0, them: 45 })
    expect(s.finish).toBe('eliminated')
    expect(s.phase).toBe('complete')
    expect(s.playoffs.champion).not.toBe('KC')
    expect(s.screens.map(x => x.type)).toEqual([SCREEN.AWARDS, SCREEN.MADE_PLAYOFFS, SCREEN.ELIMINATED])
  })

  it('a screen is cleared once acknowledged', () => {
    const s = playAll(fullSeason('KC'), { winAll: true })
    acknowledgeScreen(s)
    expect(s.screens).toHaveLength(3)
    expect(s.screens[0].type).toBe(SCREEN.MADE_PLAYOFFS)
  })

  it('the view carries what the client draws', () => {
    const s = playAll(fullSeason('KC'), { winAll: true })
    const v = seasonView(s)
    expect(v.superBowl.numeral).toBe('LXI')
    expect(v.standings.AFC.West).toHaveLength(4)
    expect(v.record.w).toBe(17)
    expect(standingsView(s.games, makeRng(1)).NFC.North[0].w).toBeGreaterThan(0)
  })
})
