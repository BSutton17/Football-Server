// ── Season stats ([season stats]) ──────────────────────────────────────────
//
// Every player's numbers for the year, kept on the save: { regular, post, pace }.
//
//   regular   Regular-season totals. What the league's leaders and its awards are about.
//   post      Playoff totals, kept apart for the same reason the league keeps them apart.
//   pace      ⚠️ AWARDS ONLY. A played game is shorter than a simulated one. A five-minute-quarter game
//             has about 97 snaps where an NFL game has about 125, so a player's real numbers would never
//             be compared fairly with the rest of the league. Voters see each played game scaled up to a
//             full game's snaps. The player only ever sees what really happened, which is `regular`.
//
// ⚠️ NOT SENT TO THE CLIENT. It is around a hundred kilobytes, and seasonView picks out what a screen needs.

import { makeRng } from '../game/utils/rng.js'
import { ROSTER, PLAYER, rosterPlayer, gameIdsOf } from './rosters.js'
import { simBoxScore } from './boxScore.js'

export const STAT_FIELDS = [
  'g', 'attempts', 'completions', 'passYards', 'passTD', 'interceptionsThrown', 'sacksTaken',
  'carries', 'rushYards', 'rushTD', 'targets', 'receptions', 'recYards', 'recTD',
  'tackles', 'tfl', 'sacks', 'interceptions', 'passesDefended',
]

const FULL_GAME_SNAPS = 125
const MAX_PACE = 3

export function emptyLedger() {
  return { regular: {}, post: {}, pace: {} }
}

function hash32(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// A player's form for the whole year: the breakout season and the disappointing one. Fixed by the save
// and the player, so a season has its own story and writing a game's line again changes nothing.
const FORM_SPREAD = 0.1
function formFor(seed) {
  const cache = new Map()
  return (id) => {
    let form = cache.get(id)
    if (form == null) {
      const rng = makeRng((seed ^ hash32(`form:${id}`)) >>> 0)
      const u = Math.max(rng(), 1e-9)
      form = Math.exp(Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng()) * FORM_SPREAD)
      cache.set(id, form)
    }
    return form
  }
}

function addLine(into, id, line, scale = 1) {
  let total = into[id]
  if (!total) { total = {}; into[id] = total }
  for (const field of STAT_FIELDS) {
    if (line[field]) total[field] = (total[field] ?? 0) + line[field] * scale
  }
}

export function ledgerOf(season) {
  if (!season.stats) season.stats = emptyLedger()
  return season.stats
}

// The box score for a game nobody played, seeded by the season and the game. Its own stream, so the scores
// a save has already produced are not disturbed by who caught what.
export function simulatedBox(season, game) {
  const rng = makeRng((season.seed ^ hash32(`box:${game.id}`)) >>> 0)
  return simBoxScore(ROSTER[game.home], ROSTER[game.away], {
    homeScore: game.hs, awayScore: game.as, homeTds: game.htd ?? 0, awayTds: game.atd ?? 0,
  }, formFor(season.seed), rng)
}

const bucketOf = (ledger, game) => (game.round != null ? ledger.post : ledger.regular)

export function bookSimulatedGame(season, game) {
  const ledger = ledgerOf(season)
  const box = simulatedBox(season, game)
  for (const [id, line] of Object.entries(box)) addLine(bucketOf(ledger, game), id, line)
}

// The engine's box score for a played game, in roster ids. `stats` is the game's stats.js object as it
// finished, `teams` the club in each slot. Anyone not on a roster is left out rather than guessed at.
export function boxFromEngine(stats, teams) {
  const box = {}
  let snaps = 0
  for (const line of stats?.players?.values?.() ?? []) {
    const teamId = teams[line.slot]
    const player = teamId ? rosterPlayer(teamId, line.id) : null
    if (!player) continue
    const out = { g: 1 }
    for (const field of STAT_FIELDS) if (field !== 'g' && line[field]) out[field] = line[field]
    // Scrimmage plays, for the pace below. A carry and an attempt each cost a snap, and so does a sack.
    snaps += (line.attempts ?? 0) + (line.carries ?? 0) + (line.sacksTaken ?? 0)
    box[player.id] = out
  }
  return { box, snaps }
}

export function bookPlayedGame(season, game, { box, snaps }) {
  const ledger = ledgerOf(season)
  for (const [id, line] of Object.entries(box)) addLine(bucketOf(ledger, game), id, line)
  if (game.round == null && snaps > 0) {
    const extra = Math.min(MAX_PACE, Math.max(1, FULL_GAME_SNAPS / snaps)) - 1
    if (extra > 0) for (const [id, line] of Object.entries(box)) addLine(ledger.pace, id, { ...line, g: 0 }, extra)
  }
}

// A save from before stats existed: its games are written from their final scores. Its played games
// have no plays to count any more, so they are written the same way as the rest.
export function backfillStats(season) {
  if (season.stats) return false
  season.stats = emptyLedger()
  for (const game of [...season.games, ...(season.playoffs?.games ?? [])]) {
    if (game.status === 'final') bookSimulatedGame(season, game)
  }
  return true
}

function sum(a, b) {
  if (!a) return b ?? {}
  if (!b) return a
  const out = { ...a }
  for (const [k, v] of Object.entries(b)) out[k] = (out[k] ?? 0) + v
  return out
}

// A player's whole year so far, playoffs included: what the SEASON graphic adds today's game to.
export function careerSoFar(season, id) {
  const ledger = ledgerOf(season)
  return sum(ledger.regular[id], ledger.post[id])
}

// For a game about to start: each player's year so far, keyed the way the engine's box score keys him.
export function totalsForGame(season, teams) {
  const out = {}
  teams.forEach((teamId, slot) => {
    for (const [rawId, player] of gameIdsOf(teamId)) {
      const line = careerSoFar(season, player.id)
      if (Object.keys(line).length) out[`${slot}:${rawId}`] = line
    }
  })
  return out
}

// What voters read: the regular season, with played games brought up to a full game's snaps.
export function votingLines(season) {
  const ledger = ledgerOf(season)
  const out = {}
  for (const id of new Set([...Object.keys(ledger.regular), ...Object.keys(ledger.pace)])) {
    out[id] = sum(ledger.regular[id], ledger.pace[id])
  }
  return out
}

// ── The league's leaders ─────────────────────────────────────────────────

export function passerRating(l) {
  const att = l?.attempts ?? 0
  if (!att) return 0
  const part = (v) => Math.max(0, Math.min(2.375, v))
  const a = part(((l.completions ?? 0) / att - 0.3) * 5)
  const b = part(((l.passYards ?? 0) / att - 3) * 0.25)
  const c = part(((l.passTD ?? 0) / att) * 20)
  const d = part(2.375 - ((l.interceptionsThrown ?? 0) / att) * 25)
  return ((a + b + c + d) / 6) * 100
}

const LEADER_TABLES = [
  ['passYards', 'Passing yards'], ['passTD', 'Passing TDs'], ['rushYards', 'Rushing yards'], ['rushTD', 'Rushing TDs'],
  ['recYards', 'Receiving yards'], ['receptions', 'Receptions'], ['recTD', 'Receiving TDs'],
  ['sacks', 'Sacks'], ['interceptions', 'Interceptions'], ['tackles', 'Tackles'], ['tfl', 'Tackles for loss'], ['passesDefended', 'Passes defended'],
]
const LEADER_ROWS = 8

export function leadersView(season) {
  const { regular } = ledgerOf(season)
  const entries = Object.entries(regular)
  return LEADER_TABLES.map(([field, label]) => ({
    id: field,
    label,
    rows: entries
      .filter(([, line]) => line[field])
      .sort((a, b) => b[1][field] - a[1][field] || a[0].localeCompare(b[0]))
      .slice(0, LEADER_ROWS)
      .map(([id, line]) => ({ id, name: PLAYER[id]?.name ?? id, teamId: PLAYER[id]?.teamId ?? null, pos: PLAYER[id]?.pos ?? '', value: Math.round(line[field]) })),
  })).filter(t => t.rows.length)
}

// The player's own club, position by position, as far as anyone has done anything.
export function teamStatsView(season, teamId) {
  const { regular } = ledgerOf(season)
  const order = { QB: 0, RB: 1, WR: 2, TE: 3, DL: 4, LB: 5, CB: 6, S: 7, OL: 8 }
  return (ROSTER[teamId]?.all ?? [])
    .filter(p => regular[p.id])
    .map(p => ({ id: p.id, name: p.name, pos: p.pos, line: regular[p.id] }))
    .sort((a, b) => (order[a.pos] ?? 9) - (order[b.pos] ?? 9))
}
