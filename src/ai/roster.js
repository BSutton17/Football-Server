// ── The computer's roster ([offline]) ────────────────────────────────────────
//
// A gap worth being explicit about: the server has no player data. `src/data/teams.js` is 32 ids
// and names, and the full rosters — every player, every rating — live on the CLIENT, in
// `Client/src/data/nflTeams.ts`. That is not an oversight: a human player's phone sends each
// placed player's ratings along with the placement, so the server never needed its own copy.
//
// The AI has no phone. So its roster comes from one of two places:
//
//   SUPPLIED — the client hands the computer's roster over when it creates the solo room. This is
//     the real path. The client already has all 32 rosters, the game is single-player so there is
//     nobody to cheat, and it avoids duplicating 1400 lines of player data into a second repo that
//     would immediately start drifting from the first. (Client and Server are separate repos; the
//     cost of a duplicate here is the same cost that ruled out porting the whole sim.)
//
//   SYNTHETIC — a generated roster with the right POSITIONS and no ratings, used when nobody
//     supplied one (tests, the headless training harness, an older client). The engine's `ratingOf`
//     already falls back to a default for any missing rating, so a synthetic player is an average
//     player rather than a broken one. The AI plays correctly; it just plays with nobodies.
//
// Either way the shape is the same, and it is the shape `selectPlayers` and `buildFormation` read:
//   { id, position, ovr, ratings?, xFactor? }

// What a team carries. Matches the client's pools exactly: the offense picks 5 of its 9 skill
// players and the defense 7 of its 11 coverage players, with the line and quarterback automatic.
export const ROSTER_SHAPE = { WR: 4, TE: 3, RB: 2, CB: 4, S: 3, LB: 4 }

export function syntheticRoster(teamId = 'AI') {
  const prefix = String(teamId).toLowerCase()
  const out = []
  for (const [position, count] of Object.entries(ROSTER_SHAPE)) {
    for (let i = 1; i <= count; i++) {
      out.push({
        id: `${prefix}_${position.toLowerCase()}${i}`,
        position,
        // A gentle gradient so "best available" still means something — the AI picks its starters
        // by overall, and a flat roster would make that choice arbitrary.
        ovr: 80 - (i - 1) * 3,
        name: `${position}${i}`,
      })
    }
  }
  return out
}

// Normalizes whatever the client supplied into the shape the AI reads, dropping anything that does
// not look like a player. A malformed roster falls back to synthetic rather than producing an AI
// that cannot field a team — an opponent with average players is a game, an opponent with no
// players is a bug report.
// ⚠️ FALLING BACK TO SYNTHETIC IS A SILENT, WHOLE-GAME DEGRADATION, SO IT SAYS SO NOW.
//
// A synthetic roster has ids and positions and NOTHING ELSE: no ratings, no X-Factors. The computer
// then plays on generic position baselines for speed, awareness, catching, route running and
// tackling, with the entire X-Factor mechanic missing on its side, against a human using their real
// roster. And it is invisible from the outside, because the generated ids (`sea_cb1`) are identical
// to the real ones, so the opponent still shows as Seattle with Seattle's logo.
//
// It happened for a whole game before anybody noticed, and it was reported as a gameplay complaint --
// "the CBs were getting burned deep and the offense just could not do much" -- rather than as a bug,
// which is exactly what an invisible handicap looks like from the player's chair. One line in the log
// would have found it on the first snap.
function fallToSynthetic(teamId, why) {
  console.warn(`[offline] ⚠️ ${teamId ?? 'the computer'} is fielding a SYNTHETIC roster (${why}) -- ` +
    'no ratings and no X-Factors, position baselines only. The client sends the roster; a solo room ' +
    'without one is a handicapped opponent.')
  return syntheticRoster(teamId)
}

export function normalizeRoster(supplied, teamId) {
  if (!Array.isArray(supplied) || supplied.length === 0) {
    return fallToSynthetic(teamId, supplied == null ? 'none was sent' : 'the one sent was empty')
  }

  const clean = supplied
    .filter(p => p && typeof p.id === 'string' && typeof p.position === 'string')
    .map(p => ({
      id: p.id,
      position: p.position,
      ovr: Number.isFinite(p.ovr) ? p.ovr : 75,
      name: typeof p.name === 'string' ? p.name : p.position,
      ratings: p.ratings && typeof p.ratings === 'object' ? p.ratings : undefined,
      xFactor: typeof p.xFactor === 'string' ? p.xFactor : undefined,
    }))

  // It has to be able to field a legal eleven. Short of that, synthetic.
  const have = {}
  for (const p of clean) have[p.position] = (have[p.position] ?? 0) + 1
  const enough = (have.WR ?? 0) + (have.TE ?? 0) + (have.RB ?? 0) >= 5 &&
    (have.CB ?? 0) + (have.S ?? 0) + (have.LB ?? 0) >= 7
  if (!enough) {
    return fallToSynthetic(teamId,
      `only ${(have.WR ?? 0) + (have.TE ?? 0) + (have.RB ?? 0)} pass catchers and ` +
      `${(have.CB ?? 0) + (have.S ?? 0) + (have.LB ?? 0)} in coverage, from ${supplied.length} sent`)
  }

  // ⚠️ AND A ROSTER WITH NO RATINGS IS NOT A ROSTER, however many names are in it. It would pass the
  // count test above and field eleven men who are all position baselines -- the same degradation as
  // synthetic, arriving through the front door and without the warning.
  const rated = clean.filter(p => p.ratings).length
  if (rated === 0) {
    console.warn(`[offline] ⚠️ ${teamId ?? 'the computer'} was sent ${clean.length} players and NOT ONE ` +
      'has ratings -- it will play on position baselines with no X-Factors.')
  }

  return clean
}
