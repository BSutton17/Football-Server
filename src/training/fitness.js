// ── Fitness ([training]) ─────────────────────────────────────────────────────
//
// What a genome is scored on. Defence-first, as agreed: the network calls the coverage, the
// scripted offense is the fixed opponent, and the score is how much better than PAR the defense
// did — par being what the heuristic allowed in the same situation (see baseline.js).
//
// Scoring against par rather than against raw yardage is the whole design. Raw yards allowed would
// reward a genome for drawing easy situations: third-and-fifteen from the opponent's own 3 allows
// fewer yards than first-and-ten at midfield no matter who is calling it. Par cancels that out, so
// what is left is the decision.
//
// ⚠️ GUARDS, and each one exists because the obvious version of this is exploitable:
//
//   • A play the harness could not run scores ZERO, not par. Otherwise a genome that reliably
//     breaks the game — an illegal formation the server refuses — collects an average score for
//     doing nothing, and "break the harness" becomes a viable strategy.
//   • Turnovers are rewarded, but capped, so a genome cannot farm interceptions by playing a
//     coverage that concedes everything underneath in exchange for the occasional pick.
//   • The result is CLAMPED. One freak 80-yard play should not swamp thirty-nine sound decisions.

export const FITNESS_VERSION = 'v1'

// Yards better than par, clamped to this, so a single outlier cannot dominate a slate.
const YARDS_CLAMP = 15

// A turnover is worth about this many yards. Roughly the real value of a possession change; high
// enough to be worth chasing, low enough that it cannot become the only thing worth doing.
const TURNOVER_BONUS = 12
const TURNOVER_CAP = 0.35        // …and no more than this share of the total can come from them

// A touchdown allowed is worth more than the yards on the play — it ends the drive at the worst
// possible price, and a coverage that concedes them is worse than its yardage suggests.
const TOUCHDOWN_PENALTY = 10

// A sack is a defensive win the yardage already partly captures; a small extra so pressure is not
// invisible.
const SACK_BONUS = 3

// Scores ONE play from the defense's point of view. Positive is good defense.
// `side` flips the whole scale. Everything below is written from the DEFENSE's point of view —
// fewer yards than par is good, a turnover is good, a touchdown allowed is bad — and the offense
// wants precisely the opposite of each. One sign, applied once, rather than a second scoring
// function that could drift out of step with this one.
export function scorePlay(play, par = 0, { side = 'defense' } = {}) {
  if (!play.ok) return { score: 0, reason: play.problems[0] ?? 'play did not run', invalid: true }
  const sign = side === 'offense' ? -1 : 1

  // Yards BETTER than par. The defense wants fewer yards than expected, so the sign flips.
  const yardsVsPar = clamp(sign * (par - play.yards), -YARDS_CLAMP, YARDS_CLAMP)

  let turnover = sign * (play.turnover ? TURNOVER_BONUS : 0)
  const touchdown = sign * (play.outcome === 'touchdown' ? -TOUCHDOWN_PENALTY : 0)
  const sack = sign * (play.sacked ? SACK_BONUS : 0)

  // Cap the share that can come from turnovers.
  const other = Math.abs(yardsVsPar) + Math.abs(touchdown) + Math.abs(sack)
  if (turnover > 0 && other > 0) {
    turnover = Math.min(turnover, (other / (1 - TURNOVER_CAP)) * TURNOVER_CAP)
  }

  return {
    score: yardsVsPar + turnover + touchdown + sack,
    terms: { yardsVsPar, turnover, touchdown, sack },
    invalid: false,
  }
}

// Scores a whole slate. Returns a fitness that is always ≥ 0, because NEAT's fitness sharing
// divides by species size and negative fitness makes that arithmetic meaningless.
export function scoreSlate(plays, expected = {}, { side = 'defense' } = {}) {
  // ⚠️ PAR HAS TO ACTUALLY BIND, AND FOR 250 GENERATIONS IT DID NOT.
  //
  // Situation ids are `g{generation}-s{i}` and the slate ROTATES by generation, but par was always
  // measured on generation 0. So `expected[p.situationId]` missed on every lookup and the `?? 0`
  // below quietly supplied a par of zero for every play in the run. Nothing failed, nothing logged,
  // and every score in the run was raw yards allowed — the exact thing the header of this file
  // says the design exists to avoid.
  //
  // Worse, it inverted the harness-breaking guard. With par at zero a valid play conceding yards
  // scores NEGATIVE while a play the harness could not run scores exactly 0, so failing to produce
  // a runnable play became strictly better than defending well. (The champion happened not to find
  // that, which was luck, not design.)
  //
  // A silent default is what made this invisible, so a total miss is now a hard error. A partial
  // miss is legal — a caller may score a subset — but a complete one means the two sides were
  // measured on different slates and every number that follows is meaningless.
  const parKeys = Object.keys(expected)
  if (parKeys.length > 0 && plays.length > 0) {
    const matched = plays.filter(p => expected[p.situationId] !== undefined).length
    if (matched === 0) {
      throw new Error(
        `par does not match this slate: ${plays.length} plays, ${parKeys.length} par entries, 0 overlap. ` +
        `Play ids look like "${plays[0]?.situationId}", par ids like "${parKeys[0]}". ` +
        `runBaseline() must be given the SAME generation as buildSlate().`
      )
    }
  }

  const parts = plays.map(p => scorePlay(p, expected[p.situationId] ?? 0, { side }))
  const raw = parts.reduce((a, p) => a + p.score, 0) / (parts.length || 1)
  const invalid = parts.filter(p => p.invalid).length

  return {
    // Shifted into positive territory. The offset is fixed, so the ORDERING is untouched — which
    // is all that selection actually uses.
    fitness: Math.max(0, raw + YARDS_CLAMP),
    raw,
    invalid,
    // A genome that cannot produce a legal call on a third of the slate is broken, not unlucky.
    // Zeroed outright so it cannot breed.
    penalized: invalid > plays.length / 3,
    parts,
  }
}

// The final number, with the broken-genome guard applied.
export function finalFitness(slateResult) {
  return slateResult.penalized ? 0 : slateResult.fitness
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
