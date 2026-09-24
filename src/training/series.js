// ── A series of downs, and what it is worth ([series]) ──────────────────────
//
// The episode both AIs are scored on. Four downs from a spot: convert, score, or hand it over.
//
// ⚠️ WHY NOT PER-PLAY YARDS-VS-PAR, WHICH IS WHAT THIS REPLACES.
//
// The old fitness was a pile of numbers I invented — 12 for a turnover, 10 for a touchdown allowed,
// 3 for a sack, 1.2 per bunched pair, all clamped and capped by more numbers I invented. Every one
// is a surface where a genome can win at the proxy instead of at football, and they did exactly
// that twice: a defense that blitzed six on every down because pressure was underpriced, and one
// that piled its whole secondary into one spot because spacing was not priced at all.
//
// A series has an OUTCOME, and the outcome is the real objective. Converting is good. Scoring is
// better. Handing the ball over is bad. There is nothing to mis-weight because there is nothing
// being weighed — no yardage term at all.
//
// ⚠️ AND IT IS ZERO SUM. One number is computed from the offense's point of view and the defense
// gets its negative. Two separately-tuned scoring functions would eventually disagree about who
// won a play, and that disagreement is invisible until it has already taught both sides something
// wrong.

import { playDown, applySituation } from './game.js'
import { startNextPlay, resolveDecision } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'

export const SERIES_VERSION = 'v1'

// Converting is worth this, plus a bonus for doing it EARLY. Taking four downs to gain ten yards
// leaves nothing in hand; doing it on first down keeps the whole series live. The user's rule:
// the earlier the conversion the bigger the reward, and the harsher it is on the defense.
const CONVERT = 10
const EARLY_BONUS = 2          // +6 on 1st down, +4 on 2nd, +2 on 3rd, +0 on 4th

// Scoring ends the argument. A touchdown is worth far more than a conversion; a field goal is a
// consolation that still puts points up.
const TOUCHDOWN = 30
const FIELD_GOAL = 8

// Failing to convert hands the ball over. A giveaway is worse than a punt because it is a stop AND
// a takeaway, so the defense is paid more for it.
const STOP = -10
const TAKEAWAY = -20

// A series that could not be played at all scores ZERO for both sides — never a reward. Otherwise
// breaking the harness becomes a strategy, which is exactly what an earlier fitness accidentally
// made profitable.
export const BROKEN = 0

// What one finished series was worth TO THE OFFENSE. The defense's score is the negative.
export function scoreSeries(result) {
  if (!result.ok) return BROKEN
  switch (result.outcome) {
    case 'touchdown':  return TOUCHDOWN
    case 'field_goal': return FIELD_GOAL
    case 'converted':  return CONVERT + (4 - result.downUsed) * EARLY_BONUS
    case 'turnover':   return TAKEAWAY
    case 'downs':      return STOP
    default:           return STOP
  }
}

// How far the offense may get before the series is called done. A conversion resolves it, so this
// only bounds the pathological case.
const MAX_DOWNS = 4

// Plays one series from a spot and reports how it ended.
//
// The engine owns down, distance and field position between plays — `playDown` snaps from wherever
// the game already is — so this loop only has to decide when the series is over.
export function runSeries(ctx, situation) {
  const { state } = ctx
  applySituation(state, { ...situation, down: 1, distance: 10 })

  const offenseSlot = state.possession
  const startYardLine = state.yardLine
  const plays = []
  let problems = []

  for (let down = 1; down <= MAX_DOWNS; down++) {
    // ⚠️ FOURTH DOWN ARMS THE DECISION MENU, which pauses the play clock and gates the snap until
    // the offense picks punt / field goal / go for it. Without an answer the offense simply never
    // sets and the series dies — every failure in the first working version was exactly this.
    //
    // A four-down series is a test of CONVERTING, so it always goes for it. Punting would end the
    // series without measuring the thing being measured, and it would hand the defense a free
    // "stop" for a decision the offense made rather than for anything it did.
    // `quiet` again: resolveDecision re-syncs in slot order, which wipes the defense exactly as
    // startNextPlay did. playDown emits game_state itself, defense first.
    if (state.decisionPending) resolveDecision(state, ctx.io, 'go_for_it', { quiet: true })

    // The curriculum can demand a run on a given down of the series.
    const force = situation.forceDown === down ? (situation.forcePlayType ?? 'run') : null
    const play = playDown(ctx, force ? { forcePlayType: force } : {})
    plays.push(play)
    problems = problems.concat(play.problems ?? [])

    if (!play.ok) {
      return { ok: false, outcome: 'broken', downUsed: down, plays, problems, startYardLine }
    }

    if (play.outcome === 'touchdown') {
      return { ok: true, outcome: 'touchdown', downUsed: down, plays, problems, startYardLine }
    }
    if (play.turnover) {
      return { ok: true, outcome: 'turnover', downUsed: down, plays, problems, startYardLine }
    }

    // ⚠️ The engine parks in DEAD after a whistle and returns to pre-snap on a 2-second TIMER.
    // A series is played synchronously with no event loop in between, so that timer never fires and
    // every series died on the second down. `startNextPlay` is the timer's own body, called
    // directly — the same code, just not waited for.
    // `quiet`: playDown emits game_state itself, DEFENSE FIRST. Letting this broadcast in slot
    // order instead is what made the defense field nobody on every down after the first.
    if (state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })

    // The engine has already advanced down and distance. A fresh first down means the series was
    // converted — that is the thing being measured, so it ends here rather than rolling on.
    if (state.possession === offenseSlot && state.down === 1) {
      return { ok: true, outcome: 'converted', downUsed: down, plays, problems, startYardLine }
    }
    // Possession changed without a turnover on the play: downs ran out.
    if (state.possession !== offenseSlot) {
      return { ok: true, outcome: 'downs', downUsed: down, plays, problems, startYardLine }
    }
  }

  // Four downs used without converting.
  return { ok: true, outcome: 'downs', downUsed: MAX_DOWNS, plays, problems, startYardLine }
}
