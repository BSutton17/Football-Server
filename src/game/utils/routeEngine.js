import { FIELD } from '../../constants.js'
import { ROUTE_DEF, STOP_ROUTES } from './routeDefinitions.js'
import { ratingOf, cutThresholdFromRating, cutSpeedRetentionFromRating } from '../../data/ratings.js'

// Builds the ordered waypoint list for a player's route.
// Called lazily the first time getRouteTarget is invoked for a player.
function buildWaypoints(route, startX, losY, dir, scale) {
  const s    = scale ?? 1
  const near = startX > FIELD.WIDTH / 2 ? 1 : -1
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
export function getRouteTarget(player, losY, dir, dt) {
  const route = player.route
  if (!route) return null

  // Lazy init — build waypoints and timing state once on the first tick of live play.
  if (!player.routeWaypoints) {
    player.routeWaypoints   = buildWaypoints(route, player.x, losY, dir, player.routeDepthScale)
    player.routeWaypointIdx = 0
    player.routeElapsed     = 0
    player.routePhase       = 'running'
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

  if (dist < threshold) {
    if (!isFinal) {
      // Cut to the next waypoint — bleed off speed proportional to route running rating
      const retention = cutSpeedRetentionFromRating(rrRating)
      player.vx *= retention
      player.vy *= retention
      player.routeWaypointIdx++
    } else if (STOP_ROUTES.has(route)) {
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

  return waypoints[player.routeWaypointIdx]
}

// True when a stop-route receiver has reached their endpoint and is waiting for the ball.
export function isSettled(player) {
  return player.routePhase === 'settled'
}
