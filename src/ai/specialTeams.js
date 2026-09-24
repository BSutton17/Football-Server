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
export const FG_DISTANCE_PENALTY = 1.25     // percentage points lost per yard

// Chance the AI makes a field goal from this spot.
export function fieldGoalChance(distanceToGoal) {
  return clamp01((100 - distanceToGoal * FG_DISTANCE_PENALTY) / 100)
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
