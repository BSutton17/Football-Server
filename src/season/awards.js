// ── The league's awards ([awards]) ─────────────────────────────────────────
//
// "The game should give out all NFL awards (besides coaching award) before the playoffs start. This
// should be based on all of the stats of the season and use real NFL criteria."
//
// Decided after Week 18 and before a playoff snap, which is when the real ballots are due, so playoff
// games count for nothing. Who gets what is decided the way the real thing is:
//
//   VOTED BY 50 WRITERS  The AP's MVP, Offensive and Defensive Player of the Year, the two Rookies of the
//                        Year, and Comeback Player of the Year. Each writer ranks five players, scored
//                        10-5-3-2-1. Writers do not agree with each other, so each one here reads the same
//                        résumés with a little of his own opinion. That is why a close race can go either way.
//   A PANEL OF SIX       Protector of the Year: former offensive linemen, on skill metrics, impact on team
//                        success and strength of opponent. Leadership and durability have nothing to
//                        measure them in this game, so the panel does not weigh them.
//   THE STAT SHEET       The Deacon Jones Sack Leader Award and the Jim Brown Award (the rushing title). A
//                        tie is shared.
//   THE FANS             The FedEx Air and Ground Players of the Year: three finalists, and a public vote.
//
// What each voter looks at is the history of the award:
//
//   MVP      A quarterback on a winning team, in practice: the last non-quarterback was in 2012 and the last
//            defensive player in 1986, and winners come from the top of the conference.
//   OPOY     Production. Lately a receiver or a back, since a quarterback that good tends to be the MVP.
//   DPOY     Sacks and takeaways on a good defense. Edge rushers usually, a shutdown corner sometimes.
//   Rookies  The same questions, for first-year players only.
//   Comeback A real season after missing most of the last one.
//
// ⚠️ NOT GIVEN: Walter Payton Man of the Year, the Art Rooney Sportsmanship Award, the Bart Starr Award and
// Salute to Service recognize conduct off the field, which no stat in this game can speak to.

import { makeRng } from '../game/utils/rng.js'
import { TEAM, TEAMS } from './teams.js'
import { ROSTER, PLAYER, careersFor } from './rosters.js'
import { passerRating, votingLines, ledgerOf } from './seasonStats.js'
import { buildTable } from './standings.js'

const DEFENSE = new Set(['DL', 'LB', 'CB', 'S'])
const OFFENSE = new Set(['QB', 'RB', 'WR', 'TE'])

const VOTERS = 50
const PANEL = 6
const BALLOT = [10, 5, 3, 2, 1]
const OPINION = 0.1            // how far one writer's view of a résumé strays from the room's
const FINALISTS = 5

function gaussian(rng) {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function hash32(text) {
  let h = 0x811c9dc5
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

// ── What the numbers are worth ───────────────────────────────────────────

const n = (l, field) => l?.[field] ?? 0

export function quarterbackValue(l) {
  const rating = passerRating(l)
  return n(l, 'passYards') / 25 + n(l, 'passTD') * 4 - n(l, 'interceptionsThrown') * 2.5
    + n(l, 'rushYards') / 15 + n(l, 'rushTD') * 4 + Math.max(-30, rating - 92) * 1.6
}

export function scrimmageValue(l) {
  // Catches count for something, or a back's touchdowns would keep every receiver off the ballot.
  return (n(l, 'rushYards') + n(l, 'recYards')) / 10 + (n(l, 'rushTD') + n(l, 'recTD')) * 5 + n(l, 'receptions') * 0.5
}

// Sacks and picks win this award, and a star's reputation is real: a corner nobody throws at has few numbers.
export function defensiveValue(l, player) {
  return n(l, 'sacks') * 6 + n(l, 'interceptions') * 9 + n(l, 'tfl') * 1.5 + n(l, 'passesDefended') * 1.2
    + n(l, 'tackles') * 0.25 + Math.max(0, (player?.ovr ?? 80) - 80) * 2
}

// ── The room ─────────────────────────────────────────────────────────────

function buildContext(season) {
  const table = buildTable(season.games)
  const lines = votingLines(season)
  const careers = careersFor(season.year)
  const seeds = season.playoffs?.seeds ?? null

  const seedOf = (teamId) => {
    const list = seeds?.[TEAM[teamId].conference]
    const at = list ? list.indexOf(teamId) : -1
    return at >= 0 ? at + 1 : null
  }

  const games = (id) => {
    const t = table[id]
    return t.w + t.l + t.t || 1
  }
  const winPct = (id) => {
    const t = table[id]
    return (t.w + t.t / 2) / games(id)
  }

  // Rank 1 is the fewest points allowed in the league.
  const defenseRank = new Map(
    [...TEAMS].sort((a, b) => table[a.id].pa - table[b.id].pa).map((t, i) => [t.id, i + 1]),
  )

  // What a club's line did, from what its backs and its quarterback did.
  const unit = {}
  for (const t of TEAMS) {
    const u = { sacks: 0, carries: 0, rushYards: 0, attempts: 0 }
    for (const p of ROSTER[t.id].all) {
      const l = lines[p.id]
      u.sacks += n(l, 'sacksTaken')
      u.carries += n(l, 'carries')
      u.rushYards += n(l, 'rushYards')
      u.attempts += n(l, 'attempts')
    }
    unit[t.id] = u
  }

  const opponentsPct = (id) => {
    const results = table[id].results
    if (!results.length) return 0.5
    return results.reduce((sum, r) => sum + winPct(r.opp), 0) / results.length
  }

  const players = Object.values(PLAYER)
  return { season, table, lines, careers, seedOf, winPct, games, defenseRank, unit, opponentsPct, players }
}

// ── Ballots ──────────────────────────────────────────────────────────────

function vote(candidates, rng, { voters = VOTERS, opinion = OPINION } = {}) {
  const pool = [...candidates].sort((a, b) => b.score - a.score).slice(0, 14)
  const tally = new Map(pool.map(c => [c.player.id, { ...c, points: 0, first: 0 }]))
  for (let v = 0; v < voters; v++) {
    const ballot = pool
      .map(c => ({ id: c.player.id, seen: c.score * (1 + gaussian(rng) * opinion) }))
      .sort((a, b) => b.seen - a.seen)
    BALLOT.forEach((points, place) => {
      const row = ballot[place] && tally.get(ballot[place].id)
      if (!row) return
      row.points += points
      if (place === 0) row.first++
    })
  }
  return [...tally.values()]
    .sort((a, b) => b.points - a.points || b.first - a.first || b.score - a.score)
}

// ── What a card shows. The real numbers, never the pace-adjusted ones voters read. ──

function chipsFor(player, line, ctx) {
  const l = line ?? {}
  if (player.pos === 'QB') {
    return [
      { value: Math.round(n(l, 'passYards')), label: 'YDS' },
      { value: Math.round(n(l, 'passTD')), label: 'TD' },
      { value: Math.round(n(l, 'interceptionsThrown')), label: 'INT' },
      { value: passerRating(l).toFixed(1), label: 'RTG' },
    ]
  }
  if (player.pos === 'RB') {
    return [
      { value: Math.round(n(l, 'rushYards')), label: 'RUSH' },
      { value: n(l, 'carries') ? (n(l, 'rushYards') / n(l, 'carries')).toFixed(1) : '0.0', label: 'AVG' },
      { value: Math.round(n(l, 'recYards')), label: 'REC' },
      { value: Math.round(n(l, 'rushTD') + n(l, 'recTD')), label: 'TD' },
    ]
  }
  if (player.pos === 'WR' || player.pos === 'TE') {
    return [
      { value: Math.round(n(l, 'receptions')), label: 'REC' },
      { value: Math.round(n(l, 'recYards')), label: 'YDS' },
      { value: Math.round(n(l, 'recTD')), label: 'TD' },
    ]
  }
  if (player.pos === 'OL') {
    const u = ctx.rawUnit(player.teamId)
    return [
      { value: Math.round(u.sacks), label: 'SACKS ALLOWED' },
      { value: u.carries ? (u.rushYards / u.carries).toFixed(1) : '0.0', label: 'YDS/CARRY' },
    ]
  }
  const out = [
    { value: Math.round(n(l, 'sacks')), label: 'SACKS', always: player.pos === 'DL' || player.pos === 'LB' },
    { value: Math.round(n(l, 'interceptions')), label: 'INT', always: player.pos === 'CB' || player.pos === 'S' },
    { value: Math.round(n(l, 'tackles')), label: 'TKL', always: true },
    { value: Math.round(n(l, 'tfl')), label: 'TFL' },
    { value: Math.round(n(l, 'passesDefended')), label: 'PD', always: player.pos === 'CB' },
  ]
  return out.filter(c => c.always || c.value).slice(0, 4).map(({ value, label }) => ({ value, label }))
}

function recordLine(ctx, teamId) {
  const t = ctx.table[teamId]
  const record = `${t.w}-${t.l}${t.t ? `-${t.t}` : ''}`
  const seed = ctx.seedOf(teamId)
  return seed ? `${record} · ${TEAM[teamId].conference} #${seed} seed` : record
}

function card(ctx, player, extra = {}) {
  const line = ctx.rawLines[player.id]
  return {
    id: player.id,
    name: player.name,
    pos: player.pos,
    teamId: player.teamId,
    record: recordLine(ctx, player.teamId),
    chips: chipsFor(player, line, ctx),
    ...extra,
  }
}

// ── The ballots themselves ───────────────────────────────────────────────

function mvpBoard(ctx) {
  const rows = []
  for (const p of ctx.players) {
    if (!OFFENSE.has(p.pos)) continue
    const l = ctx.lines[p.id]
    if (!l) continue
    const pct = ctx.winPct(p.teamId)
    const seed = ctx.seedOf(p.teamId)
    // Winning is most of it: a great season on a losing team has not won this in the modern era.
    const team = 0.42 + pct * 0.95 + (seed === 1 ? 0.1 : seed === 2 ? 0.04 : 0)
    const raw = p.pos === 'QB' ? quarterbackValue(l) : scrimmageValue(l) * 0.72
    if (raw > 0) rows.push({ player: p, score: raw * team })
  }
  return rows
}

// A back's yards come on many more touches than a receiver's. Over the last ten years this award has gone
// about evenly to backs and to receivers, and without this nearly every one goes to a back.
const RB_DISCOUNT = 0.86

function opoyBoard(ctx) {
  const rows = []
  for (const p of ctx.players) {
    if (!OFFENSE.has(p.pos)) continue
    const l = ctx.lines[p.id]
    if (!l) continue
    const raw = p.pos === 'QB' ? quarterbackValue(l) * 0.62 : scrimmageValue(l) * (p.pos === 'RB' ? RB_DISCOUNT : 1)
    if (raw > 0) rows.push({ player: p, score: raw * (0.88 + ctx.winPct(p.teamId) * 0.24) })
  }
  return rows
}

// A defense that stops people lends its stars some of the credit.
function dpoyBoard(ctx, players = ctx.players) {
  const rows = []
  for (const p of players) {
    if (!DEFENSE.has(p.pos)) continue
    const l = ctx.lines[p.id]
    if (!l) continue
    const rank = ctx.defenseRank.get(p.teamId)
    const raw = defensiveValue(l, p) + (rank <= 5 ? 12 : rank <= 10 ? 6 : 0)
    if (raw > 0) rows.push({ player: p, score: raw * (0.9 + ctx.winPct(p.teamId) * 0.2) })
  }
  return rows
}

function rookieBoards(ctx) {
  const rookies = ctx.players.filter(p => ctx.careers.rookies.has(p.id))
  const offense = []
  for (const p of rookies) {
    if (!OFFENSE.has(p.pos)) continue
    const l = ctx.lines[p.id]
    if (!l) continue
    const raw = p.pos === 'QB' ? quarterbackValue(l) : scrimmageValue(l) * (p.pos === 'RB' ? RB_DISCOUNT : 1)
    if (raw > 0) offense.push({ player: p, score: raw })
  }
  return { offense, defense: dpoyBoard(ctx, rookies) }
}

// ⚠️ THE ONE AWARD THAT CANNOT BE WON ON NUMBERS ALONE. It is for coming back from something, so only a
// veteran who missed more than half of last season is on the ballot.
const COMEBACK_MAX_GAMES_LAST_YEAR = 8

function comebackBoard(ctx) {
  const rows = []
  for (const p of ctx.players) {
    if (p.pos === 'OL' || ctx.careers.rookies.has(p.id)) continue
    const games = ctx.careers.prevGames[p.id]
    if (games == null || games > COMEBACK_MAX_GAMES_LAST_YEAR) continue
    const l = ctx.lines[p.id]
    if (!l) continue
    const value = DEFENSE.has(p.pos)
      ? defensiveValue(l, p) * 0.8
      : p.pos === 'QB' ? quarterbackValue(l) * 0.62 : scrimmageValue(l)
    if (value <= 0) continue
    rows.push({
      player: p,
      score: (value + (17 - games) * 2) * (0.85 + ctx.winPct(p.teamId) * 0.3),
      note: games === 0 ? `Did not play in ${ctx.season.year - 1}` : `Played ${games} ${games === 1 ? 'game' : 'games'} in ${ctx.season.year - 1}`,
    })
  }
  return rows
}

// The panel's three things it can measure: how he blocks, what the line did for the team, and against whom.
function protectorBoard(ctx) {
  const leaguePerAttempt = 0.068, leagueYpc = 4.3
  const rows = []
  for (const t of TEAMS) {
    const u = ctx.unit[t.id]
    const sackRate = u.attempts ? u.sacks / u.attempts : leaguePerAttempt
    const ypc = u.carries ? u.rushYards / u.carries : leagueYpc
    const line = (leaguePerAttempt - sackRate) * 600 + (ypc - leagueYpc) * 12
    const team = ctx.winPct(t.id) * 8
    const schedule = (ctx.opponentsPct(t.id) - 0.5) * 30
    for (const p of ROSTER[t.id].ol) {
      const skill = ((p.passBlock ?? p.ovr) * 0.6 + (p.runBlock ?? p.ovr) * 0.4 - 75) * 3.2
      const score = skill + line + team + schedule
      if (score > 0) rows.push({ player: p, score })
    }
  }
  return rows
}

// ── Each kind of award ───────────────────────────────────────────────────

function votedAward(ctx, { id, name, group, board, voters = VOTERS }) {
  const rows = vote(board, makeRng((ctx.season.seed ^ hash32(`award:${id}`)) >>> 0), { voters })
  if (!rows.length) return null
  const finalists = rows.slice(0, FINALISTS).map(r => card(ctx, r.player, {
    points: r.points, first: r.first, ...(r.note ? { note: r.note } : {}),
  }))
  return { id, name, group, voters, winner: finalists[0], finalists }
}

function statTitle(ctx, { id, name, group, field, label }) {
  const rows = ctx.players
    .map(p => ({ p, v: n(ctx.rawLines[p.id], field) }))
    .filter(r => r.v > 0)
    .sort((a, b) => b.v - a.v || (ctx.rawLines[b.p.id]?.g ?? 0) - (ctx.rawLines[a.p.id]?.g ?? 0))
  if (!rows.length) return null
  const best = rows[0].v
  const shared = rows.filter(r => r.v === best).map(r => r.p)
  const winner = card(ctx, shared[0], { note: `Led the NFL with ${Math.round(best).toLocaleString('en-US')} ${label}` })
  return {
    id, name, group, voters: 0, winner,
    sharedWith: shared.slice(1).map(p => card(ctx, p)),
    finalists: rows.slice(0, 3).map(r => card(ctx, r.p, { note: `${Math.round(r.v)} ${label}` })),
  }
}

// Three finalists, and the public chooses. The public likes the better season, but not reliably.
function fanVote(ctx, { id, name, group, board }) {
  const rng = makeRng((ctx.season.seed ^ hash32(`award:${id}`)) >>> 0)
  const top = [...board].sort((a, b) => b.score - a.score).slice(0, 3)
  if (!top.length) return null
  const pulled = top.map(r => ({ ...r, seen: r.score * (1 + gaussian(rng) * 0.08) })).sort((a, b) => b.seen - a.seen)
  const finalists = pulled.map(r => card(ctx, r.player))
  return { id, name, group, voters: 0, fans: true, winner: finalists[0], finalists }
}

// ── The show's running order: the small titles first, the MVP last ───────

export function computeAwards(season) {
  const ctx = buildContext(season)
  const { regular } = ledgerOf(season)
  ctx.rawLines = regular
  ctx.rawUnit = (teamId) => {
    const u = { sacks: 0, carries: 0, rushYards: 0 }
    for (const p of ROSTER[teamId].all) {
      const l = regular[p.id]
      u.sacks += n(l, 'sacksTaken')
      u.carries += n(l, 'carries')
      u.rushYards += n(l, 'rushYards')
    }
    return u
  }

  const qbBoard = ctx.players.filter(p => p.pos === 'QB' && ctx.lines[p.id])
    .map(p => ({ player: p, score: Math.max(1, quarterbackValue(ctx.lines[p.id])) }))
  const rbBoard = ctx.players.filter(p => p.pos === 'RB' && ctx.lines[p.id])
    .map(p => ({ player: p, score: Math.max(1, scrimmageValue(ctx.lines[p.id])) }))
  const rookies = rookieBoards(ctx)

  return [
    statTitle(ctx, { id: 'deacon_jones', name: 'Deacon Jones Sack Leader Award', group: 'Led the NFL in sacks', field: 'sacks', label: 'sacks' }),
    statTitle(ctx, { id: 'jim_brown', name: 'Jim Brown Award', group: 'Led the NFL in rushing', field: 'rushYards', label: 'rushing yards' }),
    fanVote(ctx, { id: 'fedex_air', name: 'FedEx Air Player of the Year', group: 'Voted by the fans', board: qbBoard }),
    fanVote(ctx, { id: 'fedex_ground', name: 'FedEx Ground Player of the Year', group: 'Voted by the fans', board: rbBoard }),
    votedAward(ctx, { id: 'protector', name: 'Protector of the Year', group: 'Chosen by a panel of former linemen', board: protectorBoard(ctx), voters: PANEL }),
    votedAward(ctx, { id: 'droy', name: 'AP Defensive Rookie of the Year', group: 'Voted by the Associated Press', board: rookies.defense }),
    votedAward(ctx, { id: 'oroy', name: 'AP Offensive Rookie of the Year', group: 'Voted by the Associated Press', board: rookies.offense }),
    votedAward(ctx, { id: 'cpoy', name: 'AP Comeback Player of the Year', group: 'Voted by the Associated Press', board: comebackBoard(ctx) }),
    votedAward(ctx, { id: 'dpoy', name: 'AP Defensive Player of the Year', group: 'Voted by the Associated Press', board: dpoyBoard(ctx) }),
    votedAward(ctx, { id: 'opoy', name: 'AP Offensive Player of the Year', group: 'Voted by the Associated Press', board: opoyBoard(ctx) }),
    votedAward(ctx, { id: 'mvp', name: 'AP Most Valuable Player', group: 'Voted by the Associated Press', board: mvpBoard(ctx) }),
  ].filter(Boolean)
}
