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
const FG_AUTOMATIC_TO = 25      // a kick this short is as close to certain as anything in football
const FG_MAX = 0.99
const FG_NEAR_FALLOFF = 0.010   // per yard from 25 to 45
const FG_LONG_FROM = 45
const FG_LONG_FALLOFF = 0.028   // per yard past 45, where legs start to matter
const FG_FLOOR = 0.02           // never quite impossible

// Chance the AI makes a field goal of this KICK distance. Roughly:
//   30 yd 94%   35 yd 89%   40 yd 84%   45 yd 79%   50 yd 65%   55 yd 51%   60 yd 37%
export function fieldGoalChance(kickDistance) {
  const d = Math.max(0, kickDistance)
  const near = FG_MAX - Math.max(0, Math.min(d, FG_LONG_FROM) - FG_AUTOMATIC_TO) * FG_NEAR_FALLOFF
  const long = Math.max(0, d - FG_LONG_FROM) * FG_LONG_FALLOFF
  return clamp01(Math.max(near - long, FG_FLOOR))
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

  // In range and it is worth more than the down.
  if (legal.has('field_goal') && fgDistance <= 52 && togo > 2) return choose('field_goal')

  // Short yardage in plus territory: take the shot.
  if (legal.has('go_for_it') && togo <= 2 && yardsToGoal(k) <= 45) return choose('go_for_it')

  // Fourth and inches anywhere past midfield.
  if (legal.has('go_for_it') && togo <= 1 && k.yardLine >= 50) return choose('go_for_it')

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

  // Kicking. The meter is tapped up with alternating aim so the angle lands where it was aimed:
  // each tap adds power AND rotates, so an odd number of taps leaves the aim off-centre unless the
  // rotations cancel.
  if (st.kicking && st.phase === 'setup') {
    return { event: 'special_teams_input', payload: { aim: nextTap(st, k, rng) } }
  }

  return null
}

// Which way to tap next. The AI decides ONCE per kick whether this one is going in (at the rate the
// design specified) and then aims accordingly: at the target when it means to make it, deliberately
// wide when it does not. Everything else is just building the meter.
function nextTap(st, k, rng) {
  const target = st.targetAngle ?? 0
  const aim = st.angle ?? 0

  // Decide the outcome once, on the first tap, and remember it on the state the AI owns.
  if (st.__aiIntent === undefined) {
    const chance = st.kickType === 'extra_point'
      ? XP_MAKE_CHANCE
      : fieldGoalChance(st.fieldGoalDistance ?? yardsToGoal(k) + 17)
    st.__aiIntent = rng() < chance ? 'make' : 'miss'
  }

  const wanted = st.__aiIntent === 'make' ? target : (target > 0 ? -0.8 : 0.8)
  return aim < wanted ? 'right' : 'left'
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
