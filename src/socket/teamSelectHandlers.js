import { isValidTeamId } from '../data/teams.js'
import { getTeamSelect, setPick, lockPick, bothLocked, clearTeamSelect } from '../game/teamSelect.js'
import { getRoom } from '../game/roomManager.js'
import { initGame, getGame } from '../game/gameState.js'
import { startGameLoop } from '../game/simulation.js'
import { serializeGameState } from '../game/serialization.js'

// Which player slot (0 | 1) a socket occupies in its room, or -1 if not seated.
function slotOf(roomId, socketId) {
  const room = getRoom(roomId)
  return room ? room.players.indexOf(socketId) : -1
}

export function registerTeamSelectHandlers(io, socket) {
  // Provisional pick — broadcast so BOTH screens reflect each player's current choice ([269]).
  socket.on('select_team', (payload) => {
    const roomId = socket.data.roomId
    const teamId = payload?.teamId
    if (!roomId || !isValidTeamId(teamId) || !getTeamSelect(roomId)) return
    const slot = slotOf(roomId, socket.id)
    if (slot < 0) return

    setPick(roomId, slot, teamId)
    io.to(roomId).emit('team_selected', { slot, teamId, locked: false })
  })

  // Final pick. Once both slots have locked, the game begins.
  socket.on('lock_team', (payload) => {
    const roomId = socket.data.roomId
    const teamId = payload?.teamId
    const sel    = roomId ? getTeamSelect(roomId) : null
    if (!isValidTeamId(teamId) || !sel) return
    const slot = slotOf(roomId, socket.id)
    if (slot < 0) return

    // [282] No duplicate teams: if the OTHER player has already locked this team, reject the lock
    // (first lock wins) and tell this player to choose another.
    const other = 1 - slot
    if (sel.locked[other] && sel.picks[other] === teamId) {
      socket.emit('team_taken', { teamId })
      return
    }

    lockPick(roomId, slot, teamId)
    io.to(roomId).emit('team_selected', { slot, teamId, locked: true })

    if (bothLocked(roomId)) startGameFromSelection(io, roomId)
  })
}

// Both players locked — create the authoritative game state (recording each slot's team),
// start the tick loop, and push everyone into gameplay with a full game_state snapshot.
function startGameFromSelection(io, roomId) {
  const room = getRoom(roomId)
  const sel  = getTeamSelect(roomId)
  if (!room || !sel) return

  const offenseSlot = room.offenseSlot ?? 0
  const state = initGame(roomId, offenseSlot)
  state.teams = [sel.picks[0], sel.picks[1]]   // chosen team per slot — for future per-team play
  startGameLoop(roomId, io)

  io.to(roomId).emit('team_select_complete', { teams: state.teams })
  room.players.forEach((socketId, slot) => {
    if (!socketId) return
    io.to(socketId).emit('game_state', serializeGameState(getGame(roomId), slot))
  })

  clearTeamSelect(roomId)
  console.log(`[teamselect] ${roomId} both locked → game start (${sel.picks[0]} vs ${sel.picks[1]})`)
}
