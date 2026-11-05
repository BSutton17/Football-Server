// ── Simulating a game ([seasons]) ──────────────────────────────────────────
//
// "The game will simulate the season for all of the other games. These should respect who is home and
// who is away."
//
// ⚠️ NOT THE REAL ENGINE. A full computer-vs-computer game takes minutes of real ticks, and a single
// week is sixteen of them on a shared server that is also running everybody's live games. So this is a
// statistical model calibrated to look like NFL results: drives, touchdowns, field goals, an overtime,
// and the upsets that make a season worth following.
//
// How strong a team is comes from the ratings on its card, the offense against the other side's
// defense. Each team also has a good day or a bad day, drawn per game, which is where upsets come
// from: without it the best roster would go 17-0 and the bottom of the league would never win.

// Calibrated by eye against typical NFL figures over 40,000 games: about 24 points a team with a spread
// of 10, a margin spread of 14, the home side winning 54 to 55%, and around 15% of games decided by 21 or
// more. Over a season the best record averages 13 or 14 wins and the worst 3 or 4.
const LEAGUE_POINTS = 23           // an average team against an average defense
const POINTS_PER_RATING = 0.3      // what one point of offense-over-defense rating is worth
const LEAGUE_OFFENSE = 83.7        // where the ratings on the cards actually centre
const LEAGUE_DEFENSE = 81.7
const HOME_POINTS = 1.5            // per team: the league's home edge has been a little over two points
const FORM_SPREAD = 0.12           // how far a team's day can swing its scoring, as a fraction

const TD_SHARE = 0.7               // of a team's points, what comes from touchdowns
const DRIVES_MIN = 10
const DRIVES_EXTRA = 3
const SAFETY_PER_DRIVE = 0.003
const TWO_POINT_SHARE = 0.08       // tries that are two-pointers
const TWO_POINT_MADE = 0.5
const EXTRA_POINT_MADE = 0.95

const OT_TIE_CHANCE = 0.06         // regular-season overtimes that end level
const OT_TD_CHANCE = 0.35          // of those that are decided, the ones won with a touchdown

// A normal draw from the two uniforms the seeded generator gives us.
function gaussian(rng) {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

export function expectedPoints(off, def, { home = false, neutral = false } = {}) {
  const edge = (off.offOvr - LEAGUE_OFFENSE) - (def.defOvr - LEAGUE_DEFENSE)
  return LEAGUE_POINTS + edge * POINTS_PER_RATING + (home && !neutral ? HOME_POINTS : 0)
}

function playOutSide(expected, rng) {
  const form = Math.max(0.2, 1 + gaussian(rng) * FORM_SPREAD)
  const points = expected * form
  const drives = DRIVES_MIN + Math.floor(rng() * (DRIVES_EXTRA + 1))
  const pointsPerDrive = points / drives
  const tdChance = pointsPerDrive * TD_SHARE / 6.95
  const fgChance = pointsPerDrive * (1 - TD_SHARE) / 3

  let score = 0, tds = 0
  for (let i = 0; i < drives; i++) {
    const roll = rng()
    if (roll < tdChance) {
      tds++
      score += 6
      if (rng() < TWO_POINT_SHARE) { if (rng() < TWO_POINT_MADE) score += 2 }
      else if (rng() < EXTRA_POINT_MADE) score += 1
    } else if (roll < tdChance + fgChance) {
      score += 3
    } else if (roll < tdChance + fgChance + SAFETY_PER_DRIVE) {
      score += 2
    }
  }
  return { score, tds }
}

// home / away — entries from TEAM. `playoff` forbids a tie; `neutral` removes the home edge.
export function simGame(home, away, { neutral = false, playoff = false } = {}, rng = Math.random) {
  const h = playOutSide(expectedPoints(home, away, { home: true, neutral }), rng)
  const a = playOutSide(expectedPoints(away, home, { neutral }), rng)
  let overtime = false

  if (h.score === a.score) {
    overtime = true
    if (playoff || rng() >= OT_TIE_CHANCE) {
      // The better side, by expectation, is more likely to win it. Never a certainty.
      const hEdge = expectedPoints(home, away, { home: true, neutral }) - expectedPoints(away, home, { neutral })
      const homeWins = rng() < Math.min(0.8, Math.max(0.2, 0.5 + hEdge * 0.03))
      const winner = homeWins ? h : a
      if (rng() < OT_TD_CHANCE) { winner.score += 6; winner.tds++ } else { winner.score += 3 }
    }
  }

  return { homeScore: h.score, awayScore: a.score, homeTds: h.tds, awayTds: a.tds, overtime }
}
