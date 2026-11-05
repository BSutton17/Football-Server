// ── Where the engine tells Seasons what happened ([seasons]) ───────────────
//
// The engine knows nothing about accounts or the database, and must not: every other kind of game runs
// through the same code. These are the three moments Seasons cares about. Nothing is registered unless
// the server wired them up, and every call site checks `state.season`, so an ordinary game never gets
// past the first line.

const noop = () => {}

let hooks = { onCheckpoint: noop, onGameOver: noop, onRoomExpired: noop }

export function setSeasonHooks(next) {
  hooks = { ...hooks, ...next }
}

// The game is at a stable point and should be saved.
export function seasonCheckpoint(state) {
  if (state?.season) hooks.onCheckpoint(state)
}

export function seasonGameOver(state, io) {
  if (state?.season) hooks.onGameOver(state, io)
}

// Nobody came back in time and the room is being torn down. The save survives it.
export function seasonRoomExpired(state, roomId) {
  if (state?.season) hooks.onRoomExpired(state, roomId)
}
