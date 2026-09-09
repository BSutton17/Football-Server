import { FIELD } from '../../constants.js'
import { ROUTE_DEF } from './routeDefinitions.js'
import { routeTraits } from './routeGeometry.js'
import { ratingOf, cutThresholdFromRating, cutSpeedRetentionFromRating } from '../../data/ratings.js'

// Builds the ordered waypoint list for a player's route.
// Called lazily the first time getRouteTarget is invoked for a player.
// pivotX is the lateral reference that decides which way "outward" faces — the BALL'S spot (hash),
// not the field's geometric middle, since the ball shifts laterally through the game.
export function buildWaypoints(route, startX, losY, dir, scale, pivotX) {
  const s    = scale ?? 1
  const near = startX >= (pivotX ?? FIELD.WIDTH / 2) ? 1 : -1
  const segs = ROUTE_DEF[route] ?? [[0, 10]]

  return segs.map(([nearFactor, dd]) => ({
    x: Math.max(1, Math.min(FIELD.WIDTH - 1, startX + near * nearFactor)),
    y: losY + dir * dd * s,
  }))
}

// Returns the current steering target {x, y} for a route runner.
// Manages phase transitions: advances through waypoints, applies cut speed penalties,
// and extends the final target when the receiver should keep running.
//
// Also tracks routeElapsed (seconds since snap) and routePhase ('running' | 'settled').
// routePhase is used by the stamina system to reduce drain when a player is stationary.
//
// Mutates several properties on the player object on first call and on transitions.
export function getRouteTarget(player, losY, dir, dt, pivotX) {
  const route = player.route
  if (!route) return null

  // Lazy init — build waypoints and timing state once on the first tick of live play.
  if (!player.routeWaypoints) {
    player.routeWaypoints   = buildWaypoints(route, player.x, losY, dir, player.routeDepthScale, pivotX)
    player.routeWaypointIdx = 0
    player.routeElapsed     = 0
    player.routePhase       = 'running'
    // [route geometry] Named routes are classified by SHAPE, exactly like drawn ones — there is no
    // longer a list of route names anywhere in the simulation. Derived here rather than from
    // ROUTE_DEF because it is the built waypoints that matter: the depth handle and the near-side
    // mirroring both change what the route actually is, and a shortened "go" is not a deep threat.
    player.routeTraits = routeTraits(player.routeWaypoints, player.y, losY, dir, player.x, pivotX)
    player.routeStart  = { x: player.x, y: player.y }
  }

  // Accumulate time spent on this route.
  player.routeElapsed += dt ?? 0

  const waypoints = player.routeWaypoints
  const idx       = player.routeWaypointIdx
  const target    = waypoints[idx]
  const isFinal   = idx === waypoints.length - 1

  const dx   = target.x - player.x
  const dy   = target.y - player.y
  const dist = Math.sqrt(dx * dx + dy * dy)

  const rrRating  = ratingOf(player, 'routeRunning') ?? 55
  const threshold = cutThresholdFromRating(rrRating)

  // A waypoint counts as reached when the receiver gets close to it — or, on a drawn route, once he
  // has run PAST it. Aiming ahead of the path means he deliberately cuts the inside of a bend, so he
  // may never come within `threshold` of a waypoint he has already left behind; without this he
  // would keep steering at a point that is now behind him and stall on the curve.
  const passed = player.routeDrawn && hasPassed(player, waypoints, idx)

  if (dist < threshold || passed) {
    if (!isFinal) {
      // Cut to the next waypoint — bleed off speed proportional to route running rating.
      let retention = cutSpeedRetentionFromRating(rrRating)

      // [route draw] A drawn route describes a CURVE with many closely-spaced waypoints, and
      // charging the full cut penalty at each one would leave a receiver crawling through a gentle
      // bend. So for drawn routes the penalty scales with how sharply the path actually turns
      // here: a hard break still costs full price, a lazy arc costs almost nothing. Named routes
      // keep the flat penalty they were tuned with — hence the explicit flag rather than keying off
      // routeTraits, which every route now carries.
      if (player.routeDrawn) {
        const turn = turnAngleAt(waypoints, idx, player)
        retention = 1 - (1 - retention) * Math.min(1, turn / 90)
      }

      player.vx *= retention
      player.vy *= retention
      player.routeWaypointIdx++
    } else if (player.routeTraits?.settles) {
      // Whether the receiver sits down at the end is read from the route's shape: one that finishes
      // working back toward the passer is one he settles on.
      // Stop route — player is settled at their spot, waiting for the ball.
      player.routePhase = 'settled'
    } else {
      // Continuation route — extend target 20 yards in current velocity direction.
      const spd = Math.sqrt(player.vx * player.vx + player.vy * player.vy) || 1
      waypoints[idx] = {
        x: Math.max(1, Math.min(FIELD.WIDTH - 1, player.x + (player.vx / spd) * 20)),
        y: player.y + (player.vy / spd) * 20,
      }
    }
  }

  // [route draw] A drawn route is a CURVE described by a chain of waypoints, and steering straight
  // at the next one makes the receiver saw between headings — he turns at each point, overshoots,
  // then turns back for the next. That is the jitter you see on a wheel or any other rounded route.
  //
  // So a drawn route is followed by aiming at a point some distance AHEAD along the path instead of
  // at the next waypoint (the pure-pursuit idea used for vehicle path following). The receiver then
  // leans into the bend continuously and flows through it. Named routes are unaffected: their
  // waypoints are far apart and their corners are meant to be planted on.
  //
  // Only GENTLE bends get this treatment. Aiming ahead deliberately cuts the inside of a turn, which
  // is right for an arc and wrong for a break: on a comeback the receiver would slice the corner and
  // never actually reach his break point. So a waypoint the route turns hard at is steered straight
  // at and planted on — the same sharp-versus-curved distinction the drawing is beautified with.
  if (player.routeDrawn) {
    const turn = turnAngleAt(waypoints, player.routeWaypointIdx, player)
    if (turn < CURVE_MAX_TURN_DEG) {
      return lookAheadTarget(player, waypoints, player.routeWaypointIdx)
    }
  }

  return waypoints[player.routeWaypointIdx]
}

// True once the receiver is beyond the plane through waypoint `idx` perpendicular to the leg that
// arrives at it — i.e. he has run past it, however wide.
function hasPassed(player, waypoints, idx) {
  const here = waypoints[idx]
  // For the first waypoint the leg arrives from where the route began, which is recorded at setup —
  // without it the opening waypoint could never be "passed" and the receiver would stall on it.
  const from = idx > 0 ? waypoints[idx - 1] : player.routeStart
  if (!from) return false

  const legX = here.x - from.x, legY = here.y - from.y
  const len = Math.hypot(legX, legY)
  if (len < 1e-6) return false

  return ((player.x - here.x) * legX + (player.y - here.y) * legY) / len > 0
}

// Turn angle below which a waypoint is part of a curve to be flowed through, rather than a break to
// be planted on. Matches the beautifier's CUT_ANGLE_DEG so the two agree on what a "cut" is.
const CURVE_MAX_TURN_DEG = 35

// How far ahead along the path a drawn-route runner aims. Roughly a stride and a half: far enough
// to smooth the bend, close enough that he still tracks the shape rather than cutting across it.
const PURSUIT_LOOKAHEAD = 3.5

// The point PURSUIT_LOOKAHEAD yards along the remaining path, measured from where the receiver is
// now. Falls back to the final waypoint once there is less path than that left.
function lookAheadTarget(player, waypoints, idx) {
  let remaining = PURSUIT_LOOKAHEAD
  let from = { x: player.x, y: player.y }

  for (let i = idx; i < waypoints.length; i++) {
    const to = waypoints[i]
    const seg = Math.hypot(to.x - from.x, to.y - from.y)
    if (seg >= remaining) {
      const t = seg < 1e-6 ? 0 : remaining / seg
      return { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t }
    }
    remaining -= seg
    from = to
  }
  return waypoints[waypoints.length - 1]
}

// Degrees of direction change at waypoint `idx`: the angle between the leg arriving at it (from the
// previous waypoint, or from the receiver on the first one) and the leg leaving it.
function turnAngleAt(waypoints, idx, player) {
  const from = idx > 0 ? waypoints[idx - 1] : { x: player.x, y: player.y }
  const here = waypoints[idx]
  const next = waypoints[idx + 1]
  if (!next) return 0

  const ax = here.x - from.x, ay = here.y - from.y
  const bx = next.x - here.x, by = next.y - here.y
  const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
  if (la < 1e-6 || lb < 1e-6) return 0

  const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
  return Math.acos(cos) * 180 / Math.PI
}

// True when a stop-route receiver has reached their endpoint and is waiting for the ball.
export function isSettled(player) {
  return player.routePhase === 'settled'
}
