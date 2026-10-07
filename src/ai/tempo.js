// ── When the offense snaps it ([tempo]) ────────────────────────────────────
//
// The computer used to pick a moment at random — somewhere between 20 and 5 seconds left on the
// play clock — so that a human could not learn its rhythm. That is a fine reason to be
// unpredictable and a terrible reason to be *arbitrary*: it meant a team protecting a one-score
// lead with two minutes left snapped the ball as quickly as a team down seventeen, and the clock,
// which is half of late-game football, was never actually being managed.
//
// This decides the tempo the way a coach does. The framework is the one the author supplied, and it
// reduces to a single question asked from the offense's point of view:
//
//     DOES THE CLOCK RUNNING HELP US OR HURT US?
//
// Leading: it helps — every second that disappears is one the other team cannot score in, so take
// the play clock down to the bone. Trailing: it hurts — snap it and go. Tied: it depends on whether
// there is enough time left for the possession to matter.
//
// ⚠️ THE PLAY CLOCK HERE IS 25 SECONDS (40 on the first snap of a drive), NOT THE NFL'S 40. The
// principles carry over; the numbers do not. Everything below is expressed as a fraction of
// whatever clock is running, so it stays right if those ever change.
//
// ⚠️ AND IT IS STILL NOT A METRONOME. Each tempo carries a spread rather than a fixed number, so the
// rhythm is readable as intent without being a stopwatch a human can set their watch by.

import { AI_SET_LATEST, AI_SET_EARLIEST } from './timing.js'
import { RULES } from '../constants.js'
import { scoreMargin } from './knowledge.js'

// Used only when a knowledge object predates the first game_state.
const DEFAULT_QUARTER_SECONDS = RULES.QUARTER_SECONDS

export const TEMPO = {
  BURN: 'burn',      // milk it — snap as late as the delay-of-game rule allows
  NORMAL: 'normal',  // ordinary rhythm
  HURRY: 'hurry',    // no-huddle — snap and go
}

// Where in the play clock each tempo sets, as SECONDS REMAINING. Setting later burns more game
// clock, because the game clock runs while the offense stands there.
//
// The band for each is what keeps it unpredictable: a coach milking the clock still snaps somewhere
// between "late" and "very late", not at exactly 4.0 every time.
const BANDS = {
  [TEMPO.BURN]: { min: AI_SET_EARLIEST, max: AI_SET_EARLIEST + 3 },
  [TEMPO.NORMAL]: { min: AI_SET_EARLIEST + 4, max: AI_SET_LATEST - 4 },
  [TEMPO.HURRY]: { min: AI_SET_LATEST - 2, max: AI_SET_LATEST },
}

// ⚠️ HURRY CANNOT BE A FIXED PLAY-CLOCK READING, AND AS ONE IT WAS BARELY A HURRY AT ALL.
//
// The band above is an absolute reading, so hurrying meant "set with 18 to 20 seconds showing". On the
// ordinary 25-second play clock that is a five-second wait, which is nearly fine. On the FORTY-FIVE
// second clock of a new drive it is a TWENTY-FIVE SECOND WAIT -- so an offense taking over after a
// kickoff with fifty seconds left in the half, needing points, stood at the line and burned half of
// what it had. The one situation the tempo exists for is the one it handled worst.
//
// Asked for: "when in situations where they need to play very fast (end of a half and down in points)
// allow them to set the offense within 3 seconds". So a hurry is measured from the moment the offense is
// READY rather than from a number on the clock, and it is the same three seconds whatever the play clock
// happens to be.
//
// The jitter stays, for the reason every band here has one: a rhythm a human can time is a rhythm a
// human can jump.
export const HURRY_SET_WITHIN = 3

// The reading to set at when hurrying, given what the play clock says right now.
export function hurrySetTime(playClockNow, rng = Math.random) {
  return Math.max(0, (playClockNow ?? 0) - rng() * HURRY_SET_WITHIN)
}

// A score is a touchdown and the extra point. Two scores is the line at which a team stops managing
// the clock and starts needing possessions.
const ONE_SCORE = 8

// ⚠️ EVERY THRESHOLD IS A FRACTION OF THE QUARTER, NOT A NUMBER OF SECONDS.
//
// A quarter here is three to six minutes; the coaching that these rules come from is written for
// fifteen. Four minutes left in this game is the same part of the game as fifteen minutes left in
// that one, so an absolute "last six minutes" rule would have the offense managing the clock from
// the opening snap of every quarter. The NFL figures below are quoted and then divided by fifteen,
// which is the whole translation.
//
// When the end of a period starts to shape the decision at all. Before this the right answer is
// almost always "play football" — the first and third quarters have no deadline worth hurrying for,
// and burning clock early costs you the drive you were trying to protect.
const LATE_FRACTION = {
  2: 0.17,   // the NFL's last two or three minutes of a half
  4: 0.53,   // the NFL's last eight, where a one-score game is already being managed
}

// Inside this, a trailing team has to move whatever else is true. (The NFL's last two minutes.)
const DESPERATE_FRACTION = 0.13

// How far into the closing stretch a ONE-SCORE deficit starts calling for no-huddle, as a fraction
// of the quarter. (The NFL's five minutes remaining — "shift toward conserving time".)
const ONE_SCORE_HURRY_FRACTION = 0.33

// Roughly what one snap costs in game time at each tempo — used by `possessionsLeft` to answer "is
// there even time for this to matter", which is the question behind hurrying at all.
export const SECONDS_PER_SNAP = { [TEMPO.BURN]: 34, [TEMPO.NORMAL]: 22, [TEMPO.HURRY]: 12 }

// 0 while the period's end is irrelevant, rising to 1 at the whistle.
function lateness(quarter, clock, quarterSeconds) {
  const threshold = (LATE_FRACTION[quarter] ?? 0) * quarterSeconds
  if (!threshold) return 0
  return Math.max(0, Math.min(1, (threshold - clock) / threshold))
}

// ⚠️ THE OFFENSE'S OWN VIEW. `k.score` is already viewer-relative (own / opp), so a positive margin
// means this team is ahead — no need to know which slot anybody is.
export function chooseTempo(k) {
  const quarter = k?.quarter ?? 1
  const quarterSeconds = k?.quarterSeconds ?? DEFAULT_QUARTER_SECONDS
  const clock = k?.clock ?? quarterSeconds
  const margin = scoreMargin(k)
  const late = lateness(quarter, clock, quarterSeconds)
  const desperate = clock <= DESPERATE_FRACTION * quarterSeconds

  // Nowhere near the end of a half: play at an ordinary rhythm. Burning clock in the first quarter
  // buys nothing and costs you snaps; hurrying wastes the one resource you have plenty of.
  if (late <= 0) return TEMPO.NORMAL

  // ── Trailing ────────────────────────────────────────────────────────────
  if (margin < 0) {
    // Down by more than a score, or simply out of time: go.
    if (-margin > ONE_SCORE || desperate) return TEMPO.HURRY
    // Down by one score: go once the period is genuinely closing. There is no sense sprinting with
    // eight minutes left and a normal drive available — but by about five minutes a one-score
    // deficit is a drive-and-a-stop problem, and the seconds between snaps are the ones that run out.
    return clock <= ONE_SCORE_HURRY_FRACTION * quarterSeconds ? TEMPO.HURRY : TEMPO.NORMAL
  }

  // ── Leading ─────────────────────────────────────────────────────────────
  if (margin > 0) {
    // ⚠️ THE SECOND QUARTER IS NOT THE FOURTH. Running the first half out protects nothing: the
    // other team gets the ball after half time whatever happens. The only thing worth doing with a
    // lead late in the second is denying them one more possession before the break, which is only
    // on when it is properly late.
    // Once inside that window at all, denying them one more possession IS the plan, so burn it.
    if (quarter === 2) return late > 0 ? TEMPO.BURN : TEMPO.NORMAL
    return TEMPO.BURN
  }

  // ── Tied ────────────────────────────────────────────────────────────────
  //
  // The clock is neither friend nor enemy until there is only time for one more possession — then
  // it belongs to whoever has the ball, which is us.
  return desperate ? TEMPO.HURRY : TEMPO.NORMAL
}

// ⚠️ HOW FAST TO GET TO THE LINE IS A DIFFERENT QUESTION FROM HOW TO CALL THE PLAY. Requested: "the AI
// offense should not feel rushed to hurry the ball up if the clock is stopped due to a timeout or an
// incomplete pass." The point of hurrying is the game clock running between snaps; with it stopped,
// the seconds spent lining up cost nothing, so a hurry there only throws away the time to set up
// properly. The play CALL still reads the situation (chooseTempo, through tempoRunLean) — trailing
// late is still a reason to throw — only the snap timing relaxes.
export function snapTempo(k) {
  const tempo = chooseTempo(k)
  return tempo === TEMPO.HURRY && k?.clockStopped ? TEMPO.NORMAL : tempo
}

// The play-clock reading to set the formation at, given the tempo. Random inside the band so the
// rhythm cannot be timed.
export function setTimeFor(tempo, rng = Math.random) {
  const band = BANDS[tempo] ?? BANDS[TEMPO.NORMAL]
  return band.min + rng() * (band.max - band.min)
}

// How many more snaps this team can expect out of the remaining clock at a given tempo. Exported
// because it is the honest way to ask "is there time for this to matter" — and because a trailing
// team with two snaps left should be throwing, not managing.
export function snapsLeft(clock, tempo) {
  return Math.floor(Math.max(0, clock) / (SECONDS_PER_SNAP[tempo] ?? SECONDS_PER_SNAP[TEMPO.NORMAL]))
}

// ── What the tempo means for the CALL ──────────────────────────────────────
//
// "This may also affect play calling." It does, and in the direction the tempo already implies: a
// team milking the clock wants the ball on the ground and in bounds, and a team out of time wants it
// in the air and out of bounds. Returned as a multiplier on the run share rather than a play list,
// so it composes with everything the solve already decided about down and distance.
//
// ⚠️ DELIBERATELY MODEST. The solved table is the play-caller; this is a lean on top of it. Turning
// a 15%-run situation into a 60%-run one because the clock says so would throw away the equilibrium
// that makes the offense hard to defend, and a defense that knows you must run is not one you can
// run on.
const BURN_RUN_LEAN = 1.8
const HURRY_RUN_LEAN = 0.35

export function tempoRunLean(tempo) {
  if (tempo === TEMPO.BURN) return BURN_RUN_LEAN
  if (tempo === TEMPO.HURRY) return HURRY_RUN_LEAN
  return 1
}
