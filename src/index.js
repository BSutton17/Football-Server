import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { Server } from 'socket.io';
import { registerSocketHandlers } from './socket/index.js';
import { SIM } from './constants.js';

const PORT = process.env.PORT || 3001;
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';

const app = express();

app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Browsers send the Origin WITHOUT a trailing slash, so origins must be stored that way. Allow the
// local dev client and the deployed Netlify client (override/extend with the CLIENT_ORIGIN env var).
const allowedOrigins = [
  CLIENT_ORIGIN,
  'http://localhost:5173',
  'https://electric-football.netlify.app',
].map((o) => o.replace(/\/$/, ''));
const origins = [...new Set(allowedOrigins)];

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: origins,
    methods: ['GET', 'POST'],
  },
  // Skip HTTP long-polling — game requires persistent WebSocket connection
  transports: ['websocket'],
  // Detect dead connections quickly so the opponent gets notified fast
  pingInterval: 5000,
  pingTimeout: 10000,
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} — accepting connections from ${origins.join(', ')}`);
  console.log(`[server] simulation tick rate: ${SIM.TICK_RATE} Hz (${SIM.TICK_MS} ms/tick)`);
});
