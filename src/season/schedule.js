// ── The real NFL schedule ([seasons]) ──────────────────────────────────────
//
// "The season mechanic will follow the schedule of the current NFL season." "Respect who is home and
// who is away." "Display the team's strength of schedule (according to the NFL)."
//
// The source is ESPN's public scoreboard feed, the one the ESPN site itself reads. There is no
// official NFL API open to a project like this one, and this one is unofficial too, so nothing depends
// on it being up: the first fetch for a year is stored, and a schedule ships in the repository as a
// floor (data/schedule2026.js).
//
// STRENGTH OF SCHEDULE IS THE NFL'S OWN DEFINITION: the combined record, last season, of every opponent
// on this year's schedule, each game counting once (so a division rival counts twice). Rank 1 is the
// hardest. It is a number about last year's teams, which is why it can look odd against this year's
// rosters; that is how the league publishes it too.

// ESPN's abbreviations, where they differ from ours.
const ESPN_TO_TEAM = { WSH: 'WAS' }
const toTeam = (abbr) => ESPN_TO_TEAM[abbr] ?? abbr

const URL_BASE = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard'
const REGULAR_SEASON_WEEKS = 18

async function fetchWeek(year, week, fetcher) {
  const res = await fetcher(`${URL_BASE}?seasontype=2&week=${week}&dates=${year}`, {
    headers: { accept: 'application/json', 'user-agent': 'E-Football/1.0' },
  })
  if (!res.ok) throw new Error(`ESPN answered ${res.status} for ${year} week ${week}`)
  const body = await res.json()
  return body.events ?? []
}

function normalizeEvent(event, week) {
  const c = event.competitions?.[0]
  const home = c?.competitors?.find(t => t.homeAway === 'home')
  const away = c?.competitors?.find(t => t.homeAway === 'away')
  if (!home || !away) return null
  return {
    id: `w${week}-${toTeam(away.team.abbreviation)}-${toTeam(home.team.abbreviation)}`,
    week,
    home: toTeam(home.team.abbreviation),
    away: toTeam(away.team.abbreviation),
    neutral: !!c.neutralSite,
    date: event.date ?? null,
    // Only meaningful on a finished season, which is what strength of schedule is computed from.
    homeScore: Number(home.score ?? NaN),
    awayScore: Number(away.score ?? NaN),
    final: !!c.status?.type?.completed,
  }
}

async function fetchAllEvents(year, fetcher) {
  const games = []
  for (let week = 1; week <= REGULAR_SEASON_WEEKS; week++) {
    const events = await fetchWeek(year, week, fetcher)
    for (const e of events) {
      const g = normalizeEvent(e, week)
      if (g) games.push(g)
    }
  }
  return games
}

// wins / losses / ties per team from a finished season.
export function recordsFrom(games) {
  const records = {}
  const row = (id) => (records[id] ??= { w: 0, l: 0, t: 0 })
  for (const g of games) {
    if (!g.final || !Number.isFinite(g.homeScore) || !Number.isFinite(g.awayScore)) continue
    const h = row(g.home), a = row(g.away)
    if (g.homeScore > g.awayScore) { h.w++; a.l++ }
    else if (g.homeScore < g.awayScore) { h.l++; a.w++ }
    else { h.t++; a.t++ }
  }
  return records
}

// The NFL's strength of schedule for each team, ranked with 1 the hardest.
export function strengthOfSchedule(games, lastYearRecords) {
  const totals = {}
  const add = (team, opp) => {
    const r = lastYearRecords[opp]
    if (!r) return
    const t = (totals[team] ??= { w: 0, l: 0, t: 0 })
    t.w += r.w; t.l += r.l; t.t += r.t
  }
  for (const g of games) { add(g.home, g.away); add(g.away, g.home) }

  const rows = Object.entries(totals).map(([team, t]) => {
    const played = t.w + t.l + t.t
    return { team, w: t.w, l: t.l, t: t.t, pct: played ? (t.w + t.t / 2) / played : 0 }
  }).sort((a, b) => b.pct - a.pct)

  const out = {}
  rows.forEach((r, i) => {
    // Teams on exactly the same percentage share a rank, as the league lists them.
    const rank = i > 0 && Math.abs(rows[i - 1].pct - r.pct) < 1e-9 ? out[rows[i - 1].team].rank : i + 1
    out[r.team] = { rank, pct: Number(r.pct.toFixed(3)), w: r.w, l: r.l, t: r.t }
  })
  return out
}

export async function fetchSchedule(year, fetcher = globalThis.fetch) {
  const all = await fetchAllEvents(year, fetcher)
  if (all.length < 272) throw new Error(`ESPN returned ${all.length} games for ${year}, expected 272`)

  // Strength of schedule needs last season. A failure there must not cost the schedule itself.
  let sos = {}
  let lastYear = {}
  try {
    lastYear = recordsFrom(await fetchAllEvents(year - 1, fetcher))
    sos = strengthOfSchedule(all, lastYear)
  } catch (err) {
    console.warn(`[season] no strength of schedule for ${year}: ${err.message}`)
  }

  return {
    year,
    sosYear: year - 1,
    fetchedAt: new Date().toISOString(),
    games: all.map(({ id, week, home, away, neutral, date }) => ({ id, week, home, away, neutral, date })),
    sos,
    lastYear,
  }
}
