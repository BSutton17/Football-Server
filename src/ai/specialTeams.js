// ── Special teams policy ([offline]) ─────────────────────────────────────────
//
// Kicking is a minigame — a power meter you tap and an aim you rotate — and there is nothing for
// an AI to learn in it. So the AI does not play the minigame. It decides what it WANTS to happen
// and then supplies inputs that produce it, at the rates the design specified:
//
//   • extra point  — 99% good
//   • field goal   — (100 − distance × 1.25)%, where distance is yards from the opponent's goal
//                    line. A 19-yard chip shot is 97.5%; a 57-yarder is 50%.
//   • block attempt — 1% chance of getting home.
//   • punt returns — let it bounce when the ball lands inside the 10, return it otherwise.
//
// ⚠️ ASSUMPTION, still unconfirmed: `n` in "100 − n × 1.25" is read as YARDS FROM THE OPPONENT'S
// GOAL LINE, not `state.yardLine`. In this codebase `yardLine` is offense-relative and counts UP
// toward the opponent, so reading it literally would make every field goal inside the 20 a 0%
// proposition. The inverse produces a sane curve, so that is what this uses. One constant to flip
// if it was meant the other way.

import { yardsToGoal } from './knowledge.js'

export const XP_MAKE_CHANCE = 0.99
export const FG_BLOCK_CHANCE = 0.01
// Roughly what one more snap costs off the clock. Below this there is no time to improve the spot,
// so the kick is the call.
export const ONE_MORE_PLAY_SECONDS = 8
// ⚠️ THE ARGUMENT IS THE KICK DISTANCE, not the yards to the goal line — the caller passes
// `fieldGoalDistance`, which already includes the end zone and the snap (goal line + 17). The old
// parameter name said otherwise and the curve was built as though it were the shorter number.
//
// The straight line it used — one percentage point and a quarter per yard from 100 — made the
// computer a dreadful kicker: a 37-yard attempt, which a real kicker makes about 88% of the time,
// came out a coin flip at 54%, and even a chip shot from the two was 75%. "The AI are missing too
// many field goals."
//
// Two segments, because real accuracy does not fall off at one rate: it is nearly flat out to the
// high thirties and then drops away quickly past 45.
// ⚠️ THESE ARE THE RATES THAT WERE ASKED FOR, NOT A CURVE I FITTED. Written as bands so they can
// be checked against the request rather than reverse-engineered out of an equation:
//
//   the 35 and in  100%      the 40  90%      the 45  80%      the 50  75%
//
// Interpolated WITHIN each band rather than stepped, because a cliff between 34 and 36 yards would
// be visible and strange. Past the last band it keeps falling at the same kind of slope to a floor:
// a seventy-yard attempt is not a 75% proposition.
//
// The argument is the KICK distance — goal line plus seventeen — which is what the caller passes.
//
// ⚠️ AND THE BANDS ARE KICK DISTANCE, WHICH IS THE YARD LINE PLUS SEVENTEEN. That is the thing the
// first pass got wrong. "100% inside 35" was read as a 35-yard KICK — the eighteen yard line — when
// what was meant was the 35 YARD LINE, which is a 52-yard kick. Restated: "the AI is still missing
// field goals, especially past the 35, when those should be 100%."
//
// So the automatic band now runs to 52 and the rest of the curve follows it out. The numbers below
// are kick distances; the yard line each corresponds to is in the comment beside it.
const FG_BANDS = [
  { to: 52, rate: 1.00 },   // the 35 yard line and in
  { to: 57, rate: 0.90 },   // the 40
  { to: 62, rate: 0.80 },   // the 45
  { to: 67, rate: 0.75 },   // the 50
]
const FG_BEYOND_FALLOFF = 0.03   // per yard past the last band
const FG_FLOOR = 0.05

export function fieldGoalChance(kickDistance) {
  const d = Math.max(0, kickDistance)
  if (d <= FG_BANDS[0].to) return FG_BANDS[0].rate

  for (let i = 1; i < FG_BANDS.length; i++) {
    const lo = FG_BANDS[i - 1]
    const hi = FG_BANDS[i]
    if (d > hi.to) continue
    // Linear across the band, so it lands exactly on the stated rate at the band's edge.
    return clamp01(lo.rate + (hi.rate - lo.rate) * ((d - lo.to) / (hi.to - lo.to)))
  }

  const last = FG_BANDS[FG_BANDS.length - 1]
  return clamp01(Math.max(last.rate - (d - last.to) * FG_BEYOND_FALLOFF, FG_FLOOR))
}

// ── Punt returns ──────────────────────────────────────────────────────────────
//
// One rule, exactly as specified: inside the 10, let it bounce (fielding it there risks a touchback
// or worse field position than the roll gives you); anywhere else, bring it out.
export const BOUNCE_INSIDE = 10

export function puntReturnChoice(landingYardLine) {
  // `landingYardLine` is where the ball comes down, measured from the RETURNING team's own goal.
  return landingYardLine <= BOUNCE_INSIDE ? 'let_it_bounce' : 'return'
}

// [4th and inches] A yard or less. Anywhere past the floor below, this is a down to go for.
const INCHES_YARDS = 1

// Own 40 and in: here a failed conversion is points for the other side rather than field position,
// so the punt keeps its place. Past it, punting a yard away is giving the drive up.
const PUNT_FLOOR_YARDLINE = 40

// On 4th and inches a kick has to be near-automatic to be worth more than the yard. Inside the 23,
// roughly — a fifty-yarder is a worse bet than a quarterback sneak.
const SHORT_YARDAGE_FG_MAX = 40

// ── Fourth down ───────────────────────────────────────────────────────────────
//
// Field position first, then distance. The thresholds are the ordinary ones: kick it when you are
// close enough, go for it when you are too far to kick and too close to punt, punt otherwise.
export function fourthDownChoice(k, rng = Math.random) {
  const d = k.decision
  if (!d) return null

  const legal = new Set(d.options.filter(o => o.legal).map(o => o.id))
  const togo = k.distance
  const fgDistance = d.fieldGoalDistance ?? (yardsToGoal(k) + 17)

  const choose = (id) => ({ event: 'special_teams_choice', payload: { option: id } })

  // A conversion menu after a touchdown comes through the same channel.
  if (d.context === 'conversion') {
    // Two points only when the scoreboard actually calls for it; otherwise take the near-certain
    // point. Chasing two when it does not change the arithmetic is how you lose by one.
    const diff = (k.score?.opp ?? 0) - (k.score?.own ?? 0)
    const wantsTwo = diff === 1 || diff === 2 || diff === 5 || diff === 10
    return choose(wantsTwo && k.quarter >= 4 ? 'two_point' : 'extra_point')
  }

  // Desperate: late, behind, and a punt does not help.
  const behind = (k.score?.own ?? 0) < (k.score?.opp ?? 0)
  const desperate = behind && k.quarter === 4 && k.clock <= 240
  if (desperate && legal.has('go_for_it') && !(legal.has('field_goal') && fgDistance <= 50)) {
    return choose('go_for_it')
  }

  // ⚠️ ASKED ON AN EARLY DOWN, THE ANSWER IS USUALLY "PLAY ON". The menu now opens on any down
  // inside the last thirty seconds of a half, and everything below this point reasons as though it
  // were fourth down — which would have the computer kicking on 1st and 10 with half a minute left
  // and the ball still moving. It takes the points only when there is no time to do better.
  if (k.down !== 4 && legal.has('field_goal')) {
    const noTimeLeft = (k.clock ?? 999) <= ONE_MORE_PLAY_SECONDS
    return choose(noTimeLeft && fgDistance <= 52 ? 'field_goal' : 'go_for_it')
  }

  // ⚠️ FOURTH AND INCHES IS NOT A PUNTING SITUATION. It used to be, anywhere short of midfield —
  // so the computer punted the ball away on 4th and a foot from its own 45, which no coach has done
  // in twenty years. A yard is the easiest thing in football to gain and punting concedes the drive
  // to avoid it.
  //
  // The one place it stays right is deep in your own end, where losing it hands over points rather
  // than field position — hence the floor at the own 40.
  if (togo <= INCHES_YARDS && k.yardLine > PUNT_FLOOR_YARDLINE) {
    // …unless the kick is the better score. A near-automatic field goal is worth more than a yard;
    // a fifty-yarder is not, and going for it from there is the higher-value call.
    if (legal.has('field_goal') && fgDistance <= SHORT_YARDAGE_FG_MAX) return choose('field_goal')
    if (legal.has('go_for_it')) return choose('go_for_it')
  }

  // In range and it is worth more than the down.
  if (legal.has('field_goal') && fgDistance <= 52 && togo > 2) return choose('field_goal')

  // Short yardage in plus territory: take the shot.
  if (legal.has('go_for_it') && togo <= 2 && yardsToGoal(k) <= 45) return choose('go_for_it')


  if (legal.has('field_goal') && fgDistance <= 52) return choose('field_goal')
  if (legal.has('punt')) return choose('punt')
  return choose('go_for_it')
}

// ── Acting during a kick ──────────────────────────────────────────────────────
//
// What to fire while a special-teams play is on the field. Returns one action, or null when it is
// not this seat's turn to do anything.
export function specialTeamsAction(k, rng = Math.random) {
  const st = k.specialTeams
  if (!st) return null

  // Returning a punt: the decision window is open and this seat is the receiving team.
  if (st.returnPending && !st.kicking) {
    return {
      event: 'punt_return_choice',
      payload: { option: puntReturnChoice(st.returnLandingYardLine ?? 50) },
    }
  }

  // Defending a field goal: one attempt, and it rarely works.
  if (!st.kicking && st.blockAvailable && !st.blockAttempted) {
    // The roll happens HERE rather than being left to the engine's own region model, because the
    // design fixed the rate at 1%. Declining to attempt is the other 99%.
    if (rng() >= FG_BLOCK_CHANCE) return null
    return { event: 'fg_block', payload: { position: 0 } }
  }

  // ⚠️ THE WHOLE STRIKE IS COMMITTED IN ONE INPUT, AND THE AI DOES NOT WORK THE METER.
  //
  // The meter is a hand-speed minigame and the computer has no hand. What it had instead was a
  // dependence on how often `special_teams_update` happened to be broadcast, and that dependence
  // did not merely make it a poor kicker -- combined with the stale-menu bug in knowledge.js it
  // meant it fired no kick inputs AT ALL. Measured: punts 21.4 yards every time (the floor of the
  // distance curve) and field goals 0 for 20 from 37 and 49 yards.
  //
  // So it states what it is doing -- power, aim, and the backspin toggle -- in a single input, the
  // same abstraction the make/miss intent was already using. One message per kick, no tap loop, no
  // cadence to depend on, and the result is a function of the decision rather than of the network.
  //
  // ⚠️ NOT A HANDICAP BYPASS AND NOT A PERFECT KICKER. The make/miss rate is unchanged (it is
  // still `fieldGoalChance`, decided here and then expressed as an aim instead of being lost), and
  // punt power is deliberately short of full with real spread -- see kickPowerFor.
  if (st.kicking && st.phase === 'setup') {
    const memo = kickMemo(k, st)
    if (memo.committed) return null                 // one strike per kick; nothing left to say
    memo.committed = true
    return {
      event: 'special_teams_input',
      payload: {
        power: kickPowerFor(st, k, rng),
        angle: aimFor(st, k, memo, rng),
        // Punt-only: checks the ball up instead of letting it roll, which is the difference between
        // pinning somebody inside the ten and a touchback. A human had this and the AI did not.
        ...(st.kickType === 'punt' ? { backspin: wantsBackspin(k) } : {}),
      },
    }
  }

  return null
}

// This seat's memory of the kick currently on the field.
//
// ⚠️ IT CANNOT LIVE ON `st`. The view object is replaced wholesale by every
// `special_teams_update`, so a flag written on it is forgotten ten times a second -- which is how
// the field-goal make/miss intent came to be re-rolled on every frame of the kick. knowledge.js
// owns `aiKick` and clears it when the kick ends.
function kickMemo(k, st) {
  if (!k.aiKick || k.aiKick.kickType !== st.kickType) k.aiKick = { kickType: st.kickType }
  return k.aiKick
}

// How well the computer strikes this one, as a fraction of the meter.
//
// ⚠️ NOT 100%. A perfect meter every time is as wrong as 9% and in the more annoying direction:
// the human reached 75% in a real game, so a computer pinned at full would out-kick every player
// every time. This is a good-but-human strike with real spread, so some punts are better than
// others and the odd one is poor.
//
// A field goal is struck near its best regardless -- distance there is a pass/fail gate and the
// make/miss decision is already taken by `nextTap`, so softening the power as well would punish it
// twice for the same thing.
const PUNT_POWER_MEAN = 0.82
const PUNT_POWER_SPREAD = 0.12
const PLACEKICK_POWER = 0.95

function kickPowerFor(st, k, rng) {
  if (st.kickType !== 'punt') return PLACEKICK_POWER
  const jitter = (rng() * 2 - 1) * PUNT_POWER_SPREAD
  return Math.max(0.35, Math.min(1, PUNT_POWER_MEAN + jitter))
}

// Where the kick is aimed. The AI decides ONCE per kick whether this one is going in, at the rate
// the design specified, and then aims accordingly: at the target when it means to make it,
// deliberately wide when it does not.
//
// ⚠️ THE INTENT USED TO BE DECIDED AND THEN NEVER EXPRESSED. It was turned into one tap of a
// rotation that takes ten taps to cross the face of the uprights, and the AI was firing no taps, so
// the aim sat on nought and the make/miss decision reached the ball as noise. Every band and curve
// in this file was being computed and thrown away. It is stated outright now.
const MISS_BY = 0.8

function aimFor(st, k, memo, rng) {
  const target = st.targetAngle ?? 0
  // A punt has no uprights to split: the target is straight ahead and the aim stays there.
  if (st.kickType === 'punt' || st.kickType === 'kickoff') return target

  if (memo.intent === undefined) {
    const chance = st.kickType === 'extra_point'
      ? XP_MAKE_CHANCE
      : fieldGoalChance(st.fieldGoalDistance ?? yardsToGoal(k) + 17)
    memo.intent = rng() < chance ? 'make' : 'miss'
  }

  return memo.intent === 'make' ? target : (target > 0 ? -MISS_BY : MISS_BY)
}

// Punting from far enough upfield that the ball would otherwise reach the end zone on the roll.
// Inside this the placement is worth more than the extra yards, so the ball gets checked up.
const BACKSPIN_FROM = 55        // own 55 and beyond — the opponent's 45 and in

function wantsBackspin(k) {
  return (k?.yardLine ?? 0) >= BACKSPIN_FROM
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
