// ── AI seat registry + the emit bridge ([offline]) ───────────────────────────
//
// A virtual socket can ACT (it fires events into the handlers), but on its own it cannot HEAR:
// the game talks to players through `io.to(target).emit(...)`, and Socket.io's `to()` only knows
// about real connections. An AI seat is not one, so every emit aimed at it would fall on the floor.
//
// `bridgeIo` wraps the server's io once, at startup, so those emits are also delivered to any
// registered AI seat. With no seats registered it is a pass-through, which is the normal case for
// every online game — the wrapper costs one Map lookup per emit and changes nothing.
//
// Delivery mirrors Socket.io's own semantics, and the two cases differ:
//   io.to(roomId)   — everyone in the room, so every AI seat in that room hears it.
//   io.to(socketId) — one seat, so only that AI seat hears it.
// Both appear in the codebase (per-slot payloads like game_state use the socket-id form, precisely
// because each side is sent a different view of the same state).

const seats = new Map()   // socketId -> virtualSocket

export function registerAiSeat(socket) {
  seats.set(socket.id, socket)
  return socket
}

export function unregisterAiSeat(socketId) {
  seats.delete(socketId)
}

export function getAiSeat(socketId) {
  return seats.get(socketId) ?? null
}

export function aiSeatsInRoom(roomId) {
  const out = []
  for (const s of seats.values()) if (s.data?.roomId === roomId) out.push(s)
  return out
}

// Clears every seat in a room — called when a game ends or is abandoned, so a controller can't
// outlive its game and keep acting into a room that no longer exists.
export function clearAiSeats(roomId) {
  for (const [id, s] of seats) if (s.data?.roomId === roomId) seats.delete(id)
}

// Test/diagnostic only.
export function aiSeatCount() { return seats.size }

// Wraps io so emits reach AI seats too. Idempotent: wrapping an already-wrapped io returns it
// unchanged, so this is safe to call from more than one entry point.
export function bridgeIo(io) {
  if (!io || io.__aiBridged) return io

  const bridged = {
    __aiBridged: true,

    to(target) {
      const real = io.to(target)
      return {
        emit(event, payload) {
          real.emit(event, payload)
          // A target is either a room id or a socket id. Checking the seat map first is what
          // distinguishes them — an AI socket id can never be a room id (rooms are 4 digits).
          const direct = seats.get(target)
          if (direct) { direct.emit(event, payload); return }
          for (const s of aiSeatsInRoom(target)) s.emit(event, payload)
        },
      }
    },

    // notifyRoleSwap resolves a socket here to refresh its cached role. Real sockets come from
    // Socket.io's registry; AI seats come from ours.
    sockets: {
      get sockets() {
        const real = io.sockets?.sockets
        return {
          get: (id) => seats.get(id) ?? real?.get?.(id) ?? undefined,
        }
      },
    },

    on(...args) { return io.on(...args) },
    // The underlying server, for anything that needs the genuine article.
    raw: io,
  }

  return bridged
}
