import { PHASE, transition } from './stateMachine.js'
import { RULES } from '../constants.js'
import { getGame, advanceDown, changePossession, yardLineFromAbsY } from './gameState.js'
import { getRoom } from './roomManager.js'
import { serializeClock, serializeScore, serializeGameState, serializeGameOver, serializePlayResult } from './serialization.js'
import { recoverStamina } from './systems/stamina.js'
import { computeReceiverOpenness } from './utils/openness.js'
import { resolvePass } from './utils/passOutcome.js'
import { getRatings, ratingOf } from '../data/ratings.js'

// How long to pause (ms) before the next play begins.
// Quarter transitions get a slightly longer pause so players can see the scoreboard.
const BETWEEN_PLAYS_MS    = 2000
const BETWEEN_QUARTERS_MS = 3000
const HALFTIME_MS         = 4000   // [218] a slightly longer pause between Q2 and Q3

// ── Event types ───────────────────────────────────────────────────────────────
//
// Every meaningful thing that can happen during a play has a name here.
// Other modules import EVENT and call enqueue() — they never handle
// consequences themselves.  All consequences live in the stub handlers below.

export const EVENT = {
  // Client-initiated
  SNAP:              'SNAP',              // offense snapped the ball
  THROW:             'THROW',             // QB threw a pass
  PUNT:              'PUNT',              // offense punted on 4th down

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
    case EVENT.PUNT:              return onPunt(payload, state, io)
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

  const { outcome, reason } = resolvePass({
    openness, qbAccuracy, receiverCatch,
    interceptionEligible: state.throwAtDefender ?? false,
  })

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
}

// payload: { reason? } — [180] incompletion handling. reason is 'broken_up' (defended) or 'drop'
// (open but dropped); absent for a throwaway / no-target miss.
function onPassIncomplete({ reason } = {}, state, io) {
  // Incomplete pass: no gain, the clock stops ([204]), the ball returns to the previous spot,
  // and it's the next down.
  const result = advanceDown(state, 0)
  state.clockStopped = true   // [204] incompletion stops the clock

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
  state.deadBallSpot = { x: absX, y: absY }

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
function onTackle({ x, y, interceptionReturn }, state, io) {
  // [190] Contact ends an interception return: the intercepting team takes over at the spot.
  if (interceptionReturn) { settleInterception(state, io, x, y); return }

  // Record the exact spot the runner was brought down ([162]) — the authoritative dead-ball
  // location that the next LOS, the first-down measurement, and scoring all derive from.
  state.deadBallSpot = { x, y }

  // Spot the ball at that exact location: the new yard line IS the spot's yard line, so
  // forward progress is measured precisely rather than from a rounded delta. Yards gained
  // can be negative on a tackle for loss behind the LOS.
  const spotYardLine = yardLineFromAbsY(state, y)

  // [202] Safety: the ball carrier was brought down in their OWN end zone (spot behind the goal
  // line). Award the safety instead of advancing the ball to a negative yard line (which then
  // broke the next snap's formation/spotting).
  if (spotYardLine < 0) { onSafety({ safetySlot: state.possession }, state, io); return }

  const yardsGained  = spotYardLine - state.yardLine

  const result = advanceDown(state, yardsGained)   // sets state.yardLine = spotYardLine

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

// payload: { scoringSlot, x, y }
function onTouchdown({ scoringSlot }, state, io) {
  // [195] Seven points to the scoring team.
  state.score[scoringSlot] = (state.score[scoringSlot] ?? 0) + 7

  // After the score the team that was scored on receives the kickoff at their own 25 and becomes
  // the offense (direction follows the slot, as at kickoff). This sets possession explicitly
  // rather than via changePossession, because on a defensive-return TD the scoring team is the
  // defense — the receiving team is NOT simply "the other side of the current possession".
  const receivingSlot = 1 - scoringSlot
  state.possession         = receivingSlot
  state.direction          = receivingSlot === 0 ? 1 : -1
  state.yardLine           = RULES.KICKOFF_YARD_LINE
  state.down               = 1
  state.distance           = RULES.FIRST_DOWN_YARDS
  state.interceptionReturn = false
  state.ballCarrierId      = null
  state.clockStopped       = true   // [204] a score stops the clock
  state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.5)

  transition(state, PHASE.DEAD)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      // [196] Dedicated, viewer-relative touchdown event — both clients are notified who scored
      // and the new score. This is the hook future audio/animation (celebration) will key off.
      io.to(socketId).emit('touchdown', { scored: slot === scoringSlot, score: serializeScore(state, slot) })
      io.to(socketId).emit('score_update', serializeScore(state, slot))   // [195] sync both players
      io.to(socketId).emit('play_result', serializePlayResult(state, 'touchdown', 0, receivingSlot, slot))
    })
  }

  notifyRoleSwap(state, io)   // [211] possession changed — swap both players' roles (server + client)

  console.log(`[game] ${state.roomId} TOUCHDOWN slot ${scoringSlot} (+7) — score ${state.score[0]}-${state.score[1]}`)
  beginNextPlay(state.roomId, io)
}

// payload: { safetySlot } — slot that conceded the safety (tackled in its own end zone)
//
// [202] Foundation for safety scoring & possession. A safety awards 2 points to the OTHER team
// and turns the ball over to them; the clock stops. Detection (a carrier downed in its own end
// zone) and the proper free-kick spot are future work — this lays the scoring/possession/clock
// scaffolding the rest builds on, mirroring the touchdown handler.
function onSafety({ safetySlot }, state, io) {
  const scoringSlot = 1 - safetySlot
  state.score[scoringSlot] = (state.score[scoringSlot] ?? 0) + 2

  // The conceding team kicks the ball back to the scoring team (simplified to its own 25 for
  // now; the real free-kick spot comes with full implementation).
  state.possession         = scoringSlot
  state.direction          = scoringSlot === 0 ? 1 : -1
  state.yardLine           = RULES.KICKOFF_YARD_LINE
  state.down               = 1
  state.distance           = RULES.FIRST_DOWN_YARDS
  state.interceptionReturn = false
  state.ballCarrierId      = null
  state.clockStopped       = true   // [204] a score stops the clock
  state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.5)

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

// payload: (none) — [punt] A 4th-down punt. Placeholder model until punters with ratings exist:
// the ball travels 50 yards downfield, or 25 if punting from the opponent's half (a 50-yarder would
// sail through the end zone), then the other team takes over there. The clock stops. Punting from
// inside the opponent's 25 is blocked in validation. This WILL change when punter stats land.
function onPunt(_payload, state, io) {
  const from        = state.yardLine                       // own-goal-relative (0–100)
  const distance    = from > 50 ? 25 : 50
  const landSpot    = from + distance                      // in the punting team's frame
  const newYardLine = Math.max(1, Math.min(99, 100 - landSpot))   // receiving team's frame

  state.clockStopped = true   // [204] a punt (change of possession) stops the clock
  transition(state, PHASE.DEAD)

  const newPossessionSlot = turnover(state, io, newYardLine)

  const room = getRoom(state.roomId)
  if (room) {
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      io.to(socketId).emit('play_result', serializePlayResult(state, 'punt', 0, newPossessionSlot, slot))
    })
  }

  console.log(`[game] ${state.roomId} PUNT from ${from} (${distance} yds) → slot ${newPossessionSlot} ball at ${state.yardLine}`)
  beginNextPlay(state.roomId, io)
}

// payload: (none)
function onTurnoverOnDowns(_payload, _state, _io) {
  // 4th down failed — flip possession at the current yard line.
}

// payload: { qbY, losY, dir }
function onSack({ qbY, losY, dir }, state, io) {
  // [201] A sack ends the play and records the loss of yardage (negative — the QB was behind
  // the LOS). It is an in-bounds play, so the clock keeps running ([204]) unless the sack
  // happened to be a turnover on downs (change of possession), which stops it.

  // [202] Sacked in your own end zone is a safety, not a normal loss.
  if (yardLineFromAbsY(state, qbY) < 0) { onSafety({ safetySlot: state.possession }, state, io); return }

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
    // Halftime: 80% stamina recovery for non-linemen, and swap ends ([217]).
    state.pendingStaminaRecovery = Math.max(state.pendingStaminaRecovery, 0.8)
    state.direction = -state.direction
  }

  io.to(state.roomId).emit('clock_update', serializeClock(state))
  if (state.quarter === 3) io.to(state.roomId).emit('halftime')   // [218] foundation hook

  console.log(`[game] ${state.roomId} end of Q${prev} → Q${state.quarter} begins`)
}

// [219][220] End the game: enter the terminal GAME_OVER phase (no further snaps) and send each
// player the viewer-relative final result (win / loss / tie).
function endGame(state, io) {
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

    transition(state, PHASE.PRE_SNAP)

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
