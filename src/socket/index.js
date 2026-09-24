import { registerRoomHandlers } from './roomHandlers.js';
import { registerGameHandlers } from './gameHandlers.js';
import { registerTeamSelectHandlers } from './teamSelectHandlers.js';
import { registerPlayer, removePlayer, getConnectedCount } from '../game/playerRegistry.js';
import { createSoloRoom } from '../ai/solo.js';
import { bridgeIo } from '../ai/seats.js';

const CODE_RE = /^\d{4}$/;

export function registerSocketHandlers(io) {
  // [offline] Wrap io ONCE so emits can also reach virtual (AI) seats. With no AI seats registered
  // this is a pass-through, so every online game is unaffected.
  const bridged = bridgeIo(io);

  bridged.on('connection', (socket) => {
    registerPlayer(socket.id);
    console.log(`[socket] + ${socket.id} (online: ${getConnectedCount()})`);

    registerRoomHandlers(bridged, socket);
    registerTeamSelectHandlers(bridged, socket);
    registerGameHandlers(bridged, socket);

    // [offline] Solo games get their own event rather than a flag on create_room, so the ordinary
    // two-player path is untouched and cannot be changed by a malformed payload.
    socket.on('create_solo_room', (payload) => {
      const roomId = typeof payload === 'string' ? payload : payload?.roomId;
      if (typeof roomId !== 'string' || !CODE_RE.test(roomId)) {
        socket.emit('room_error', { message: 'Invalid room code' });
        return;
      }
      const result = createSoloRoom(bridged, socket, {
        roomId,
        mode:       payload?.mode,
        difficulty: payload?.difficulty,
        seed:       Number.isInteger(payload?.seed) ? payload.seed : null,
        // [offline] Rosters live on the client, so a solo room may supply the computer's team.
        aiRoster:   Array.isArray(payload?.aiRoster) ? payload.aiRoster : null,
        // The player may name the computer's team, or leave it null for a random one.
        aiTeamId:   typeof payload?.aiTeamId === 'string' ? payload.aiTeamId : null,
      });
      if (result.error === 'exists') {
        socket.emit('room_error', { message: 'Code already in use, please try again' });
      }
    });

    socket.on('error', (err) => {
      console.error(`[socket] error from ${socket.id}: ${err.message}`);
    });

    socket.on('disconnect', () => {
      removePlayer(socket.id);
      console.log(`[socket] - ${socket.id} (online: ${getConnectedCount()})`);
    });
  });
}
