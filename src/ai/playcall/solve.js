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

// How sharply formation values turn into a distribution. In yards: a formation worth this much
// less than the best is called about a third as often.
const FORMATION_TEMPERATURE = 1.5

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
export function formationMix(values) {
  if (!values.length) return []
  const best = Math.max(...values)
  const weights = values.map(v => Math.exp((v - best) / FORMATION_TEMPERATURE))
  const total = weights.reduce((a, b) => a + b, 0)
  return weights.map(w => w / total)
}

// ── Assembling the table select.js reads ────────────────────────────────────
//
// The shape is deliberately the one the selector already expects: situation key -> play id ->
// probability, and situation+formation -> shell id -> probability. Nothing downstream has to know
// a solve happened.
export function buildTable(subgames) {
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
    offense[situation] = playProbs
  }
  return { offense, defense }
}
