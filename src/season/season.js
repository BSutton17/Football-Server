// ── A season ([seasons]) ───────────────────────────────────────────────────
//
// The whole season as plain data and pure functions, with no database and no sockets, so every rule
// here can be tested by playing a season in a loop. It is what `seasons` stores and what the API sends.
//
//   regular    Weeks 1 to 18 of the real schedule. Each week the player plays or sims their game (or has
//              a bye), and when that is done the rest of the week is simulated.
//   playoffs   Four rounds, the official bracket. The player plays or sims their game each round; the
//              other games of the round simulate after it.
//   complete   Nothing left to play. There is one season per save, by design: "they will have to start
//              a new season to play again."
//
// ⚠️ A SIMULATED GAME IS SEEDED FROM THE SEASON AND THE GAME'S ID, not from a running generator. There is
// no counter to save or to get out of step, and re-running a week after a crash lands on the same scores.

import { makeRng } from '../game/utils/rng.js'
import { TEAM } from './teams.js'
import { simGame } from './simGame.js'
import { buildTable, conferenceSeeds, standingsView } from './standings.js'
import { superBowlNumber, superBowlNumeral } from './calendar.js'

export const LAST_REGULAR_WEEK = 18
export const SCREEN = {
  MADE_PLAYOFFS: 'made_playoffs',
  MISSED_PLAYOFFS: 'missed_playoffs',
  ELIMINATED: 'eliminated',
  CONFERENCE_CHAMPION: 'conference_champion',
  SUPER_BOWL_CHAMPION: 'super_bowl_champion',
}
const ROUND_NAMES = { 1: 'Wild Card', 2: 'Divisional', 3: 'Conference Championship', 4: 'Super Bowl' }

function hash32(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const gameRng = (season, id) => makeRng((season.seed ^ hash32(id)) >>> 0)

export function createSeason({ id, userId, slot, teamId, settings, schedule, seed, now = new Date() }) {
  return {
    _id: id,
    userId,
    slot,
    year: schedule.year,
    teamId,
    settings,
    seed,
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
    phase: 'regular',
    week: 1,
    games: schedule.games.map(g => ({ ...g, status: 'scheduled' })),
    playoffs: null,
    // How the player's season ended, once it has: null | 'missed' | 'eliminated' | 'champion'.
    finish: null,
    // Screens the player has yet to see, oldest first. Kept on the save so a crash cannot skip one.
    screens: [],
    // The game they have started and not finished. It can be resumed, never simulated or replayed.
    activeGameId: null,
  }
}

const allGames = (s) => (s.playoffs ? [...s.games, ...s.playoffs.games] : s.games)

export function findGame(season, gameId) {
  return allGames(season).find(g => g.id === gameId) ?? null
}

// The player's game for the current week or round. Null means a bye, or that the season is over.
export function currentUserGame(season) {
  const { teamId } = season
  if (season.phase === 'regular') {
    return season.games.find(g => g.week === season.week && (g.home === teamId || g.away === teamId)) ?? null
  }
  if (season.phase === 'playoffs') {
    return season.playoffs.games.find(g => g.round === season.playoffs.round && (g.home === teamId || g.away === teamId)) ?? null
  }
  return null
}

function finalize(game, { homeScore, awayScore, homeTds, awayTds, overtime }, by) {
  game.status = 'final'
  game.hs = homeScore
  game.as = awayScore
  game.htd = homeTds ?? 0
  game.atd = awayTds ?? 0
  game.ot = !!overtime
  game.by = by
}

function simulate(season, game) {
  const result = simGame(
    TEAM[game.home], TEAM[game.away],
    { neutral: !!game.neutral, playoff: game.round != null },
    gameRng(season, game.id),
  )
  finalize(game, result, 'sim')
}

// ── Moving the season on ─────────────────────────────────────────────────

function finishPeriod(season) {
  if (season.phase === 'regular') {
    for (const g of season.games) if (g.week === season.week && g.status !== 'final') simulate(season, g)
    if (season.week < LAST_REGULAR_WEEK) {
      season.week++
      return
    }
    beginPlayoffs(season)
    return
  }
  if (season.phase === 'playoffs') {
    const { round } = season.playoffs
    for (const g of season.playoffs.games) if (g.round === round && g.status !== 'final') simulate(season, g)
    afterRound(season)
  }
}

const winnerOf = (g) => (g.hs > g.as ? g.home : g.away)
const loserOf = (g) => (g.hs > g.as ? g.away : g.home)

function seedOf(season, teamId) {
  const conf = TEAM[teamId].conference
  return season.playoffs.seeds[conf].indexOf(teamId) + 1
}

function playoffGame(season, round, conf, home, away, opts = {}) {
  return {
    id: `p${round}-${away}-${home}`,
    round, conf, home, away,
    homeSeed: conf ? seedOf(season, home) : null,
    awaySeed: conf ? seedOf(season, away) : null,
    neutral: !!opts.neutral,
    status: 'scheduled',
  }
}

function beginPlayoffs(season) {
  const table = buildTable(season.games)
  const tieRng = gameRng(season, 'seeding')
  const seeds = { AFC: conferenceSeeds('AFC', table, tieRng), NFC: conferenceSeeds('NFC', table, tieRng) }
  season.playoffs = { seeds, round: 1, games: [], champion: null, conferenceChampions: {} }
  season.phase = 'playoffs'

  // #1 has the week off. Then 2 v 7, 3 v 6, 4 v 5, the higher seed at home.
  for (const conf of ['AFC', 'NFC']) {
    for (const [hi, lo] of [[2, 7], [3, 6], [4, 5]]) {
      season.playoffs.games.push(playoffGame(season, 1, conf, seeds[conf][hi - 1], seeds[conf][lo - 1]))
    }
  }

  if (![...seeds.AFC, ...seeds.NFC].includes(season.teamId)) {
    season.finish = 'missed'
    season.screens.push({ type: SCREEN.MISSED_PLAYOFFS })
    runOutPlayoffs(season)
    return
  }
  season.screens.push({
    type: SCREEN.MADE_PLAYOFFS,
    seed: seedOf(season, season.teamId),
    bye: seedOf(season, season.teamId) === 1,
  })
}

function runOutPlayoffs(season) {
  while (season.phase === 'playoffs') finishPeriod(season)
}

function survivors(season, conf, round) {
  const games = season.playoffs.games.filter(g => g.round === round && g.conf === conf)
  return games.map(winnerOf)
}

function afterRound(season) {
  const p = season.playoffs
  const { round } = p
  const { teamId } = season
  const roundGames = p.games.filter(g => g.round === round)
  const userGame = roundGames.find(g => g.home === teamId || g.away === teamId)
  const stillPlaying = season.finish == null

  if (userGame && stillPlaying && loserOf(userGame) === teamId) {
    season.finish = 'eliminated'
    season.screens.push({
      type: SCREEN.ELIMINATED,
      round: ROUND_NAMES[round],
      by: winnerOf(userGame),
    })
  }

  if (round === 4) {
    const game = roundGames[0]
    p.champion = winnerOf(game)
    if (p.champion === teamId) {
      season.finish = 'champion'
      season.screens.push({ type: SCREEN.SUPER_BOWL_CHAMPION })
    }
    season.phase = 'complete'
    return
  }

  if (round === 3) {
    for (const g of roundGames) {
      const champ = winnerOf(g)
      p.conferenceChampions[g.conf] = champ
      if (champ === teamId) season.screens.push({ type: SCREEN.CONFERENCE_CHAMPION, conference: g.conf })
    }
    // The Super Bowl is at a neutral site with no home field. One club is still DESIGNATED home for the
    // uniforms, by the league's rotation: the AFC in odd-numbered games, the NFC in even.
    const afc = p.conferenceChampions.AFC
    const nfc = p.conferenceChampions.NFC
    const afcHome = superBowlNumber(season.year) % 2 === 1
    p.games.push(playoffGame(season, 4, null, afcHome ? afc : nfc, afcHome ? nfc : afc, { neutral: true }))
    p.round = 4
    if (season.finish == null || season.finish === 'missed' || season.finish === 'eliminated') maybeRunOut(season)
    return
  }

  // The bracket RE-SEEDS each round: the best seed left hosts the worst seed left.
  for (const conf of ['AFC', 'NFC']) {
    const alive = survivors(season, conf, round)
    if (round === 1) alive.push(p.seeds[conf][0])
    alive.sort((a, b) => p.seeds[conf].indexOf(a) - p.seeds[conf].indexOf(b))
    if (round === 1) {
      p.games.push(playoffGame(season, 2, conf, alive[0], alive[3]))
      p.games.push(playoffGame(season, 2, conf, alive[1], alive[2]))
    } else {
      p.games.push(playoffGame(season, 3, conf, alive[0], alive[1]))
    }
  }
  p.round = round + 1
  maybeRunOut(season)
}

// Out of it: nothing more to play, so the rest of the bracket plays itself to a champion.
function maybeRunOut(season) {
  if (season.finish === 'eliminated' || season.finish === 'missed') runOutPlayoffs(season)
}

// ── What the player does ─────────────────────────────────────────────────

// Simulate the player's own game, or a bye. Refused while a started game is unfinished: "once a game
// is over there is no way to replay it", and a game begun is resumed, not swapped for a better result.
export function simCurrent(season) {
  if (season.phase === 'complete') return { error: 'The season is over.' }
  if (season.activeGameId) return { error: 'Finish the game in progress first.' }
  const game = currentUserGame(season)
  if (game && game.status !== 'final') simulate(season, game)
  finishPeriod(season)
  return { ok: true }
}

// Marks a game as begun. Only the player's current game, and only once.
export function beginGame(season, gameId) {
  const game = currentUserGame(season)
  if (!game || game.id !== gameId) return { error: 'That is not your next game.' }
  if (game.status === 'final') return { error: 'That game has been played.' }
  if (season.activeGameId && season.activeGameId !== gameId) return { error: 'Another game is in progress.' }
  season.activeGameId = gameId
  return { game }
}

// A played game has finished. `us` and `them` are the player's and the opponent's points.
export function recordUserGame(season, gameId, { us, them, usTds = 0, themTds = 0, overtime = false }) {
  const game = findGame(season, gameId)
  if (!game) return { error: 'Unknown game.' }
  if (game.status === 'final') return { error: 'That game has already been recorded.' }
  if (season.activeGameId !== gameId) return { error: 'That game was not in progress.' }
  // ⚠️ A PLAYOFF GAME CANNOT END LEVEL. The engine plays overtime until it does not, so reaching here
  // with a tie means something is wrong, and advancing a team off a tie would invent a result.
  if (game.round != null && us === them) return { error: 'A playoff game cannot end in a tie.' }

  const isHome = game.home === season.teamId
  finalize(game, {
    homeScore: isHome ? us : them,
    awayScore: isHome ? them : us,
    homeTds: isHome ? usTds : themTds,
    awayTds: isHome ? themTds : usTds,
    overtime,
  }, 'user')
  season.activeGameId = null
  finishPeriod(season)
  return { ok: true }
}

export function acknowledgeScreen(season) {
  season.screens.shift()
}

// ── What the screens need ────────────────────────────────────────────────

export function recordOf(season, teamId = season.teamId) {
  const table = buildTable(season.games)
  const r = table[teamId]
  return { w: r.w, l: r.l, t: r.t }
}

export function playoffRecordOf(season, teamId = season.teamId) {
  let w = 0, l = 0
  for (const g of season.playoffs?.games ?? []) {
    if (g.status !== 'final' || (g.home !== teamId && g.away !== teamId)) continue
    if (winnerOf(g) === teamId) w++; else l++
  }
  return { w, l }
}

export function seasonSummary(season) {
  const record = recordOf(season)
  const game = currentUserGame(season)
  return {
    id: season._id,
    slot: season.slot,
    year: season.year,
    teamId: season.teamId,
    settings: season.settings,
    phase: season.phase,
    week: season.week,
    round: season.playoffs?.round ?? null,
    record,
    finish: season.finish,
    activeGameId: season.activeGameId,
    updatedAt: season.updatedAt,
    nextOpponent: game ? (game.home === season.teamId ? game.away : game.home) : null,
    champion: season.playoffs?.champion ?? null,
  }
}

export function seasonView(season) {
  const game = currentUserGame(season)
  return {
    ...seasonSummary(season),
    games: season.games,
    playoffs: season.playoffs,
    screens: season.screens,
    currentGame: game,
    roundName: season.playoffs ? ROUND_NAMES[season.playoffs.round] : null,
    standings: standingsView(season.games, gameRng(season, 'standings')),
    superBowl: { number: superBowlNumber(season.year), numeral: superBowlNumeral(season.year) },
  }
}
