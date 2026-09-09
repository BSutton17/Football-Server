import { createRoom, joinRoom, leaveRoomBySlot, updateSocketId, getRoom } from '../game/roomManager.js';
import { updatePlayer } from '../game/playerRegistry.js';
import { createSession, markDisconnected, reconnect, getTokenBySocketId, invalidateSession, getTokensByRoomId } from '../game/sessionManager.js';
import { getGame, deleteGame } from '../game/gameState.js';
import { isPlayerPaused } from '../game/pause.js';
import { PAUSE_RECONNECT_WINDOW_MS } from '../constants.js';
import { stopGameLoop } from '../game/simulation.js';
import { serializeGameState } from '../game/serialization.js';
import { beginTeamSelect, getTeamSelect, clearTeamSelect } from '../game/teamSelect.js';
import { TEAMS } from '../data/teams.js';

const TEAM_IDS = TEAMS.map(t => t.id);

const CODE_RE = /^\d{4}$/;   // 4-digit numeric room code

function isValidCode(roomId) {
  return typeof roomId === 'string' && CODE_RE.test(roomId);
}

export function registerRoomHandlers(io, socket) {
  // ── Create room ──────────────────────────────────────────────────────────────
  // [manual] payload is either a bare room code (legacy) or { roomId, mode, difficulty }. The
  // creator's mode/difficulty are recorded on the room and govern it for the whole game.
  socket.on('create_room', (payload) => {
    const roomId     = typeof payload === 'string' ? payload : payload?.roomId;
    const mode       = typeof payload === 'string' ? undefined : payload?.mode;
    const difficulty = typeof payload === 'string' ? undefined : payload?.difficulty;

    if (!isValidCode(roomId)) {
      socket.emit('room_error', { message: 'Invalid room code' });
      return;
    }

    const result = createRoom(roomId, socket.id, { mode, difficulty });

    if (result.error === 'exists') {
      socket.emit('room_error', { message: 'Code already in use, please try again' });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    updatePlayer(socket.id, { roomId });

    socket.emit('room_joined', { slot: result.slot, mode: result.mode, difficulty: result.difficulty });
    console.log(`[room] created ${roomId} by ${socket.id} [${result.mode}/${result.difficulty}]`);
  });

  // ── Join room ────────────────────────────────────────────────────────────────
  // [manual] payload is either a bare room code (legacy) or { roomId, mode }. When a mode is given
  // it must match the room's — the room is authoritative, so a mismatch is rejected with the real
  // mode rather than silently switching the joiner into a game they didn't pick.
  socket.on('join_room', (payload) => {
    const roomId = typeof payload === 'string' ? payload : payload?.roomId;
    const mode   = typeof payload === 'string' ? undefined : payload?.mode;

    if (!isValidCode(roomId)) {
      socket.emit('room_error', { message: 'Invalid room code' });
      return;
    }

    const result = joinRoom(roomId, socket.id, { mode });

    if (result.error === 'not_found') { socket.emit('room_not_found'); return; }
    if (result.error === 'full')      { socket.emit('room_full');      return; }
    if (result.error === 'mode_mismatch') {
      socket.emit('room_mode_mismatch', { mode: result.mode });
      return;
    }

    socket.join(roomId);
    socket.data.roomId = roomId;
    updatePlayer(socket.id, { roomId });

    socket.emit('room_joined', { slot: result.slot, mode: result.mode, difficulty: result.difficulty });

    // Assign roles and create sessions for both players at the same time
    const creatorId = Object.keys(result.roles).find(id => id !== socket.id);
    const joinerId  = socket.id;

    // [268][269] Both players enter TEAM SELECTION before gameplay — the game state and tick loop
    // are NOT created until both lock in a team (see teamSelectHandlers). Sending team_select_start
    // to both at once means they enter the selection screen simultaneously.
    beginTeamSelect(roomId);

    for (const [socketId, role] of Object.entries(result.roles)) {
      const slot  = socketId === joinerId ? 1 : 0;
      const token = createSession(socketId, roomId, slot, role);

      io.to(socketId).emit('roles_assigned', { role });
      io.to(socketId).emit('session_token', token);
      // [quarter length] Ship the current setting with the screen so both players see it from the
      // first frame, rather than the guest waiting for the host to touch the control.
      io.to(socketId).emit('team_select_start', {
        slot, teamIds: TEAM_IDS,
        quarterMinutes: getTeamSelect(roomId)?.quarterMinutes,
      });

      updatePlayer(socketId, { role });
      const peer = io.sockets.sockets.get(socketId);
      if (peer) peer.data.role = role;
    }

    console.log(`[room] ${roomId} full — team selection started (offense slot: ${result.roles[creatorId] === 'offense' ? 0 : 1})`);
  });

  // ── Reconnect ────────────────────────────────────────────────────────────────
  socket.on('reconnect_to_room', (token) => {
    if (typeof token !== 'string') return;

    const session = reconnect(token, socket.id);

    if (!session) {
      socket.emit('reconnect_failed');
      return;
    }

    const { roomId, slot, role } = session;

    // The token resolved, but the room it points at may be gone (game ended/abandoned, or it was
    // never anything but a stale token from a previous game). Without a room AND either an active
    // team selection or a live game, there's nothing to rejoin — fail the reconnect so the client
    // returns to the lobby instead of landing in a 'ready' state with no game (which would make the
    // first place_player fail with "No active game found"). [268] join-after-stale-token fix.
    if (!getRoom(roomId) || (!getTeamSelect(roomId) && !getGame(roomId))) {
      invalidateSession(token);
      socket.emit('reconnect_failed');
      return;
    }

    // Slot the returning player back into their room
    updateSocketId(roomId, slot, socket.id);

    socket.join(roomId);
    socket.data.roomId = roomId;
    socket.data.role   = role;
    updatePlayer(socket.id, { roomId, role });

    socket.emit('reconnect_success', { roomId, role, slot });
    socket.to(roomId).emit('opponent_reconnected');

    // If the room is still in team selection, drop the player back onto the select screen with the
    // current picks restored; otherwise restore the live game state ([268] reconnect support).
    const sel = getTeamSelect(roomId);
    if (sel) {
      socket.emit('team_select_start', {
        slot, teamIds: TEAM_IDS,
        quarterMinutes: getTeamSelect(roomId)?.quarterMinutes,   // [quarter length] restore on reconnect
      });
      sel.picks.forEach((teamId, s) => {
        if (teamId) socket.emit('team_selected', { slot: s, teamId, locked: sel.locked[s] });
      });
    } else {
      const gameState = getGame(roomId);
      if (gameState) {
        // Restore BOTH teams' picks so the client recovers team colors, rosters, and names after a
        // refresh (state.teams = locked team per slot, set when both players locked in).
        (gameState.teams ?? []).forEach((teamId, s) => {
          if (teamId) socket.emit('team_selected', { slot: s, teamId, locked: true });
        });
        socket.emit('game_state', serializeGameState(gameState, slot));
      }
    }

    console.log(`[room] ${socket.id} reconnected to ${roomId} as ${role}`);
  });

  // ── Disconnect ───────────────────────────────────────────────────────────────
  socket.on('disconnect', (reason) => {
    const { roomId } = socket.data;
    if (!roomId) return;

    const token = getTokenBySocketId(socket.id);

    if (token) {
      // Hold the slot for 30 seconds to allow reconnect — or for ten minutes if the game is paused
      // ([pause]): the whole point of a pause is that somebody has stepped away, and a phone going
      // to sleep in their pocket should not abandon the match.
      markDisconnected(token, (expiredRoomId, slot) => {
        // Clean up sessions, game state, and loop before notifying the other player
        for (const t of getTokensByRoomId(expiredRoomId)) invalidateSession(t);
        leaveRoomBySlot(expiredRoomId, slot);
        stopGameLoop(expiredRoomId);
        deleteGame(expiredRoomId);
        clearTeamSelect(expiredRoomId);
        io.to(expiredRoomId).emit('game_abandoned');
        console.log(`[room] session expired — ${expiredRoomId} slot ${slot} abandoned`);
      }, {
        isPaused: () => isPlayerPaused(getGame(roomId)),
        pausedWindowMs: PAUSE_RECONNECT_WINDOW_MS,
      });

      socket.to(roomId).emit('opponent_disconnected');
      console.log(`[socket] - ${socket.id} disconnected from ${roomId} (${reason}) — 30s window open`);
    } else {
      // No session (left before roles assigned) — clean up immediately
      socket.to(roomId).emit('opponent_left');
      console.log(`[socket] - ${socket.id} left ${roomId} (${reason})`);
    }
  });
}
