import {
  validatePlacePlayer,
  validateRemovePlayer,
  validateAssignRoute,
  validateSetOffense,
  validateAssignCoverage,
  validateClearCoverage,
  validateSnapBall,
  validateThrowToReceiver,
  validateThrowAtDefender,
  validateScramble,
  validateThrowaway,
} from '../game/validation.js'
import { getGame, initGame, commitThrowTarget, resolveThrowTarget } from '../game/gameState.js'
import { transition, PHASE } from '../game/stateMachine.js'
import { FIELD } from '../constants.js'
import { initLivePhase } from '../game/systems/init.js'
import { enqueue, EVENT, resolveDecision, broadcastSpecialTeams } from '../game/eventQueue.js'
import { startGameLoop } from '../game/simulation.js'
import { getRoom } from '../game/roomManager.js'
import { serializeGameState } from '../game/serialization.js'
import {
  beginSpecialTeams, applyKickInput, isSpecialTeamsActive, isValidKickType,
} from '../game/specialTeams.js'

// Shared rejection helper — rejects the action and logs it without crashing.
function reject(socket, event, reason) {
  console.warn(`[game] rejected ${event} from ${socket.id}: ${reason}`)
  socket.emit('room_error', { message: reason })
}

export function registerGameHandlers(io, socket) {

  // ── Pre-snap: formation ───────────────────────────────────────────────────

  socket.on('place_player', (payload) => {
    const err = validatePlacePlayer(socket, payload)
    if (err) return reject(socket, 'place_player', err)

    const state = getGame(socket.data.roomId)
    const { id, x, y, label, team, ratings, xFactor } = payload

    // Clients send offense-relative y (0 = own goal line, 100 = opp goal line).
    // Simulation uses absolute y (0 = south EZ back, 120 = north EZ back).
    const absY = state.direction === 1
      ? y + FIELD.END_ZONE_DEPTH
      : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - y

    // Store the label — movement/ratings/auto-rush all key off it. For offense it is
    // re-applied by initLivePhase from the playDesign; for defense this is the only
    // place it gets set (a DL with no label never enters the auto-rush branch).
    // [293] ratings (per-team player attributes) ride along so the sim uses them via ratingOf.
    // [294] xFactor is the player's potential ability; xFactorActive starts false (earned in-game).
    const map = team === 'o' ? state.offensePlayers : state.defensePlayers
    map.set(id, { id, x, y: absY, vx: 0, vy: 0, label, ratings: ratings ?? undefined, xFactor: xFactor ?? undefined, xFactorActive: false })

    // Echo the original relative y — both clients render in relative coordinates
    io.to(socket.data.roomId).emit('player_placed', { id, x, y, label, team })
  })

  socket.on('remove_player', (id) => {
    const err = validateRemovePlayer(socket, id)
    if (err) return reject(socket, 'remove_player', err)

    const state = getGame(socket.data.roomId)
    const map = socket.data.role === 'offense' ? state.offensePlayers : state.defensePlayers
    map.delete(id)
    io.to(socket.data.roomId).emit('player_removed', id)
  })

  socket.on('assign_route', (payload) => {
    const err = validateAssignRoute(socket, payload)
    if (err) return reject(socket, 'assign_route', err)
    // TODO: store route on the player, echo route_assigned to both clients
  })

  socket.on('assign_coverage', (payload) => {
    const err = validateAssignCoverage(socket, payload)
    if (err) return reject(socket, 'assign_coverage', err)

    const state = getGame(socket.data.roomId)
    const { playerId, type, targetId, zoneType, zoneCenterX, zoneCenterY } = payload
    state.defenseCoverage.set(playerId, {
      type,
      targetId:    targetId    ?? null,
      zoneType:    zoneType    ?? null,
      zoneCenterX: zoneCenterX ?? null,
      zoneCenterY: zoneCenterY ?? null,
    })
    socket.emit('coverage_assigned', payload)
  })

  socket.on('clear_coverage', (payload) => {
    const err = validateClearCoverage(socket, payload)
    if (err) return reject(socket, 'clear_coverage', err)

    const state = getGame(socket.data.roomId)
    state.defenseCoverage.delete(payload.playerId)
    socket.emit('coverage_cleared', { playerId: payload.playerId })
  })

  // ── Offense locks formation ───────────────────────────────────────────────

  socket.on('set_offense', (payload) => {
    const err = validateSetOffense(socket, payload)
    if (err) return reject(socket, 'set_offense', err)

    const state = getGame(socket.data.roomId)
    state.playDesign = {
      playType: payload.playType,
      runAngle:  payload.runAngle,
      players:   payload.players,
    }

    state.playClockRunning = false
    transition(state, PHASE.COUNTDOWN)
    io.to(socket.data.roomId).emit('offense_set', { playClockRemaining: Math.ceil(state.playClock) })
    console.log(`[game] ${socket.data.roomId} offense locked → countdown [${payload.playType}]`)

    // 5-second window for defense to adjust — emit countdown ticks; at 0 the hike button unlocks.
    const roomId = socket.data.roomId
    ;[5, 4, 3, 2, 1, 0].forEach((count, i) => {
      setTimeout(() => {
        const s = getGame(roomId)
        if (!s || s.phase !== PHASE.COUNTDOWN) return
        io.to(roomId).emit('hike_countdown', { count })
      }, i * 1000)
    })
  })

  // ── Snap ─────────────────────────────────────────────────────────────────

  socket.on('snap_ball', () => {
    const err = validateSnapBall(socket)
    if (err) return reject(socket, 'snap_ball', err)

    const roomId = socket.data.roomId
    const state  = getGame(roomId)

    initLivePhase(state)
    transition(state, PHASE.LIVE)
    io.to(roomId).emit('ball_snapped')
    console.log(`[game] ${roomId} ball snapped → live`)
  })

  // ── Dev mode: one-click playtest setup ────────────────────────────────────
  //
  // Teleports a full canned offense + defense (with routes and coverages) into place and leaves
  // the play in PRE_SNAP — it does NOT snap; the developer starts the play with the normal
  // Set Offense → Hike controls. Not part of the real game (disabled in production).
  //
  // The setup is authoritative on the server AND broadcast to BOTH clients (player_placed for
  // each player, coverage_assigned for each assignment) — exactly like manual placement — so the
  // server state and the other player's screen stay in sync instead of glitching. The client
  // sends offense-relative y (like place_player); we store absolute y and echo the relative y back.
  socket.on('dev_quick_setup', (payload) => {
    if (process.env.NODE_ENV === 'production') return
    const roomId = socket.data.roomId
    const state  = getGame(roomId)
    if (!state || !payload) return

    const toAbsY = (y) => state.direction === 1
      ? y + FIELD.END_ZONE_DEPTH
      : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - y

    const place = (p, team, map) => {
      map.set(p.id, { id: p.id, x: p.x, y: toAbsY(p.y), vx: 0, vy: 0, label: p.label })
      io.to(roomId).emit('player_placed', { id: p.id, x: p.x, y: p.y, label: p.label, team })
    }

    state.offensePlayers  = new Map()
    state.defensePlayers  = new Map()
    state.defenseCoverage = new Map()

    for (const p of payload.offense ?? []) place(p, 'o', state.offensePlayers)
    for (const p of payload.defense ?? []) place(p, 'd', state.defensePlayers)

    for (const c of payload.coverage ?? []) {
      state.defenseCoverage.set(c.playerId, {
        type:        c.type,
        targetId:    c.targetId    ?? null,
        zoneType:    c.zoneType    ?? null,
        zoneCenterX: c.zoneCenterX ?? null,
        zoneCenterY: c.zoneCenterY ?? null,
      })
      io.to(roomId).emit('coverage_assigned', {
        playerId: c.playerId, type: c.type, targetId: c.targetId,
        zoneType: c.zoneType, zoneCenterX: c.zoneCenterX, zoneCenterY: c.zoneCenterY,
      })
    }

    state.ballCarrierId      = null
    state.targetReceiverId   = null
    state.deadBallSpot       = null
    state.activeThrow        = null
    state.qbScrambling       = false
    state.interceptionReturn = false
    state.phase              = PHASE.PRE_SNAP   // staged, NOT snapped — dev starts it via Set Offense → Hike

    console.log(`[dev] ${roomId} quick playtest formation staged + broadcast`)
  })

  // ── Live play ─────────────────────────────────────────────────────────────

  // [184] Offense converts the QB into a runner on a live pass play. [185] Irreversible: the
  // QB can no longer throw (enforced in validateThrowToReceiver) for the rest of the play.
  // [186] Setting ballCarrierId to the QB routes it through the shared ball-carrier model,
  // so it reads lanes with RB vision and runs north-south toward open space.
  socket.on('scramble', () => {
    const err = validateScramble(socket)
    if (err) return reject(socket, 'scramble', err)

    const state = getGame(socket.data.roomId)
    let qb = null
    for (const p of state.offensePlayers.values()) {
      if (p.label === 'QB') { qb = p; break }
    }
    if (!qb) return reject(socket, 'scramble', 'No quarterback on the field')

    state.qbScrambling  = true
    state.ballCarrierId = qb.id
    io.to(socket.data.roomId).emit('qb_scrambling')
    console.log(`[game] ${socket.data.roomId} QB scrambling — throwing locked`)
  })

  // [187][188] QB throws the ball away — a deliberate incompletion. It consumes a down and
  // stops the clock (every incompletion does), exactly like a missed pass with no target.
  socket.on('throwaway', () => {
    const err = validateThrowaway(socket)
    if (err) return reject(socket, 'throwaway', err)

    const roomId = socket.data.roomId
    const state  = getGame(roomId)
    state.targetReceiverId = null
    enqueue(roomId, EVENT.PASS_INCOMPLETE, {})
    console.log(`[game] ${roomId} QB threw the ball away — incomplete`)
  })

  socket.on('throw_to_receiver', (receiverId) => {
    const err = validateThrowToReceiver(socket, receiverId)
    if (err) return reject(socket, 'throw_to_receiver', err)

    const state = getGame(socket.data.roomId)
    // The first tapped receiver becomes the throw target and launches the pass ([165]).
    // Once committed, any further taps are silently ignored — the decision is locked so
    // the offense can't change its mind after the pass is in the air ([166]).
    if (commitThrowTarget(state, receiverId)) {
      // Aim the ball at the receiver's position at this instant — the moment of release ([167]).
      const target = resolveThrowTarget(state, receiverId)
      enqueue(state.roomId, EVENT.THROW, target)
      console.log(`[game] ${state.roomId} throw committed to ${receiverId} at (${target.x.toFixed(1)}, ${target.y.toFixed(1)})`)
    }
  })

  // Throwing the ball at a defender is an immediate interception by that defender. Locks the throw
  // decision for the play (like a normal throw); the defender becomes the live returner at his spot.
  socket.on('throw_at_defender', (defenderId) => {
    const err = validateThrowAtDefender(socket, defenderId)
    if (err) return reject(socket, 'throw_at_defender', err)

    const state = getGame(socket.data.roomId)
    if (commitThrowTarget(state, defenderId)) {
      const d = state.defensePlayers.get(defenderId)
      io.to(socket.data.roomId).emit('pass_thrown', { receiverId: defenderId })   // brief line to the defender
      enqueue(state.roomId, EVENT.INTERCEPTION, { catcherId: defenderId, x: d.x, y: d.y })
      console.log(`[game] ${state.roomId} thrown at defender ${defenderId} — interception`)
    }
  })

  // [222] Postgame reset — start a fresh game on the SAME room/sockets (no reconnect). Only valid
  // once the game is over. Re-initializes all game state (score, clock, quarter, possession,
  // field, fatigue), restarts the tick loop (it stopped itself at game over), and re-syncs both
  // players' roles and game state. Slot 0 starts on offense for the new game.
  socket.on('reset_game', () => {
    const roomId = socket.data.roomId
    if (!roomId) return
    const state = getGame(roomId)
    if (!state || state.phase !== PHASE.GAME_OVER) return

    initGame(roomId, 0)
    startGameLoop(roomId, io)   // idempotent — re-arms the loop that stopped at game over

    const room = getRoom(roomId)
    if (!room) return
    room.players.forEach((socketId, slot) => {
      if (!socketId) return
      const role = slot === 0 ? 'offense' : 'defense'
      const sock = io.sockets?.sockets?.get(socketId)
      if (sock?.data) sock.data.role = role
      io.to(socketId).emit('roles_assigned', { role })
      io.to(socketId).emit('game_state', serializeGameState(getGame(roomId), slot))
    })
    console.log(`[game] ${roomId} reset for a new game`)
  })

  // ── 4th-down decision ([Special Teams][2][3][4]) ───────────────────────────
  //
  // The offense picks Go For It / Punt / Field Goal. Server-authoritative: only the offense, only
  // while the menu is up; resolveDecision falls back to the default for an illegal option.
  socket.on('special_teams_choice', ({ option } = {}) => {
    const roomId = socket.data.roomId
    const state  = getGame(roomId)
    if (!state || !state.decisionPending) return
    const room = getRoom(roomId)
    if (!room) return
    if (room.players.indexOf(socket.id) !== state.possession) return   // only the offense decides
    resolveDecision(state, io, option)
  })

  // ── Special teams kick input ([Special Teams][6][7][8]) ────────────────────
  //
  // The kicking team aims (angle) and taps Kick. Server-authoritative: it owns the power meter and
  // executes the kick (via the kick clock); the client only forwards intent. The FIRST input starts
  // the kick timer (applyKickInput); `kick: true` is fired by the kick clock on the next tick.
  socket.on('special_teams_input', (payload = {}) => {
    const roomId = socket.data.roomId
    const state  = getGame(roomId)
    if (!state || !isSpecialTeamsActive(state)) return
    const room = getRoom(roomId)
    if (!room) return
    const slot = room.players.indexOf(socket.id)
    if (slot < 0) return

    if (applyKickInput(state, slot, payload)) broadcastSpecialTeams(state, io)
  })

  // Dev-only: stage a special-teams scenario so the kicking engine and its UI can be exercised
  // before the per-kick tickets wire the real entry points (after a score → kickoff, 4th down →
  // punt/FG, post-TD → extra point). Disabled in production, like dev_quick_setup.
  socket.on('dev_special_teams', (payload = {}) => {
    if (process.env.NODE_ENV === 'production') return
    const roomId = socket.data.roomId
    const state  = getGame(roomId)
    if (!state || !isValidKickType(payload.kickType)) return
    beginSpecialTeams(state, payload.kickType, { kickingSlot: payload.kickingSlot ?? state.possession })
    broadcastSpecialTeams(state, io)
    console.log(`[dev] ${roomId} special teams staged: ${payload.kickType}`)
  })
}
