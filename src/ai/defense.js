// ── The defensive brain (heuristic) ([offline]) ──────────────────────────────
//
// Two decisions, in this order, both made from the pre-snap picture alone:
//
//   1. PERSONNEL — how many corners, safeties and linebackers to have on the field. Decided from
//      the OPPONENT'S personnel, because that is what a real defense substitutes against: two tight
//      ends is a different problem from four wide, and bringing the wrong bodies is a mistake no
//      amount of good coverage fixes afterwards.
//
//   2. THE CALL — which shell, from the situation. Down, distance, field position, clock.
//
// Everything here is a pure function of Knowledge, so it cannot see the play call. It is also
// deliberately simple and legible: this is the fixed opponent NEAT will be trained against and
// measured against, so it needs to be something a human can read and argue with, not a black box.
// When NEAT replaces the CALL, this file stays as the baseline.

import { SHELLS, extraRushers } from './playbook/coverages.js'
import { oppPersonnel, oppSkill, oppInBox, yardsToGoal, isGoalToGo, FIELD_MID } from './knowledge.js'
import { skillFor, allowedShells } from './difficulty.js'

// This seat's coverage pool is 4 CB, 3 S, 4 LB, and seven of them go on the field (the four down
// linemen are placed automatically). So a personnel call is a choice of three numbers summing to 7.
export const COVERAGE_ON_FIELD = 7

// ── Personnel ─────────────────────────────────────────────────────────────────
//
// Matching rule, in words: a corner for every wide receiver, a linebacker for every tight end and
// back, safeties for the rest. Then two floors that override it, because both are ways of losing
// a game outright rather than merely being out-leveraged:
//
//   • never fewer than 2 LB when the offense is heavy (2+ TE/RB in the box) — the user's "zero
//     people in the box against two tight ends" case;
//   • never fewer than 2 CB, because a receiver with a linebacker on him is not coverage.
export function choosePersonnel(k, ballX = FIELD_MID) {
  const opp = oppPersonnel(k)
  const box = oppInBox(k, ballX)

  let CB = clamp(opp.WR, 2, 4)
  let LB = clamp(opp.TE + opp.RB, box >= 2 ? 2 : 1, 4)
  let S = COVERAGE_ON_FIELD - CB - LB

  // Safeties are the adjustment: too few and there is nobody over the top, too many and the run
  // fits are soft. Pull from whichever group has the most to give.
  if (S < 1) {
    S = 1
    while (CB + LB + S > COVERAGE_ON_FIELD) (CB > LB ? CB-- : LB--)
  }
  if (S > 3) {
    const spare = S - 3
    S = 3
    // Spend the spare on corners in a passing situation, linebackers otherwise.
    if (isPassingSituation(k)) CB = Math.min(4, CB + spare)
    else LB = Math.min(4, LB + spare)
    // Whatever still does not fit goes to the other group.
    while (CB + LB + S < COVERAGE_ON_FIELD) (isPassingSituation(k) ? CB++ : LB++)
  }

  return { CB, S, LB }
}

// ── The call ──────────────────────────────────────────────────────────────────
//
// Written as an ordered list of rules with the situation each answers. First match wins, so the
// strongest situational reads sit at the top. Anything that falls through gets the base call.
//
// `rng` makes the call non-deterministic on purpose: a defense that always answers 3rd-and-8 with
// the same blitz is a defense you beat once and then forever. Each rule offers a small menu and
// picks from it.
export function chooseShell(k, rng = Math.random, ballX = FIELD_MID) {
  const toGo = k.distance
  const togoal = yardsToGoal(k)
  const box = oppInBox(k, ballX)
  const opp = oppPersonnel(k)

  // [difficulty] The SITUATION picks the menu; the tier decides how much of that menu this computer
  // is allowed to call from. Easy is held to the vanilla shells, so it can never answer 3rd-and-8
  // with a zone blitz — it lines up in something you can see and beat. Narrowing happens here, at
  // the one place a call is made, rather than in ten rules that would drift apart.
  // ⚠️ This is a restriction on the AI, never an advantage: `allowedShells` can only ever remove
  // options, and falls back to the full menu rather than leaving the defense with no call at all.
  const skill = skillFor(k.difficulty)
  const pick = (...ids) => {
    const menu = allowedShells(skill, ids)
    return menu[Math.floor(rng() * menu.length)]
  }

  // Late and ahead: the only thing that beats you is a long one. Give up the short throw. Every
  // tier gets this one — it is a situation, not a wrinkle, and a defense that rushed four deep
  // safeties into man coverage up 3 with 40 seconds left would read as broken rather than easy.
  if (isPreventSituation(k)) return 'prevent'

  // Backed up against the goal line, the field is short and there is no deep to defend.
  if (togoal <= 5 || (isGoalToGo(k) && togoal <= 8)) {
    return pick('cover_1', 'man_blitz_5', 'cover_2_man')
  }

  // Obvious run: heavy personnel, short yardage, or a back-heavy box.
  if (isRunSituation(k, box, opp)) {
    return pick('cover_1', 'cover_3', 'man_blitz_5')
  }

  // Obvious pass, long to go. Pressure or two-deep, not single-high.
  if (toGo >= 8 && k.down >= 3) {
    return pick('cover_2', 'tampa_2', 'zone_blitz_5', 'man_blitz_5', 'cover_4')
  }

  // Third and manageable: take away the sticks underneath.
  if (k.down === 3 && toGo <= 5) {
    return pick('cover_1', 'man_blitz_6', 'cover_2_man')
  }

  // Second and long behaves like a passing down without the desperation.
  if (k.down === 2 && toGo >= 10) {
    return pick('cover_2', 'cover_3', 'tampa_2', 'zone_blitz_5')
  }

  // Base. Spread the calls so the offense cannot sit on one.
  return pick('cover_3', 'cover_2', 'cover_1', 'cover_4', 'tampa_2')
}

// ── Situation reads ───────────────────────────────────────────────────────────

// Four or more wide, or third-and-long: throwing is the only sensible thing to do.
export function isPassingSituation(k) {
  const opp = oppPersonnel(k)
  if (opp.WR >= 4) return true
  if (k.down >= 3 && k.distance >= 7) return true
  if (k.down === 2 && k.distance >= 12) return true
  return false
}

// Heavy personnel, a crowded box, or short yardage.
export function isRunSituation(k, box, opp) {
  if (k.distance <= 3) return true
  if (opp.TE >= 2 && box >= 2) return true
  if (opp.RB >= 2) return true
  if (box >= 3) return true
  return false
}

// Prevent is a scoreboard-and-clock decision, never a down-and-distance one: it is only correct
// when a long completion is the ONLY thing that can beat you. Playing it otherwise just hands out
// free yards.
const PREVENT_CLOCK_SECONDS = 40
export function isPreventSituation(k) {
  const leading = (k.score?.own ?? 0) > (k.score?.opp ?? 0)
  const lateHalf = k.quarter === 2 || k.quarter === 4
  return leading && lateHalf && k.clock <= PREVENT_CLOCK_SECONDS && yardsToGoal(k) > 25
}

// ── Putting it together ───────────────────────────────────────────────────────

// The whole pre-snap defensive decision. Returns the call plus the reasoning, so a log line (or a
// debug overlay later) can say WHY — which is what makes a heuristic baseline worth having.
export function callDefense(k, rng = Math.random, ballX = FIELD_MID) {
  const personnel = choosePersonnel(k, ballX)
  const shellId = chooseShell(k, rng, ballX)
  const shell = SHELLS[shellId]

  return {
    shellId,
    shellName: shell?.name ?? shellId,
    personnel,
    extraRushers: extraRushers(shellId),
    why: describe(k, ballX),
  }
}

function describe(k, ballX) {
  const opp = oppPersonnel(k)
  return `${k.down}&${Math.round(k.distance)} at ${Math.round(k.yardLine)}` +
    ` | ${opp.WR}WR/${opp.TE}TE/${opp.RB}RB, box ${oppInBox(k, ballX)}` +
    (isPreventSituation(k) ? ' | prevent' : isPassingSituation(k) ? ' | pass sit' : '')
}

// Which of this seat's roster players to put on the field for a given personnel call. Best
// available by overall at each position — the AI has no reason to hold anyone back.
export function selectPlayers(roster, personnel) {
  const out = []
  for (const [label, n] of Object.entries(personnel)) {
    const group = roster
      .filter(p => p.position === label)
      .sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0))
    out.push(...group.slice(0, n))
  }
  return out
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }
