// ── The league's players ([season stats]) ──────────────────────────────────
//
// Every club's roster as the season engine sees it, generated from the client's by
// scripts/syncSeasonData.mjs. Also the one place that knows how a player's id in a running game maps to
// his id on the roster: the quarterback and the two lines are placed automatically and play under
// ids like `auto_qb` and `auto_ol_lt`, which are identical on both teams.

import { ROSTER_DATA } from './rosterData.js'
import careers2026 from './data/careers2026.js'

const AUTO_OL = ['auto_ol_lt', 'auto_ol_lg', 'auto_ol_c', 'auto_ol_rg', 'auto_ol_rt']
const AUTO_DL = ['auto_dl1', 'auto_dl2', 'auto_dl3', 'auto_dl4']

const byOvr = (a, b) => b.ovr - a.ovr

function buildTeam(teamId, players) {
  const at = (pos) => players.filter(p => p.pos === pos)
  const team = {
    all: players,
    qb: at('QB')[0] ?? null,
    // Best first, because that is who gets the ball. The lines keep their roster order as well, since
    // that order is what the game's automatic ids are assigned from.
    rb: at('RB').sort(byOvr), wr: at('WR').sort(byOvr), te: at('TE').sort(byOvr),
    ol: at('OL'), dl: at('DL'),
    lb: at('LB').sort(byOvr), cb: at('CB').sort(byOvr), s: at('S').sort(byOvr),
    rawToRoster: new Map(),
  }
  for (const p of players) p.teamId = teamId
  for (const p of players) team.rawToRoster.set(p.id, p)
  if (team.qb) team.rawToRoster.set('auto_qb', team.qb)
  team.ol.forEach((p, i) => { if (AUTO_OL[i]) team.rawToRoster.set(AUTO_OL[i], p) })
  team.dl.forEach((p, i) => { if (AUTO_DL[i]) team.rawToRoster.set(AUTO_DL[i], p) })
  return team
}

export const ROSTER = Object.fromEntries(
  Object.entries(ROSTER_DATA).map(([teamId, players]) => [teamId, buildTeam(teamId, players.map(p => ({ ...p })))]),
)

export const PLAYER = Object.fromEntries(
  Object.values(ROSTER).flatMap(team => team.all.map(p => [p.id, p])),
)

// The roster entry behind an id used in a game. Null for anyone who is not on this club's roster.
export function rosterPlayer(teamId, rawId) {
  return ROSTER[teamId]?.rawToRoster.get(rawId) ?? null
}

// Every [id in a game, roster entry] pair for a club.
export function gameIdsOf(teamId) {
  return [...(ROSTER[teamId]?.rawToRoster.entries() ?? [])]
}

// Who is a rookie and who missed time, by season. Only known for years the data was generated for: a
// year's rookies are not next year's, so a stale list is worse than none, and those awards then wait
// for `scripts/syncSeasonData.mjs <year> --careers`.
const CAREERS = { [careers2026.year]: careers2026 }

export function careersFor(year) {
  const data = CAREERS[year]
  return data ? { known: true, rookies: new Set(data.rookies), prevGames: data.prevGames } : { known: false, rookies: new Set(), prevGames: {} }
}
