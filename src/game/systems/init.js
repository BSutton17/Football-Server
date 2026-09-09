import { FIELD } from '../../constants.js'
import { sanitizeDrawnRoute, drawnRouteWaypoints, routeTraits } from '../utils/routeGeometry.js'
import { buildWaypoints } from '../utils/routeEngine.js'
import { getLosY } from '../gameState.js'
import { getRatings, ratingOf, speedFromRating } from '../../data/ratings.js'
import { onSnapXFactors } from './xFactors.js'

// Fraction of top speed the running back is already moving at when a run play begins —
// it takes the handoff with momentum rather than from a dead stop, then accelerates up.
const RB_RUN_START_SPEED_FRACTION = 0.35

// ── Press jam at the snap ([press]) ──────────────────────────────────────────────
// A CB/S in man coverage jammed up at the LOS right in front of its receiver. press vs the
// receiver's routeRunning decides the jam: the loser is STUNNED for |difference| / 50 seconds
// (e.g. press 99 vs route 89 → WR stunned 0.2s; press 89 vs route 99 → defender stunned 0.2s).
const PRESS_LOS_DEPTH = 1.5   // yds from the LOS the defender must be to count as "press"
const PRESS_NEAR      = 1.5   // yds laterally it must be from the receiver ("right in front")
const PRESS_STUN_DIV  = 50    // rating-points-per-second of stun

function resolvePressJams(state) {
  if (!state.defensePlayers || !state.defenseCoverage || !state.offensePlayers) return
  if (state.yardLine == null) return
  const dir  = state.direction
  const losY = getLosY(state)
  for (const d of state.defensePlayers.values()) {
    if (d.label !== 'CB' && d.label !== 'S') continue
    const cov = state.defenseCoverage.get(d.id)
    if (cov?.type !== 'man' || !cov.targetId) continue
    const wr = state.offensePlayers.get(cov.targetId)
    if (!wr) continue

    // Must be pressed at the line, right in front of the receiver.
    if (Math.abs((d.y - losY) * dir) > PRESS_LOS_DEPTH) continue
    if (Math.abs(d.x - wr.x) > PRESS_NEAR) continue

    const press = ratingOf(d, 'press') ?? 0
    const route = ratingOf(wr, 'routeRunning') ?? 0
    const stun  = Math.abs(press - route) / PRESS_STUN_DIV
    if (stun <= 0) continue

    if (press > route) wr.stunTimer = Math.max(wr.stunTimer ?? 0, stun)   // jammed at the line
    else               d.stunTimer  = Math.max(d.stunTimer ?? 0, stun)    // beaten clean off the press
  }
}

// Called once when phase transitions COUNTDOWN → LIVE.
// Populates offensePlayers with any auto-placed players (OL, QB) that were never
// sent via place_player, and annotates all offense players with label/route data
// so the movement system doesn't have to search playDesign every tick.
export function initLivePhase(state) {
  if (!state.playDesign) return

  const dir   = state.direction
  const isRun = state.playDesign.playType === 'run'
  const toAbs = (relY) => dir === 1
    ? relY + FIELD.END_ZONE_DEPTH
    : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - relY

  for (const p of state.playDesign.players) {
    if (p.team !== 'o') continue

    let fp
    if (state.offensePlayers.has(p.id)) {
      // Already placed via place_player — just attach route/label info
      fp                 = state.offensePlayers.get(p.id)
      fp.label           = p.label
      fp.route           = p.route ?? null
      fp.routeDepthScale = p.routeDepthScale ?? 1
    } else {
      // Auto-placed player (OL, QB) — convert relY → absY and insert
      fp = {
        id:             p.id,
        x:              p.x,
        y:              toAbs(p.y),
        vx:             0,
        vy:             0,
        label:          p.label,
        route:          p.route ?? null,
        routeDepthScale: p.routeDepthScale ?? 1,
      }
      state.offensePlayers.set(p.id, fp)
    }

    // [route draw] A hand-drawn route arrives as offsets from where the receiver was standing when
    // it was drawn. This is the single choke point where it becomes real, and therefore where it is
    // clamped: the client beautifies for feel, but the SERVER decides what is legal — length, the
    // cut lock, and staying inbounds. Building the waypoints here also means the route is anchored
    // to wherever the receiver actually ended up, so moving him after drawing carries his route.
    if (p.drawnRoute) {
      const clean = sanitizeDrawnRoute(p.drawnRoute, fp.x)
      if (clean) {
        const losY = getLosY(state)
        fp.route          = 'custom'
        fp.routeDrawn     = true   // drawn routes get the angle-scaled cut penalty (see routeEngine)
        fp.drawnRoute     = clean
        fp.routeWaypoints = drawnRouteWaypoints(clean, fp.x, fp.y, dir)
        // Pre-seeding the engine's own state so it walks these instead of building from a template.
        fp.routeWaypointIdx = 0
        fp.routeElapsed     = 0
        fp.routePhase       = 'running'
        // Geometry stands in for the route NAME everywhere the sim used to classify by name.
        fp.routeTraits = routeTraits(fp.routeWaypoints, fp.y, losY, dir, fp.x, state.ballX)
        fp.routeStart  = { x: fp.x, y: fp.y }
      } else {
        fp.route = null   // an unusable drawing is no route at all, not a broken one
      }
    }

    // [route geometry] Named routes get their waypoints and traits built HERE rather than lazily on
    // the receiver's first movement tick. Deep-safety rotation runs before the per-player loop, so
    // building them lazily left every route unclassified on the opening tick of a play.
    else if (fp.route && fp.route !== 'block') {
      const losY = getLosY(state)
      fp.routeWaypoints   = buildWaypoints(fp.route, fp.x, losY, dir, fp.routeDepthScale, state.ballX)
      fp.routeWaypointIdx = 0
      fp.routeElapsed     = 0
      fp.routePhase       = 'running'
      fp.routeTraits      = routeTraits(fp.routeWaypoints, fp.y, losY, dir, fp.x, state.ballX)
      fp.routeStart       = { x: fp.x, y: fp.y }
    }

    // [293] Carry the player's per-team ratings onto the field entity so the sim uses them.
    if (p.ratings) fp.ratings = p.ratings
    // [294] Carry the player's potential X-Factor (inactive until earned during gameplay).
    if (p.xFactor) { fp.xFactor = p.xFactor; fp.xFactorActive ??= false }

    // RB starts a run already moving at 35% speed downfield ([159]), then accelerates up.
    if (isRun && fp.label === 'RB') {
      const topSpd = speedFromRating(ratingOf(fp, 'speed'))
      fp.vx = 0
      fp.vy = dir * RB_RUN_START_SPEED_FRACTION * topSpd
    }
  }

  // Resolve press jams at the snap — stuns the loser of each press matchup ([press]).
  resolvePressJams(state)

  // [294] Restore active X-Factor stars onto the fresh play entities, and tick the Team Chemistry
  // per-snap ramp for an active QB.
  onSnapXFactors(state)
}
