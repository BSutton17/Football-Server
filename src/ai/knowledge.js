// ── What the AI knows ([offline]) ────────────────────────────────────────────
//
// The AI's entire picture of the game, assembled ONLY from the events its virtual socket receives.
// Nothing in here reaches into the game state, and that is the point: the standing rule of this
// codebase is that **the defense never sees the play call**, and the cheapest way to guarantee it
// is to make the information physically absent rather than merely un-consulted.
//
// So this file is the boundary. Every other module in ai/ is a pure function of a Knowledge object
// and therefore CANNOT cheat, however it is written later. If you ever need something here that the
// server does not already send to a human player's phone, the answer is not to import gameState —
// it is to decide whether a human would be told, and if so, emit it to both sides.
//
// What arrives, and when:
//   player_placed / player_removed  — the opponent's formation, as it is built. This is exactly
//                                     what a human sees: id, spot, and LABEL (WR/TE/RB). Routes are
//                                     never broadcast, so they are not here either.
//   game_state                      — the situation at each play boundary: down, distance, field
//                                     position, THE BALL'S HASH, clock, score, and this seat's role.
//   offense_set                     — the offense has locked its formation; the adjust window opens.
//   hike_countdown                  — seconds left in that window.
//   ball_snapped                    — the play is LIVE. The ONLY notice of it: the next
//                                     game_state does not come until the play has ended.
//   positions_update                — live positions, 20 times a second.
//   switch_sides                    — possession changed; this seat's role flipped.

import { FIELD } from '../constants.js'

// Positions arrive in OFFENSE-RELATIVE yards: 0 is the offense's own goal line, 100 the opponent's.
// Everything in ai/ works in that frame, because it is the frame a play is actually designed in —
// "eight yards downfield" means the same thing on either side of the field.
export const FIELD_MID = FIELD.WIDTH / 2

export const RECEIVER_LABELS = new Set(['WR', 'TE', 'RB'])

export function createKnowledge(slot) {
  return {
    slot,
    role: null,             // 'offense' | 'defense' — which side this seat is on right now
    phase: null,

    // Situation, from the last game_state.
    down: 1,
    distance: 10,
    yardLine: 25,
    // ⚠️ THE BALL IS NOT ALWAYS IN THE MIDDLE OF THE FIELD. It is spotted on a hash, and that hash
    // moves laterally all game. Everything a formation is built around pivots on it: the line, the
    // quarterback, receiver splits, zone landmarks, the defensive front. Defaulting to the field
    // middle (which this AI did at first) puts the offensive line up to thirteen yards from where
    // the client draws it — so the whole line JUMPED at the snap, and a defense correctly lined up
    // on the hash found itself nowhere near the offense it was supposed to be facing.
    ballX: FIELD.WIDTH / 2,
    clock: 0,
    playClock: 30,
    quarter: 1,
    score: { own: 0, opp: 0 },
    timeouts: { own: 3, opp: 3 },
    mode: 'automatic',
    difficulty: 'easy',
    specialTeams: null,
    decision: null,

    // The field. `own` is this seat's players, `opp` the other side's — named by SIDE rather than
    // by offense/defense because the roles swap mid-game and a map keyed on the wrong one is the
    // exact bug that strands a player on the wrong side of the ball.
    own: new Map(),         // id -> { id, x, y, label }
    opp: new Map(),

    // Live play.
    live: new Map(),        // id -> { id, x, y, team, openness?, ready?, carrier? }
    manualPlay: false,      // this play is driven by the GO button (manual room, pass call)
    // [pressure] The server has offered the throwaway (2s of live play on a pass). Until this
    // arrives, bailing out is refused — so the AI has to know, exactly as a human sees the button.
    throwawayReady: false,
    offenseSet: false,      // the offense has locked its formation
    countdown: null,        // seconds left in the defensive adjust window, or null

    // Bookkeeping so a controller can tell a new play from a re-render of the same one.
    playSerial: -1,
    newPlay: false,
  }
}

// Folds one received event into the picture. Returns the knowledge for chaining.
// Unknown events are ignored rather than throwing — the server grows events all the time and an AI
// that falls over when it hears an unfamiliar one is worse than an AI that ignores it.
export function applyEvent(k, event, payload) {
  switch (event) {
    case 'game_state': return onGameState(k, payload)

    case 'player_placed': {
      const { id, x, y, label, team } = payload ?? {}
      if (!id) return k
      const mine = isOwnTeam(k, team)
      const map = mine ? k.own : k.opp
      map.set(id, { id, x, y, label: label ?? '' })
      // A role swap mid-drive can move a player across the two maps; drop any stale copy from the
      // other one so nobody is counted twice.
      const other = mine ? k.opp : k.own
      other.delete(id)
      return k
    }

    case 'player_removed': {
      const id = typeof payload === 'string' ? payload : payload?.id
      if (id) { k.own.delete(id); k.opp.delete(id) }
      return k
    }

    case 'offense_set':
      k.offenseSet = true
      k.countdown = payload?.playClockRemaining ?? null
      return k

    // [pressure] The bail-out became legal. A sack costs seven yards; a throwaway costs none.
    case 'throwaway_ready':
      k.throwawayReady = true
      return k

    case 'hike_countdown':
      k.countdown = payload?.count ?? null
      return k

    // [offline] The play clock is how the computer's offense knows when to set — it waits for a
    // randomly chosen reading rather than setting the instant it has decided.
    case 'play_clock_update':
      k.playClock = payload?.playClock ?? k.playClock
      return k

    // ⚠️ THE SNAP DOES NOT SEND A game_state. `snap_ball` emits `ball_snapped` and transitions the
    // phase server-side; the next game_state does not arrive until the play is OVER. So a picture
    // that only tracked phase through game_state sat on 'countdown' for the entire play, and every
    // live-play decision gated on `phase === 'live'` was dead code. That is exactly how the AI's
    // quarterback came to hold the ball until he was sacked, twice, in the first real game.
    case 'ball_snapped':
      k.phase = 'live'
      k.manualPlay = !!payload?.manual
      return k

    // …and `play_result` is the only notice that it ENDED. Same asymmetry as the snap: the next
    // game_state does not arrive until the next play is set up, so without this the AI believes a
    // finished play is still live and keeps acting into it — which the server refuses with
    // "Action not available in current phase (dead)".
    case 'play_result':
      k.phase = 'dead'
      return k

    case 'positions_update': {
      k.live.clear()
      for (const p of payload ?? []) {
        k.live.set(p.id, {
          id: p.id, x: p.x, y: p.y, team: p.team,
          openness: p.openness, ready: p.ready,
          carrier: p.state === 'ball',
        })
      }
      return k
    }

    case 'switch_sides':
      k.role = payload?.role ?? k.role
      return k

    default:
      return k
  }
}

function onGameState(k, gs) {
  if (!gs) return k
  const serial = gs.playSerial ?? -1
  k.newPlay = serial !== k.playSerial
  k.playSerial = serial

  k.phase = gs.phase
  k.role = gs.role ?? k.role
  k.down = gs.down
  k.distance = gs.distance
  k.yardLine = gs.yardLine
  k.ballX = gs.ballX ?? k.ballX
  k.clock = gs.clock
  k.playClock = gs.playClock ?? k.playClock
  k.quarter = gs.quarter
  k.score = gs.score ?? k.score
  k.timeouts = gs.timeouts ?? k.timeouts
  k.mode = gs.mode ?? k.mode
  k.difficulty = gs.difficulty ?? k.difficulty
  k.specialTeams = gs.specialTeams ?? null
  k.decision = gs.decision ?? null

  // Each play starts from a clean field: the server wipes placed players between plays, so a
  // formation carried over from the last snap is a lie the AI would otherwise act on.
  if (k.newPlay) {
    k.own.clear()
    k.opp.clear()
    k.live.clear()
    k.offenseSet = false
    k.countdown = null
    k.throwawayReady = false
  }
  return k
}

// 'o' / 'd' in a payload is OFFENSE / DEFENSE, not mine / theirs. Which of those this seat is
// depends on who currently has the ball.
function isOwnTeam(k, team) {
  return k.role === 'offense' ? team === 'o' : team === 'd'
}

// ── Reading the picture ───────────────────────────────────────────────────────

export function isOffense(k) { return k.role === 'offense' }
export function isDefense(k) { return k.role === 'defense' }

// Yards to the opponent's goal line. `yardLine` counts up toward it, so this is the distance a
// field goal is measured from and the number a red-zone rule wants.
export function yardsToGoal(k) { return 100 - k.yardLine }

// Goal-to-go: the first-down marker is the goal line.
export function isGoalToGo(k) { return k.distance >= yardsToGoal(k) }

// Skill players on the other side, in the order they read across the field (west to east).
export function oppSkill(k) {
  return [...k.opp.values()]
    .filter(p => RECEIVER_LABELS.has(p.label))
    .sort((a, b) => a.x - b.x)
}

// Personnel the other side has on the field, as counts. The single most useful thing a defense
// knows pre-snap: three receivers and a back is a very different problem from two tight ends.
export function oppPersonnel(k) {
  const out = { WR: 0, TE: 0, RB: 0 }
  for (const p of k.opp.values()) if (p.label in out) out[p.label]++
  return out
}

// How many of the opponent's skill players are lined up IN THE BOX — tight to the formation and
// near the line. Heavy personnel in the box is a run indicator and drives how many defenders the
// AI needs down there to match it.
export const BOX_HALF_WIDTH = 9     // yards either side of the ball
export const BOX_DEPTH = 5          // yards behind the line a back still counts as in the box

export function oppInBox(k, ballX = FIELD_MID) {
  let n = 0
  for (const p of k.opp.values()) {
    if (!RECEIVER_LABELS.has(p.label)) continue
    if (Math.abs(p.x - ballX) > BOX_HALF_WIDTH) continue
    if (p.y < k.yardLine - BOX_DEPTH) continue
    n++
  }
  return n
}

// Which side of the formation each receiver is on. A single receiver isolated on one side is the
// case called out by name in the design: he must never be left uncovered.
export function receiversBySide(k, ballX = FIELD_MID) {
  const left = [], right = []
  for (const p of oppSkill(k)) (p.x < ballX ? left : right).push(p)
  return { left, right }
}
