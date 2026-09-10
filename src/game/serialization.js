import { getScoreFor, getLosY } from './gameState.js'
import { isPlayerPaused } from './pause.js'
import { FIELD, HIDES_OPENNESS } from '../constants.js'
import { computeReceiverOpenness } from './utils/openness.js'
import { findBallCarrier } from './systems/movement.js'
import { serializeSpecialTeams, serializeDecision, serializeConversion } from './specialTeams.js'
import { activeXFactorIds } from './systems/xFactors.js'

const RECEIVER_LABELS = new Set(['WR', 'TE', 'RB'])

// Openness color is revealed only once a receiver has DECLARED ([openness reveal]): after it makes
// its first cut (clears the first route waypoint) or, on a route with no cut (go/seam), after this
// many seconds. Before that the coverage hasn't shown its hand, so the receiver keeps its base color.
const OPENNESS_REVEAL_DELAY = 1.3   // seconds since snap for a no-cut route

// A receiver has "declared" — the client light turns on and it becomes a viable throw target — once
// it has made its first cut (cleared the first waypoint) or, on a no-cut route, held long enough for
// the read to develop. Single source of truth for the ready gate (openness reveal + throw-early check).
export function isReceiverReady(p) {
  return (p.routeWaypointIdx ?? 0) >= 1 || (p.routeElapsed ?? 0) >= OPENNESS_REVEAL_DELAY
}

// ── Coordinate rounding ───────────────────────────────────────────────────────
//
// Player positions are floats from continuous simulation (e.g. 26.667341...).
// Clients only need ~1 inch of precision for rendering — 2 decimal places in
// yards is about 0.9 inches.  Sending full float64 precision 20× per second
// wastes bandwidth for invisible accuracy.

function roundCoord(n) {
  return Math.round(n * 100) / 100
}

// ── Full snapshot ─────────────────────────────────────────────────────────────
//
// Sent once when the game starts and again if a player reconnects mid-game.
// Contains everything needed to reconstruct the game display from scratch.
//
// viewerSlot (0 | 1): score is expressed from the viewer's perspective.
//   { offense: <viewer's points>, defense: <opponent's points> }

export function serializeGameState(state, viewerSlot) {
  return {
    phase:    state.phase,
    quarter:  state.quarter,
    clock:    state.clock,
    down:     state.down,
    distance: state.distance,
    yardLine: state.yardLine,
    ballX:    roundCoord(state.ballX ?? FIELD.WIDTH / 2),   // [hash] lateral spot the next formation lines up on
    playClock: Math.ceil(state.playClock ?? 25),           // [play-clock] starting value for this snap (40 on a drive start)
    playSerial: state.playSerial ?? 0,                     // [stale set] which pre-snap situation this is
    // [pause] Carried so a player returning from a lost connection lands back into the paused game
    // rather than a frozen-looking one with no explanation.
    paused: isPlayerPaused(state),
    pausedByYou: isPlayerPaused(state) && state.pausedBy === viewerSlot,

    score:    getScoreFor(state, viewerSlot),
    // [70] Timeouts remaining, viewer-relative (own = this player's team). Both counts sync to both
    // clients. Follows the TEAM (slot), not the current offense/defense role, so it survives turnovers.
    timeouts: { own: state.timeouts?.[viewerSlot] ?? 0, opp: state.timeouts?.[1 - viewerSlot] ?? 0 },
    role:     state.possession === viewerSlot ? 'offense' : 'defense',
    specialTeams: serializeSpecialTeams(state, viewerSlot),   // [Special Teams][1] null on a normal scrimmage play
    // [Special Teams][2][3] 4th-down menu, or [51] the post-TD extra-point / 2-pt menu — both render
    // through the same client menu (scoring/offense team only).
    decision: serializeDecision(state, viewerSlot) ?? serializeConversion(state, viewerSlot),
    xfActiveIds: activeXFactorIds(state),   // [294] active-X-Factor players → star shows pre-snap too
    fatigue:  serializeFatigue(state, viewerSlot),   // [fatigue] own-team stamina (drives the bars)
    // [manual] Fixed for the game. The client needs both: mode switches HIKE for GO, and difficulty
    // tells it whether openness colors will arrive at all (hard sends none to the offense).
    mode:       state.mode ?? 'automatic',
    difficulty: state.difficulty ?? 'easy',
  }
}

// Per-player stamina (0–100) for the VIEWER'S OWN team only ([fatigue feedback]: never show the
// opponent's fatigue). The client renders these as bars when the Fatigue view is toggled on. Read
// from the PERSISTENT fatigue map (tagged with each player's team slot) rather than the per-play
// offense/defense maps — those are wiped at the play boundary where this game_state is sent, so the
// bars must survive across plays.
function serializeFatigue(state, viewerSlot) {
  const out = {}
  if (!state.playerFatigue) return out
  for (const [id, f] of state.playerFatigue) {
    if (f && f.slot === viewerSlot && Number.isFinite(f.stamina)) out[id] = Math.round(f.stamina)
  }
  return out
}

// ── Per-tick position update ──────────────────────────────────────────────────
//
// Sent every simulation tick (50 ms) during live play.
// Y is converted from absolute field coordinates to offense-relative yards:
//   0  = own goal line, 100 = opponent goal line, -10/110 = end zone backs
// This lets the renderer draw from the offense's perspective regardless of
// which direction they're advancing on the absolute field.
// team: 'o' (offense) | 'd' (defense) — tells the renderer which color to use.

// [manual] `viewerSlot` decides how much of the passing read this payload is allowed to carry.
// On HARD difficulty the offense is never sent openness at all — the colors it would drive simply
// don't exist client-side, so there is nothing to recover from devtools. The defense always gets
// the true read, and easy / automatic games are unchanged. Pass null for the full payload.
//
// Receivers always carry `ready`: whether the route has declared ([68]). Easy mode signals that
// implicitly (openness only appears once ready), but hard mode has no color to lean on, so the
// client fades an undeclared receiver and lights it up on `ready` instead.
// [lane block] The context the short-pass lane check needs: where the LOS is, which way the offense
// is going, and who is actually playing zone (a man defender with his back turned gets no play on
// the ball). Exported so the throw resolution settles the pass on the identical read.
export function laneContext(state) {
  const zoneIds = new Set()
  if (state.defenseCoverage) {
    for (const [id, cov] of state.defenseCoverage) {
      if (cov?.type === 'zone') zoneIds.add(id)
    }
  }
  return { losY: getLosY(state), direction: state.direction, zoneIds }
}

export function serializePositions(state, viewerSlot = null) {
  const positions = []
  // Who is being denied the openness read, and why. The two sides are withheld for opposite
  // reasons, so they are separate rules rather than one:
  //   • the OFFENSE loses it on medium/hard — that is what those difficulties mean.
  //   • the DEFENSE loses it only if the host turned its vision off ([defense vision]). It is on by
  //     default, because a defender who cannot see how open a receiver is has no way of knowing
  //     what his coverage needs to fix.
  const isOffenseViewer = viewerSlot != null && viewerSlot === state.possession
  const hideOpenness = viewerSlot != null && (
    isOffenseViewer
      ? HIDES_OPENNESS.has(state.difficulty)
      : state.defenseSeesOpenness === false
  )

  const toRelY = state.direction === 1
    ? (absY) => absY - FIELD.END_ZONE_DEPTH           // northbound: shift by south end zone
    : (absY) => FIELD.LENGTH - FIELD.END_ZONE_DEPTH - absY  // southbound: invert

  // Openness ([169]) is computed against the live defenders and the QB (the passer).
  const defenders = [...state.defensePlayers.values()]
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }
  // [lane block] Everything the short-pass throwing-lane check needs. Computed once per tick rather
  // than per receiver, and shared with the throw resolution so the color the offense reads is the
  // same read the pass is actually settled on.
  const lane = laneContext(state)

  // Whoever currently has the ball is tagged so the client can render the football on them and
  // follow them with the camera ([193]). findBallCarrier covers the designed runner, a scrambling
  // QB, a receiver after the catch, and an intercepting defender on a return.
  const carrierId = findBallCarrier(state)?.id ?? null

  for (const p of state.offensePlayers.values()) {
    const pos = { id: p.id, x: roundCoord(p.x), y: roundCoord(toRelY(p.y)), team: 'o' }
    if (p.id === carrierId) pos.state = 'ball'
    if (p.xFactorActive) pos.xfActive = true   // [294] both clients render an active X-Factor as a star
    // [pancake] Flattened by a block: the client fades him out and he is out of the play.
    if ((p.pancakedFor ?? 0) > 0) pos.pancaked = true
    // Pass catchers carry an openness score so the client can color them ([169]) — but only once
    // the receiver has declared: after its first cut (routeWaypointIdx ≥ 1) or, on a no-cut route,
    // after OPENNESS_REVEAL_DELAY. Until then it keeps its base color (the read hasn't developed).
    if (RECEIVER_LABELS.has(p.label)) {
      const ready = isReceiverReady(p)
      pos.ready = ready
      if (ready && !hideOpenness) pos.openness = roundCoord(computeReceiverOpenness(p, defenders, qb, lane))
    }
    positions.push(pos)
  }
  for (const p of state.defensePlayers.values()) {
    const pos = { id: p.id, x: roundCoord(p.x), y: roundCoord(toRelY(p.y)), team: 'd' }
    if (p.id === carrierId) pos.state = 'ball'   // an intercepting defender returning the ball
    if (p.xFactorActive) pos.xfActive = true     // [294]
    positions.push(pos)
  }

  return positions
}

// ── Ball-carrier vision ([163]) ───────────────────────────────────────────────
//
// Debug payload for the run visualizer: the ball carrier's evaluated vision rays.
// Ray directions are sent in the offense-relative frame (forward is always +y) so the
// client can draw them directly regardless of which way the offense is advancing:
//   dx = ray's lateral component, dy = forward component (ray.dirY × direction).
// Returns null when there's no run carrier with an evaluated lane.

export function serializeCarrierVision(state) {
  if (state.playDesign?.playType !== 'run') return null

  let carrier = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'RB' && p.runLane?.rays) { carrier = p; break }
  }
  if (!carrier) return null

  const dir  = state.direction
  const best = carrier.runLane
  const rays = carrier.runLane.rays.map(r => ({
    dx:       roundCoord(r.dirX),
    dy:       roundCoord(r.dirY * dir),   // forward in the offense-relative frame
    clear:    roundCoord(r.clear),
    selected: r.angle === best.angle,
  }))

  return { id: carrier.id, rays }
}

// ── Post-play result ──────────────────────────────────────────────────────────
//
// Sent to each player individually after a play ends.
// Must be called once per player because newPossession is viewer-relative:
//   - The team that gains the ball sees newPossession = 'offense'
//   - The team that loses the ball sees newPossession = 'defense'
//
// newPossessionSlot: the slot (0 | 1) that now has the ball.
//                   Pass null/undefined if possession did not change.
// viewerSlot:       which player is receiving this payload.

export function serializePlayResult(state, outcome, yardsGained, newPossessionSlot, viewerSlot, firstDown = false, detail = null) {
  const result = {
    outcome,
    yardsGained,
    down:     state.down,
    distance: state.distance,
    yardLine: state.yardLine,
    firstDown,   // [224][225] true when this play moved the chains (drives the "First down!" notice)
    detail,      // [pass-outcome] 'broken_up' | 'drop' on an incompletion, so the notice can match
  }

  if (newPossessionSlot != null) {
    result.newPossession = newPossessionSlot === viewerSlot ? 'offense' : 'defense'
  }

  return result
}

// ── Periodic clock update ─────────────────────────────────────────────────────
//
// Sent after each clock tick.  Math.ceil keeps the display at whole seconds
// (300, 299, 298...) instead of flickering between 299.9 and 300.

export function serializeClock(state) {
  return {
    quarter: state.quarter,
    clock:   Math.ceil(state.clock),
  }
}

// ── Score update ──────────────────────────────────────────────────────────────
//
// Sent after the score changes.  Viewer-relative — same translation as the
// full snapshot.

export function serializeScore(state, viewerSlot) {
  return getScoreFor(state, viewerSlot)
}

// ── Game-over summary ─────────────────────────────────────────────────────────
//
// Sent to each player individually when Q4 ends.
// result is from the receiver's perspective: 'win', 'loss', or 'tie'.

export function serializeGameOver(state, viewerSlot) {
  const score = getScoreFor(state, viewerSlot)
  const result = score.offense > score.defense ? 'win'
               : score.offense < score.defense ? 'loss'
               : 'tie'
  return { score, result }
}
