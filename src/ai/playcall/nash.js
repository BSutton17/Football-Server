// ── Solving the play-call matchup ([authored]) ──────────────────────────────
//
// Once the plays are a fixed, finite, hand-authored list, choosing between them stops being a
// learning problem and becomes a SOLVABLE one. Simulate every play against every shell, and the
// result is a payoff matrix. The best way to call plays from a payoff matrix is not a network —
// it is the game-theoretic solution, which we can compute exactly.
//
// ⚠️ THE ANSWER IS A MIXED STRATEGY, AND THAT IS THE POINT. The solution is a PROBABILITY
// DISTRIBUTION over plays, never a single pick, because predictability is precisely what a
// zero-sum solve punishes: any call you make every time on 3rd-and-7 is a call the defense can sit
// on. So "do not run the same play on the same down and distance" is not a rule bolted on top of
// this — it is the property the method was chosen for.
//
// ⚠️ WHY NOT TRAIN A NETWORK FOR THIS. We did, three times. A per-play proxy fitness taught a
// defense to blitz six every down; ping-pong cycled; 600 generations of simultaneous co-evolution
// produced an offense WORSE than the hand-written heuristic, because the best offensive concept
// flips sign depending on which defense it meets, so the gradient reverses as the opponent moves.
// A matrix has no gradient to reverse. It is also exact, reproducible, and inspectable — you can
// read WHY a play was called, which no genome will ever tell you.

// Regret matching (Hart & Mas-Colell). In a two-player zero-sum game the AVERAGE strategies of
// two regret-matching players converge to a Nash equilibrium, which is all we need and costs forty
// lines rather than a linear-programming dependency.
const DEFAULT_ITERATIONS = 20000

function fromRegrets(cumRegret) {
  let total = 0
  const s = new Array(cumRegret.length)
  for (let i = 0; i < cumRegret.length; i++) {
    s[i] = cumRegret[i] > 0 ? cumRegret[i] : 0
    total += s[i]
  }
  // Before any regret has accumulated there is nothing to prefer, so play everything equally.
  if (total <= 0) return new Array(cumRegret.length).fill(1 / cumRegret.length)
  for (let i = 0; i < s.length; i++) s[i] /= total
  return s
}

function normalize(v) {
  const total = v.reduce((a, b) => a + b, 0)
  return total > 0 ? v.map(x => x / total) : new Array(v.length).fill(1 / v.length)
}

// `payoff[i][j]` is what ROW (the offense) scores when it calls i against the defense's j.
// Zero sum, so the defense's payoff is the negative and one matrix describes the whole matchup.
export function solveZeroSum(payoff, { iterations = DEFAULT_ITERATIONS } = {}) {
  const rows = payoff.length
  const cols = payoff[0]?.length ?? 0
  if (!rows || !cols) return { row: [], col: [], value: 0, iterations: 0 }

  const regretRow = new Array(rows).fill(0)
  const regretCol = new Array(cols).fill(0)
  const sumRow = new Array(rows).fill(0)
  const sumCol = new Array(cols).fill(0)

  for (let t = 0; t < iterations; t++) {
    const sRow = fromRegrets(regretRow)
    const sCol = fromRegrets(regretCol)
    for (let i = 0; i < rows; i++) sumRow[i] += sRow[i]
    for (let j = 0; j < cols; j++) sumCol[j] += sCol[j]

    // What each of ROW's options would have been worth against the defense's current mix...
    const utilRow = new Array(rows).fill(0)
    for (let i = 0; i < rows; i++) {
      let u = 0
      for (let j = 0; j < cols; j++) u += payoff[i][j] * sCol[j]
      utilRow[i] = u
    }
    let evRow = 0
    for (let i = 0; i < rows; i++) evRow += sRow[i] * utilRow[i]
    // ...and the regret is how much better it would have been to have played that one all along.
    for (let i = 0; i < rows; i++) regretRow[i] += utilRow[i] - evRow

    const utilCol = new Array(cols).fill(0)
    for (let j = 0; j < cols; j++) {
      let u = 0
      for (let i = 0; i < rows; i++) u -= payoff[i][j] * sRow[i]   // zero sum
      utilCol[j] = u
    }
    let evCol = 0
    for (let j = 0; j < cols; j++) evCol += sCol[j] * utilCol[j]
    for (let j = 0; j < cols; j++) regretCol[j] += utilCol[j] - evCol
  }

  const row = normalize(sumRow)
  const col = normalize(sumCol)
  let value = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) value += row[i] * payoff[i][j] * col[j]
  return { row, col, value, iterations }
}

// ── When the defense gets to SEE something first ────────────────────────────
//
// ⚠️ PERSONNEL IS PUBLIC, AND THAT CHANGES THE GAME. The defense legally sees who trots onto the
// field: three receivers brings a nickel corner, four brings dime. That is not a violation of
// "the defense never sees the play call" — personnel is not the call — but it does mean the
// defense is no longer choosing blind, and a simultaneous matrix would model it wrongly in BOTH
// directions. It would let the defense play dime against a heavy set, and it would let the
// offense empty the backfield on every third-and-long without ever being punished for the tell.
//
// So the defense gets one strategy PER SIGNAL, and the offense one over all its plays. The
// equilibrium then produces the football answer on its own: dime against four wide, base against
// heavy, and an offense that has to vary its personnel because the tell is being read.
//
// `signals[i]` is whatever the defense can observe about offensive play i before it must commit —
// in practice its personnel grouping. Counterfactual regret weighting (CFR) is what makes the
// per-signal averages converge: a signal that rarely happens must not be drowned out by one that
// happens constantly.
// ⚠️ THE TREMBLING HAND, AND WHY IT IS NOT OPTIONAL HERE.
//
// An equilibrium offense abandons a dominated look entirely, so that look never occurs, so the
// defense's answer to it is OFF-PATH and the maths leaves it completely undetermined — the solver
// returns a coin flip and is not wrong to. That is useless against a person, who will absolutely
// line up in a formation the equilibrium offense would never call, and would be met with a random
// defense when they did.
//
// So the defense is solved against an offense assumed to misclick a little. Every look then has
// positive probability, every info set gets a determinate and sensible answer, and the equilibrium
// itself barely moves. This is the trembling-hand refinement, and it is the difference between a
// defense that is theoretically unexploitable and one that is also sane on a snap it never expected.
const TREMBLE = 0.02

export function solveSignaling(payoff, signals, { iterations = DEFAULT_ITERATIONS, tremble = TREMBLE } = {}) {
  const rows = payoff.length
  const cols = payoff[0]?.length ?? 0
  if (!rows || !cols) return { row: [], col: {}, value: 0, signals: [] }

  const groups = [...new Set(signals)]
  const members = new Map(groups.map(g => [g, signals.map((s, i) => (s === g ? i : -1)).filter(i => i >= 0)]))

  const regretRow = new Array(rows).fill(0)
  const sumRow = new Array(rows).fill(0)
  const regretCol = new Map(groups.map(g => [g, new Array(cols).fill(0)]))
  const sumCol = new Map(groups.map(g => [g, new Array(cols).fill(0)]))

  for (let t = 0; t < iterations; t++) {
    const sRow = fromRegrets(regretRow)
    const sCol = new Map(groups.map(g => [g, fromRegrets(regretCol.get(g))]))
    for (let i = 0; i < rows; i++) sumRow[i] += sRow[i]

    // The offense is scored against whichever defensive mix its own signal will summon.
    const utilRow = new Array(rows).fill(0)
    for (let i = 0; i < rows; i++) {
      const cs = sCol.get(signals[i])
      let u = 0
      for (let j = 0; j < cols; j++) u += payoff[i][j] * cs[j]
      utilRow[i] = u
    }
    let evRow = 0
    for (let i = 0; i < rows; i++) evRow += sRow[i] * utilRow[i]
    for (let i = 0; i < rows; i++) regretRow[i] += utilRow[i] - evRow

    // The offense the DEFENSE is solved against: the real mix, plus a tremble so no look has zero
    // reach and every info set stays determinate. The offense's own regrets above use the true mix.
    const shown = new Array(rows)
    for (let i = 0; i < rows; i++) shown[i] = (1 - tremble) * sRow[i] + tremble / rows

    for (const g of groups) {
      // Reach: how often this look actually shows up, given how the offense is currently playing.
      let reach = 0
      for (const i of members.get(g)) reach += shown[i]
      const cs = sCol.get(g)
      const rc = regretCol.get(g)
      const sc = sumCol.get(g)
      // Counterfactual utility — left UNNORMALISED by reach on purpose, which is what keeps a rare
      // look's regrets on the same scale as a common one's.
      const utilCol = new Array(cols).fill(0)
      for (let j = 0; j < cols; j++) {
        let u = 0
        for (const i of members.get(g)) u -= payoff[i][j] * shown[i]
        utilCol[j] = u
      }
      let evCol = 0
      for (let j = 0; j < cols; j++) evCol += cs[j] * utilCol[j]
      for (let j = 0; j < cols; j++) rc[j] += utilCol[j] - evCol
      // The average strategy IS weighted by reach — a look the offense almost never shows should
      // not dominate the defense's averaged answer.
      for (let j = 0; j < cols; j++) sc[j] += reach * cs[j]
    }
  }

  const row = normalize(sumRow)
  const col = {}
  for (const g of groups) col[g] = normalize(sumCol.get(g))
  let value = 0
  for (let i = 0; i < rows; i++) {
    const cs = col[signals[i]]
    for (let j = 0; j < cols; j++) value += row[i] * payoff[i][j] * cs[j]
  }
  return { row, col, value, signals: groups }
}

// How exploitable a pair of strategies is: how much the best reply beats them by. A true
// equilibrium is 0. This is the check that the solve actually worked, rather than trusting it.
export function exploitability(payoff, row, col) {
  const rows = payoff.length, cols = payoff[0]?.length ?? 0
  let value = 0
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) value += row[i] * payoff[i][j] * col[j]

  let bestRow = -Infinity
  for (let i = 0; i < rows; i++) {
    let u = 0
    for (let j = 0; j < cols; j++) u += payoff[i][j] * col[j]
    if (u > bestRow) bestRow = u
  }
  let bestCol = -Infinity
  for (let j = 0; j < cols; j++) {
    let u = 0
    for (let i = 0; i < rows; i++) u -= payoff[i][j] * row[i]
    if (u > bestCol) bestCol = u
  }
  return (bestRow - value) + (bestCol + value)
}

// ── Is this mix actually unpredictable? ─────────────────────────────────────
//
// Normalised entropy: 1.0 is a perfectly even spread, 0.0 is the same call every time.
export function spread(mix) {
  const live = mix.filter(p => p > 1e-9)
  if (live.length <= 1) return 0
  let h = 0
  for (const p of live) h -= p * Math.log(p)
  return h / Math.log(mix.length)
}

// How many calls carry real weight — more honest than counting non-zeros, which a rounding error
// inflates.
export function effectiveOptions(mix) {
  const sumSq = mix.reduce((a, p) => a + p * p, 0)
  return sumSq > 0 ? 1 / sumSq : 0
}

// ⚠️ A NEAR-PURE SOLUTION IS A BALANCE BUG, NOT A RESULT TO SHIP.
//
// If the solve says "call this every single time", the honest reading is that one option dominates
// the whole playbook — which is exactly what `training:headroom` found when man_blitz_6 beat every
// other shell on every down, and what made the first trained defense blitz six and nothing else.
// Papering over that with forced randomness would hide the bug AND make the AI play worse. So this
// reports it loudly, and the mixing floor below is a safety net, not the fix.
const PURE_THRESHOLD = 1.25        // effective options below this is essentially one call

export function diagnose(mix, labels = []) {
  const eff = effectiveOptions(mix)
  const top = mix.map((p, i) => ({ p, label: labels[i] ?? String(i) })).sort((a, b) => b.p - a.p)
  return {
    spread: spread(mix),
    effectiveOptions: eff,
    nearPure: eff < PURE_THRESHOLD,
    top: top.slice(0, 5),
    warning: eff < PURE_THRESHOLD
      ? `"${top[0].label}" is called ${(top[0].p * 100).toFixed(0)}% of the time — one option dominates the playbook, which is a BALANCE BUG to fix, not a strategy to ship`
      : null,
  }
}

// ⚠️ A SAFETY NET, DELIBERATELY SMALL. Blends a sliver of uniform play over the options the solve
// actually liked, so no call is ever literally 100% even if the matrix says it should be. It costs
// a little expected value on purpose — being readable costs more.
//
// It is NOT a substitute for `diagnose`: if a floor is doing real work, something upstream is wrong.
export function withMixingFloor(mix, { floor = 0.05 } = {}) {
  if (floor <= 0) return mix.slice()
  // Only over the support the solve chose — spreading onto plays it rejected would call bad plays.
  const support = mix.map(p => (p > 1e-6 ? 1 : 0))
  const n = support.reduce((a, b) => a + b, 0)
  if (n <= 1) return mix.slice()
  return normalize(mix.map((p, i) => (1 - floor) * p + floor * (support[i] / n)))
}
