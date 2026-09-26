// ── Solving what to call ([authored]) ───────────────────────────────────────
//
// Turns simulated outcomes into the distributions `select.js` calls from.
//
// ⚠️ THE DEFENSE SEES THE FORMATION, WHICH DECOMPOSES THE DECISIONS — BUT NOT THE SAMPLING.
//
// Every play can meet every shell on the field, so all 126 x 94 = 11,844 matchups really occur and
// every one has a value that must be estimated. Splitting by formation does NOT reduce that:
// 17 formations x ~7.4 plays x 94 shells is exactly the same 11,844 cells, because each play
// belongs to exactly one formation. It is worth saying plainly, because it looks like a saving and
// is not.
//
// What the decomposition does buy is the part that was actually impossible:
//
//   • EACH PROBLEM BECOMES TINY. One game of 126 actions against 94 needs far more iterations to
//     converge than seventeen games of 7 against 94. Strategy-space size, not cell count, is what
//     made the single matrix hopeless.
//   • THEY ARE INDEPENDENT. Each formation solves on its own, in parallel, and a formation nobody
//     calls can be skipped entirely without touching the rest.
//   • SAMPLES CAN BE AIMED. "Is this formation solved yet" is answerable per formation, so effort
//     goes where the evidence is thin instead of being spread evenly over a matrix.
//
// ⚠️ AND THE FORMATION CHOICE ITSELF NEEDS NO MIXING. Mixing exists to stop the other side sitting
// on your choice — but the defense already KNOWS the formation, so hiding it buys nothing. The
// offense simply prefers the formations whose subgames are worth more. What must stay hidden, and
// therefore mixed, is which play comes out of one.
//
// ⚠️ SOFTMAX RATHER THAN ARGMAX over formations, though. Always calling the single best formation
// is correct only if the value estimates are exact, and they are sampled — a formation half a yard
// behind on noisy evidence should not vanish from the playbook.

import { solveZeroSum, withMixingFloor, diagnose } from './nash.js'
import { runShare, situationFromKey } from './situation.js'

// How sharply formation values turn into a distribution. In yards: a formation worth this much
// less than the best is called about a third as often.
const FORMATION_TEMPERATURE = 1.5

// ⚠️ NO FORMATION MAY OWN A SITUATION. Measured values came back spanning -0.2 to 9.6 yards, and
// at a temperature of 1.5 that is not a softmax, it is an argmax: one formation took 87% of 2nd and
// medium. The temperature above was calibrated for a spread of a yard or two, which is the regime
// its comment describes; the real playbook is nowhere near it.
//
// Two things go wrong when a situation collapses onto one formation, and neither is about hiding
// information — the defense sees the formation anyway, and that argument still holds:
//
//   • THE ESTIMATE IS NOT THAT GOOD. Eight samples a cell cannot justify a nine-yard separation,
//     and a bare softmax reads it as though it could.
//   • IT CALLS FOOTBALL THAT IS NOT FOOTBALL. The best-valued formation on 3rd and short measured
//     out as an EMPTY set — no back, so it cannot run — and the bucket came out at 14% run on
//     3rd and 1, with sixteen other authored formations sitting unused behind it.
const FORMATION_CEILING = 0.35

// ── What a play is worth ────────────────────────────────────────────────────
//
// ⚠️ THE CONSTANTS ARE MEASURED, NOT INVENTED. The last fitness function I wrote was a pile of
// numbers I chose — 12 for a turnover, 3 for a sack — and each one was a surface where a genome
// could win at the proxy instead of at football. Two did.
//
// Here there is exactly one number that is not raw yardage: what a possession is worth. It is
// measured from the simulation itself (mean yards a drive gains) and passed in, so a turnover is
// charged what losing the ball actually costs in this engine rather than what I guessed.
export function playValue(outcome, { possessionValue }) {
  const yards = outcome.yards ?? 0
  if (outcome.turnover) return -possessionValue
  if (outcome.touchdown) return possessionValue + yards
  // A conversion is worth the yards plus a fresh set of downs, which is a possession continued
  // rather than a new one — the same currency, discounted.
  if (outcome.firstDown) return yards + possessionValue * 0.25

  // ⚠️ FAILING TO CONVERT HAS TO COST SOMETHING, AND IT DID NOT. This took `firstDown` but never
  // the DOWN, so a 3rd-and-1 incompletion scored exactly 0 — the same as a 1st-and-10 incompletion,
  // though the first ends the drive and the second costs almost nothing.
  //
  // With no price on failure, the only thing separating plays in short yardage was raw yardage, so
  // a twelve-yard pass beat a one-yard conversion and the solve called 3rd and 1 a throwing down:
  // 26% run where football says about 73%.
  //
  // Fourth down is unambiguous — not converting hands the ball over on the spot, which is the same
  // loss the turnover branch above charges. Third down is softer: you punt, so what is lost is the
  // continuation the conversion would have bought, priced symmetrically with the bonus for getting
  // it. A team was going to punt sooner or later, so charging a whole possession would overstate it.
  //
  // ⚠️ AND ON THOSE DOWNS THE YARDS THEMSELVES BARELY COUNT. Charging for the failure was only
  // half of it: this still paid full price for yardage that did not convert, so on 3rd and 16 a
  // four-yard run scored -2.6 against an incompletion's -6.6 and looked four yards better. Both
  // punt. Those four yards buy a marginally better punt and nothing else.
  //
  // That is what made the solve prefer the run MORE on 3rd and 16 (50%) than on 3rd and 1 (39%),
  // which is backwards: the run was collecting a consolation prize for gaining yards nobody needed.
  // Discounted hard rather than zeroed, because field position on the punt is real, just small.
  const down = outcome.down ?? 1
  const FAILED_YARDS = 0.15
  if (down >= 4) return yards * FAILED_YARDS - possessionValue
  if (down === 3) return yards * FAILED_YARDS - possessionValue * 0.25
  return yards
}

// ── One subgame ─────────────────────────────────────────────────────────────
//
// `estimates[playIndex][shellIndex]` is the mean value seen for that matchup, and `counts` how
// many samples back it. Cells nobody has visited fall back to the play's own mean, so an unplayed
// matchup is treated as ordinary rather than as a disaster or a jackpot.
export function fillGaps(estimates, counts) {
  const rows = estimates.length
  const cols = estimates[0]?.length ?? 0
  const filled = estimates.map(r => [...r])

  let grand = 0, grandN = 0
  for (let i = 0; i < rows; i++) {
    for (let j = 0; j < cols; j++) {
      if (counts[i][j] > 0) { grand += estimates[i][j] * counts[i][j]; grandN += counts[i][j] }
    }
  }
  const overall = grandN ? grand / grandN : 0

  for (let i = 0; i < rows; i++) {
    let rowSum = 0, rowN = 0
    for (let j = 0; j < cols; j++) {
      if (counts[i][j] > 0) { rowSum += estimates[i][j] * counts[i][j]; rowN += counts[i][j] }
    }
    const rowMean = rowN ? rowSum / rowN : overall
    for (let j = 0; j < cols; j++) if (!counts[i][j]) filled[i][j] = rowMean
  }
  return filled
}

// Solve one (situation, formation) subgame into an offensive mix, a defensive mix, and what the
// subgame is worth to the offense.
export function solveSubgame({ estimates, counts, iterations = 8000 }) {
  if (!estimates?.length || !estimates[0]?.length) {
    return { offense: [], defense: [], value: 0, confident: false }
  }
  const payoff = fillGaps(estimates, counts)
  const { row, col, value } = solveZeroSum(payoff, { iterations })

  // How much of this answer rests on cells nobody actually played.
  let visited = 0, total = 0
  for (let i = 0; i < counts.length; i++) {
    for (let j = 0; j < counts[i].length; j++) { total++; if (counts[i][j] > 0) visited++ }
  }
  return {
    offense: withMixingFloor(row, { floor: 0.03 }),
    defense: withMixingFloor(col, { floor: 0.03 }),
    value,
    coverage: total ? visited / total : 0,
    // ⚠️ A subgame solved off a handful of visited cells is a guess wearing a distribution. Saying
    // so lets the caller keep the prior instead of adopting a confident-looking fiction.
    confident: total > 0 && visited / total >= 0.25,
    diagnosis: diagnose(row),
  }
}

// ── Formation choice ────────────────────────────────────────────────────────
//
// Softmax over what each formation's subgame turned out to be worth.
export function formationMix(values, { ceiling = FORMATION_CEILING } = {}) {
  if (!values.length) return []
  const best = Math.max(...values)
  const weights = values.map(v => Math.exp((v - best) / FORMATION_TEMPERATURE))
  const total = weights.reduce((a, b) => a + b, 0)
  return withCeiling(weights.map(w => w / total), ceiling)
}

// Caps any single share and hands the excess to the others, repeating because redistributing can
// push a second formation over the line. The mirror of `withMixingFloor`.
//
// ⚠️ AND ONLY WHERE THE SUPPORT CAN ACTUALLY SATISFY IT. Two formations cannot both sit under 35%,
// and forcing it there does not spread the call — it flattens them to 50/50 and throws away the
// solve's preference entirely, which is a worse answer than the collapse it was meant to fix. A
// ceiling is a cap on a wide distribution; with two options there is no width to cap.
export function withCeiling(mix, ceiling) {
  if (!(ceiling > 0) || ceiling >= 1) return mix.slice()
  const support = mix.reduce((a, p) => a + (p > 1e-9 ? 1 : 0), 0)
  if (support * ceiling <= 1) return mix.slice()
  const out = mix.slice()
  for (let pass = 0; pass < 12; pass++) {
    let excess = 0
    const room = []
    for (let i = 0; i < out.length; i++) {
      if (out[i] > ceiling) { excess += out[i] - ceiling; out[i] = ceiling; room.push(0) }
      // Only onto the support the solve chose. Handing weight to a formation it gave none would
      // resurrect an option it had rejected, which is the same trap `withMixingFloor` avoids.
      else room.push(mix[i] > 1e-9 ? ceiling - out[i] : 0)
    }
    if (excess <= 1e-9) break
    const capacity = room.reduce((a, b) => a + b, 0)
    if (capacity <= 1e-9) break
    for (let i = 0; i < out.length; i++) out[i] += excess * (room[i] / capacity)
  }
  const total = out.reduce((a, b) => a + b, 0)
  return out.map(p => p / total)
}

// ── Assembling the table select.js reads ────────────────────────────────────
//
// The shape is deliberately the one the selector already expects: situation key -> play id ->
// probability, and situation+formation -> shell id -> probability. Nothing downstream has to know
// a solve happened.
// ⚠️ THE SOLVE DECIDES WHICH PLAY, THE SITUATION DECIDES RUN OR PASS. Three complete solves have
// now disagreed with football about the run/pass SPLIT, and in both directions: 61-65% run on third
// and long in one, 0% run on second and short at the goal line in another, and 12% run on third and
// one when the answer is about three quarters. The split is the one thing this model is bad at.
//
// It is bad at it for a structural reason, not a tuning one. A play-level equilibrium treats seven
// similar pass concepts as seven independent actions, so the pass side accumulates weight simply by
// being numerous; and the value function cannot price "we needed one yard and got four" the way a
// coach does. Meanwhile the solve is GOOD at the thing it was built for: which concept beats which
// shell, measured in this engine.
//
// So the two questions are separated. The situational share sets how often the ball is run, and the
// solved distribution decides which run and which pass — keeping everything the sampling actually
// learned and discarding only the part it kept getting wrong.
function withRunShare(playProbs, situationKey, playType) {
  const target = runShare(situationFromKey(situationKey))
  let runTotal = 0, passTotal = 0
  for (const [id, p] of Object.entries(playProbs)) {
    if (playType(id) === 'run') runTotal += p
    else passTotal += p
  }
  // A bucket with only one kind of play in it has no split to set.
  if (runTotal <= 0 || passTotal <= 0) return playProbs

  const runScale = target / runTotal
  const passScale = (1 - target) / passTotal
  const out = {}
  for (const [id, p] of Object.entries(playProbs)) {
    out[id] = p * (playType(id) === 'run' ? runScale : passScale)
  }
  return out
}

// `playType` maps a play id to 'run' or 'pass'. Passed in rather than imported, because this module
// is pure post-processing over solved numbers and has no business loading a playbook.
export function buildTable(subgames, { playType = null } = {}) {
  const offense = {}
  const defense = {}

  // Group by situation so formations can be weighed against each other inside it.
  const bySituation = new Map()
  for (const sg of subgames) {
    if (!bySituation.has(sg.situation)) bySituation.set(sg.situation, [])
    bySituation.get(sg.situation).push(sg)
  }

  for (const [situation, group] of bySituation) {
    // ⚠️ ONLY THE SUBGAMES THAT ARE ACTUALLY SOLVED. An unconfident one is left out entirely so the
    // selector falls back to its prior for that situation, rather than half the plays coming from
    // evidence and half from a guess with no way to tell them apart later.
    const solid = group.filter(g => g.confident)
    if (!solid.length) continue

    const mix = formationMix(solid.map(g => g.value))
    const playProbs = {}
    solid.forEach((g, gi) => {
      g.plays.forEach((playId, i) => {
        playProbs[playId] = (playProbs[playId] ?? 0) + mix[gi] * (g.offense[i] ?? 0)
      })
      const key = `${situation}|${g.formation}`
      defense[key] = Object.fromEntries(g.shells.map((id, j) => [id, g.defense[j] ?? 0]))
    })
    offense[situation] = playType ? withRunShare(playProbs, situation, playType) : playProbs
  }
  return { offense, defense }
}
