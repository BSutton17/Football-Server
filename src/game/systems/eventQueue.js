import { processQueue } from '../eventQueue.js'

// Drains the event queue for this room.
// Runs after movement and clock so all events from this tick are collected
// before any of them are processed.
export function runEventQueue(state, io, _dt) {
  processQueue(state.roomId, state, io)
}
