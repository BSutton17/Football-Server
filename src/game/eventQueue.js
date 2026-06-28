import { PHASE, transition } from './stateMachine.js'
import { RULES, FIELD, FIELD_CENTER_X } from '../constants.js'
import { getGame, advanceDown, changePossession, yardLineFromAbsY, getLosY, clampToHash } from './gameState.js'
import {
  DECISION, DECISION_SECONDS, decisionRequired, isDecisionLegal, decisionDefault, fieldGoalDistance,
  KICK, ST_PHASE, beginSpecialTeams, advanceSTPhase, endSpecialTeams, serializeSpecialTeams,
  PUNT_RETURN, PUNT_RETURN_SECONDS, puntReturnDefault, isValidPuntReturn, FG_HOLDER_DEPTH,
  fgBlockRegion, fgBlockProbability, CONVERSION, conversionDefault, isValidConversion,
} from './specialTeams.js'
import { calculateKickResult, computePuntReturn, resolvePuntBounce, DEFAULT_KICK_POWER, DEFAULT_KICK_ACCURACY } from './kickEngine.js'
import { getSpecialist } from '../data/specialists.js'
import { getRoom } from './roomManager.js'
import { serializeClock, serializeScore, serializeGameState, serializeGameOver, serializePlayResult } from './serialization.js'
import { recoverStamina } from './systems/stamina.js'
import { computeReceiverOpenness } from './utils/openness.js'
import { resolvePass, opennessTier } from './utils/passOutcome.js'
import {
  recordPassOutcome, recordScramble, recordPassingTouchdown,
  recordReceiverOutcome, recordTouchdownScorer, recordRun,
  recordDefenderOutcome, findGuardingDB,
  throwCompletionBonus, adjustOpennessForReceiver, applyDefenderOpenness, receiverThrowMods, defenderThrowMods,
  findOffenseQB, resetXFactors, resetDriveProgress, ageXFactorsOneDrive, DEEP_YARDS,
} from './systems/xFactors.js'
import { getRatings, ratingOf } from '../data/ratings.js'

// How long to pause (ms) before the next play begins.
// Quarter transitions get a slightly longer pause so players can see the scoreboard.
const BETWEEN_PLAYS_MS    = 2000
const BETWEEN_QUARTERS_MS = 3000
const HALFTIME_MS         = 4000   // [218] a slightly longer pause between Q2 and Q3
const HALFTIME_YARD_LINE  = 30     // second-half kickoff: receiving offense starts on its own 30

// ── Event types ───────────────────────────────────────────────────────────────
//
// Every meaningful thing that can happen during a play has a name here.
// Other modules import EVENT and call enqueue() — they never handle
// consequences themselves.  All consequences live in the stub handlers below.

export const EVENT = {
  // Client-initiated
  SNAP:              'SNAP',              // offense snapped the ball
  THROW:             'THROW',             // QB threw a pass

  // Detected by movement system
  PASS_COMPLETE:     'PASS_COMPLETE',     // receiver caught the ball
  PASS_INCOMPLETE:   'PASS_INCOMPLETE',   // ball hit the ground
  INTERCEPTION:      'INTERCEPTION',      // defense caught the pass
  TACKLE:            'TACKLE',            // ball carrier brought down
  OUT_OF_BOUNDS:     'OUT_OF_BOUNDS',     // carrier stepped out of bounds
  TOUCHDOWN:         'TOUCHDOWN',         // ball crossed the goal line
  SAFETY:            'SAFETY',            // offense tackled in their own end zone

  // Detected by clock system
  CLOCK_EXPIRED:     'CLOCK_EXPIRED',     // game clock reached zero
  TURNOVER_ON_DOWNS: 'TURNOVER_ON_DOWNS', // failed to convert on 4th down

  // Detected by sack detection system
  SACK:              'SACK',              // defender reached QB behind the LOS
}

// ── Queue storage ─────────────────────────────────────────────────────────────
//
// One queue per room.  Events are plain objects: { type, payload }.
// Payload carries only what the handler needs (IDs, coordinates, etc.).

const queues = new Map()  // Map<roomId, Array<{ type, payload }>>

// Add an event to a room's queue.  Safe to call from any system.
export function enqueue(roomId, type, payload = {}) {
  let q = queues.get(roomId)
  if (!q) {
    q = []
    queues.set(roomId, q)
  }
  q.push({ type, payload })
}

// Drain and process all queued events for a room in the order they arrived.
// Clears the queue before iterating so handlers can safely enqueue follow-up
// events without causing an infinite loop — those fire next tick.
export function processQueue(roomId, state, io) {
  const q = queues.get(roomId)
  if (!q || q.length === 0) return

  const batch = q.splice(0)   // drain atomically

  for (const event of batch) {
    // Once a play ends, skip any remaining events in this batch.
    // Example: if TOUCHDOWN and CLOCK_EXPIRED both arrive in the same tick,
    // the touchdown resolves first and the clock event is ignored.
    if (state.phase === PHASE.DEAD || state.phase === PHASE.GAME_OVER) break

    dispatch(event, state, io)
  }
}

// Remove a room's queue (call when the game is deleted or abandoned).
export function clearQueue(roomId) {
  queues.delete(roomId)
}

// ── Dispatcher ────────────────────────────────────────────────────────────────

function dispatch({ type, payload }, state, io) {
  switch (type) {
    case EVENT.SNAP:              return onSnap(payload, state, io)
    case EVENT.THROW:             return onThrow(payload, state, io)
    case EVENT.PASS_COMPLETE:     return onPassComplete(payload, state, io)
    case EVENT.PASS_INCOMPLETE:   return onPassIncomplete(payload, state, io)
    case EVENT.INTERCEPTION:      return onInterception(payload, state, io)
    case EVENT.TACKLE:            return onTackle(payload, state, io)
    case EVENT.OUT_OF_BOUNDS:     return onOutOfBounds(payload, state, io)
    case EVENT.TOUCHDOWN:         return onTouchdown(payload, state, io)
    case EVENT.SAFETY:            return onSafety(payload, state, io)
    case EVENT.TURNOVER_ON_DOWNS: return onTurnoverOnDowns(payload, state, io)
    case EVENT.CLOCK_EXPIRED:     return onClockExpired(payload, state, io)
    case EVENT.SACK:              return onSack(payload, state, io)
    default:
      console.warn(`[events] unknown event type: ${type}`)
  }
}

// ── Handlers (implemented in later tickets) ───────────────────────────────────
//
// Each handler receives:
//   payload — event-specific data (player IDs, coordinates, etc.)
//   state   — the live game state object (mutate directly)
//   io      — Socket.io server instance (to emit events to clients)

// payload: (none)
function onSnap(_payload, _state, _io) {
  // Transition phase to LIVE, set ballCarrierId to QB.
}

// payload: { receiverId, x, y } — the catch location snapshotted at release ([167])
function onThrow({ receiverId, x, y }, state, io) {
  state.activeThrow   = { receiverId, x, y }
  state.ballCarrierId = null   // ball briefly in the air

  // Tell BOTH clients where the ball is going so each can draw the pass line ([pass-line feedback]);
  // the client clears it after a couple seconds.
  io.to(state.roomId).emit('pass_thrown', { receiverId })

  // [179] Resolve the pass instantly — no ball flight. The outcome is computed from the
  // receiver's openness ([169]–[174]), the QB's accuracy ([177]) and the receiver's hands
  // ([176]); an interception is only possible on a tight (red) window ([178]).
  const receiver = state.offensePlayers.get(receiverId)
  if (!receiver) { enqueue(state.roomId, EVENT.PASS_INCOMPLETE, {}); return }

  const defenders = [...state.defensePlayers.values()]
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }

  const openness      = computeReceiverOpenness(receiver, defenders, qb)
  const qbAccuracy    = qb ? ratingOf(qb, 'accuracy') : getRatings('QB').accuracy
  const receiverCatch = ratingOf(receiver, 'catching')

  // [294] Classify the throw for X-Factor effects/earns. Deep = ≥ DEEP_YARDS past the LOS. The
  // window can be reclassified BEFORE the pass resolves: a WR's ability widens/un-smothers it (High
  // Point, I'm Always F*cking Open), then the guarding DB's Intimidator can shrink the open band.
  const guardingDB  = findGuardingDB(state, receiver)
  const airYards    = (receiver.y - getLosY(state)) * state.direction
  const deep        = airYards >= DEEP_YARDS
  let   effOpenness = adjustOpennessForReceiver(state, receiver, openness, deep)
  effOpenness       = applyDefenderOpenness(state, guardingDB, effOpenness)
  const tier        = opennessTier(effOpenness)

  // Throw-chance modifiers: QB ability (completion) + WR ability (catch + INT) + guarding DB
  // (catch penalty + INT bonus). All fold into resolvePass's completionBonus / intDelta.
  const qbBonus  = throwCompletionBonus(state, qb, { tier, deep })
  const wrMods   = receiverThrowMods(state, receiver, { tier })
  const dbMods   = defenderThrowMods(state, guardingDB, { tier, deep })

  const { outcome, reason } = resolvePass({
    openness: effOpenness, qbAccuracy, receiverCatch,
    completionBonus: qbBonus + wrMods.catchBonus + dbMods.catchBonus,
    intDelta: wrMods.intDelta + dbMods.intDelta,
    interceptionEligible: state.throwAtDefender ?? false,
  })

  // [294] Feed the resolved outcome into every involved player's X-Factor progress (earns + losses):
  // the QB, the targeted receiver, and the DB guarding that receiver.
  recordPassOutcome(state, qb, { outcome, tier, deep, receiverId }, io)
  recordReceiverOutcome(state, receiver, { outcome, reason, tier, deep }, io)
  recordDefenderOutcome(state, guardingDB, { outcome, reason, tier }, io)

  if (outcome === 'complete') {
    enqueue(state.roomId, EVENT.PASS_COMPLETE, { receiverId, x: receiver.x, y: receiver.y })
  } else if (outcome === 'intercepted') {
    // Nearest defender to the target makes the pick.
    let catcher = null, best = Infinity
    for (const d of defenders) {
      const dist = Math.hypot(d.x - receiver.x, d.y - receiver.y)
      if (dist < best) { best = dist; catcher = d }
    }
    enqueue(state.roomId, EVENT.INTERCEPTION, { catcherId: catcher?.id ?? null, x: receiver.x, y: receiver.y })
  } else {
    // reason distinguishes a drop (open window) from a defended break-up so the notice matches.
    enqueue(state.roomId, EVENT.PASS_INCOMPLETE, { reason })
  }
}

// payload: { receiverId, x, y } — x,y is the catch location (receiver position at the catch)
function onPassComplete({ receiverId, x, y }, state, _io) {
  // [182] Record the exact catch location before anything moves — the authoritative spot for
  // first-down measurement and passing statistics.
  state.catchSpot = { x, y }

  // [181] Catch secured — the receiver IMMEDIATELY becomes the ball carrier and the play
  // continues (it runs on until a tackle / out of bounds / score ends it). From here the
  // receiver is driven by the shared ball-carrier model in movement.js, exactly like a runner:
  // its route velocity carries straight into the run with no acceleration reset ([183]).
  state.ballCarrierId    = receiverId
  state.targetReceiverId = null
  state.activeThrow      = null

  // [294] Mark that this play featured a completed pass — onTouchdown reads this to credit a
  // PASSING touchdown (vs a QB scramble TD) toward the QB's X-Factor progress.
  state.passCompletedThisPlay = true
}

// payload: { reason? } — [180] incompletion handling. reason is 'broken_up' (defended) or 'drop'
// (open but dropped); absent for a throwaway / no-target miss.
function onPassIncomplete({ reason } = {}, state, io) {
  // Incomplete pass: no gain, the clock stops ([204]), the ball returns to the previous spot,
  // and it's the next down.
  const result = advanceDown(state, 0)
  state.clockStopped = true   // [204] incompletion stops the clock
  state.prevPlayIncompletePass = true   // [294] Short Term Memory keys off the prior play being an incompletion

  let newPossessionSlot = null
  if (result === 'turnover_on_downs') {
    newPossessionSlot = turnover(state, io)
  }

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) {
        io.to(socketId).emit('play_result', serializePlayResult(
          state, 'incomplete', 0, newPossessionSlot, slot, false, reason ?? null,
        ))
      }
    })
  }

  console.log(`[game] ${state.roomId} INCOMPLETE — ${state.down}&${state.distance} at ${state.yardLine}`)
  beginNextPlay(state.roomId, io)
}

// payload: { catcherId, x, y } — x,y is the interception spot (absolute)
function onInterception({ catcherId, x, y }, state, io) {
  const catcher = catcherId ? state.defensePlayers.get(catcherId) : null

  // No defender to take it (shouldn't happen) — settle immediately as a turnover at the spot.
  if (!catcher) { settleInterception(state, io, x, y); return }

  // [189] Possession transfers the instant of the pick: the intercepting defender becomes the
  // live ball carrier, dropped at the catch spot with fresh carrier state for the vision model.
  catcher.x = x; catcher.y = y; catcher.vx = 0; catcher.vy = 0
  catcher.runLane = null
  catcher.runSpeedCap = null
  catcher.visionTimer = null
  catcher.runElapsed = null
  catcher.pursuitReaction = null

  state.ballCarrierId      = catcher.id
  state.interceptionReturn = true   // [190] play stays LIVE — the return runs until contact
  state.targetReceiverId   = null
  state.activeThrow        = null
  state.tackleEnqueued     = false

  console.log(`[game] ${state.roomId} INTERCEPTION by ${catcher.id} at (${x.toFixed(1)}, ${y.toFixed(1)}) — return live`)
}

// Settles a finished interception: the intercepting team takes over at the spot, possession and
// direction flip, the play goes dead. Shared by the no-returner fallback and the return tackle.
function settleInterception(state, io, absX, absY) {
  state.prevPlayIncompletePass = false   // [294] an interception isn't an incomplete pass
  state.deadBallSpot = { x: absX, y: absY }
  state.ballX        = clampToHash(absX)   // [hash] new offense lines up on the hash at the return spot

  // Spot in the new offense's frame: the same physical point mirrors to (100 − old-frame spot).
  const spotRel = yardLineFromAbsY(state, absY)
  const newPossessionSlot = turnover(state, io, Math.max(0, Math.min(100, 100 - spotRel)))
  state.clockStopped = true   // [204] change of possession stops the clock

  state.interceptionReturn = false
  state.ballCarrierId      = null

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) {
        io.to(socketId).emit('play_result', serializePlayResult(
          state, 'interception', 0, newPossessionSlot, slot,
        ))
      }
    })
  }

  console.log(`[game] ${state.roomId} INTERCEPTION return over — possession → slot ${newPossessionSlot} at ${state.yardLine}`)
  beginNextPlay(state.roomId, io)
}

// payload: { carrierId, x, y, interceptionReturn? }
function onTackle({ carrierId, x, y, interceptionReturn }, state, io) {
  // [190] Contact ends an interception return: the intercepting team takes over at the spot.
  if (interceptionReturn) { settleInterception(state, io, x, y); return }

  state.prevPlayIncompletePass = false   // [294] this play wasn't an incomplete pass

  // Record the exact spot the runner was brought down ([162]) — the authoritative dead-ball
  // location that the next LOS, the first-down measurement, and scoring all derive from.
  state.deadBallSpot = { x, y }
  state.ballX        = clampToHash(x)   // [hash] spot the ball laterally on the nearest hash

  // Spot the ball at that exact location: the new yard line IS the spot's yard line, so
  // forward progress is measured precisely rather than from a rounded delta. Yards gained
  // can be negative on a tackle for loss behind the LOS.
  const spotYardLine = yardLineFromAbsY(state, y)

  // [202] Safety: the ball carrier was brought down in their OWN end zone (spot behind the goal
  // line). Award the safety instead of advancing the ball to a negative yard line (which then
  // broke the next snap's formation/spotting).
  if (spotYardLine < 0) { onSafety({ safetySlot: state.possession }, state, io); return }

  const yardsGained  = spotYardLine - state.yardLine

  // [294] A QB brought down as the ball carrier was a scramble (or designed QB run) — credit the
  // yardage toward Shake It Off's earn condition (a single scramble of ≥10 yds).
  const carrier = carrierId ? state.offensePlayers.get(carrierId) : null
  if (carrier?.label === 'QB') recordScramble(state, carrier, yardsGained, io)

  const result = advanceDown(state, yardsGained)   // sets state.yardLine = spotYardLine

  // [294] A run by an RB ball carrier drives its X-Factor progress (Shifty 20+ yd run, Serious
  // Dedication first downs) and the RB loss trigger (3 consecutive non-positive runs).
  if (carrier?.label === 'RB') {
    recordRun(state, carrier, { yards: yardsGained, firstDown: result === 'first_down' }, io)
  }

  let newPossessionSlot = null
  if (result === 'turnover_on_downs') {
    newPossessionSlot = turnover(state, io)
  }

  // [204] An in-bounds tackle keeps the clock running; a turnover on downs (change of
  // possession) stops it.
  state.clockStopped = result === 'turnover_on_downs'

  transition(state, PHASE.DEAD)

  const reportedYards = Math.round(yardsGained)   // whole yards for the play-result display
  const firstDown = result === 'first_down'        // [224][225] moved the chains
  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) {
        io.to(socketId).emit('play_result', serializePlayResult(
          state, 'tackle', reportedYards, newPossessionSlot, slot, firstDown,
        ))
      }
    })
  }

  console.log(`[game] ${state.roomId} TACKLE — ${reportedYards} yds (${state.down}&${state.distance} at ${state.yardLine})`)
  beginNextPlay(state.roomId, io)
}

// payload: { carrierId, x, y }
function onOutOfBounds({ carrierId }, _state, _io) {
  // Same as tackle but clock stops.
}

// ── Kickoff ([Special Teams][5]) ───────────────────────────────────────────────
//
// After EVERY score, an automatic kickoff: no input, no return. The receiving team (whoever did NOT
// just put points on the board) takes over at its own 30. We enter the unified special-teams state
// ([1]) so both clients show a brief "Kickoff" interstitial, then beginNextPlay clears it and the
// receiving team lines up at the 30. `kickingSlot` is the team kicking off (the scoring team on a
// TD/FG; the conceding team on a safety free-kick). Returns the receiving slot.
function enterKickoff(state, io, kickingSlot) {
  const receivingSlot = 1 - kickingSlot
  state.possession         = receivingSlot
  state.direction          = receivingSlot === 0 ? 1 : -1
  state.yardLine           = RULES.KICKOFF_RESULT_YARD_LINE   // receiving team's own 30
  state.ballX              = FIELD_CENTER_X
  state.down               = 1
  state.distance           = RULES.FIRST_DOWN_YARDS
  state.interceptionReturn = false
  state.ballCarrierId      = null
  state.clockStopped       = true   // a score stops the clock
  state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.5)

  // Automatic kick — straight to KICKING (no aim/power window), cleared by beginNextPlay.
  beginSpecialTeams(state, KICK.KICKOFF, { kickingSlot })
  advanceSTPhase(state, ST_PHASE.KICKING)
  broadcastSpecialTeams(state, io)
  return receivingSlot
}

// payload: { scoringSlot, carrierId, x, y }
function onTouchdown({ scoringSlot, carrierId }, state, io) {
  state.prevPlayIncompletePass = false   // [294] a TD isn't an incomplete pass

  // [51] Reaching the end zone DURING a two-point try is the conversion succeeding — worth 2, then a
  // kickoff. (No nested extra-point decision.)
  if (state.twoPointActive != null) { applyTwoPointResult(state, io, true); return }

  // [294] Credit X-Factor progress for a touchdown by the OFFENSE (not a defensive return).
  if (scoringSlot === state.possession) {
    // A passing TD (the play featured a completed pass) → the QB's universal 2-TD earn path.
    if (state.passCompletedThisPlay) {
      const qb = findOffenseQB(state)
      if (qb) recordPassingTouchdown(state, qb, io)
    }
    // A WR/TE/RB who scored → the skill-player universal earn path (a single TD earns any of their
    // abilities). recordTouchdownScorer ignores a QB scorer (their path is 2 passing TDs).
    const scorer = carrierId ? state.offensePlayers.get(carrierId) : null
    if (scorer) recordTouchdownScorer(state, scorer, io)
  }

  // [51] Six points for the touchdown — the try (extra point or 2-pt) adds the rest.
  state.score[scoringSlot] = (state.score[scoringSlot] ?? 0) + RULES.TD_POINTS

  // [51] The SCORING team keeps the ball to attempt the conversion; arm the XP / 2-pt menu. (For a
  // defensive-return TD the scorer was the defense, so possession flips to them for the try.)
  const defensiveReturnTd = scoringSlot !== state.possession
  state.possession        = scoringSlot
  // A defensive-return TD flips the attacking direction too — the returner ran the OTHER way, so the
  // scoring team now advances toward the opposite goal. Without this, possession and direction
  // disagree and getLosY spots the conversion (and ensuing kickoff) on the WRONG end — e.g. the 2-pt
  // try lands on the scoring team's own 3 instead of the opponent's 3.
  if (defensiveReturnTd) state.direction = -state.direction
  state.conversionPending = true
  state.conversionTimer   = RULES.CONVERSION_SECONDS
  state.clockStopped      = true              // a score stops the clock
  state.ballX             = FIELD_CENTER_X    // reset the lateral spot (the try is centered)
  state.interceptionReturn = false

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      // [196] Dedicated, viewer-relative touchdown event — both clients learn who scored + the score.
      io.to(socketId).emit('touchdown', { scored: slot === scoringSlot, score: serializeScore(state, slot) })
      io.to(socketId).emit('score_update', serializeScore(state, slot))
      io.to(socketId).emit('play_result', serializePlayResult(state, 'touchdown', 0, scoringSlot, slot))
    })
  }

  notifyRoleSwap(state, io)   // possession is now the scoring team (for the try)

  console.log(`[game] ${state.roomId} TOUCHDOWN slot ${scoringSlot} (+6) — conversion pending — score ${state.score[0]}-${state.score[1]}`)
  beginNextPlay(state.roomId, io)
}

// ── Extra-point / two-point conversion ([Special Teams][51][52]) ────────────────
//
// Resolve the scoring team's post-TD choice (or the auto-pick on timeout).
//   [52] EXTRA_POINT → set the field-goal system up from the opponent's 25, ball centered, and let the
//        kicking interface run (executeKick → applyExtraPointOutcome).
//        TWO_POINT  → snap a normal play from the opponent's 2; reaching the end zone is worth 2.
export function resolveConversion(state, io, option) {
  if (!state.conversionPending) return
  if (!isValidConversion(option)) option = conversionDefault()

  state.conversionPending = false
  state.conversionTimer   = 0
  const slot = state.possession

  if (option === CONVERSION.EXTRA_POINT) {
    // [52] Always from the opponent's 25, dead center — independent of where the TD was scored.
    state.yardLine = RULES.XP_YARD_LINE
    state.ballX    = FIELD_CENTER_X
    beginSpecialTeams(state, KICK.EXTRA_POINT, { kickingSlot: slot })
    broadcastSpecialTeams(state, io)
    console.log(`[game] ${state.roomId} conversion: EXTRA POINT — kicking from the opp 25`)
  } else {
    // Two-point try: a single scrimmage play from the opponent's 2. The conversion flag turns a score
    // into +2 (onTouchdown) and any other ending into a failed try (beginNextPlay).
    state.twoPointActive = slot
    state.yardLine       = RULES.TWO_POINT_YARD_LINE
    state.down           = 1
    state.distance       = 100 - RULES.TWO_POINT_YARD_LINE   // goal-to-go from the 2
    state.ballX          = FIELD_CENTER_X
    const room = getRoom(state.roomId)
    if (room) {
      room.players.forEach((socketId, viewerSlot) => {
        if (socketId) io.to(socketId).emit('game_state', serializeGameState(state, viewerSlot))
      })
    }
    console.log(`[game] ${state.roomId} conversion: TWO-POINT TRY — snap from the opp 2`)
  }
}

// Settle a two-point try: +2 on success, nothing on failure, then the scoring team kicks off.
function applyTwoPointResult(state, io, success) {
  const slot = state.twoPointActive
  state.twoPointActive = null
  if (success) state.score[slot] = (state.score[slot] ?? 0) + RULES.TWO_POINT_POINTS

  const receivingSlot = enterKickoff(state, io, slot)   // [5] scoring team kicks off
  // On success we're called mid-play (LIVE); on failure we're already in DEAD (from the play ender).
  if (state.phase !== PHASE.DEAD) transition(state, PHASE.DEAD)
  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, viewerSlot) => {
      if (!socketId) return
      io.to(socketId).emit('score_update', serializeScore(state, viewerSlot))
      io.to(socketId).emit('play_result', serializePlayResult(state, 'two_point', 0, receivingSlot, viewerSlot, false, success ? 'made' : 'missed'))
    })
  }
  notifyRoleSwap(state, io)
  console.log(`[game] ${state.roomId} TWO-POINT ${success ? 'GOOD (+2)' : 'NO GOOD'} slot ${slot} — score ${state.score[0]}-${state.score[1]}`)
  beginNextPlay(state.roomId, io)
}

// An extra point: good per the FG trajectory ([42]). A make scores 1; either way the scoring team
// kicks off afterward.
function applyExtraPointOutcome(state, io, result) {
  state.prevPlayIncompletePass = false
  const kickingSlot = state.possession
  const good        = result.good
  state.clockStopped = true
  if (good) state.score[kickingSlot] = (state.score[kickingSlot] ?? 0) + RULES.XP_POINTS

  const receivingSlot = enterKickoff(state, io, kickingSlot)   // [5] kickoff after the try
  transition(state, PHASE.DEAD)
  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      io.to(socketId).emit('score_update', serializeScore(state, slot))
      io.to(socketId).emit('play_result', serializePlayResult(state, 'extra_point', 0, receivingSlot, slot, false, good ? 'made' : 'missed'))
    })
  }
  notifyRoleSwap(state, io)
  console.log(`[game] ${state.roomId} EXTRA POINT ${good ? 'GOOD (+1)' : 'NO GOOD'} slot ${kickingSlot} — score ${state.score[0]}-${state.score[1]}`)
  beginNextPlay(state.roomId, io)
}

// payload: { safetySlot } — slot that conceded the safety (tackled in its own end zone)
//
// [202] Foundation for safety scoring & possession. A safety awards 2 points to the OTHER team
// and turns the ball over to them; the clock stops. Detection (a carrier downed in its own end
// zone) and the proper free-kick spot are future work — this lays the scoring/possession/clock
// scaffolding the rest builds on, mirroring the touchdown handler.
function onSafety({ safetySlot }, state, io) {
  state.prevPlayIncompletePass = false   // [294]
  const scoringSlot = 1 - safetySlot
  state.score[scoringSlot] = (state.score[scoringSlot] ?? 0) + 2

  // [Special Teams][5] The conceding team free-kicks to the scoring team, which receives at its own
  // 30 (modeled as an automatic kickoff). kickingSlot is the conceding team, so the receiver is the
  // scoring team.
  enterKickoff(state, io, safetySlot)

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      io.to(socketId).emit('score_update', serializeScore(state, slot))
      io.to(socketId).emit('play_result', serializePlayResult(state, 'safety', 0, scoringSlot, slot))
    })
  }

  notifyRoleSwap(state, io)   // [211] possession changed — swap both players' roles (server + client)

  console.log(`[game] ${state.roomId} SAFETY slot ${safetySlot} (+2 → slot ${scoringSlot}) — score ${state.score[0]}-${state.score[1]}`)
  beginNextPlay(state.roomId, io)
}

// ── Kick execution ([Special Teams][6][8]) ─────────────────────────────────────
//
// Run the unified kick engine on the captured power + aim, then hand the raw result to the
// per-type outcome. Called by the kick clock when the player taps Kick or the timer expires.
export function executeKick(state, io) {
  const st = state.specialTeams
  if (!st) return
  advanceSTPhase(state, ST_PHASE.KICKING)

  // [15][16][17] Resolve the kick with the player's input AND the kicker's ratings (Kicker for
  // FG/XP, Punter for punts — defaults until those players exist).
  const isFG = st.kickType === KICK.FIELD_GOAL || st.kickType === KICK.EXTRA_POINT
  const result = calculateKickResult({
    kickType:        st.kickType,
    power:           st.power,
    angle:           st.angle,
    kickerPower:     getKickRating(state, st.kickType, 'power'),
    kickerAccuracy:  getKickRating(state, st.kickType, 'accuracy'),
    yardLine:        state.yardLine,
    requiredDistance: isFG ? fieldGoalDistance(state) : 0,
    ballX:           state.ballX,          // [18] the hash the ball is spotted on
    uprightsX:       FIELD_CENTER_X,       // [18] the goalposts are centered
    backspin:        st.backspin,          // [21] punt backspin toggle
    fieldWidth:      FIELD.WIDTH,          // [24] enables out-of-bounds detection
  })
  st.result = result
  // The kick is away — tell both clients so they freeze the meter and show "KICKED", and so the
  // receiving team sees the punt preview ([27]). Sent now (with the result) before it's applied.
  broadcastSpecialTeams(state, io)

  switch (st.kickType) {
    case KICK.PUNT:
      // [28][29] A punt that comes down IN THE FIELD OF PLAY hands the receiving team a Return /
      // Fair Catch / Let It Bounce choice. A direct-to-end-zone (air) touchback or an out-of-bounds
      // punt is dead on arrival — there's no legal return, so we skip the menu and resolve now ([29]).
      if (result.airTouchback || result.outOfBounds) return applyPuntOutcome(state, io, result)
      return beginPuntReturnDecision(state, io)
    case KICK.FIELD_GOAL:  return applyFieldGoalOutcome(state, io, result)
    case KICK.EXTRA_POINT: return applyExtraPointOutcome(state, io, result)   // [52]
    default: return
  }
}

// [15][16] The kicker's Power / Accuracy rating for this kick, from the KICKING TEAM's real
// specialist: the Punter powers punts, the Kicker powers field goals and extra points. We look up
// the team that's kicking (state.teams[kickingSlot]) in the specialist table; falls back to a
// default if the team/data is missing.
function getKickRating(state, kickType, which) {
  const fallback    = which === 'power' ? DEFAULT_KICK_POWER : DEFAULT_KICK_ACCURACY
  const kickingSlot = state.specialTeams?.kickingSlot ?? state.possession
  const teamId      = state.teams?.[kickingSlot]
  const specialist  = getSpecialist(teamId, kickType === KICK.PUNT ? 'punter' : 'kicker')
  const r           = specialist?.[which]
  return typeof r === 'number' ? r : fallback
}

// A punt downed on arrival — an air touchback ([25]) or out of bounds ([24]). The clock stops and the
// receiving team takes over: [38] a touchback spots them at their own 20, an OOB punt at the crossing.
function applyPuntOutcome(state, io, result) {
  state.prevPlayIncompletePass = false
  const from = state.yardLine

  state.clockStopped = true
  state.ballX        = FIELD_CENTER_X
  transition(state, PHASE.DEAD)

  // [38] All punt touchbacks spot the receiving offense at its own 20.
  const spot = result.touchback ? RULES.TOUCHBACK_YARD_LINE : result.landingYardLine
  const newPossessionSlot = turnover(state, io, spot)

  // [24] An out-of-bounds punt is downed where it crossed the sideline; flag it for the play notice.
  const detail = result.outOfBounds ? 'out_of_bounds' : result.touchback ? 'touchback' : null
  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) io.to(socketId).emit('play_result', serializePlayResult(state, 'punt', 0, newPossessionSlot, slot, false, detail))
    })
  }
  const tag = result.outOfBounds ? ', out of bounds' : result.touchback ? ', touchback' : ''
  console.log(`[game] ${state.roomId} PUNT from ${from} (${result.distance.toFixed(0)} yds${tag}) → slot ${newPossessionSlot} at ${state.yardLine}`)
  beginNextPlay(state.roomId, io)
}

// [28] An in-field punt — arm the receiving team's Return / Fair Catch / Let It Bounce menu. The
// play stays in flight (ST phase KICKING) while the kick clock ticks the decision timer; the menu
// auto-resolves to the default if it expires (runKickClock → resolvePuntReturn).
function beginPuntReturnDecision(state, io) {
  const st = state.specialTeams
  st.returnPending = true
  st.returnTimer   = PUNT_RETURN_SECONDS
  broadcastSpecialTeams(state, io)   // now carries the return menu for the receiving team
  console.log(`[game] ${state.roomId} PUNT in play — receiving team decides (default ${puntReturnDefault()})`)
}

// Returner ability — a stand-in until per-team returner players exist (mirrors the kicker/punter
// defaults). [31] feeds it into the return calculation.
const DEFAULT_RETURNER_RATING = 75

// [28] Resolve the receiving team's punt choice (or the auto-pick on timeout). All spots are in the
// RECEIVING team's frame (own goal 0 → opponent goal 100): a return ADDS yards (toward the opponent),
// a forward roll SUBTRACTS them (toward the receiving goal).
//   [30] Fair Catch    → downed at the catch (the air landing), AT the landing spot — no roll, no return.
//   [31] Return        → run back via computePuntReturn (hang time + returner + punter + randomness);
//   [32]                 a rare (~1%) breakaway is a return touchdown.
//   [33] Let It Bounce → the ball rolls 0–10 yds toward the receiving goal; [34] backspin checks it
//                        back 1–5; a roll into the end zone is a touchback.
// Server-authoritative — an invalid choice falls back to the default. `rng` is injectable for tests.
export function resolvePuntReturn(state, io, choice, rng = Math.random) {
  const st = state.specialTeams
  if (!st || !st.returnPending) return
  if (!isValidPuntReturn(choice)) choice = puntReturnDefault()

  st.returnPending = false
  st.returnTimer   = 0
  const r          = st.result
  const airLanding = r.previewLandingYardLine                 // the catch / air-landing spot
  const clampSpot  = v => Math.max(1, Math.min(99, Math.round(v)))
  // [30] Default the next snap to the lateral spot the ball was caught on (nearest hash).
  const landingX   = r.landingX != null ? clampToHash(r.landingX) : FIELD_CENTER_X

  let spot, detail, ballX = FIELD_CENTER_X
  switch (choice) {
    case PUNT_RETURN.FAIR_CATCH:
      // [30] End the play right at the landing location — no return yardage, no bounce.
      spot = clampSpot(airLanding); detail = 'fair_catch'; ballX = landingX; break

    case PUNT_RETURN.RETURN: {
      // [31][32] Run it back. A breakaway takes it all the way — score it as a return touchdown.
      const { yards, touchdown } = computePuntReturn({
        hangTime:       r.hangTime,
        returnerRating: DEFAULT_RETURNER_RATING,
        punterPower:    getKickRating(state, KICK.PUNT, 'power'),
      }, rng)
      if (touchdown) {
        onTouchdown({ scoringSlot: 1 - st.kickingSlot, carrierId: null }, state, io)   // [32]
        console.log(`[game] ${state.roomId} PUNT RETURN TOUCHDOWN — slot ${1 - st.kickingSlot}`)
        return
      }
      spot = clampSpot(airLanding + yards); detail = 'return'; break
    }

    case PUNT_RETURN.LET_IT_BOUNCE:
    default: {
      // [33] Roll forward; [34] backspin checks it back; [37] a no-backspin roll that stops inside the
      // opponent's 8 is a touchback (it would trickle into the end zone) unless backspin kept it out.
      const bounce = resolvePuntBounce({ airLanding, backspin: !!r.backspin }, rng)
      if (bounce.touchback) { spot = RULES.TOUCHBACK_YARD_LINE; detail = 'touchback' }   // [38] own 20
      else                  { spot = bounce.yardLine; detail = null }
      break
    }
  }
  applyPuntReturnOutcome(state, io, spot, detail, choice, ballX)
}

// Shared spotter for a decided in-field punt: hand the ball to the receiving team at `spotYardLine`,
// stop the clock, notice the result, and set up the next play.
function applyPuntReturnOutcome(state, io, spotYardLine, detail, choice, ballX = FIELD_CENTER_X) {
  state.prevPlayIncompletePass = false
  const from = state.yardLine

  state.clockStopped = true
  state.ballX        = ballX
  transition(state, PHASE.DEAD)

  const newPossessionSlot = turnover(state, io, spotYardLine)
  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) io.to(socketId).emit('play_result', serializePlayResult(state, 'punt', 0, newPossessionSlot, slot, false, detail))
    })
  }
  console.log(`[game] ${state.roomId} PUNT ${choice} from ${from} → slot ${newPossessionSlot} at ${state.yardLine}`)
  beginNextPlay(state.roomId, io)
}

// A field goal. [43] A make (between the uprights AND with the leg to clear the bar — result.good)
// scores 3 and is followed by a kickoff. [44] A miss (wide left / wide right / short — result.miss
// Reason) is an immediate dead ball, no return; [45] the opponent takes over at the spot of the kick.
function applyFieldGoalOutcome(state, io, result) {
  state.prevPlayIncompletePass = false
  const kickingSlot = state.possession
  const required    = fieldGoalDistance(state)
  const good        = result.good
  state.clockStopped = true

  if (good) {
    state.score[kickingSlot] = (state.score[kickingSlot] ?? 0) + RULES.FG_POINTS
    const receivingSlot = enterKickoff(state, io, kickingSlot)   // [5] kickoff after the score
    transition(state, PHASE.DEAD)
    const room = getRoom(state.roomId)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (!socketId) return
        io.to(socketId).emit('score_update', serializeScore(state, slot))
        io.to(socketId).emit('play_result', serializePlayResult(state, 'field_goal', 0, receivingSlot, slot, false, 'made'))
      })
    }
    notifyRoleSwap(state, io)
    console.log(`[game] ${state.roomId} FIELD GOAL GOOD slot ${kickingSlot} (+3, ${required} yd) — score ${state.score[0]}-${state.score[1]}`)
  } else {
    // [44][45] Missed (wide left / wide right / short) — an immediate dead ball, no return. Standard
    // NFL spot: the opponent takes over at the SPOT OF THE KICK (the holder, 7 yds behind the LOS),
    // but no closer to their own goal than the 20.
    state.ballX = FIELD_CENTER_X
    transition(state, PHASE.DEAD)
    const kickSpot = 100 - (state.yardLine - FG_HOLDER_DEPTH)   // spot of the kick, receiving frame
    const spot     = Math.min(99, Math.max(RULES.MISSED_FG_MIN_YARD_LINE, kickSpot))
    const newPossessionSlot = turnover(state, io, spot)
    const detail = result.missReason ?? 'missed'               // [44] wide_left | wide_right | short
    const room = getRoom(state.roomId)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (socketId) io.to(socketId).emit('play_result', serializePlayResult(state, 'field_goal', 0, newPossessionSlot, slot, false, detail))
      })
    }
    console.log(`[game] ${state.roomId} FIELD GOAL MISSED (${detail}, ${required} yd) → slot ${newPossessionSlot} at ${state.yardLine}`)
  }
  beginNextPlay(state.roomId, io)
}

// [49][53] Resolve the defense's FG/XP block attempt. The defender commits a timing tap at a
// normalized bar position; the region under it ([48]) sets the block chance — the SERVER rolls it
// ([50]) so both players see the same outcome. A blocked field goal is a turnover on downs; a blocked
// extra point just scores nothing and is followed by a kickoff. A failed attempt is consumed (one per
// kick) and the kick plays on. The caller (socket handler) has validated it's the defender (canAttemptBlock).
export function resolveFieldGoalBlock(state, io, position, rng = Math.random) {
  const st = state.specialTeams
  if (!st || st.blockAttempted) return
  st.blockAttempted = true

  const region  = fgBlockRegion(position)
  const blocked = rng() < fgBlockProbability(region)
  st.blocked    = blocked
  broadcastSpecialTeams(state, io)   // lock the bar on both clients

  if (!blocked) {
    console.log(`[game] ${state.roomId} FG block attempt — ${region}, NOT blocked; kick plays on`)
    return                            // kick clock keeps running → executeKick at timer expiry
  }

  // Blocked → dead ball. The kick never fires (transitioning out of PRE_SNAP stops the kick clock).
  state.prevPlayIncompletePass = false
  state.clockStopped = true
  state.ballX        = FIELD_CENTER_X
  const room = getRoom(state.roomId)

  if (st.kickType === KICK.EXTRA_POINT) {
    // [53] A blocked extra point scores nothing; the kicking (scoring) team still kicks off — exactly
    // like a missed extra point, NOT a turnover on downs.
    const kickingSlot   = state.possession
    const receivingSlot = enterKickoff(state, io, kickingSlot)
    transition(state, PHASE.DEAD)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (!socketId) return
        io.to(socketId).emit('play_result', serializePlayResult(state, 'extra_point', 0, receivingSlot, slot, false, 'blocked'))
      })
    }
    notifyRoleSwap(state, io)
    console.log(`[game] ${state.roomId} EXTRA POINT BLOCKED (${region}) — no point, kickoff`)
  } else {
    // [49] A blocked field goal is a turnover on downs — the opponent takes over at the LOS.
    transition(state, PHASE.DEAD)
    const newPossessionSlot = turnover(state, io)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (socketId) io.to(socketId).emit('play_result', serializePlayResult(state, 'field_goal', 0, newPossessionSlot, slot, false, 'blocked'))
      })
    }
    console.log(`[game] ${state.roomId} FIELD GOAL BLOCKED (${region}) → turnover on downs to slot ${newPossessionSlot} at ${state.yardLine}`)
  }
  beginNextPlay(state.roomId, io)
}

// payload: (none)
function onTurnoverOnDowns(_payload, _state, _io) {
  // 4th down failed — flip possession at the current yard line.
}

// [delay of game] The play clock hit zero — a 5-yard penalty on the offense. The LOS moves back (no
// further than the 1, half-the-distance near the goal), the distance grows by the same, the SAME down
// is replayed, and the play clock resets to 25. e.g. 1st & 10 → 1st & 15. Stays in PRE_SNAP so the
// offense re-lines up (the formation slides back with the LOS on the next game_state).
export function applyDelayOfGame(state, io) {
  const back = Math.min(RULES.DELAY_OF_GAME_YARDS, Math.max(0, state.yardLine - 1))
  const oldLosY = getLosY(state)
  state.yardLine -= back
  state.distance += back

  // Slide the already-placed formations back with the LOS so the next snap lines up on the new spot.
  // (The offense re-sends its formation on Set, but the defense never re-places — without this its
  // players would snap from the OLD line, 5 yards off. Players are stored in absolute Y, so shift by
  // the absolute-Y change of the line.)
  const losShift = getLosY(state) - oldLosY
  if (losShift !== 0) {
    for (const p of state.offensePlayers?.values() ?? []) p.y += losShift
    for (const p of state.defensePlayers?.values() ?? []) p.y += losShift
  }

  state.playClock        = RULES.PLAY_CLOCK_SECONDS
  state.playClockRunning = true
  state.newDrive         = false

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      io.to(socketId).emit('game_state', serializeGameState(state, slot))   // LOS back, new down & distance
      io.to(socketId).emit('play_clock_expired')                            // → "Delay of game" notice
    })
  }
  console.log(`[game] ${state.roomId} DELAY OF GAME (−${back}) → ${state.down} & ${state.distance} at ${state.yardLine}`)
}

// [Special Teams][1] Push the viewer-relative special-teams state to both players.
export function broadcastSpecialTeams(state, io) {
  const room = getRoom(state.roomId)
  if (!room) return
  room.players.forEach((socketId, slot) => {
    if (socketId) io.to(socketId).emit('special_teams_update', serializeSpecialTeams(state, slot))
  })
}

// ── 4th-down decision ([Special Teams][2][3][4]) ───────────────────────────────
//
// Resolve the offense's 4th-down choice (or the auto-pick when the menu times out). Server-
// authoritative: an illegal option falls back to the default. Go For It resumes normal pre-snap;
// Punt / Field Goal hand off to the unified kicking engine — they enter the special-teams SETUP so
// the offense aims + powers the kick ([6][7][8][9]); the kick clock resolves it.
export function resolveDecision(state, io, option) {
  if (!state.decisionPending) return
  if (!isDecisionLegal(state, option)) option = decisionDefault(state)

  state.decisionPending = false
  state.decisionTimer   = 0
  const roomId = state.roomId

  if (option === DECISION.PUNT || option === DECISION.FIELD_GOAL) {
    const kickType = option === DECISION.PUNT ? KICK.PUNT : KICK.FIELD_GOAL
    beginSpecialTeams(state, kickType, { kickingSlot: state.possession })
    broadcastSpecialTeams(state, io)
    console.log(`[game] ${roomId} 4th-down decision: ${option} — kicking interface up`)
  } else {
    // Go For It — resume normal pre-snap; re-sync so the menu clears and the play clock runs.
    const room = getRoom(roomId)
    if (room) {
      room.players.forEach((socketId, slot) => {
        if (socketId) io.to(socketId).emit('game_state', serializeGameState(state, slot))
      })
    }
    console.log(`[game] ${roomId} 4th-down decision: GO FOR IT`)
  }
}

// Arm (or clear) the 4th-down menu for the upcoming snap. Called from beginNextPlay AFTER the play
// is set up in PRE_SNAP, so the game_state it then emits carries the menu. While decisionPending is
// true the play clock is paused (runPlayClock) and the offense can't set/snap (validation).
function maybeStartDecision(state) {
  // [51] The post-TD extra-point / 2-pt menu owns this pre-snap — never overlay the 4th-down menu.
  if (state.conversionPending) { state.decisionPending = false; state.decisionTimer = 0; return }
  state.decisionPending = decisionRequired(state)
  state.decisionTimer   = state.decisionPending ? DECISION_SECONDS : 0
  if (state.decisionPending) {
    console.log(`[game] ${state.roomId} 4th down — decision menu (default ${decisionDefault(state)})`)
  }
}

// payload: { qbY, losY, dir, qbX }
function onSack({ qbY, losY, dir, qbX }, state, io) {
  // [201] A sack ends the play and records the loss of yardage (negative — the QB was behind
  // the LOS). It is an in-bounds play, so the clock keeps running ([204]) unless the sack
  // happened to be a turnover on downs (change of possession), which stops it.

  // [202] Sacked in your own end zone is a safety, not a normal loss.
  if (yardLineFromAbsY(state, qbY) < 0) { onSafety({ safetySlot: state.possession }, state, io); return }

  state.prevPlayIncompletePass = false   // [294] a sack isn't an incomplete pass
  if (qbX != null) state.ballX = clampToHash(qbX)   // [hash] spot the ball laterally where the QB was downed

  const yardsGained = Math.round((qbY - losY) * dir)

  const result = advanceDown(state, yardsGained)

  let newPossessionSlot = null
  if (result === 'turnover_on_downs') {
    newPossessionSlot = turnover(state, io)
  }

  state.clockStopped = result === 'turnover_on_downs'   // [201][204] running clock unless it's a turnover

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) {
        io.to(socketId).emit('play_result', serializePlayResult(
          state, 'sack', yardsGained, newPossessionSlot, slot,
        ))
      }
    })
  }

  console.log(`[game] ${state.roomId} SACK — ${yardsGained} yds (${state.down}&${state.distance} at ${state.yardLine})`)
  beginNextPlay(state.roomId, io)
}

// payload: (none) — [216] end of a quarter (or the game).
//
// The clock can run out mid-play (LIVE) or between plays on a running clock (PRE_SNAP /
// COUNTDOWN, [204]). Funnel whichever phase we're in through DEAD so the period transition is
// uniform, then either advance the quarter or end the game.
function onClockExpired(_payload, state, io) {
  if (state.phase === PHASE.LIVE || state.phase === PHASE.PRE_SNAP || state.phase === PHASE.COUNTDOWN) {
    transition(state, PHASE.DEAD)
  }

  if (state.quarter >= RULES.QUARTERS) {
    endGame(state, io)
    return
  }

  const enteringHalftime = state.quarter === 2   // Q2 → Q3
  advanceQuarter(state, io)
  // [218] Halftime gets a slightly longer pause than a normal quarter break.
  beginNextPlay(state.roomId, io, enteringHalftime ? HALFTIME_MS : BETWEEN_QUARTERS_MS)
}

// [216] Advance to the next quarter, preserving possession, field position, down & distance.
// [217] At halftime the teams switch ends (the field direction flips) while score and roles are
// untouched — since rendering is offense-relative, both teams keep attacking toward the top.
// [218] Emits a halftime event the client can later hang halftime UI / stats off.
function advanceQuarter(state, io) {
  const prev = state.quarter
  state.quarter++
  state.clock = RULES.QUARTER_SECONDS
  state.clockStopped = true   // [204] the new quarter's clock is stopped until the next snap

  if (state.quarter === 3) {
    // Halftime: 80% stamina recovery for non-linemen, and a full field reset for the second-half
    // kickoff. The team that started the game on DEFENSE now receives — possession flips to the
    // opening-defense slot (regardless of who had the ball when the half ended), the ball is spotted
    // on that offense's own 30, and it's a fresh 1st & 10 drive.
    state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.8)
    state.possession = 1 - state.openingPossession
    state.direction  = state.possession === 0 ? 1 : -1
    state.yardLine   = HALFTIME_YARD_LINE
    state.down       = 1
    state.distance   = RULES.FIRST_DOWN_YARDS
    state.ballX      = FIELD_CENTER_X
    state.newDrive   = true   // fresh drive: longer play clock + defensive adjust window
    notifyRoleSwap(state, io)  // possession flipped — push each client its new role + update server roles
    resetXFactors(state, io)   // [294] every X-Factor and all earn progress is wiped at the half
  }

  io.to(state.roomId).emit('clock_update', serializeClock(state))
  if (state.quarter === 3) io.to(state.roomId).emit('halftime')   // [218] foundation hook

  console.log(`[game] ${state.roomId} end of Q${prev} → Q${state.quarter} begins`)
}

// [219][220] End the game: enter the terminal GAME_OVER phase (no further snaps) and send each
// player the viewer-relative final result (win / loss / tie).
function endGame(state, io) {
  resetXFactors(state, io)   // [294] wipe X-Factors at game end
  transition(state, PHASE.GAME_OVER)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (socketId) io.to(socketId).emit('game_over', serializeGameOver(state, slot))
    })
  }

  console.log(`[game] ${state.roomId} final — slot0: ${state.score[0]}, slot1: ${state.score[1]}`)
}

// ── Turnover handling ([192]) ───────────────────────────────────────────────────
//
// A turnover — an interception ([189]) or a failure on downs — flips possession AND swaps
// both teams' offense/defense roles. changePossession updates the authoritative server state
// (possession, direction, field position, down & distance); notifyRoleSwap then pushes each
// client its NEW role over switch_sides so the UI follows the ball. Always call turnover()
// rather than changePossession() directly so the role swap can never be forgotten.
// [211] The one possession-swap system. Every play that changes who has the ball — interception,
// turnover on downs, touchdown, safety — calls this after setting state.possession. For each
// player it (1) updates the AUTHORITATIVE server-side role (socket.data.role) so the validators
// accept the new offense's set/snap/throw and the new defense's coverage, and (2) emits
// switch_sides so the client adopts its new role. Both players switch responsibilities in place,
// without leaving the game.
function notifyRoleSwap(state, io) {
  resetDriveProgress(state)   // [294] possession changed → the offense's drive ended (Serious Dedication per-drive count)
  ageXFactorsOneDrive(state, io)   // a new drive begins — age active X-Factors, expiring any past the 3-drive cap
  state.newDrive = true       // [play-clock] a possession change begins a new drive → 40 s play clock next snap
  const room = getRoom(state.roomId)
  if (!room) return
  room.players.forEach((socketId, slot) => {
    if (!socketId) return
    const role = state.possession === slot ? 'offense' : 'defense'
    const sock = io.sockets?.sockets?.get(socketId)   // (mock io in tests has no socket registry)
    if (sock?.data) sock.data.role = role
    io.to(socketId).emit('switch_sides', { role })
  })
}

function turnover(state, io, newYardLine = null) {
  changePossession(state, newYardLine)
  notifyRoleSwap(state, io)
  return state.possession
}

// ── Shared play-reset helper ──────────────────────────────────────────────────
//
// Called after any play ends (tackle, incomplete pass, quarter transition, etc.).
// Waits delayMs, then clears all the stuff that only belongs to one play
// (player positions, who has the ball) and moves back to PRE_SNAP so both
// teams can line up again.
//
// Re-fetches the game state inside the timeout — if the game was abandoned
// during the delay, the lookup returns null and we exit cleanly.
function beginNextPlay(roomId, io, delayMs = BETWEEN_PLAYS_MS) {
  setTimeout(() => {
    const state = getGame(roomId)
    if (!state || state.phase !== PHASE.DEAD) return

    // [51] A two-point try that ended without reaching the end zone is a FAILED conversion (a score
    // clears twoPointActive in onTouchdown before this runs). No points; the scoring team kicks off.
    // We're already in DEAD, so applyTwoPointResult stages the kickoff and reschedules this.
    if (state.twoPointActive != null) { applyTwoPointResult(state, io, false); return }

    // [216] Safety net: if the clock ran out at the exact end of this play, the play-ending event
    // pre-empted CLOCK_EXPIRED in the queue. Resolve the period end here rather than lining up
    // with a dead clock. (When onClockExpired handled it directly the clock is already reset > 0.)
    if (state.clock <= 0) {
      if (state.quarter >= RULES.QUARTERS) { endGame(state, io); return }
      advanceQuarter(state, io)
    }

    // Apply any pending stamina recovery (possession change = 0.5, Q3 = 0.8).
    if (state.pendingStaminaRecovery > 0) {
      recoverStamina(state, state.pendingStaminaRecovery)
      state.pendingStaminaRecovery = 0
    }

    // Wipe everything that was specific to the play that just ended
    state.offensePlayers        = new Map()
    state.defensePlayers        = new Map()
    state.ballCarrierId         = null
    state.targetReceiverId      = null
    state.deadBallSpot          = null
    state.catchSpot             = null
    state.qbScrambling          = false
    state.interceptionReturn    = false
    state.activeThrow           = null
    state.tick                  = 0
    state.qbPressureCount       = 0
    state.qbUnderHeavyPressure  = false
    state.sackEnqueued          = false
    state.tackleEnqueued        = false
    state.passCompletedThisPlay = false   // [294] per-play: did this play feature a completed pass
    state.qbSackImmunity        = 0       // [294] Shake It Off grace window resets each play
    endSpecialTeams(state)                // [Special Teams][5] clear the kickoff (or any kick) interstitial

    // [play-clock] Reset the play clock for the upcoming snap: 40 s on the first play of a drive
    // (the offense needs time to drag its formation in), 25 s on every other play. newDrive is left
    // set through this play's pre-snap + countdown (the defense gets a longer adjust window on a fresh
    // drive) and is cleared at the snap.
    state.playClock        = state.newDrive ? RULES.PLAY_CLOCK_NEW_DRIVE : RULES.PLAY_CLOCK_SECONDS
    state.playClockRunning = true

    transition(state, PHASE.PRE_SNAP)

    // [Special Teams][2][3] Arm the 4th-down menu before the game_state below goes out (so it
    // carries the menu). Pauses the play clock and gates set/snap until the offense chooses.
    maybeStartDecision(state)

    // Send the full game state to each player so their screens reflect
    // the current quarter, clock, down, distance, and field position
    const room = getRoom(roomId)
    if (!room) return

    room.players.forEach((socketId, slot) => {
      if (socketId) {
        io.to(socketId).emit('game_state', serializeGameState(state, slot))
      }
    })

    console.log(`[game] ${roomId} Q${state.quarter} — ready for next snap (${state.down}&${state.distance} at ${state.yardLine})`)
  }, delayMs)
}
