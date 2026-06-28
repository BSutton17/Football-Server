import { RULES, FIELD, HASH, FIELD_CENTER_X } from '../constants.js'
import { PHASE } from './stateMachine.js'

// ── Coordinate system ────────────────────────────────────────────────────────
//
// Absolute field coordinates (used for all player/ball positions):
//   x — yards from west sideline (0 → 53.33)
//   y — yards from south end-zone back line (0 → 120)
//       y=0  : south end-zone back wall
//       y=10 : south goal line
//       y=110: north goal line
//       y=120: north end-zone back wall
//
// yardLine — offense-relative (0 = own goal line, 100 = opponent goal line).
// direction — which absolute-y direction the current offense is advancing:
//   +1: offense goes toward higher y (northward)
//   -1: offense goes toward lower  y (southward)
// Slot 0 starts going north; slot 1 starts going south.
// Both flip whenever possession changes.
//
// ── Score ────────────────────────────────────────────────────────────────────
//
// score[0] and score[1] are each slot's total points for the game.
// The client expects { offense, defense } relative to the viewer's slot.
// Use getScoreFor(state, viewerSlot) before emitting score_update.
//
// ── Field players ────────────────────────────────────────────────────────────
//
// offensePlayers / defensePlayers: Map<playerId, FieldPlayer>
//
//   FieldPlayer: { id, x, y, vx, vy }
//     x, y  — absolute position, yards
//     vx,vy — velocity, yards/sec (both 0 during pre_snap)

// gameStates: Map<roomId, GameState>
const gameStates = new Map()

export function initGame(roomId, offenseSlot) {
  const state = {
    roomId,

    // ── Phase & clock ────────────────────────────────────────────────────────
    phase: PHASE.PRE_SNAP,
    quarter: 1,
    clock: RULES.QUARTER_SECONDS, // 300

    // [204] Whether the game clock is currently stopped between plays. The clock always runs
    // during LIVE; between plays it keeps running ONLY after plays that don't stop it (in-bounds
    // tackles, sacks) and is frozen after ones that do (incompletions, scores, change of
    // possession, quarter end). Starts stopped — the clock doesn't move until the first snap.
    clockStopped: true,

    // ── Possession & direction ───────────────────────────────────────────────
    possession: offenseSlot,
    direction: offenseSlot === 0 ? 1 : -1,

    // ── Field position (offense-relative) ───────────────────────────────────
    yardLine: RULES.KICKOFF_YARD_LINE,  // 25
    down: 1,
    distance: RULES.FIRST_DOWN_YARDS,   // 10

    // ── Score indexed by slot ────────────────────────────────────────────────
    score: [0, 0],

    // ── Active field players for this play ──────────────────────────────────
    offensePlayers: new Map(),   // Map<playerId, FieldPlayer>
    defensePlayers: new Map(),   // Map<playerId, FieldPlayer>

    // ── Ball tracking ────────────────────────────────────────────────────────
    ballCarrierId: null,      // player holding the ball; null when airborne or dead
    targetReceiverId: null,   // throw target; set on snap_ball → throw_to_receiver

    // In-flight pass ([167]): { receiverId, x, y } — the intended receiver and the catch
    // location (the receiver's position at release). Null when no pass is in the air.
    activeThrow: null,

    // Exact spot (absolute {x, y}) where the last completed pass was caught ([182]).
    // Recorded the instant a catch is secured; the basis for first-down measurement and
    // future passing statistics. Null until a pass is completed.
    catchSpot: null,

    // [184][185] True once the offense converts the QB into a runner on a pass play.
    // Irreversible for the rest of the play: it locks out throwing and routes the QB
    // through the shared ball-carrier model.
    qbScrambling: false,

    // [189][190] True while an intercepting defender is returning the ball. The ball is loose
    // to the defense: ballCarrierId points at a defensePlayers entry, the return runs through
    // the shared ball-carrier model (running AGAINST state.direction), and the original offense
    // becomes the pursuit. The formal possession/spot change happens when the returner is
    // contacted (see onTackle). Reset between plays.
    interceptionReturn: false,

    // Exact spot (absolute {x, y}) where the last runner was brought down ([162]).
    // Authoritative dead-ball location: drives the next line of scrimmage, the first-down
    // measurement, and whether the spot crossed a goal line for scoring. Null until a play
    // ends with a tackle.
    deadBallSpot: null,

    // [hash] Lateral spot of the ball for the NEXT snap (absolute X). Set when a play ends: a tackle/
    // sack/interception spots it ON the nearest hash if it ended outside the hashes, otherwise at the
    // exact spot; a score/safety/punt resets it to center (kickoff). Persists across the play
    // boundary so the next formation lines up on it. Sent to clients in game_state.
    ballX: FIELD_CENTER_X,

    // ── Special teams ([Special Teams][1]) ───────────────────────────────────
    // null during normal scrimmage plays; set to the unified kicking-engine descriptor while a
    // kickoff / punt / field goal / extra point is in progress. See game/specialTeams.js.
    specialTeams: null,

    // [Special Teams][2][3] 4th-down decision menu. While decisionPending is true, normal pre-snap
    // is paused (the offense must choose Go For It / Punt / Field Goal); decisionTimer counts down
    // from DECISION_SECONDS and the server auto-picks the default at 0.
    decisionPending: false,
    decisionTimer:   0,

    // [Special Teams][51] Post-touchdown extra-point / 2-pt menu (scoring team), then the active 2-pt
    // try. conversionPending pauses pre-snap like the 4th-down menu; twoPointActive flags a 2-pt play.
    conversionPending: false,
    conversionTimer:   0,
    twoPointActive:    null,

    // ── Play design (set when offense locks formation) ───────────────────────
    // playDesign: { playType, runAngle, players: [{ id, x, y, label, team, route?, routeDepthScale? }] }
    playDesign: null,

    // ── Defensive coverage assignments ───────────────────────────────────────
    // Map<defenderId, { type, targetId, zoneType, zoneCenterX, zoneCenterY }>
    //   type        — 'man' | 'zone' | 'blitz' | 'spy'
    //   targetId    — receiver ID (man only), else null
    //   zoneType    — 'flat' | 'deep' | 'curl' | 'hook' (zone only), else null
    //   zoneCenterX — zone center X in yards (zone only), else null
    //   zoneCenterY — zone center Y in yards (zone only), else null
    defenseCoverage: new Map(),

    // ── Play clock ───────────────────────────────────────────────────────────
    // Counts down during PRE_SNAP. Pauses when offense presses Set (transition to COUNTDOWN).
    // Reset on each new play: 40 s on the first play of a drive (time to set the formation),
    // 25 s otherwise. The opening snap of the game is a drive start, so it begins at 40.
    playClock:        RULES.PLAY_CLOCK_NEW_DRIVE,
    playClockRunning: true,

    // True when the upcoming snap is the first of a drive (set on any possession change). Consumed
    // by beginNextPlay to pick the 40 s play clock, then cleared. The opening play uses the 40 s
    // initial value above, so this starts false.
    newDrive: false,

    // ── Player fatigue ───────────────────────────────────────────────────────
    // Persists across plays (NOT reset in resetPlay).
    // Map<playerId, { stamina: 0–100, label }>
    playerFatigue: new Map(),

    // Fraction of lost stamina to recover at the start of the next play.
    // Set to 0.5 on possession change, 0.8 at Q3. Consumed and cleared in beginNextPlay.
    pendingStaminaRecovery: 0,

    // ── Per-tick pressure state (written by runPressureDetection) ────────────
    qbPressureCount:      0,
    qbUnderHeavyPressure: false,

    // Simulation tick counter for the current play (0 at snap). Used by run debug logging.
    tick: 0,

    // Guard: prevents multiple SACK events from firing in one play.
    sackEnqueued: false,

    // Guard: prevents multiple TACKLE events from firing in one play.
    tackleEnqueued: false,

    // ── X-Factors ([294]) ─────────────────────────────────────────────────────
    // Per-player ability progress + active state, keyed by playerId. Persists across plays within
    // a half; wiped entirely at half-time and game end (resetXFactors). See systems/xFactors.js.
    xFactors: new Map(),

    // True when the play that just ended was an incomplete pass — Short Term Memory reads this on
    // the NEXT throw. Set by the terminal play handlers; carries across the play boundary.
    prevPlayIncompletePass: false,

    // True once a completed pass happened this play (so a TD can be classed as a passing TD).
    // Reset each play.
    passCompletedThisPlay: false,

    // Seconds of sack immunity remaining after a Shake It Off escape (rusher is shoved off and the
    // QB can't be re-sacked for this window). Reset each play.
    qbSackImmunity: 0,
  }

  gameStates.set(roomId, state)
  return state
}

export function getGame(roomId) {
  return gameStates.get(roomId) ?? null
}

export function deleteGame(roomId) {
  gameStates.delete(roomId)
}

// ── Derived helpers ──────────────────────────────────────────────────────────

// Absolute Y coordinate of the line of scrimmage.
export function getLosY(state) {
  return state.direction === 1
    ? FIELD.END_ZONE_DEPTH + state.yardLine              // 10 + yardLine
    : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - state.yardLine  // 110 - yardLine
}

// [hash] Spot the ball laterally: a dead-ball X outside a hash mark is pulled IN to that hash; an X
// between the hashes is kept. The result is the lateral origin the next formation lines up on.
export function clampToHash(x) {
  return Math.max(HASH.LEFT, Math.min(HASH.RIGHT, x))
}

// Inverse of getLosY: the offense-relative yard line (0–100) of an absolute y position.
// Used to spot the ball from the exact dead-ball location ([162]). Values < 0 lie in the
// offense's own end zone (a safety), > 100 in the opponent's (a touchdown).
export function yardLineFromAbsY(state, absY) {
  return state.direction === 1
    ? absY - FIELD.END_ZONE_DEPTH
    : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - absY
}

// Score in the format the client expects: { offense, defense } from viewerSlot's POV.
// offense = the viewer's own accumulated points; defense = the opponent's.
export function getScoreFor(state, viewerSlot) {
  return {
    offense: state.score[viewerSlot],
    defense: state.score[1 - viewerSlot],
  }
}

// Resets per-play fields for the start of a new snap (clears placed players and ball state).
// Does NOT change score, clock, down/distance, or yardLine — those persist across plays.
export function resetPlay(state) {
  state.phase            = PHASE.PRE_SNAP
  state.offensePlayers   = new Map()
  state.defensePlayers   = new Map()
  state.ballCarrierId    = null
  state.targetReceiverId = null
  state.catchSpot        = null
  state.qbScrambling     = false
  state.interceptionReturn = false
  state.playDesign       = null
  state.defenseCoverage  = new Map()
  state.playClock        = 25
  state.playClockRunning = true
}

// Advances down and distance after a play ends.
//
// yardsGained — positive means the offense moved forward; negative means they
//               were pushed back (sack, etc.).
//
// Returns one of three outcomes the caller must act on:
//   'first_down'        — offense crossed the marker; down resets to 1 & 10
//   'continue'          — offense didn't make it but still has downs left
//   'turnover_on_downs' — 4th down failed; caller should enqueue that event
//                         so changePossession can run
// Distance for a fresh set of downs: normally 10, but goal-to-go once the 10-yard marker would
// land in/past the end zone — there the goal line IS the marker, so the distance is the yards left
// to the goal ([1st & Goal]).
function firstDownDistance(yardLine) {
  return Math.min(RULES.FIRST_DOWN_YARDS, 100 - yardLine)
}

export function advanceDown(state, yardsGained) {
  state.yardLine += yardsGained

  if (yardsGained >= state.distance) {
    state.down     = 1
    state.distance = firstDownDistance(state.yardLine)
    return 'first_down'
  }

  state.distance -= yardsGained

  if (state.down >= RULES.DOWNS) {
    // 4th down failed — leave state.down at 4 so the play result is readable;
    // changePossession (called by the TURNOVER_ON_DOWNS handler) resets it to 1.
    return 'turnover_on_downs'
  }

  state.down++
  return 'continue'
}

// The yard line the offense needs to reach for a first down.
// Computed from current state — not stored separately.
export function getFirstDownLine(state) {
  return state.yardLine + state.distance
}

// Commits the throw target on the first receiver tapped during a pass play ([165]).
// The decision then LOCKS: once a target is set, later taps are ignored ([166]) so the
// offense can't change its mind after the pass is committed. Returns true if THIS tap set
// the target (the caller should then launch the throw), false if one was already chosen.
export function commitThrowTarget(state, receiverId) {
  if (state.targetReceiverId != null) return false   // [166] already committed — ignore
  state.targetReceiverId = receiverId                // [165] first tap wins
  return true
}

// Throw target system ([167]): resolves the intended receiver and the catch location for a
// pass. The ball is aimed where the receiver IS at the instant of release — its position is
// snapshotted here (by value, not held by reference), with no lead. Returns
// { receiverId, x, y }, or null if the receiver is no longer on the field.
export function resolveThrowTarget(state, receiverId) {
  const receiver = state.offensePlayers.get(receiverId)
  if (!receiver) return null
  return { receiverId, x: receiver.x, y: receiver.y }
}

// Transfers the ball to the other team.
//
// newYardLine — where to spot the ball from the NEW offense's perspective (0–100).
//   • Omit (or pass null) for turnovers: the ball stays at the same physical spot,
//     which is automatically mirrored to the new offense's yard-line view.
//   • Pass RULES.KICKOFF_YARD_LINE (25) after a touchdown or safety, where the
//     new offense always starts from their own 25.
//
// Every possession change also flips direction (+1 ↔ -1) so the simulation
// always knows which absolute-y direction the current offense is advancing.
export function changePossession(state, newYardLine = null) {
  state.possession = 1 - state.possession
  state.direction  = -state.direction
  state.yardLine   = newYardLine ?? (100 - state.yardLine)
  state.down       = 1
  state.distance   = firstDownDistance(state.yardLine)
  // Both teams switch roles — non-linemen recover 50% of lost stamina next play.
  state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.5)
}
