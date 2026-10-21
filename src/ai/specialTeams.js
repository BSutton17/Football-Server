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

import { yardsToGoal, scoreMargin } from './knowledge.js'

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

// ── Fourth down: the expected-points model ───────────────────────────────────────
//
// "Increase the AI's ability to be aggressive and go for it on fourth down when it should. The NFL
// has advanced analytics on going for it on fourth down … consider the distance, where you are on
// the field, the score, the quarter and the time left."
//
// ⚠️ IT USED TO BE A HANDFUL OF THRESHOLDS, AND THEY WERE A 2005 COACH'S. Kick if in range, go only
// on 4th and 2 or less past the opponent's 45, punt otherwise — so 4th and 3 at midfield was a punt
// and 4th and 2 at the 30 was a field goal, both of which the analytics models (nfl4th, the NYT
// 4th-down bot, EdjSports) call wrong. It now does what those models do: price every legal option in
// EXPECTED POINTS and take the best one, then lean that by the scoreboard and the clock.
//
//   go    = P(convert) × value of the new 1st down  −  P(fail) × the opponent's value at this spot
//   kick  = P(make) × 3 points                      −  P(miss) × the opponent's value at the kick spot
//   punt  =                                          −  the opponent's value where the punt leaves them
//
// Every "value" is the expected points of a 1st and 10 at that spot (EP_FIRST_AND_TEN), and a score
// is worth its points less what the other side expects from the kickoff that follows it.

// Expected points of a 1st and 10, by yards to the goal line. The NFL curve: Grantland's published
// anchors (own 20 = 0.34, midfield = 2.04, opponent's 10 = 4.74) with the usual shape between them
// (the Wharton "Go For It?" study's first-down EP curve, nflfastR's model). Linear between points.
const EP_FIRST_AND_TEN = [
  [1, 6.0], [5, 5.3], [10, 4.74], [20, 3.75], [30, 3.15], [40, 2.6], [50, 2.04],
  [60, 1.5], [70, 0.95], [80, 0.34], [90, -0.25], [95, -0.6], [99, -1.0],
]

export function expectedPoints(toGoal) {
  return interpolate(EP_FIRST_AND_TEN, Math.max(1, Math.min(99, toGoal)))
}

// ⚠️ HOW OFTEN A 4TH DOWN IS CONVERTED, AND THIS GAME IS NOT THE NFL. Two curves, blended:
//
//   NFL — Wharton "Go For It?" (NFL play-by-play 2009–19, every 4th-down attempt). 64% on 4th and 1,
//         52% on 2, 48% on 3, and about 4 in 10 out to 7 yards.
//   GAME — measured here, AI against AI at medium, 40 full games, every 4th down gone for
//          (`node scripts/fullGameLab.mjs 40 --conversions`, 3rd and 4th downs pooled, made
//          monotone). Short yardage converts far MORE often than in the NFL — 77% at a yard, 72% at
//          two or three — and then falls off a cliff at ten: 14%, against the NFL's 32%.
//
// Half and half, because the measurement is the computer against the computer and a human defends
// differently; the game's own curve is the truth for this engine, the NFL's is the hedge. Re-measure
// and adjust GAME if the offense or defense changes — this table is what makes the AI aggressive.
const CONVERSION_NFL  = [[1, 0.64], [2, 0.52], [3, 0.48], [4, 0.44], [5, 0.41], [6, 0.41], [7, 0.40], [8, 0.34], [9, 0.34], [10, 0.32], [15, 0.22], [20, 0.12]]
const CONVERSION_GAME = [[1, 0.77], [2, 0.72], [3, 0.72], [4, 0.55], [5, 0.55], [6, 0.50], [7, 0.40], [8, 0.40], [9, 0.40], [10, 0.14], [15, 0.11], [20, 0.06]]
const CONVERSION_GAME_WEIGHT = 0.5

// Near the goal line the field is compressed — no room behind the defense — and anything longer than
// a short-yardage play converts less often than the same distance in the open field. Phased in from
// the 25 to the 10 rather than switched on at the 20, which made 4th and 5 a better bet at the 20
// than at the 19.
const SQUEEZE_FROM = 25
const SQUEEZE_FULL = 10
const RED_ZONE_SQUEEZE = 0.15

export function conversionChance(togo, toGoal = 50) {
  const t = Math.max(1, togo)
  const p = CONVERSION_GAME_WEIGHT * interpolate(CONVERSION_GAME, t)
          + (1 - CONVERSION_GAME_WEIGHT) * interpolate(CONVERSION_NFL, t)
  if (t < 3) return p
  return p * (1 - RED_ZONE_SQUEEZE * clamp01((SQUEEZE_FROM - toGoal) / (SQUEEZE_FROM - SQUEEZE_FULL)))
}

// ⚠️ THE MODEL PRICES A FIELD GOAL AT THE NFL'S MAKE RATE, NOT THE COMPUTER'S. The AI is a perfect
// kicker inside 52 yards by design (FG_BANDS above), but the expected-points curve it is compared
// against is the NFL's, and that curve already has NFL kicking baked into it. Mixing a perfect kicker
// into an NFL curve would make every kick look better than every drive. NFL make rate by kick
// distance (2015–2024 seasons).
const NFL_FG_MAKE = [[20, 0.99], [30, 0.96], [35, 0.93], [40, 0.88], [45, 0.82], [50, 0.74], [55, 0.62], [60, 0.45], [65, 0.25], [70, 0.08]]

// NFL average net punt (gross less the return), and where a short-field punt ends up on average once
// the touchbacks and the ones downed inside the ten are mixed together — about the 13 whether it is
// struck from your own 45 or the opponent's 40.
// ⚠️ A SOFT FLOOR, NOT A HARD ONE. A touchback branch (pin at the 10, but the 20 if it reaches the
// end zone) made a punt from midfield worth more than one from the opponent's 40; a hard floor at the
// 13 still made the own 45 — exactly 41 yards out — a sweet spot that punted on 4th and 3 between two
// spots that went. The closer the landing gets to the goal line, the more of them are touchbacks, so
// the yards bleed away gradually: a 41-yard net from the own 45 is worth the 18, not the 14.
const NET_PUNT_YARDS = 41
const PUNT_PIN_FLOOR = 13
const PUNT_PIN_SOFTNESS = 6

function puntReceiverSpot(toGoal) {
  const landing = toGoal - NET_PUNT_YARDS
  return PUNT_PIN_FLOOR + PUNT_PIN_SOFTNESS * Math.log1p(Math.exp((landing - PUNT_PIN_FLOOR) / PUNT_PIN_SOFTNESS))
}

// What a score is worth once the other side gets the kickoff back (receiving team at its own 30).
const KICKOFF_RECEIVER_EP = expectedPoints(100 - 30)
const TD_VALUE = 7 - KICKOFF_RECEIVER_EP
const FG_VALUE = 3 - KICKOFF_RECEIVER_EP

// The three options in expected points, from the offense's side, with no scoreboard or clock. `toGoal`
// is yards to the opponent's goal line; the opponent's value is read off the same curve from THEIR
// side of the spot.
export function fourthDownValues(toGoal, togo, fgDistance) {
  const p = conversionChance(togo, toGoal)
  const success = togo >= toGoal ? TD_VALUE : expectedPoints(toGoal - togo - 1)
  const go = p * success - (1 - p) * expectedPoints(100 - toGoal)

  const make = interpolate(NFL_FG_MAKE, fgDistance)
  const missSpot = Math.max(20, toGoal + 7)                         // spot of the kick, floor at the 20
  const fieldGoal = make * FG_VALUE - (1 - make) * expectedPoints(100 - missSpot)

  const punt = -expectedPoints(100 - puntReceiverSpot(toGoal))

  return { go, field_goal: fieldGoal, punt, conversion: p }
}

// The model says "go" only when it is clearly better. An expected-points model is an average over
// every team and every defense; inside this margin the two calls are a coin toss and the kick is the
// conventional one. (At 0.3 the 4th-and-3 row went go / punt / punt / punt / go between the own 30
// and the opponent's 45 — every one of those spots sits right on the margin.)
const GO_MARGIN = 0.25

// ── The scoreboard and the clock ─────────────────────────────────────────────────
//
// Expected points is the right currency in the first half. It stops being right late, when what
// matters is winning: behind late, a punt hands the ball back with too little time to get it again,
// and a field goal that does not catch you up is worth less than its three points. Ahead late,
// failing in your own end hands the other side a short field for the score that beats you.
//
// "Late" is a fraction of the GAME, not a number of seconds, because the host sets the quarter length
// (3–6 minutes). It begins with 15% of the game left (3:00 of a five-minute quarter, about nine
// minutes of an NFL game) and is fully on with 3% left (the last 36 seconds).
//
// ⚠️ SQUARED, SO IT ARRIVES LATE AND THEN ALL AT ONCE. Linear, it had the computer going for it on
// 4th and 10 from its own 10, down four with two minutes left — about six NFL minutes, with a
// possession and a half still to come, which no model recommends. Squared, two minutes left is a
// nudge and the last minute is a shove.
const LATE_FROM = 0.15
const LATE_FULL = 0.03

export function gameLateness(k) {
  const quarterSeconds = k.quarterSeconds ?? 300
  const quarter = Math.min(4, k.quarter ?? 1)
  const left = (4 - quarter) * quarterSeconds + Math.max(0, k.clock ?? quarterSeconds)
  const fraction = left / (4 * quarterSeconds)
  return clamp01((LATE_FROM - fraction) / (LATE_FROM - LATE_FULL)) ** 2
}

// Points added to each option, at full lateness. Scaled by lateness, so they are nothing before the
// 4th quarter and everything in the last moments.
const BEHIND_GO_BONUS     = { oneScore: 1.5, twoScores: 3.0 }   // behind by 1–8 / by 9+
const BEHIND_PUNT_PENALTY = 1.5                                  // giving the ball back
const BEHIND_FG_PENALTY   = 2.0                                  // 3 points that do not catch you up
const LEAD_TAKING_FG_BONUS = 2.0                                 // 3 points that tie it or take the lead
const AHEAD_OWN_END_GO_PENALTY = 1.0                             // a short field for the other side

function situational(values, k, toGoal) {
  const margin = scoreMargin(k)
  const late = gameLateness(k)
  const v = { ...values }
  if (late === 0) return v

  // ⚠️ TIED OR WITHIN THREE, THE KICK IS THE LEAD. Without this, down two with two minutes left the
  // computer went for it on 4th and 5 at the 15 instead of kicking the go-ahead field goal — the
  // touchdown is worth more POINTS, but the field goal is worth more GAME.
  if (margin <= 0 && margin >= -3) v.field_goal += late * LEAD_TAKING_FG_BONUS

  if (margin < 0) {
    v.go += late * (margin <= -9 ? BEHIND_GO_BONUS.twoScores : BEHIND_GO_BONUS.oneScore)
    v.punt -= late * BEHIND_PUNT_PENALTY
    // From four or more down a field goal only narrows the gap.
    if (margin <= -4) v.field_goal -= late * BEHIND_FG_PENALTY
  } else if (margin > 0 && toGoal > 50) {
    v.go -= late * AHEAD_OWN_END_GO_PENALTY
  }
  return v
}

// [4th and inches] A yard or less. Past the own 40 a punt is never the answer — the user's rule, and
// the model agrees well before that line; it is kept as a guarantee rather than left to the numbers.
const INCHES_YARDS = 1
const PUNT_FLOOR_YARDLINE = 40

// ── Fourth down ───────────────────────────────────────────────────────────────
export function fourthDownChoice(k, rng = Math.random) {
  const d = k.decision
  if (!d) return null

  const legal = new Set(d.options.filter(o => o.legal).map(o => o.id))
  const togo = k.distance
  const toGoal = yardsToGoal(k)
  const fgDistance = d.fieldGoalDistance ?? (toGoal + 17)
  // ⚠️ THE SCORE IS { offense, defense }, NOT { own, opp } — read it through scoreMargin. This
  // function read `k.score.own` and `k.score.opp`, which the engine never sends, so in a real game
  // the computer believed every game was tied: it never knew it was behind late, and it never went
  // for two. (knowledge.js has the whole story — two other features fell in the same hole.)
  const margin = scoreMargin(k)

  const choose = (id) => ({ event: 'special_teams_choice', payload: { option: id } })

  // A conversion menu after a touchdown comes through the same channel.
  if (d.context === 'conversion') {
    // Two points only when the scoreboard actually calls for it; otherwise take the near-certain
    // point. Chasing two when it does not change the arithmetic is how you lose by one.
    const diff = -margin
    const wantsTwo = diff === 1 || diff === 2 || diff === 5 || diff === 10
    return choose(wantsTwo && k.quarter >= 4 ? 'two_point' : 'extra_point')
  }

  // ⚠️ ASKED ON AN EARLY DOWN, THE ANSWER IS USUALLY "PLAY ON". The menu now opens on any down
  // inside the last thirty seconds of a half, and everything below this point reasons as though it
  // were fourth down — which would have the computer kicking on 1st and 10 with half a minute left
  // and the ball still moving. It takes the points only when there is no time to do better.
  if (k.down !== 4 && legal.has('field_goal')) {
    const noTimeLeft = (k.clock ?? 999) <= ONE_MORE_PLAY_SECONDS
    return choose(noTimeLeft && fgDistance <= 52 ? 'field_goal' : 'go_for_it')
  }

  // ── The last play of a half ─────────────────────────────────────────────────
  // No time for another snap after this one, so expected points no longer apply: there is no "next
  // drive" to be worth anything. Take the points that are on offer, or the touchdown that is needed.
  const lastSnap = (k.clock ?? 999) <= ONE_MORE_PLAY_SECONDS
  if (lastSnap && (k.quarter === 2 || k.quarter === 4)) {
    const fgHelps = k.quarter === 2 || margin >= -3        // ties or wins it, or banks it before the half
    if (legal.has('field_goal') && fgHelps && interpolate(NFL_FG_MAKE, fgDistance) >= 0.3) return choose('field_goal')
    if (k.quarter === 4 && margin < 0) return choose('go_for_it')    // a punt ends the game
    if (legal.has('punt') && margin >= 0) return choose('punt')
    return choose('go_for_it')
  }

  // ── Every other fourth down: price it ───────────────────────────────────────
  const values = situational(fourthDownValues(toGoal, togo, fgDistance), k, toGoal)
  const kicks = ['field_goal', 'punt'].filter(id => legal.has(id))
  const bestKick = kicks.reduce((best, id) => (best && values[best] >= values[id] ? best : id), null)

  // ⚠️ FOURTH AND INCHES PAST THE OWN 40 IS NEVER A PUNT — a field goal can still win it.
  if (togo <= INCHES_YARDS && k.yardLine > PUNT_FLOOR_YARDLINE && bestKick === 'punt' && legal.has('go_for_it')) {
    return choose('go_for_it')
  }

  if (!bestKick) return choose('go_for_it')
  if (legal.has('go_for_it') && values.go > values[bestKick] + GO_MARGIN) return choose('go_for_it')
  return choose(bestKick)
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

// Linear between [x, y] points; flat past either end.
function interpolate(points, x) {
  if (x <= points[0][0]) return points[0][1]
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i]
    if (x > x1) continue
    const [x0, y0] = points[i - 1]
    return y0 + (y1 - y0) * ((x - x0) / (x1 - x0))
  }
  return points[points.length - 1][1]
}
