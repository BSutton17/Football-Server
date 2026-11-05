import { createRoom, joinRoom, leaveRoomBySlot, updateSocketId, getRoom } from '../game/roomManager.js';
import { updatePlayer } from '../game/playerRegistry.js';
import { createSession, markDisconnected, reconnect, getTokenBySocketId, getSlotByToken, invalidateSession, getTokensByRoomId, setSessionRole, otherSessionAway } from '../game/sessionManager.js';
import { getGame, deleteGame } from '../game/gameState.js';
import { isPlayerPaused, beginPlayerPause, isAutoPaused, resumePlayerPause } from '../game/pause.js';
import { isSoloRoom } from '../ai/timing.js';
import { PAUSE_RECONNECT_WINDOW_MS, AUTO_PAUSE_RECONNECT_WINDOW_MS } from '../constants.js';
import { PHASE } from '../game/stateMachine.js';
import { isManualPlay, releaseGo } from '../game/manual.js';
import { clearAiSeats } from '../ai/seats.js';
import { clearQueue } from '../game/eventQueue.js';
import { seasonRoomExpired } from '../game/seasonHooks.js';

// [seasons] A season game is saved, so nothing is lost when it does expire; holding it for half an hour
// just means a return inside that time lands on the exact frame instead of the last dead ball.
const SEASON_HOLD_MS = 30 * 60 * 1000;
import { stopGameLoop } from '../game/simulation.js';
import { serializeGameState } from '../game/serialization.js';
import { repairAfterResume } from '../game/resumeRepair.js';
import { beginTeamSelect, getTeamSelect, clearTeamSelect } from '../game/teamSelect.js';
import { TEAMS } from '../data/teams.js';

const TEAM_IDS = TEAMS.map(t => t.id);

const CODE_RE = /^\d{4}$/;   // 4-digit numeric room code

function isValidCode(roomId) {
  return typeof roomId === 'string' && CODE_RE.test(roomId);
}

// ── Stepping away ([quick leave]) ────────────────────────────────────────────
//
// "Ensure the game survives quick leaves like swiping up and answering a text or leaving the app for a
// few moments." Holds the game the moment a player goes, and lets it go the moment they are back.
//
// ⚠️ THE HOLD HAS TO BEAT THE DISCONNECT. A phone suspending an app does not close its socket; the
// server finds out when a ping goes unanswered, up to fifteen seconds later, and the computer happily
// runs a whole play to nobody in that time. So the client says `app_hidden` as it leaves, and the
// disconnect path below remains as the backstop for when it could not.
function holdForAbsentPlayer(io, roomId, slot) {
  const state = getGame(roomId);
  if (!state || state.phase === PHASE.GAME_OVER) return false;
  if (isPlayerPaused(state)) return false;
  // A finger that left with GO held down is never going to lift it: nothing would ever freeze the
  // play again once it resumed. Let go on their behalf first, so the pause lands on a frozen board.
  if (state.phase === PHASE.LIVE && isManualPlay(state)) releaseGo(state, io);
  if (!beginPlayerPause(state, slot, { automatic: true })) return false;

  const room = getRoom(roomId);
  room?.players.forEach((socketId, s) => {
    if (socketId) io.to(socketId).emit('game_paused', { byYou: s === slot, auto: true });
  });
  return true;
}

// Lifts a hold the server called. A pause a player ASKED for is left alone: stepping away is what it
// was for. Neither does one player returning release a game held for another who is still gone.
export function releaseAbsenceHold(io, roomId, token) {
  const live = getGame(roomId);
  if (!isAutoPaused(live) || otherSessionAway(roomId, token)) return false;
  if (!resumePlayerPause(live)) return false;
  io.to(roomId).emit('game_resumed');
  const repaired = repairAfterResume(live, io, roomId);
  console.log(`[room] ${roomId} resumed — the player is back` +
    (repaired.length ? ` — repaired: ${repaired.join('; ')}` : ''));
  return true;
}

// Put a socket back in the seat a session token holds. Exported for a season game opened on a new
// connection, which arrives at the same place by a different door.
export function rejoinRoom(io, socket, token) {
  if (typeof token !== 'string') return;

  const session = reconnect(token, socket.id);

  if (!session) {
    socket.emit('reconnect_failed');
    return;
  }

  const { roomId, slot, previousSocketId } = session;

  // [quick leave] The connection this token used to be on is dead but nobody has told the server
  // yet. Retire it here, and clear its room first: its `disconnect` handler would otherwise find no
  // session under its id and announce `opponent_left`, which tells the other client the game is over.
  if (previousSocketId) {
    const old = io.sockets?.sockets?.get?.(previousSocketId);
    if (old) {
      old.data.roomId = null;
      old.leave?.(roomId);
      old.disconnect?.(true);
    }
  }

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

  // [role drift] The session records the role the player was GIVEN at kickoff, but roles swap on
  // EVERY possession change (notifyRoleSwap in eventQueue.js updates socket.data.role and emits
  // switch_sides — it never touched the session). Handing back the stored role after a refresh or
  // a swipe out of the tab therefore put the player on the wrong side of the ball, and since
  // socket.data.role is exactly what the validators check, every action they took was then
  // rejected: a soft-lock. Derive the role from the live game with the same formula
  // notifyRoleSwap uses, and write it back so the session can't drift again.
  const liveGame = getGame(roomId);
  const role = liveGame ? (liveGame.possession === slot ? 'offense' : 'defense') : session.role;
  setSessionRole(token, role);

  // Slot the returning player back into their room
  updateSocketId(roomId, slot, socket.id);

  socket.join(roomId);
  socket.data.roomId = roomId;
  socket.data.role   = role;
  updatePlayer(socket.id, { roomId, role });

  socket.emit('reconnect_success', { roomId, role, slot });
  socket.to(roomId).emit('opponent_reconnected');

  // ⚠️ LIFT THE PAUSE THE SERVER CALLED ON THIS PLAYER'S BEHALF. The disconnect handler pauses a
  // solo game so the computer does not play on to an empty stadium, and its comment has always
  // promised "Reconnecting resumes it" -- nothing ever did. The player came back to a game frozen on
  // a stoppage they did not ask for, every button phase-gated into a silent refusal, and no clock
  // running to get out of it.
  //
  // Only the AUTOMATIC one. A pause the player actually asked for must survive their phone dropping,
  // or stepping away would cost them the thing they stepped away for.
  releaseAbsenceHold(io, roomId, token);

  // If the room is still in team selection, drop the player back onto the select screen with the
  // current picks restored; otherwise restore the live game state ([268] reconnect support).
  const sel = getTeamSelect(roomId);
  if (sel) {
    socket.emit('team_select_start', {
      slot, teamIds: TEAM_IDS,
      quarterMinutes: getTeamSelect(roomId)?.quarterMinutes,   // [quarter length] restore on reconnect
      defenseSeesOpenness: getTeamSelect(roomId)?.defenseSeesOpenness,
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
        defenseSeesOpenness: getTeamSelect(roomId)?.defenseSeesOpenness,
      });

      updatePlayer(socketId, { role });
      const peer = io.sockets.sockets.get(socketId);
      if (peer) peer.data.role = role;
    }

    console.log(`[room] ${roomId} full — team selection started (offense slot: ${result.roles[creatorId] === 'offense' ? 0 : 1})`);
  });

  // ── Reconnect ────────────────────────────────────────────────────────────────
  socket.on('reconnect_to_room', (token) => rejoinRoom(io, socket, token));

  // ── Stepping away ([quick leave]) ────────────────────────────────────────────
  // The app went to the background / came back with its connection intact. Only a seated human: the
  // token is what proves it, and a socket that holds none has no game to hold.
  socket.on('app_hidden', () => {
    const { roomId } = socket.data;
    const token = roomId ? getTokenBySocketId(socket.id) : null;
    if (!token) return;
    holdForAbsentPlayer(io, roomId, getSlotByToken(token));
  });

  socket.on('app_visible', () => {
    const { roomId } = socket.data;
    const token = roomId ? getTokenBySocketId(socket.id) : null;
    if (!token) return;
    releaseAbsenceHold(io, roomId, token);
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
        seasonRoomExpired(getGame(expiredRoomId), expiredRoomId);
        clearAiSeats(expiredRoomId);
        clearQueue(expiredRoomId);
        for (const t of getTokensByRoomId(expiredRoomId)) invalidateSession(t);
        leaveRoomBySlot(expiredRoomId, slot);
        stopGameLoop(expiredRoomId);
        deleteGame(expiredRoomId);
        clearTeamSelect(expiredRoomId);
        io.to(expiredRoomId).emit('game_abandoned');
        console.log(`[room] session expired — ${expiredRoomId} slot ${slot} abandoned`);
      }, {
        isPaused: () => isPlayerPaused(getGame(roomId)),
        // [quick leave] A computer has nowhere to be, so a solo game waits the full ten minutes. A
        // person on the other end of an online game gets three, unless the pause was asked for.
        pausedWindowMs: () => {
          const held = getGame(roomId);
          if (held?.season) return SEASON_HOLD_MS;
          return isAutoPaused(held) && !isSoloRoom(held)
            ? AUTO_PAUSE_RECONNECT_WINDOW_MS
            : PAUSE_RECONNECT_WINDOW_MS;
        },
      });

      // [offline] In a SOLO room the other seat is a computer, which will happily keep snapping and
      // running plays to an empty stadium — the user's log showed exactly that, a game carrying on
      // for the whole 30-second reconnect window after their phone dropped. Worse than wasteful:
      // you could come back to a changed score. Hold the game instead, so it is waiting where they
      // left it. Reconnecting resumes it; the ordinary expiry still tears it down if they do not.
      // ⚠️ `slot` IS NOT IN SCOPE HERE — it is the expiry callback's parameter above. Naming it bare
      // threw a ReferenceError on every solo disconnect, and an uncaught throw in a socket handler
      // takes down the whole process: every room on the server, not just this one.
      // [quick leave] An ONLINE game now holds too. The other player used to keep snapping against an
      // empty side of the ball for thirty seconds, and then lose the game when the window closed.
      if (holdForAbsentPlayer(io, roomId, getSlotByToken(token))) {
        console.log(`[room] ${roomId} held — a player dropped`);
      }

      socket.to(roomId).emit('opponent_disconnected');
      console.log(`[socket] - ${socket.id} disconnected from ${roomId} (${reason}) — 30s window open`);
    } else {
      // No session (left before roles assigned) — clean up immediately
      socket.to(roomId).emit('opponent_left');
      console.log(`[socket] - ${socket.id} left ${roomId} (${reason})`);
    }
  });
}
