import { FIELD, ROUTE_TYPES, COVERAGE_TYPES, ZONE_TYPES } from '../constants.js'
import { PHASE } from './stateMachine.js'
import { getGame } from './gameState.js'

// ── Return convention ─────────────────────────────────────────────────────────
//
// Every exported function returns:
//   null          — input is valid, action may proceed
//   string        — human-readable reason the action was rejected
//
// Callers check once: if (err) { reject(); return }
// The game state is never modified unless validation returns null.

// ── Private helpers ───────────────────────────────────────────────────────────

// Fetch the game state for the socket's current room.
// Returns the state object, or null if the socket has no room / no game.
function resolveState(socket) {
  const roomId = socket.data?.roomId
  if (!roomId) return null
  return getGame(roomId) ?? null
}

function checkGame(socket) {
  return resolveState(socket) ? null : 'No active game found for this room'
}

function checkPhase(state, ...allowed) {
  if (!allowed.includes(state.phase)) {
    return `Action not available in current phase (${state.phase})`
  }
  return null
}

function checkRole(socket, expected) {
  if (socket.data?.role !== expected) {
    return `Only the ${expected} team can do this`
  }
  return null
}

function checkString(value, fieldName) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return `${fieldName} must be a non-empty string`
  }
  return null
}

function checkNumber(value, fieldName, min, max) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    return `${fieldName} must be a number between ${min} and ${max}`
  }
  return null
}

// Run checks in order and return the first failure, or null if all pass.
function first(...checks) {
  for (const c of checks) if (c !== null) return c
  return null
}

// ── Exported validators ───────────────────────────────────────────────────────

// place_player — each team may only place their own players during pre_snap.
// payload: { id, x, y, label, team }
export function validatePlacePlayer(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const { id, x, y, label, team } = payload ?? {}
  const expectedTeam = socket.data?.role === 'offense' ? 'o' : 'd'

  const isDefense = socket.data?.role === 'defense'
  return first(
    isDefense ? checkPhase(state, PHASE.PRE_SNAP, PHASE.COUNTDOWN) : checkPhase(state, PHASE.PRE_SNAP),
    checkString(id, 'id'),
    checkNumber(x, 'x', 0, FIELD.WIDTH),
    checkNumber(y, 'y', 0, FIELD.LENGTH),
    checkString(label, 'label'),
    team !== expectedTeam ? `team must be "${expectedTeam}" for your role` : null,
  )
}

// remove_player — each team may only remove their own players during pre_snap.
// payload: id string
export function validateRemovePlayer(socket, id) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const isDefense = socket.data?.role === 'defense'
  const baseErr = first(
    isDefense ? checkPhase(state, PHASE.PRE_SNAP, PHASE.COUNTDOWN) : checkPhase(state, PHASE.PRE_SNAP),
    checkString(id, 'id'),
  )
  if (baseErr) return baseErr

  const myMap = socket.data?.role === 'offense' ? state.offensePlayers : state.defensePlayers
  if (!myMap.has(id)) return 'Player not found or does not belong to your team'

  return null
}

// assign_route — offense only, during pre_snap.
// payload: { playerId, route, stemDepth? }
export function validateAssignRoute(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const { playerId, route, stemDepth } = payload ?? {}

  const baseErr = first(
    checkPhase(state, PHASE.PRE_SNAP),
    checkRole(socket, 'offense'),
    checkString(playerId, 'playerId'),
  )
  if (baseErr) return baseErr

  if (!ROUTE_TYPES.has(route)) return `Unknown route type: "${route}"`

  if (stemDepth !== undefined) {
    const stemErr = checkNumber(stemDepth, 'stemDepth', 0.1, 30)
    if (stemErr) return stemErr
  }

  return null
}

// set_offense — offense locks formation with full play design.
// payload: { playType, runAngle, players }
export function validateSetOffense(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const base = first(
    checkPhase(state, PHASE.PRE_SNAP),
    checkRole(socket, 'offense'),
  )
  if (base) return base

  // [Special Teams][2] Normal play is paused until the 4th-down decision (Go For It) is made.
  if (state.decisionPending) return 'Make your 4th-down decision first'
  // [Special Teams][51] …and until the post-touchdown extra-point / 2-pt choice is made.
  if (state.conversionPending) return 'Choose your extra-point try first'

  const { playType, runAngle, players } = payload ?? {}
  if (playType !== 'run' && playType !== 'pass') return 'playType must be "run" or "pass"'

  const angleErr = checkNumber(runAngle, 'runAngle', -60, 60)
  if (angleErr) return angleErr

  if (!Array.isArray(players)) return 'players must be an array'

  return null
}

// assign_coverage — defense only.
// Allowed during pre_snap AND countdown (defense adjusts up to the snap).
// payload: { playerId, type, targetId?, zoneType?, zoneCenterX?, zoneCenterY? }
export function validateAssignCoverage(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const { playerId, type, targetId, zoneType, zoneCenterX, zoneCenterY } = payload ?? {}

  const baseErr = first(
    checkPhase(state, PHASE.PRE_SNAP, PHASE.COUNTDOWN),
    checkRole(socket, 'defense'),
    checkString(playerId, 'playerId'),
  )
  if (baseErr) return baseErr

  if (!COVERAGE_TYPES.has(type)) return `Unknown coverage type: "${type}"`

  if (type === 'man') {
    if (targetId === undefined) return 'man coverage requires targetId'
    const targetErr = checkString(targetId, 'targetId')
    if (targetErr) return targetErr
  }

  if (type === 'zone') {
    if (zoneType === undefined) return 'zone coverage requires zoneType'
    if (!ZONE_TYPES.has(zoneType)) return `Unknown zone type: "${zoneType}"`
    if (zoneCenterX !== undefined) {
      const xErr = checkNumber(zoneCenterX, 'zoneCenterX', 0, FIELD.WIDTH)
      if (xErr) return xErr
    }
    if (zoneCenterY !== undefined) {
      const yErr = checkNumber(zoneCenterY, 'zoneCenterY', 0, FIELD.LENGTH)
      if (yErr) return yErr
    }
  }

  return null
}

// clear_coverage — defense only; removes all coverage assignment for one defender.
// payload: { playerId }
export function validateClearCoverage(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'
  const { playerId } = payload ?? {}
  return first(
    checkPhase(state, PHASE.PRE_SNAP, PHASE.COUNTDOWN),
    checkRole(socket, 'defense'),
    checkString(playerId, 'playerId'),
  )
}

// assign_safety_help — defense only.
// payload: { safetyId, targetDefenderId } — targetDefenderId null clears the assignment.
export function validateAssignSafetyHelp(socket, payload) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const { safetyId, targetDefenderId } = payload ?? {}

  const baseErr = first(
    checkPhase(state, PHASE.PRE_SNAP, PHASE.COUNTDOWN),
    checkRole(socket, 'defense'),
    checkString(safetyId, 'safetyId'),
  )
  if (baseErr) return baseErr

  if (targetDefenderId !== null && targetDefenderId !== undefined) {
    const targetErr = checkString(targetDefenderId, 'targetDefenderId')
    if (targetErr) return targetErr
  }

  return null
}

// snap_ball — offense only, must be in countdown phase.
export function validateSnapBall(socket) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  return first(
    checkPhase(state, PHASE.COUNTDOWN),
    checkRole(socket, 'offense'),
  )
}

// throw_to_receiver — offense only, during live play.
// payload: receiverId string
const THROW_ELIGIBLE = new Set(['WR', 'TE', 'RB'])

export function validateThrowToReceiver(socket, receiverId) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const baseErr = first(
    checkPhase(state, PHASE.LIVE),
    checkRole(socket, 'offense'),
    checkString(receiverId, 'receiverId'),
  )
  if (baseErr) return baseErr

  // Throws only happen on a pass play, and only to an eligible receiver on the field.
  if (state.playDesign?.playType !== 'pass') return 'Can only throw on a pass play'

  // The QB has been sacked this play — reject the throw (it arrives in the brief window between the
  // sack firing and the phase flipping to dead; without this the late throw can crash the sim).
  if (state.sackEnqueued) return 'Cannot throw — the QB was sacked'

  // [185] Once the QB commits to a scramble the decision is irreversible — no more throws.
  if (state.qbScrambling) return 'Cannot throw after committing to a scramble'

  const receiver = state.offensePlayers.get(receiverId)
  if (!receiver) return 'Receiver not found'
  if (!THROW_ELIGIBLE.has(receiver.label)) return 'That player is not an eligible receiver'

  return null
}

// throw_at_defender — the offense throws it straight at a defender (an immediate interception).
// Same live-pass gating as a normal throw, but the target must be a defender on the field.
export function validateThrowAtDefender(socket, defenderId) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const baseErr = first(
    checkPhase(state, PHASE.LIVE),
    checkRole(socket, 'offense'),
    checkString(defenderId, 'defenderId'),
  )
  if (baseErr) return baseErr

  if (state.playDesign?.playType !== 'pass') return 'Can only throw on a pass play'
  if (state.sackEnqueued) return 'Cannot throw — the QB was sacked'
  if (state.qbScrambling) return 'Cannot throw after committing to a scramble'
  if (!state.defensePlayers.get(defenderId)) return 'Defender not found'

  return null
}

// scramble — [184] offense converts the QB into a runner during a live pass play. One-way:
// it can't be triggered twice, and a thrown ball forecloses it (and vice versa, see throws).
export function validateScramble(socket) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const baseErr = first(
    checkPhase(state, PHASE.LIVE),
    checkRole(socket, 'offense'),
  )
  if (baseErr) return baseErr

  if (state.playDesign?.playType !== 'pass') return 'Can only scramble on a pass play'
  if (state.qbScrambling)      return 'Already scrambling'
  if (state.targetReceiverId)  return 'Cannot scramble after the ball is thrown'

  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }
  if (!qb) return 'No quarterback on the field'

  return null
}

// throwaway — [187] QB deliberately throws the ball away (an incompletion, no gain). Offense
// only, live pass play, and only while the QB still holds the ball: not after a throw is
// committed and not once the QB has taken off scrambling.
export function validateThrowaway(socket) {
  const state = resolveState(socket)
  if (!state) return 'No active game found for this room'

  const baseErr = first(
    checkPhase(state, PHASE.LIVE),
    checkRole(socket, 'offense'),
  )
  if (baseErr) return baseErr

  if (state.playDesign?.playType !== 'pass') return 'Can only throw the ball away on a pass play'
  if (state.sackEnqueued)     return 'Cannot throw the ball away — the QB was sacked'
  if (state.qbScrambling)     return 'Cannot throw the ball away while scrambling'
  if (state.targetReceiverId) return 'The ball has already been thrown'

  return null
}
