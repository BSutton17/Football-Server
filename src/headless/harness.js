// ── Headless harness ([offline][training]) ───────────────────────────────────
//
// Runs real games with no Socket.io server and no wall-clock timer. Two jobs:
//
//   • TESTING — drive a whole play, or a whole game, inside a unit test.
//   • TRAINING — the AI's fitness comes from playing thousands of plays. At 20Hz a real-time play
//     takes four seconds; stepped by hand it takes milliseconds, and the limit becomes CPU rather
//     than the clock.
//
// Nothing here is a simulation of the game — it IS the game. `tick()` is the production tick and
// the handlers are the production handlers. The only things replaced are the transport (a fake io
// that records emits) and the clock (an explicit loop instead of setInterval).

import { tick } from '../game/simulation.js'
import { getGame } from '../game/gameState.js'
import { PHASE } from '../game/stateMachine.js'
import { bridgeIo } from '../ai/seats.js'

// A stand-in for the Socket.io server. Records every emit so a test can assert on what players
// were told, and resolves sockets from a registry the harness controls.
export function createFakeIo() {
  const emits   = []
  const sockets = new Map()

  const io = {
    sockets: { sockets },
    to(target) {
      return { emit(event, payload) { emits.push({ target, event, payload }) } }
    },
    on() {},

    // ── Test helpers ────────────────────────────────────────────────────────
    emits,
    register(socket) { sockets.set(socket.id, socket); return socket },
    // Every emit of one kind, oldest first.
    of(event) { return emits.filter(e => e.event === event) },
    last(event) { const m = io.of(event); return m.length ? m[m.length - 1] : null },
    clear() { emits.length = 0 },
  }

  // Bridged so AI seats hear the game here exactly as they do in production.
  const bridged = bridgeIo(io)
  bridged.emits   = emits
  bridged.register = io.register
  bridged.of      = io.of
  bridged.last    = io.last
  bridged.clear   = io.clear
  return bridged
}

// ── Stepping ──────────────────────────────────────────────────────────────────
//
// A tick is 50ms of game time. These all step in ticks, never in real time, so a test never sleeps
// and a training run is bounded by CPU rather than by the clock.

export const TICK_SECONDS = 0.05

// Runs ticks until `done(state)` is true or the budget runs out. Returns how many ticks it took,
// or -1 if it never happened — callers assert on that rather than hanging.
// `onTick` observes the state after each tick, for telemetry that has to be sampled DURING a play
// rather than read off the result — pursuit angles, coverage separation, anything per-frame. It must
// not mutate: it is handed the live state, and a measurement that changes what it measures is worse
// than no measurement. See scripts/pursuitLab.mjs.
export function stepUntil(roomId, io, done, { maxTicks = 2000, onTick = null } = {}) {
  for (let i = 0; i < maxTicks; i++) {
    const state = getGame(roomId)
    if (!state) return -1
    if (done(state, i)) return i
    tick(roomId, io)
    if (onTick) {
      const after = getGame(roomId)
      if (after) onTick(after, i)
    }
  }
  return -1
}

export function stepTicks(roomId, io, ticks) {
  for (let i = 0; i < ticks; i++) tick(roomId, io)
}

export function stepSeconds(roomId, io, seconds) {
  stepTicks(roomId, io, Math.round(seconds / TICK_SECONDS))
}

// Runs a live play out to the whistle. The play is over when the phase leaves LIVE.
export function runPlayToWhistle(roomId, io, { maxTicks = 1200 } = {}) {
  const ticks = stepUntil(roomId, io, s => s.phase !== PHASE.LIVE, { maxTicks })
  return { ticks, state: getGame(roomId) }
}

// ── Diagnostics ───────────────────────────────────────────────────────────────

// A compact snapshot of everything that decides a play's outcome. Used to assert that two runs of
// a seeded game are genuinely identical — comparing whole states would drown in timers and Maps.
export function fingerprint(state) {
  if (!state) return null
  const pos = (m) => [...m.values()]
    .map(p => `${p.id}:${p.x.toFixed(3)},${p.y.toFixed(3)}`)
    .sort()
    .join('|')
  return [
    state.phase, state.quarter, state.down, state.distance,
    state.yardLine, state.possession, state.direction,
    (state.score ?? []).join('-'),
    Math.round((state.clock ?? 0) * 100),
    pos(state.offensePlayers), pos(state.defensePlayers),
  ].join('#')
}
