// ── Standings and the official NFL tie-breakers ([seasons]) ────────────────
//
// "Use the official NFL rules to determine playoff seeding and a bracket."
//
// This is the league's published procedure, in its order. There are two lists because the league has
// two: one for clubs in the SAME division, one for clubs from different divisions competing for a
// playoff seed.
//
// ⚠️ THE RESTART IS THE PART THAT IS EASY TO GET WRONG. Whenever a step eliminates a club from a tie of
// three or more, the survivors start again from the TOP of the list, not from the next step. And once
// one club comes through, the rest start over among themselves for the next place. `pickBest` is built
// around exactly that.
//
// One deliberate shortcut: the league's final step is a coin toss. Here it is a coin toss from the
// season's seed, so re-opening a finished season shows the same bracket.

import { TEAMS, TEAM, CONFERENCES, DIVISIONS, teamsIn } from './teams.js'

const pct = (r) => {
  const played = r.w + r.l + r.t
  return played ? (r.w + r.t / 2) / played : 0
}

function blank(id) {
  return {
    id, w: 0, l: 0, t: 0, pf: 0, pa: 0, tdFor: 0, tdAgainst: 0,
    div: { w: 0, l: 0, t: 0 }, conf: { w: 0, l: 0, t: 0 },
    results: [],   // one per game: { opp, res: 'W'|'L'|'T', pf, pa, conf, div }
  }
}

// games — regular-season games. Anything not final is ignored, so this also works mid-season.
export function buildTable(games) {
  const table = Object.fromEntries(TEAMS.map(t => [t.id, blank(t.id)]))

  const book = (id, oppId, pf, pa, tdFor, tdAgainst) => {
    const r = table[id]
    const res = pf > pa ? 'W' : pf < pa ? 'L' : 'T'
    const key = res === 'W' ? 'w' : res === 'L' ? 'l' : 't'
    const conf = TEAM[id].conference === TEAM[oppId].conference
    const div = conf && TEAM[id].division === TEAM[oppId].division
    r[key]++
    r.pf += pf; r.pa += pa
    r.tdFor += tdFor; r.tdAgainst += tdAgainst
    if (conf) r.conf[key]++
    if (div) r.div[key]++
    r.results.push({ opp: oppId, res, pf, pa, conf, div })
  }

  for (const g of games) {
    if (g.status !== 'final') continue
    book(g.home, g.away, g.hs, g.as, g.htd ?? 0, g.atd ?? 0)
    book(g.away, g.home, g.as, g.hs, g.atd ?? 0, g.htd ?? 0)
  }
  return table
}

// ── Tie-break measures. Each returns a number; higher is better. ──────────

function record(results) {
  const r = { w: 0, l: 0, t: 0 }
  for (const g of results) r[g.res === 'W' ? 'w' : g.res === 'L' ? 'l' : 't']++
  return r
}

function commonOpponents(group, table) {
  let common = null
  for (const id of group) {
    const opps = new Set(table[id].results.map(g => g.opp))
    common = common ? new Set([...common].filter(o => opps.has(o))) : opps
  }
  return common ?? new Set()
}

function combinedPct(table, opps) {
  const r = { w: 0, l: 0, t: 0 }
  for (const o of opps) { r.w += table[o].w; r.l += table[o].l; r.t += table[o].t }
  return pct(r)
}

// A club's rank in points scored plus its rank in points allowed, within a set of clubs. Lower is
// better, so the measure negates it.
function combinedRank(id, clubs, table) {
  const rank = (key, dir) => {
    const value = table[id][key]
    return 1 + clubs.filter(c => (table[c][key] - value) * dir > 0).length
  }
  return -(rank('pf', 1) + rank('pa', -1))
}

function netPoints(results) {
  return results.reduce((n, g) => n + g.pf - g.pa, 0)
}

// Head-to-head between two clubs in different divisions, or three or more in the same one.
function headToHeadPct(id, group, table) {
  return pct(record(table[id].results.filter(g => g.opp !== id && group.includes(g.opp))))
}

// Clubs from different divisions, three or more: head-to-head only counts if it was a SWEEP. One club
// that beat every other advances; one that lost to every other drops out; otherwise it does nothing.
function sweepScore(id, group, table) {
  const others = group.filter(o => o !== id)
  const games = (o) => table[id].results.filter(g => g.opp === o)
  if (others.every(o => games(o).length && games(o).every(g => g.res === 'W'))) return 1
  if (others.every(o => games(o).length && games(o).every(g => g.res === 'L'))) return -1
  return 0
}

const STEP = {
  headToHead: (id, group, table) => headToHeadPct(id, group, table),
  sweep: (id, group, table) => sweepScore(id, group, table),
  division: (id, _group, table) => pct(table[id].div),
  conference: (id, _group, table) => pct(table[id].conf),
  common: (id, group, table) => {
    const opps = commonOpponents(group, table)
    return pct(record(table[id].results.filter(g => opps.has(g.opp))))
  },
  strengthOfVictory: (id, _group, table) =>
    combinedPct(table, table[id].results.filter(g => g.res === 'W').map(g => g.opp)),
  strengthOfSchedule: (id, _group, table) =>
    combinedPct(table, table[id].results.map(g => g.opp)),
  conferenceRank: (id, _group, table) =>
    combinedRank(id, teamsIn(TEAM[id].conference).map(t => t.id), table),
  leagueRank: (id, _group, table) =>
    combinedRank(id, TEAMS.map(t => t.id), table),
  netCommon: (id, group, table) => {
    const opps = commonOpponents(group, table)
    return netPoints(table[id].results.filter(g => opps.has(g.opp)))
  },
  netConference: (id, _group, table) => netPoints(table[id].results.filter(g => g.conf)),
  netAll: (id, _group, table) => netPoints(table[id].results),
  netTouchdowns: (id, _group, table) => table[id].tdFor - table[id].tdAgainst,
}

// A step only applies when its condition holds. The league requires at least four common games between
// clubs from different divisions, and only compares head-to-head when the clubs actually met.
function stepApplies(name, group, table, kind) {
  if (name === 'common' && kind === 'conference') {
    const opps = commonOpponents(group, table)
    return group.every(id => table[id].results.filter(g => opps.has(g.opp)).length >= 4)
  }
  if (name === 'headToHead') {
    return group.every(id => table[id].results.some(g => group.includes(g.opp)))
  }
  return true
}

const DIVISION_STEPS = [
  'headToHead', 'division', 'common', 'conference', 'strengthOfVictory', 'strengthOfSchedule',
  'conferenceRank', 'leagueRank', 'netCommon', 'netAll', 'netTouchdowns',
]

function conferenceSteps(size) {
  return [
    size === 2 ? 'headToHead' : 'sweep',
    'conference', 'common', 'strengthOfVictory', 'strengthOfSchedule',
    'conferenceRank', 'leagueRank', 'netConference', 'netAll', 'netTouchdowns',
  ]
}

// The single best club of a tied group.
export function pickBest(group, table, kind, rng = Math.random) {
  let tied = [...group]
  for (;;) {
    if (tied.length === 1) return tied[0]
    const steps = kind === 'division' ? DIVISION_STEPS : conferenceSteps(tied.length)
    let eliminated = false
    for (const name of steps) {
      if (!stepApplies(name, tied, table, kind)) continue
      const scored = tied.map(id => [id, STEP[name](id, tied, table)])
      const best = Math.max(...scored.map(([, v]) => v))
      const survivors = scored.filter(([, v]) => Math.abs(v - best) < 1e-9).map(([id]) => id)
      if (survivors.length < tied.length) {
        tied = survivors
        eliminated = true
        break     // ⚠️ back to the top of the list with who is left
      }
    }
    if (!eliminated) return tied[Math.floor(rng() * tied.length)]   // the coin toss
  }
}

// A whole group in order: best record first, ties settled one place at a time.
function order(ids, table, kind, rng) {
  const remaining = [...ids]
  const out = []
  while (remaining.length) {
    const top = Math.max(...remaining.map(id => pct(table[id])))
    const tied = remaining.filter(id => Math.abs(pct(table[id]) - top) < 1e-9)
    const pick = tied.length === 1 ? tied[0] : pickBest(tied, table, kind, rng)
    out.push(pick)
    remaining.splice(remaining.indexOf(pick), 1)
  }
  return out
}

export function divisionOrder(conference, division, table, rng) {
  return order(teamsIn(conference, division).map(t => t.id), table, 'division', rng)
}

// The league's seven: four division winners seeded by record, then three wild cards. Before comparing
// clubs for a wild card, any two from the same division are settled by the division list first, and
// only the higher of them goes forward.
export function conferenceSeeds(conference, table, rng = Math.random) {
  const divisions = Object.fromEntries(DIVISIONS.map(d => [d, divisionOrder(conference, d, table, rng)]))
  const winners = order(DIVISIONS.map(d => divisions[d][0]), table, 'conference', rng)

  const wild = []
  const pool = DIVISIONS.flatMap(d => divisions[d].slice(1))
  while (wild.length < 3 && pool.length) {
    const top = Math.max(...pool.map(id => pct(table[id])))
    const tied = pool.filter(id => Math.abs(pct(table[id]) - top) < 1e-9)
    // The highest-placed tied club from each division.
    const heads = DIVISIONS.flatMap(d => divisions[d].find(id => tied.includes(id)) ?? [])
    const pick = heads.length === 1 ? heads[0] : pickBest(heads, table, 'conference', rng)
    wild.push(pick)
    pool.splice(pool.indexOf(pick), 1)
  }
  return [...winners, ...wild]
}

// What the client shows: every club's line, in division order.
export function standingsView(games, rng = Math.random) {
  const table = buildTable(games)
  const line = (id) => {
    const r = table[id]
    return {
      id, w: r.w, l: r.l, t: r.t, pct: Number(pct(r).toFixed(3)), pf: r.pf, pa: r.pa,
      div: `${r.div.w}-${r.div.l}${r.div.t ? `-${r.div.t}` : ''}`,
      conf: `${r.conf.w}-${r.conf.l}${r.conf.t ? `-${r.conf.t}` : ''}`,
    }
  }
  const out = {}
  for (const conf of CONFERENCES) {
    out[conf] = {}
    for (const div of DIVISIONS) out[conf][div] = divisionOrder(conf, div, table, rng).map(line)
  }
  return out
}
