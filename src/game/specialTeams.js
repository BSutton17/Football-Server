// ── Special Teams — the unified kicking engine ([Special Teams][1]) ──────────────
//
// Kickoffs, punts, field goals and extra points are ALL the same engine, configured differently.
// Rather than four parallel implementations, every kick is described by a single state object
// (state.specialTeams) plus a declarative per-kind config (KICK_CONFIG). The engine walks that one
// object through a small sub-phase machine; each scenario just supplies different config.
//
// This module is the foundation ([1]): the state container, the config registry, the lifecycle /
// sub-phase machine, and server-authoritative input handling. The actual kick MECHANICS — ball
// flight, returns, make/miss math, and the score/possession consequences — are layered on in the
// per-kick tickets ([2]+), each of which simply reads KICK_CONFIG and fills in the marked hooks.
//
// Authority: the server owns every decision here. The client only sends inputs (aim/power, "kick")
// and renders what serializeSpecialTeams reports.

import { RULES, FIELD, FIELD_CENTER_X } from '../constants.js'
import { PHASE } from './stateMachine.js'
import { MAX_PUSH_YARDS } from './kickEngine.js'

// The four special-teams scenarios.
export const KICK = {
  KICKOFF:     'kickoff',
  PUNT:        'punt',
  FIELD_GOAL:  'field_goal',
  EXTRA_POINT: 'extra_point',
}

// Sub-phases of a special-teams play. These mirror the scrimmage phase flow (pre_snap → live →
// dead) but live on the special-teams object so the engine is self-contained and reusable:
//   SETUP    — teams line up; the kicking team aims and sets power (player input window).
//   KICKING  — the kick is away; the ball (and any return) is live and being resolved by the sim.
//   RESOLVED — the outcome is decided; the result is applied and the next play is set up.
export const ST_PHASE = {
  SETUP:    'setup',
  KICKING:  'kicking',
  RESOLVED: 'resolved',
}

const ST_TRANSITIONS = new Map([
  [ST_PHASE.SETUP,    new Set([ST_PHASE.KICKING])],
  [ST_PHASE.KICKING,  new Set([ST_PHASE.RESOLVED])],
  [ST_PHASE.RESOLVED, new Set()],
])

// ── Per-kind engine config ──────────────────────────────────────────────────────
//
// The heart of the "one engine, configured differently" design. Every kick reads these knobs
// instead of branching on its type. Ticket [1] establishes the declarative facts every kind needs;
// later tickets read the same config to drive the shared mechanics.
//
//   label        — display name for the kicking UI.
//   points       — points scored by a successful kick (FG 3, XP 1; kickoff/punt score nothing).
//   returnable   — whether the receiving team can field and run the ball back.
//   contested    — whether both teams put players on the field (kickoff/punt) vs a protected,
//                  uncontested kick (FG/XP) where the outcome is the kick alone.
//   liveBall     — whether KICKING runs the full movement sim (a returnable kick) or just resolves
//                  the kick attempt (FG/XP).
//   playerControlled — whether the kicking team aims + powers the kick via the meter ([7][8][9]).
//                  Kickoffs are automatic ([5]); punts / FG / XP are player-kicked.
export const KICK_CONFIG = {
  [KICK.KICKOFF]:     { label: 'Kickoff',      points: 0,                returnable: true,  contested: true,  liveBall: true,  playerControlled: false },
  [KICK.PUNT]:        { label: 'Punt',         points: 0,                returnable: true,  contested: true,  liveBall: true,  playerControlled: true  },
  [KICK.FIELD_GOAL]:  { label: 'Field Goal',   points: RULES.FG_POINTS,  returnable: false, contested: false, liveBall: false, playerControlled: true  },
  [KICK.EXTRA_POINT]: { label: 'Extra Point',  points: RULES.XP_POINTS,  returnable: false, contested: false, liveBall: false, playerControlled: true  },
}

// [7][8][9][10] Kicking interface constants.
export const FULL_POWER             = 1     // the power meter starts here (full) and drains toward 0
export const KICK_TIMER_SECONDS     = 3.5   // [8] the kick fires when this timer expires
export const KICK_INACTIVITY_SECONDS = 5    // [8] auto-start the kick timer after this with no input
export const POWER_REFILL_PER_TAP   = 0.02  // [10] every valid directional input adds 2% power back
// [9][10] Power drains a full meter over the kick timer; the player fights it by tapping.
export const POWER_DRAIN_PER_SEC    = FULL_POWER / KICK_TIMER_SECONDS
// [13] The aiming arrow is capped at ±30° from straight ahead. Angle is normalized −1..1 (±1 = ±30°).
export const AIM_MAX_DEGREES        = 30
// [12] Each left/right input nudges the arrow this much (normalized); ~10 presses reach the ±30° cap.
export const AIM_STEP               = 0.1

// [28] After an in-field punt the receiving team picks one of these. (An air touchback or an out-of-
// bounds punt is dead on arrival — no menu, see [29].)
export const PUNT_RETURN = {
  RETURN:        'return',         // field it and run it back
  FAIR_CATCH:    'fair_catch',     // secure it at the catch — no roll, no return
  LET_IT_BOUNCE: 'let_it_bounce',  // don't field it — let it roll (may roll into the end zone)
}
export const PUNT_RETURN_OPTIONS = [PUNT_RETURN.RETURN, PUNT_RETURN.FAIR_CATCH, PUNT_RETURN.LET_IT_BOUNCE]
export const PUNT_RETURN_SECONDS = 5     // [28] decision window before the default is auto-picked

// The auto-pick when the return menu times out: the safe choice — secure the ball at the catch.
export function puntReturnDefault() {
  return PUNT_RETURN.FAIR_CATCH
}

export function isValidPuntReturn(choice) {
  return PUNT_RETURN_OPTIONS.includes(choice)
}

export function getKickConfig(kickType) {
  return KICK_CONFIG[kickType] ?? null
}

export function isValidKickType(kickType) {
  return Object.prototype.hasOwnProperty.call(KICK_CONFIG, kickType)
}

// ── Lifecycle ───────────────────────────────────────────────────────────────────

// Begin a special-teams play. `kickingSlot` is the team that kicks (the other receives); it
// defaults to whoever currently has possession. Returns the new special-teams state.
//
// [7] Kick initialization: a player-controlled kick starts with a FULL power meter, a CENTERED
// aiming arrow, and the kick timer armed (but not running until input / inactivity). An automatic
// kick (kickoff) carries the same fields but the kick clock ignores it.
export function beginSpecialTeams(state, kickType, { kickingSlot } = {}) {
  if (!isValidKickType(kickType)) {
    throw new Error(`[special-teams] unknown kick type: ${kickType}`)
  }
  const slot   = kickingSlot ?? state.possession
  const config = getKickConfig(kickType)
  state.specialTeams = {
    kickType,
    phase:            ST_PHASE.SETUP,
    kickingSlot:      slot,
    playerControlled: config?.playerControlled ?? false,
    // [7][9] Kick variables — full power, centered aim.
    power:            FULL_POWER,   // 1.0; drains over the kick timer ([9]), refilled by inputs ([10])
    angle:            0,            // −1 (full left) … +1 (full right); ±1 = ±30°, 0 = centered ([7][11])
    // [8] Timers — the kick timer is armed; it starts on first input or after the inactivity window.
    started:          false,
    kickTimer:        KICK_TIMER_SECONDS,
    inactivityTimer:  KICK_INACTIVITY_SECONDS,
    // [21] Punt-specific control: backspin checks the ball up (no roll) to pin the opponent deep,
    // versus a flat punt that rolls forward for distance. Only meaningful for punts.
    backspin:         false,
    // [28] Receiving team's return decision (in-field punt only). Armed once the punt lands.
    returnPending:    false,
    returnTimer:      0,
    // [46][49] Defensive FG/XP block — one timing attempt by the defending team.
    blockAttempted:   false,
    blocked:          false,
    // Outcome, filled at RESOLVED by the kick engine.
    result:           null,
  }
  return state.specialTeams
}

export function isSpecialTeamsActive(state) {
  return state.specialTeams != null
}

export function canSTTransition(fromPhase, toPhase) {
  return ST_TRANSITIONS.get(fromPhase)?.has(toPhase) ?? false
}

// Advance the special-teams sub-phase. Throws on an illegal transition so engine bugs surface
// instead of silently corrupting state — mirrors the scrimmage stateMachine.transition contract.
export function advanceSTPhase(state, toPhase) {
  const st = state.specialTeams
  if (!st) throw new Error('[special-teams] no active special-teams play')
  if (!canSTTransition(st.phase, toPhase)) {
    throw new Error(`[special-teams] illegal sub-phase transition: ${st.phase} → ${toPhase}`)
  }
  st.phase = toPhase
  return st
}

// Server-authoritative kick input ([12][14]). The ONLY input is a directional one — `aim: 'left'`
// or `aim: 'right'` (a tap on that half of the screen, or that arrow key). Each one rotates the
// arrow a step ([11][12]), capped at ±30° ([13]), AND restores 2% power ([10]); the kick itself
// fires when the timer expires. Power and timing are owned by the server — clients only send intent.
// The first input starts the kick timer ([8]). Input outside SETUP, from a non-player kick, or from
// the receiving team is rejected (returns false).
export function applyKickInput(state, slot, { aim, backspin } = {}) {
  const st = state.specialTeams
  if (!st || !st.playerControlled || st.phase !== ST_PHASE.SETUP) return false
  if (slot !== st.kickingSlot) return false

  // [21] Punt-specific backspin toggle — a setup choice; it doesn't touch the power meter or timer.
  if (typeof backspin === 'boolean') {
    if (st.kickType !== KICK.PUNT) return false
    st.backspin = backspin
    return true
  }

  const dir = aim === 'left' ? -1 : aim === 'right' ? 1 : 0
  if (dir === 0) return false      // only left/right are valid aim inputs

  st.started = true                                              // [8] first input starts the timer
  st.angle   = clamp(st.angle + dir * AIM_STEP, -1, 1)           // [11][12][13] rotate, capped at ±30°
  st.power   = Math.min(FULL_POWER, st.power + POWER_REFILL_PER_TAP)  // [10] +2% per directional input
  return true
}

export function endSpecialTeams(state) {
  state.specialTeams = null
}

// ── Serialization ───────────────────────────────────────────────────────────────
//
// Viewer-relative snapshot the client renders the kicking UI from. Returns null when no special-
// teams play is active so the client falls back to the normal scrimmage UI.
export function serializeSpecialTeams(state, viewerSlot) {
  const st = state.specialTeams
  if (!st) return null
  const config = getKickConfig(st.kickType)
  return {
    kickType:         st.kickType,
    label:            config?.label ?? st.kickType,
    phase:            st.phase,
    kicking:          st.kickingSlot === viewerSlot,   // is THIS viewer the kicking team?
    returnable:       config?.returnable ?? false,
    points:           config?.points ?? 0,
    playerControlled: st.playerControlled ?? false,
    // [7][8][9] kicking interface state — the client draws the power meter + aim arrow from these.
    power:            st.power,
    angle:            st.angle,
    started:          st.started,
    secondsRemaining: Math.max(0, st.kickTimer ?? 0),
    // [18] For a FG/XP, the aim that splits the (centered) uprights from the current hash — the
    // client shows this as a target so the player knows which way to angle. 0 for punts/kickoffs.
    targetAngle:      fgTargetAngle(state),
    // [41] Official field-goal distance (across the field + the 10-yard end zone + the holder's spot).
    // Shown to BOTH teams during a FG/XP; null for punts/kickoffs.
    fieldGoalDistance: (st.kickType === KICK.FIELD_GOAL || st.kickType === KICK.EXTRA_POINT)
      ? fieldGoalDistance(state)
      : null,
    // [46][49] Defensive block — true once the defender has committed their one timing attempt (the
    // client locks the bar on this).
    blockAttempted:   !!st.blockAttempted,
    // How far the punt actually travelled, shown to BOTH players once the kick is determined.
    kickDistance:     (st.kickType === KICK.PUNT && st.result) ? Math.round(st.result.distance) : null,
    // [21] Punt backspin toggle state (the client shows the control only on a punt).
    backspin:         st.kickType === KICK.PUNT ? !!st.backspin : false,
    // [27] Once the kick is away, what the receiving team is allowed to see. For a punt that's the
    // PROJECTED (air) landing + hang time — the final bounce distance is withheld.
    result:           serializeKickPreview(st),
    // [28][29] The Return / Fair Catch / Let It Bounce menu — only for the receiving team, only while
    // an in-field punt awaits a decision. Null otherwise (an end-zone/OOB punt never gets here).
    returnDecision:   serializeReturnDecision(st, viewerSlot),
  }
}

// [28] The receiving team's punt-return menu. Returned only to the RECEIVING viewer while a decision
// is pending; every listed option is legal ([29] — illegal scenarios never arm the menu).
function serializeReturnDecision(st, viewerSlot) {
  if (!st.returnPending) return null
  const receivingSlot = 1 - st.kickingSlot
  if (viewerSlot !== receivingSlot) return null
  return {
    secondsRemaining: Math.max(0, st.returnTimer ?? 0),
    defaultOption:    puntReturnDefault(),
    options: [
      { id: PUNT_RETURN.RETURN,        label: 'Return',        legal: true },
      { id: PUNT_RETURN.FAIR_CATCH,    label: 'Fair Catch',    legal: true },
      { id: PUNT_RETURN.LET_IT_BOUNCE, label: 'Let It Bounce', legal: true },
    ],
  }
}

// [27] What's revealed about a kick in flight. A punt shows its projected (air) landing spot and
// hang time, but NOT the roll / final downed spot. Other kicks just report their result.
function serializeKickPreview(st) {
  const r = st.result
  if (!r) return null
  if (st.kickType === KICK.PUNT) {
    return {
      kickType:        KICK.PUNT,
      landingYardLine: r.previewLandingYardLine,   // projected AIR landing (receiving frame)
      hangTime:        r.hangTime,
      touchback:       r.touchback,
      outOfBounds:     r.outOfBounds,
    }
  }
  return r
}

// [18] Normalized aim (−1..1) that centers a field goal from where the ball sits laterally.
function fgTargetAngle(state) {
  const st = state.specialTeams
  if (!st || (st.kickType !== KICK.FIELD_GOAL && st.kickType !== KICK.EXTRA_POINT)) return 0
  const offset = FIELD_CENTER_X - (state.ballX ?? FIELD_CENTER_X)
  return Math.max(-1, Math.min(1, offset / MAX_PUSH_YARDS))
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v))
}

// ── Field goal block ([Special Teams][46][47][48][49]) ───────────────────────────
//
// On a FG/XP the defense gets a timing bar: a white indicator sweeps back and forth; the defender
// taps to commit a block at a normalized position 0..1. [48] The bar is split into probability
// regions, arranged symmetrically around the CENTER (the sweet spot):
//   green  — 3% of the bar (a tiny center band) → guaranteed block
//   yellow — 60% (30% either side of green)     → 5% chance
//   red    — 37% (the outer ~18.5% on each end) → no chance
// Half-widths from center: green |pos−0.5| ≤ 0.015; green+yellow ≤ 0.315; beyond = red.
export const FG_BLOCK = {
  GREEN_HALF:  0.015,   // 3% total band
  YELLOW_HALF: 0.315,   // green+yellow span (yellow = 0.315−0.015 each side = 0.60 total)
  GREEN_PROB:  1.0,     // guaranteed
  YELLOW_PROB: 0.05,    // 5%
  RED_PROB:    0,       // no chance
}

export function fgBlockRegion(position) {
  const d = Math.abs(clamp(position, 0, 1) - 0.5)
  if (d <= FG_BLOCK.GREEN_HALF)  return 'green'
  if (d <= FG_BLOCK.YELLOW_HALF) return 'yellow'
  return 'red'
}

export function fgBlockProbability(region) {
  return region === 'green'  ? FG_BLOCK.GREEN_PROB
       : region === 'yellow' ? FG_BLOCK.YELLOW_PROB
       :                       FG_BLOCK.RED_PROB
}

// A defensive block can only be attempted on a player-kicked FG/XP that's still being aimed, once the
// kicker's timer is running ([46]), and only one attempt per kick.
export function canAttemptBlock(state, slot) {
  const st = state.specialTeams
  if (!st) return false
  if (st.kickType !== KICK.FIELD_GOAL && st.kickType !== KICK.EXTRA_POINT) return false
  if (st.phase !== ST_PHASE.SETUP || !st.started || st.blockAttempted) return false
  return slot === (1 - st.kickingSlot)   // only the defending team
}

// ── Fourth-down decision ([Special Teams][2][3][4]) ──────────────────────────────
//
// On 4th down the offense is presented a menu — Go For It, Punt, Field Goal — and must choose
// (or the server auto-picks the default after a timeout). The server is authoritative for both the
// legal options and the timeout, so the two clients never disagree.

export const DECISION = {
  GO_FOR_IT:  'go_for_it',
  PUNT:       'punt',
  FIELD_GOAL: 'field_goal',
}

// [3] The menu auto-resolves to the default after this long if the offense doesn't choose.
export const DECISION_SECONDS = 5

// [4] Legality by field position (offense-relative yardLine, 0 = own goal, 100 = opponent goal):
//   • Field goal — only once the offense has CROSSED midfield (past the 50).
//   • Punt — unavailable once the ball reaches the opponent's 35 (yardLine 65) or beyond.
const FG_MIDFIELD_LINE = 50   // must be past this to attempt a field goal
const PUNT_DEADZONE    = 65   // opponent's 35 — no punts from here in

export function canFieldGoal(state) {
  return state.down === RULES.DOWNS && state.yardLine > FG_MIDFIELD_LINE
}
export function canPunt(state) {
  return state.down === RULES.DOWNS && state.yardLine < PUNT_DEADZONE
}

export function isDecisionLegal(state, option) {
  switch (option) {
    case DECISION.GO_FOR_IT:  return true            // always an option on 4th down
    case DECISION.PUNT:       return canPunt(state)
    case DECISION.FIELD_GOAL: return canFieldGoal(state)
    default:                  return false
  }
}

// The option the server auto-selects if the menu times out. Punt from your own end of the field,
// field goal once a punt is off the table (opponent's 35+). Go For It is never auto-selected — a
// kick is always legal somewhere on a 4th down, so a timeout always yields special teams.
export function decisionDefault(state) {
  if (canPunt(state))      return DECISION.PUNT
  if (canFieldGoal(state)) return DECISION.FIELD_GOAL
  return DECISION.GO_FOR_IT
}

// Straight-line field-goal distance in yards: across the remaining field, the end zone, and the
// holder's spot behind the line of scrimmage. Used by the kick mechanics (later tickets) and the
// menu's distance readout.
export const FG_HOLDER_DEPTH = 7
export function fieldGoalDistance(state) {
  return (100 - state.yardLine) + FIELD.END_ZONE_DEPTH + FG_HOLDER_DEPTH
}

// Viewer-relative 4th-down menu, or null when no decision is pending (or for the defense, which
// doesn't choose). Drives the client menu; the server owns the countdown and the auto-pick.
export function serializeDecision(state, viewerSlot) {
  if (!state.decisionPending) return null
  if (state.possession !== viewerSlot) return null
  return {
    context:          'fourth_down',
    secondsRemaining: Math.max(0, Math.ceil(state.decisionTimer ?? 0)),
    defaultOption:    decisionDefault(state),
    fieldGoalDistance: fieldGoalDistance(state),
    options: [
      { id: DECISION.GO_FOR_IT,  label: 'Go For It',   legal: true },
      { id: DECISION.PUNT,       label: 'Punt',        legal: canPunt(state) },
      { id: DECISION.FIELD_GOAL, label: 'Field Goal',  legal: canFieldGoal(state) },
    ],
  }
}

// Is a 4th-down decision required for this play? (Offense pre-snap, 4th down, not already kicking.)
export function decisionRequired(state) {
  return state.phase === PHASE.PRE_SNAP
    && state.down === RULES.DOWNS
    && !state.specialTeams
}

// ── Extra-point / two-point decision ([Special Teams][51]) ───────────────────────
//
// After a touchdown (worth 6) the SCORING team picks the try: kick an extra point or go for two.
// Server-authoritative timer; defaults to the extra point.
export const CONVERSION = {
  EXTRA_POINT: 'extra_point',
  TWO_POINT:   'two_point',
}

export function conversionDefault() {
  return CONVERSION.EXTRA_POINT
}

export function isValidConversion(option) {
  return option === CONVERSION.EXTRA_POINT || option === CONVERSION.TWO_POINT
}

// The post-TD menu, shown to the SCORING team (which holds possession during the try). Both options
// are always legal. Null otherwise.
export function serializeConversion(state, viewerSlot) {
  if (!state.conversionPending) return null
  if (state.possession !== viewerSlot) return null
  return {
    context:          'conversion',
    secondsRemaining: Math.max(0, Math.ceil(state.conversionTimer ?? 0)),
    defaultOption:    conversionDefault(),
    options: [
      { id: CONVERSION.EXTRA_POINT, label: 'Extra Point', legal: true },
      { id: CONVERSION.TWO_POINT,   label: '2-Pt Try',    legal: true },
    ],
  }
}

