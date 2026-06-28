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

// Allowed browser origins. Trailing slashes are stripped on BOTH sides because browsers send the
// Origin without one. Extend via the CLIENT_ORIGIN env var (also accepts a comma-separated list).
const norm = (o) => o.trim().replace(/\/$/, '');
const allowedOrigins = new Set(
  [
    ...CLIENT_ORIGIN.split(','),
    'http://localhost:5173',
    'https://electric-football.netlify.app',
  ].map(norm).filter(Boolean),
);

// Function matcher so we can normalize and LOG rejections (shows up in the Heroku logs if an origin
// is being blocked). Requests without an Origin (curl, health checks, server-to-server) are allowed.
const corsOrigin = (origin, cb) => {
  if (!origin || allowedOrigins.has(norm(origin))) return cb(null, true);
  console.warn(`[server] CORS REJECTED origin: ${origin} (allowed: ${[...allowedOrigins].join(', ')})`);
  cb(null, false);
};

const httpServer = createServer(app);

const io = new Server(httpServer, {
  cors: {
    origin: corsOrigin,
    methods: ['GET', 'POST'],
  },
  // Allow the HTTP long-poll handshake AND upgrade to a persistent WebSocket. WebSocket-only can fail
  // behind some proxies/CDNs (e.g. a blocked upgrade), with no fallback; this is more robust.
  transports: ['websocket', 'polling'],
  // Detect dead connections quickly so the opponent gets notified fast
  pingInterval: 5000,
  pingTimeout: 10000,
});

registerSocketHandlers(io);

httpServer.listen(PORT, () => {
  console.log(`[server] listening on port ${PORT} — accepting connections from ${[...allowedOrigins].join(', ')}`);
  console.log(`[server] simulation tick rate: ${SIM.TICK_RATE} Hz (${SIM.TICK_MS} ms/tick)`);
});
