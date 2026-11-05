// ── Saving a game in progress ([seasons]) ──────────────────────────────────
//
// "The game should autosave every quarter in case there is a crash and the player can rejoin." It saves
// every play instead, by agreement: a quarter-only save let a player force-close after an interception
// and replay the quarter.
//
// Taken at a dead ball, when everything is on the state and nothing is in the air. The state is written
// generically rather than field by field, because it gains a field every few weeks and a list here is
// exactly the sort of thing that goes stale silently. So what is skipped is listed instead of what
// is kept, and those are all things that belong to a running process rather than to the game.

import { makeRng } from './utils/rng.js'
import { PHASE } from './stateMachine.js'

export const SNAPSHOT_VERSION = 1

// Timers, the generator (a closure), who is paused, and where this particular process has got to.
const SKIP = new Set([
  'rng', 'roomId', 'nextPlayTimer', 'nextPlayDueAt', 'countdownTimers', 'countdownDueAt', 'countdownToken',
  'phaseSince', 'stoppageSince', 'stoppage', 'pauseInterrupted', 'pausedBy', 'pauseWasAutomatic',
])

function replacer(_key, value) {
  if (value instanceof Map) return { $map: [...value.entries()] }
  if (value instanceof Set) return { $set: [...value.values()] }
  if (value?.constructor?.name === 'Timeout') return undefined
  return value
}

function reviver(_key, value) {
  if (value && typeof value === 'object') {
    if (Array.isArray(value.$map)) return new Map(value.$map)
    if (Array.isArray(value.$set)) return new Set(value.$set)
  }
  return value
}

// A string, not an object: player ids and the like become keys, and the database has opinions about
// what a key may contain.
export function snapshotGame(state) {
  const copy = {}
  for (const [k, v] of Object.entries(state)) {
    if (!SKIP.has(k) && typeof v !== 'function') copy[k] = v
  }
  // A formation someone had half placed is not worth saving: the client re-lines up on arrival, and
  // the computer re-aligns when it sees the new play. A countdown is timers, which do not survive.
  if (copy.phase === PHASE.COUNTDOWN) copy.phase = PHASE.PRE_SNAP
  if (copy.phase === PHASE.PRE_SNAP) {
    copy.offensePlayers = new Map()
    copy.defensePlayers = new Map()
    copy.defenseCoverage = new Map()
  }
  return JSON.stringify({ v: SNAPSHOT_VERSION, state: copy }, replacer)
}

// Pours a snapshot into a freshly made game state. Returns false if it cannot be read, in which case
// the state is left as it was and the caller starts the game from the top.
export function hydrateGame(state, json) {
  let parsed
  try {
    parsed = JSON.parse(json, reviver)
  } catch (err) {
    console.error(`[season] unreadable save: ${err.message}`)
    return false
  }
  if (parsed?.v !== SNAPSHOT_VERSION || !parsed.state) return false

  const { roomId, season } = state
  Object.assign(state, parsed.state, { roomId, season })
  state.stoppage = null
  state.nextPlayTimer = null
  state.nextPlayDueAt = 0
  state.countdownTimers = null
  state.phaseSince = Date.now()
  state.stoppageSince = null
  state.pauseInterrupted = null
  state.pausedBy = null
  state.pauseWasAutomatic = false
  // A fresh stream, differing per play so that replaying from a save is not a fixed fate.
  state.seed = ((state.seed ?? 1) ^ Math.imul((state.playSerial ?? 0) + 1, 0x9e3779b1)) >>> 0
  state.rng = makeRng(state.seed)
  return true
}
