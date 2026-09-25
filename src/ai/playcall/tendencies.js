// ── What the other side has been doing ([authored]) ─────────────────────────
//
// Halftime adjustments. The AI watches how the opponent has actually played the first half and
// leans against it in the second: a run-heavy team gets the box stacked, a team living underneath
// gets shaded underneath, a defense that blitzes gets the back kept in to block.
//
// ⚠️ EVERYTHING HERE IS OBSERVED AFTER THE FACT, WHICH IS WHY IT IS FAIR. Nobody sees a play call
// in advance — the standing rule is untouched. What each side sees is what ALREADY HAPPENED, which
// both players saw too, and noticing that the last twenty snaps were runs is not cheating. It is
// the entire skill of watching film.
//
// ⚠️ AND IT IS A LEAN, NEVER A RULE. It shifts weights; it never forbids a call. An adjustment that
// could rule something out would be exploitable by doing the opposite once.

// What a team does before you know anything about it. These are the numbers the lean is measured
// AGAINST — a team running 45% of the time is not run-heavy, it is normal.
export const NEUTRAL = {
  runRate: 0.45,
  shortRate: 0.60,     // share of pass plays whose routes average under the short threshold
  blitzRate: 0.25,
}

// Routes averaging under this are the short game.
const SHORT_YARDS = 9

// ⚠️ SHRINKAGE, NOT A MINIMUM PLAY COUNT. Three runs in a row is not a tendency, and a hard
// cut-off ("ignore fewer than ten plays") makes the adjustment pop into existence at play ten —
// the defense is blind, blind, blind, and then suddenly certain. Blending toward the neutral prior
// means early evidence moves the needle a little and later evidence moves it a lot, which is both
// better behaved and closer to how anyone actually forms an opinion.
//
// The weight is in plays: at PRIOR_WEIGHT observations the estimate sits halfway between what was
// seen and what was assumed.
//
// ⚠️ CALIBRATED AGAINST THE REPORTING THRESHOLD, not picked by feel. At 8 a team that had run
// three times in a row already read as run-heavy enough to act on — which is exactly the noise
// this is meant to ignore. 15 keeps three plays below the threshold and still reaches a strong
// read by twenty-odd, which is about when a human would have made up their mind too.
const PRIOR_WEIGHT = 15

// How far a maximal tendency is allowed to move anything. A defense that has seen nothing but runs
// should stack the box hard — but never so hard that it stops defending the pass, because the one
// throw it then gives up is a touchdown.
const MAX_BIAS = 0.6

export function createTendencies() {
  return {
    // Indexed by the slot that was ON OFFENSE / ON DEFENSE for that play, not by who has the ball
    // now. Possession swaps constantly; who did what does not.
    offense: [blankOffense(), blankOffense()],
    defense: [blankDefense(), blankDefense()],
  }
}

const blankOffense = () => ({ plays: 0, runs: 0, passes: 0, shortPasses: 0 })
const blankDefense = () => ({ plays: 0, blitzes: 0 })

// ── Watching ────────────────────────────────────────────────────────────────
//
// Called once per play, after it has resolved, with what both sides just saw.
export function observePlay(tend, { offenseSlot, defenseSlot, playType, routeDepth, rushers }) {
  if (!tend) return
  const off = tend.offense[offenseSlot]
  const def = tend.defense[defenseSlot]

  if (off) {
    off.plays++
    if (playType === 'run') off.runs++
    else {
      off.passes++
      if (Number.isFinite(routeDepth) && routeDepth < SHORT_YARDS) off.shortPasses++
    }
  }
  if (def) {
    def.plays++
    // Five or more coming is a blitz, counted plainly — the same test used everywhere else, and
    // not "a non-lineman is rushing", which in a 3-4 describes an ordinary four-man rush.
    if (Number.isFinite(rushers) && rushers >= 5) def.blitzes++
  }
}

// Blend what was seen with what was assumed, weighted by how much was seen.
function shrink(seen, n, prior) {
  if (!n) return prior
  return (seen + PRIOR_WEIGHT * prior) / (n + PRIOR_WEIGHT)
}

export function summarize(tend, slot) {
  const off = tend?.offense?.[slot] ?? blankOffense()
  const def = tend?.defense?.[slot] ?? blankDefense()
  return {
    plays: off.plays,
    runRate: shrink(off.runs, off.plays, NEUTRAL.runRate),
    // Measured over PASSES, not over all plays — a team that runs constantly has not thereby
    // become a short-passing team.
    shortRate: shrink(off.shortPasses, off.passes, NEUTRAL.shortRate),
    defPlays: def.plays,
    blitzRate: shrink(def.blitzes, def.plays, NEUTRAL.blitzRate),
  }
}

const lean = (rate, neutral, scale) =>
  Math.max(-MAX_BIAS, Math.min(MAX_BIAS, (rate - neutral) * scale))

// ── The adjustment ──────────────────────────────────────────────────────────
//
// What I should do differently in the second half, given what the opponent did in the first.
// Every field is a signed lean: positive means do more of it, negative means less, zero means the
// opponent has been ordinary and there is nothing to adjust to.
export function adjustmentsFor(tend, { opponentSlot }) {
  const them = summarize(tend, opponentSlot)
  return {
    // They run a lot: put more in the box, and let the linebackers sit closer to the line.
    boxBias: lean(them.runRate, NEUTRAL.runRate, 1.6),
    // They live underneath: shade underneath rather than over the top.
    underneathBias: lean(them.shortRate, NEUTRAL.shortRate, 1.4),
    // They blitz a lot: keep somebody in to block more readily.
    protectBias: lean(them.blitzRate, NEUTRAL.blitzRate, 1.8),
    evidence: { offensivePlays: them.plays, defensivePlays: them.defPlays },
  }
}

// A sentence a human can read on the halftime screen. Only the leans that are actually meaningful
// get a mention — a report listing three things that all say "normal" is noise.
const WORTH_SAYING = 0.12

export function describeAdjustments(adj) {
  const out = []
  if (adj.boxBias > WORTH_SAYING) out.push('They are running it — stacking the box')
  else if (adj.boxBias < -WORTH_SAYING) out.push('They are throwing it — dropping more into coverage')
  if (adj.underneathBias > WORTH_SAYING) out.push('They live underneath — squeezing the short game')
  else if (adj.underneathBias < -WORTH_SAYING) out.push('They are pushing it downfield — playing over the top')
  if (adj.protectBias > WORTH_SAYING) out.push('They blitz — keeping help in to block')
  else if (adj.protectBias < -WORTH_SAYING) out.push('They rush four — releasing everybody')
  return out
}

// ── Applying it ─────────────────────────────────────────────────────────────

// How many rushers the offense should PLAN for, given what this defense has shown. Feeds
// `keepInToBlock`, which already knows what to do about it.
export function expectedRushers(adj) {
  // Neutral is a four-man rush. A blitz-happy defense pushes the expectation past five, which is
  // the point at which a back stays in.
  return 4 + Math.max(0, adj.protectBias) * 3
}

// Nudges a defensive shell's weight by how well it answers what this offense has been doing.
// ⚠️ MULTIPLIES, NEVER ZEROES. A shell that answers the tendency badly is less likely, never
// impossible — otherwise one changed-up call beats the whole adjustment.
export function shellFit(shell, adj) {
  const rushers = Object.values(shell?.assignments ?? {}).filter(a => a?.job === 'rush').length
  const deep = Object.values(shell?.assignments ?? {})
    .filter(a => a?.job === 'zone' && a.zone === 'deep').length

  let w = 1
  // Against the run, more bodies coming forward and fewer parked deep.
  w *= 1 + adj.boxBias * (rushers - 4) * 0.25
  w *= 1 - adj.boxBias * (deep - 2) * 0.15
  // Against the short game, fewer deep defenders is again the answer — but for a different reason,
  // so it is a separate term rather than the same one reused.
  w *= 1 - adj.underneathBias * (deep - 2) * 0.12
  return Math.max(0.15, w)
}

// Whether a man defender should give up his usual leverage to sit underneath.
export function prefersUnderneath(adj) {
  return adj.underneathBias > WORTH_SAYING
}
