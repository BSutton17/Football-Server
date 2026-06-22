import { registerRoomHandlers } from './roomHandlers.js';
import { registerGameHandlers } from './gameHandlers.js';
import { registerTeamSelectHandlers } from './teamSelectHandlers.js';
import { registerPlayer, removePlayer, getConnectedCount } from '../game/playerRegistry.js';

export function registerSocketHandlers(io) {
  io.on('connection', (socket) => {
    registerPlayer(socket.id);
    console.log(`[socket] + ${socket.id} (online: ${getConnectedCount()})`);

    registerRoomHandlers(io, socket);
    registerTeamSelectHandlers(io, socket);
    registerGameHandlers(io, socket);

    socket.on('error', (err) => {
      console.error(`[socket] error from ${socket.id}: ${err.message}`);
    });

    socket.on('disconnect', () => {
      removePlayer(socket.id);
      console.log(`[socket] - ${socket.id} (online: ${getConnectedCount()})`);
    });
  });
}
