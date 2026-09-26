// ── Box score ([stats]) ─────────────────────────────────────────────────────
//
// Per-player counting stats and the team totals that fall out of them, kept for the halftime and
// final screens.
//
// ⚠️ EVERY NUMBER IS RECORDED WHERE THE ENGINE ALREADY DECIDED IT. The yardage on a play is
// settled in `onTackle`, the completion in `onPassComplete`, the takeaway in `onInterception` —
// so this module is only ever handed a result that already happened. It never re-derives one.
// A second opinion about how far a run went is a second source of truth, and the two would drift.
//
// ⚠️ IT IS KEYED BY PLAYER ID, NOT BY SLOT. A player is on exactly one team for the whole game, so
// his team is recorded once when he first appears and never consulted again. Possession swaps
// constantly; team membership does not.

// ── What a performance is worth ─────────────────────────────────────────────
//
// The top-three list has to rank a cornerback against a quarterback, so everything is converted to
// one number. These are the familiar fantasy weights, because they are the ones people already
// have intuitions about — a 300-yard passer and a two-interception corner landing near each other
// is the point, not a coincidence.
//
// Defensive work is weighted generously on purpose. A defense that never touches the ball still
// decides games, and a list that can only ever show three skill players would make the feature
// pointless on half the snaps.
export const WEIGHTS = {
  passYards: 0.04,        // a point per 25 yards
  passTD: 4,
  interceptionThrown: -2,
  rushYards: 0.1,         // a point per 10 yards
  rushTD: 6,
  recYards: 0.1,
  recTD: 6,
  reception: 0.5,
  tackle: 1,
  sack: 3,
  interception: 6,
  passDefended: 1,
}

const BLANK = {
  // passing
  attempts: 0, completions: 0, passYards: 0, passTD: 0, interceptionsThrown: 0, sacksTaken: 0,
  // rushing
  carries: 0, rushYards: 0, rushTD: 0,
  // receiving
  targets: 0, receptions: 0, recYards: 0, recTD: 0,
  // defense
  tackles: 0, sacks: 0, interceptions: 0, passesDefended: 0,
}

// ⚠️ EVERY ENTRY POINT TOLERATES A MISSING BOX SCORE. Not every game state is built by initGame —
// tests and special-teams paths construct their own — and a box score is a nicety. It must never
// be the reason a play cannot be run.
export function createStats() {
  return { players: new Map() }
}

// A player's line, created on first sight. `slot` is which team he plays for, recorded once.
//
// ⚠️ `info` IS DESTRUCTURED INSIDE, NOT IN THE SIGNATURE. A default parameter only fills in for
// `undefined`, and callers legitimately pass NULL — there is no passer on a run, no tackler when
// somebody runs out of bounds. Destructuring null in the signature throws.
function lineFor(stats, id, info) {
  if (!stats || !id) return null
  const { slot, name, label } = info ?? {}
  let line = stats.players.get(id)
  if (!line) {
    line = { id, slot, name: name ?? id, label: label ?? '', ...BLANK }
    stats.players.set(id, line)
  }
  // Fill in identity we did not have the first time without ever changing the team.
  if (name && line.name === line.id) line.name = name
  if (label && !line.label) line.label = label
  return line
}

const bump = (line, field, by = 1) => { if (line) line[field] += by }

// ── Recording ───────────────────────────────────────────────────────────────

export function recordAttempt(stats, { passer, target }) {
  if (!stats) return
  bump(lineFor(stats, passer?.id, passer), 'attempts')
  bump(lineFor(stats, target?.id, target), 'targets')
}

// A completion. Yardage is NOT known yet — the play runs on after the catch — so it is credited
// later, when the tackle settles it.
export function recordCompletion(stats, { passer, receiver }) {
  if (!stats) return
  bump(lineFor(stats, passer?.id, passer), 'completions')
  bump(lineFor(stats, receiver?.id, receiver), 'receptions')
}

// ⚠️ PASSING YARDS INCLUDE YARDS AFTER THE CATCH, which is how football counts them: the passer
// and the receiver are both credited the whole gain from the line of scrimmage, not the distance
// the ball travelled in the air.
export function recordPassYards(stats, { passer, receiver, yards }) {
  if (!stats) return
  bump(lineFor(stats, passer?.id, passer), 'passYards', yards)
  bump(lineFor(stats, receiver?.id, receiver), 'recYards', yards)
}

export function recordRush(stats, { runner, yards }) {
  if (!stats) return
  const line = lineFor(stats, runner?.id, runner)
  bump(line, 'carries')
  bump(line, 'rushYards', yards)
}

export function recordTackle(stats, { tackler }) {
  if (!stats) return
  bump(lineFor(stats, tackler?.id, tackler), 'tackles')
}

// ⚠️ A SACK IS NOT A PASS ATTEMPT — that is the real rule, and it matters here because the
// attempt was already counted when the throw was declared. A sack happens instead of a throw, so
// nothing to undo; the lost yards go against the team's passing total, not the passer's line.
export function recordSack(stats, { defender, passer, yards }) {
  if (!stats) return
  bump(lineFor(stats, defender?.id, defender), 'sacks')
  const line = lineFor(stats, passer?.id, passer)
  bump(line, 'sacksTaken')
  bump(line, 'passYards', yards)   // negative
}

export function recordInterception(stats, { defender, passer }) {
  if (!stats) return
  bump(lineFor(stats, defender?.id, defender), 'interceptions')
  bump(lineFor(stats, passer?.id, passer), 'interceptionsThrown')
}

export function recordPassDefended(stats, { defender }) {
  if (!stats) return
  bump(lineFor(stats, defender?.id, defender), 'passesDefended')
}

// A touchdown, credited by HOW the scorer got the ball rather than by his position — a receiver
// who took a handoff scored a rushing touchdown.
export function recordTouchdown(stats, { scorer, passer, viaPass }) {
  if (!stats) return
  const line = lineFor(stats, scorer?.id, scorer)
  if (viaPass) {
    bump(line, 'recTD')
    bump(lineFor(stats, passer?.id, passer), 'passTD')
  } else {
    bump(line, 'rushTD')
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

export function impactScore(line) {
  if (!line) return 0
  return (
    line.passYards * WEIGHTS.passYards
    + line.passTD * WEIGHTS.passTD
    + line.interceptionsThrown * WEIGHTS.interceptionThrown
    + line.rushYards * WEIGHTS.rushYards
    + line.rushTD * WEIGHTS.rushTD
    + line.recYards * WEIGHTS.recYards
    + line.recTD * WEIGHTS.recTD
    + line.receptions * WEIGHTS.reception
    + line.tackles * WEIGHTS.tackle
    + line.sacks * WEIGHTS.sack
    + line.interceptions * WEIGHTS.interception
    + line.passesDefended * WEIGHTS.passDefended
  )
}

// The one-line summary a screen shows under a name. Built from what he actually did, so a corner
// does not get a row of zeroes where his yards would be.
export function statLine(line) {
  const parts = []
  if (line.attempts) parts.push(`${line.completions}/${line.attempts}, ${line.passYards} yds`)
  if (line.passTD) parts.push(`${line.passTD} TD`)
  if (line.interceptionsThrown) parts.push(`${line.interceptionsThrown} INT`)
  if (line.carries) parts.push(`${line.carries} car, ${line.rushYards} yds`)
  if (line.rushTD) parts.push(`${line.rushTD} TD`)
  if (line.receptions) parts.push(`${line.receptions} rec, ${line.recYards} yds`)
  if (line.recTD) parts.push(`${line.recTD} TD`)
  if (line.tackles) parts.push(`${line.tackles} tkl`)
  if (line.sacks) parts.push(`${line.sacks} sack${line.sacks > 1 ? 's' : ''}`)
  if (line.interceptions) parts.push(`${line.interceptions} INT`)
  if (line.passesDefended) parts.push(`${line.passesDefended} PD`)
  return parts.join(' · ')
}

// ⚠️ ONLY PLAYERS WHO DID SOMETHING. Everyone on the field has a line the moment he is seen, and a
// list padded with three players who recorded nothing is worse than a short list.
// The best players by impact. With `slot`, only that team's — which is what the halftime screen
// shows, so each side gets its own three rather than both being drawn from whoever had the
// better half.
export function topPerformers(stats, n = 3, slot = null) {
  if (!stats) return []
  return [...stats.players.values()]
    .filter(line => slot == null || line.slot === slot)
    .map(line => ({ ...line, score: impactScore(line), summary: statLine(line) }))
    .filter(p => p.score > 0 && p.summary)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, n)
}

export function teamTotals(stats, slot) {
  if (!stats) return { passYards: 0, rushYards: 0, totalOffense: 0, takeaways: 0 }
  let passYards = 0, rushYards = 0, takeaways = 0
  for (const line of stats.players.values()) {
    if (line.slot !== slot) continue
    // ⚠️ SUM THE PASSER, NOT THE RECEIVER. Both are credited the same yards — that is how football
    // counts them — so adding recYards here would double every completion.
    passYards += line.passYards
    rushYards += line.rushYards
    // A takeaway is credited to the team that TOOK it, which is the team its defender plays for.
    takeaways += line.interceptions
  }
  return { passYards, rushYards, totalOffense: passYards + rushYards, takeaways }
}

export function serializeStats(stats, { top = 3 } = {}) {
  return {
    top: topPerformers(stats, top),
    // ⚠️ PER TEAM AS WELL AS OVERALL. A single ranked three is usually three players from
    // whichever side had the better half, so the other team's best game goes unmentioned. The
    // halftime screen wants each team's own top three; `top` stays for anything that wants the
    // outright leaders.
    byTeam: [topPerformers(stats, top, 0), topPerformers(stats, top, 1)],
    teams: [teamTotals(stats, 0), teamTotals(stats, 1)],
  }
}
