// ── The virtual socket ([offline]) ───────────────────────────────────────────
//
// How a computer opponent occupies a seat in a game.
//
// The AI does NOT call game functions directly. It is handed an object that looks exactly like a
// Socket.io socket, the ordinary handlers are registered on it, and it plays by FIRING THE SAME
// EVENTS A HUMAN'S PHONE FIRES — place_player, assign_coverage, set_offense, snap_ball,
// throw_to_receiver. Everything else in the codebase is then unable to tell the difference.
//
// That is not a convenience, it is the whole design, and it buys three things:
//
//   • LEGALITY — `validation.js` stays the single authority on what an actor may do. The AI cannot
//     place twelve men, snap out of turn, or throw on a run play, because the same validator that
//     refuses a human refuses it. No second rulebook to keep in sync.
//
//   • FAIRNESS — the AI receives exactly the payloads a human client receives, through the same
//     emits, already filtered by `serializePositions` for its slot. The defense cannot see the play
//     call for the same reason a human defense cannot: nobody ever sends it.
//
//   • REACH — every feature the game grows works for the AI for free, because features are built on
//     these events.
//
// The cost is one small shim, below. `emit` is where the AI RECEIVES the game; `fire` is where it
// ACTS on it.

// Socket ids for AI seats are namespaced so they can never collide with a real socket id and are
// obvious in a log line.
export const AI_SOCKET_PREFIX = 'ai:'

export function isAiSocketId(id) {
  return typeof id === 'string' && id.startsWith(AI_SOCKET_PREFIX)
}

// Creates a socket-shaped object for an AI seat.
//
// `onEvent(event, payload)` is the AI's inbox: every emit aimed at this seat arrives there. Leaving
// it out makes the socket a silent sink, which is what the headless harness wants when it only
// cares about the resulting game state.
export function createVirtualSocket(roomId, { slot = 1, role = 'defense', onEvent = null } = {}) {
  const handlers = new Map()

  const socket = {
    id: `${AI_SOCKET_PREFIX}${roomId}:${slot}`,
    data: { roomId, role },
    // The AI's own view of the seat. Not read by the game — it is here so the controller does not
    // have to carry a parallel record of which slot it is sitting in.
    slot,

    // ── The socket.io surface the handlers use ──────────────────────────────
    on(event, fn) { handlers.set(event, fn) },
    // Emits AT this seat: the game telling the AI something. Never throws into the game loop — a
    // controller bug must not take the tick down with it, because the human in the room is still
    // playing and a half-updated AI is far better than a dead game.
    emit(event, payload) {
      if (!onEvent) return
      try { onEvent(event, payload) }
      catch (err) { console.error(`[ai] ${socket.id} failed handling ${event}:`, err?.message ?? err) }
    },
    join() {},
    // Emits from this seat to the REST of the room — the human's client. A real socket.io socket
    // excludes the sender, and so does this: the AI is not its own audience.
    to() { return { emit() {} } },
    disconnect() {},

    // ── The AI's action channel ─────────────────────────────────────────────
    // Fires an event INTO the registered handlers, exactly as if it had arrived over the wire.
    // Returns false when nothing is listening, so a controller aiming at an event the server does
    // not have fails loudly in tests instead of silently doing nothing.
    fire(event, payload) {
      const fn = handlers.get(event)
      if (!fn) return false
      fn(payload)
      return true
    },
    hasHandler(event) { return handlers.has(event) },
  }

  return socket
}
