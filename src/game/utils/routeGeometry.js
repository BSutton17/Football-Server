// ── Route geometry ([route draw]) ────────────────────────────────────────────
//
// Everything the simulation needs to know about a route's SHAPE, derived from its waypoints rather
// than from its name. Two jobs:
//
//   sanitizeDrawnRoute — take the waypoints a player drew (already beautified client-side) and make
//                        them legal and physically sane. The client is not trusted: this is the
//                        authoritative clamp, and it is what stops a hand-rolled socket message
//                        from sending a receiver on a 300-yard zig-zag.
//
//   routeTraits        — classify a route by geometry: does it break back toward the passer, is it
//                        a deep vertical, does it settle at the end. These are the questions the
//                        openness engine and the deep-safety rotation actually care about, and a
//                        drawn route has no name to look them up by.
//
// Coordinate frame for a drawn route: a list of { dx, dd } OFFSETS from the receiver's pre-snap
// spot — dx laterally (field x, + toward the right sideline), dd downfield in the offense's
// direction of travel. Storing offsets rather than absolute points means moving the receiver after
// drawing carries his route with him, exactly like a named route does.

import { FIELD } from '../../constants.js'

// A receiver cannot run a route of unlimited length inside a play. Beyond this the tail is trimmed.
export const MAX_ROUTE_LENGTH = 45

// [route draw] No direction change is allowed beyond this much path distance into the route. Past
// it the route is locked straight ahead on whatever heading it had. Real routes do their work in
// the first twenty yards; without this a drawing could keep jinking downfield forever, which both
// looks wrong and makes the route impossible to cover by design rather than by skill.
export const CUT_LOCK_DISTANCE = 20

// Points closer together than this are noise, not intent.
const MIN_SEGMENT = 0.4

// Turn angle (degrees) at a vertex above which it counts as a genuine CUT rather than a drift. Used
// for trait classification; the client's beautifier uses the same idea to decide sharp vs curved.
const CUT_ANGLE_DEG = 35

// A route counts as a deep vertical once it gets this far downfield without breaking back.
const DEEP_VERTICAL_DEPTH = 14

// Final-leg motion back toward the line of scrimmage that marks a comeback/curl shape.
const BREAK_BACK_MIN = 1.0

// Lateral distance the final leg must travel back toward the ball to count as working underneath.
const BREAK_BACK_LATERAL_MIN = 3.0

// Total path length below which a route isn't going anywhere at all (a blocker's).
const ZERO_LENGTH_ROUTE = 0.5

// How far off the ball a receiver must line up for "outward" to mean anything. Inside this he is
// effectively on the ball and a break either way crosses it, so the lateral read is skipped.
const BREAK_BACK_MIN_SPLIT = 2.0

const clampX = (x) => Math.max(1, Math.min(FIELD.WIDTH - 1, x))

// ── Sanitize ─────────────────────────────────────────────────────────────────

// points — [{ dx, dd }] offsets as drawn. Returns a cleaned copy, or null if there is no usable
// route in it. startX is the receiver's lateral spot, used to keep the path inside the sidelines.
export function sanitizeDrawnRoute(points, startX = FIELD.WIDTH / 2) {
  if (!Array.isArray(points) || points.length === 0) return null

  // Keep only finite numbers, and drop points that repeat the previous one.
  const cleaned = []
  for (const p of points) {
    const dx = Number(p?.dx), dd = Number(p?.dd)
    if (!Number.isFinite(dx) || !Number.isFinite(dd)) continue
    // Keep the drawing inside the field laterally; a route that leaves the sideline is clamped
    // back rather than rejected, so a slightly over-enthusiastic drawing still works.
    const cx = clampX(startX + dx) - startX
    const last = cleaned[cleaned.length - 1]
    if (last && Math.hypot(cx - last.dx, dd - last.dd) < MIN_SEGMENT) continue
    cleaned.push({ dx: cx, dd })
  }
  if (cleaned.length === 0) return null

  // Walk the path, accumulating length. Two limits apply as we go:
  //   • past CUT_LOCK_DISTANCE the route may no longer change direction
  //   • past MAX_ROUTE_LENGTH it simply ends
  const out = []
  let prev = { dx: 0, dd: 0 }         // the route always starts at the receiver
  let travelled = 0
  let locked = null                    // heading at the moment cuts were locked out

  for (const pt of cleaned) {
    const segX = pt.dx - prev.dx
    const segY = pt.dd - prev.dd
    const segLen = Math.hypot(segX, segY)
    if (segLen < 1e-6) continue

    // Already past the cut lock — everything from here is one straight continuation.
    if (locked) break

    if (travelled + segLen >= CUT_LOCK_DISTANCE) {
      // Take the part of this segment up to the lock point, then stop cutting.
      const t = (CUT_LOCK_DISTANCE - travelled) / segLen
      const lockPt = { dx: prev.dx + segX * t, dd: prev.dd + segY * t }
      out.push(lockPt)
      travelled = CUT_LOCK_DISTANCE
      locked = { hx: segX / segLen, hy: segY / segLen }
      prev = lockPt
      break
    }

    out.push({ dx: pt.dx, dd: pt.dd })
    travelled += segLen
    prev = pt
  }

  if (out.length === 0) return null

  // If cuts were locked out with distance still in the budget, run straight to spend it.
  if (locked && travelled < MAX_ROUTE_LENGTH) {
    const run = MAX_ROUTE_LENGTH - travelled
    out.push({
      dx: clampX(startX + prev.dx + locked.hx * run) - startX,
      dd: prev.dd + locked.hy * run,
    })
  }

  // Hard length cap for routes that never hit the lock (a long, straight drawing).
  return trimToLength(out, MAX_ROUTE_LENGTH)
}

// Truncates a path so its total length is at most `max`, cutting the final segment short.
function trimToLength(points, max) {
  const out = []
  let prev = { dx: 0, dd: 0 }
  let total = 0
  for (const pt of points) {
    const segLen = Math.hypot(pt.dx - prev.dx, pt.dd - prev.dd)
    if (total + segLen <= max) {
      out.push(pt)
      total += segLen
      prev = pt
      continue
    }
    const t = (max - total) / segLen
    if (t > 0.02) out.push({ dx: prev.dx + (pt.dx - prev.dx) * t, dd: prev.dd + (pt.dd - prev.dd) * t })
    break
  }
  return out.length > 0 ? out : null
}

// ── Absolute waypoints ───────────────────────────────────────────────────────

// Converts stored offsets into the absolute waypoint list the route engine walks.
export function drawnRouteWaypoints(points, startX, startY, dir) {
  return points.map(p => ({
    x: clampX(startX + p.dx),
    y: startY + dir * p.dd,
  }))
}

// ── Traits ───────────────────────────────────────────────────────────────────

// Classifies a route from its absolute waypoints. `startY` is where the receiver begins and `losY`
// the line of scrimmage; both are needed because a receiver may line up off the ball.
//
//   settles      — the route finishes coming back toward the passer, so the receiver should stop
//                  and wait rather than run through the endpoint (a curl / comeback shape)
//   breaksBack   — the final leg works back toward the line, which OPENS the window: the receiver
//                  is coming underneath the defender rather than running into him
//   deepVertical — gets well downfield without breaking back; the deep shell should recognize it
//   maxDepth     — deepest point past the LOS, in yards
export function routeTraits(waypoints, startY, losY, dir, startX = null, pivotX = null) {
  const empty = { settles: false, breaksBack: false, deepVertical: false, maxDepth: 0 }
  if (!Array.isArray(waypoints) || waypoints.length === 0) return empty

  const depthOf = (p) => (p.y - losY) * dir
  let maxDepth = Math.max(0, (startY - losY) * dir)
  for (const w of waypoints) maxDepth = Math.max(maxDepth, depthOf(w))

  // Breaking back needs a STEM and then a BREAK off it. A one-waypoint route is a single
  // destination — a screen or a flat — and has no break to read, however far behind the line it
  // finishes. Requiring two points is what keeps a screen from being mistaken for a comeback.
  const hasBreak = waypoints.length >= 2
  const last = waypoints[waypoints.length - 1]
  const prev = hasBreak ? waypoints[waypoints.length - 2] : null

  // (a) The last leg gives up depth — a comeback or a curl, sitting down in front of the coverage.
  const backwards = hasBreak ? depthOf(prev) - depthOf(last) : 0
  const comesDown = backwards >= BREAK_BACK_MIN

  // (b) The last leg works back ACROSS toward the passer without climbing. This is what separates a
  // return (breaks out, then back inside toward the ball — the window opens underneath) from a zig
  // (breaks in, then back OUT toward the sideline — running away from the throw, not underneath
  // it). Geometrically the two are mirror images; only which way the final leg heads relative to
  // the ball tells them apart, which is why the pivot is needed here at all.
  //
  // It is specifically a REVERSAL that matters, not merely breaking inside. A dig or a cross also
  // cuts in toward the ball, but it does so off a straight stem — the receiver is still crossing
  // the defender's face, running into coverage rather than away from it. A return breaks OUT first
  // and then comes back the other way, which is what leaves the defender going the wrong direction.
  // So the leg before the final one has to have gone the opposite way for this to count.
  // Both legs are judged against the receiver's own release direction — which way is "outward" from
  // the ball for HIM — rather than against the ball from wherever each leg happens to start. A
  // receiver lined up almost on top of the ball has no meaningful outward, so the rule sits out
  // rather than guessing.
  let comesInside = false
  const offset = startX != null && pivotX != null ? startX - pivotX : 0
  if (hasBreak && Math.abs(offset) >= BREAK_BACK_MIN_SPLIT && backwards > -BREAK_BACK_MIN) {
    const path = [{ x: startX, y: startY }, ...waypoints]
    const n = path.length
    const legX   = path[n - 1].x - path[n - 2].x            // the final leg, laterally
    const priorX = n >= 3 ? path[n - 2].x - path[n - 3].x : 0   // the leg before it
    const outward = Math.sign(offset)

    comesInside =
      Math.abs(priorX) >= BREAK_BACK_LATERAL_MIN && Math.sign(priorX) === outward &&   // broke out…
      Math.abs(legX)   >= BREAK_BACK_LATERAL_MIN && Math.sign(legX)   === -outward     // …then back in
  }

  // A route that goes nowhere is one the receiver stands still on. This is what reproduces `block`
  // without a name lookup — its definition is a single waypoint on top of the receiver.
  let travelled = 0
  {
    let prevPt = { x: startX ?? waypoints[0].x, y: startY }
    for (const w of waypoints) { travelled += Math.hypot(w.x - prevPt.x, w.y - prevPt.y); prevPt = w }
  }
  const goesNowhere = travelled < ZERO_LENGTH_ROUTE

  const breaksBack = comesDown || comesInside
  // A route the receiver sits down on is one that gives up depth to come back to the ball. Working
  // back across the field is still live movement, so it does not settle.
  const settles    = comesDown || goesNowhere
  // Deep only if it got downfield AND didn't turn back at the end.
  const deepVertical = maxDepth >= DEEP_VERTICAL_DEPTH && !breaksBack

  return { settles, breaksBack, deepVertical, maxDepth }
}

// Turn angle in degrees at each interior vertex — the client uses the same threshold to decide
// which bends become hard cuts and which stay curves, so the two agree on what a "cut" is.
export function vertexAngles(points) {
  const out = []
  for (let i = 1; i < points.length - 1; i++) {
    const ax = points[i].x - points[i - 1].x, ay = points[i].y - points[i - 1].y
    const bx = points[i + 1].x - points[i].x, by = points[i + 1].y - points[i].y
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < 1e-6 || lb < 1e-6) { out.push(0); continue }
    const cos = Math.max(-1, Math.min(1, (ax * bx + ay * by) / (la * lb)))
    out.push(Math.acos(cos) * 180 / Math.PI)
  }
  return out
}

export const CUT_ANGLE_THRESHOLD = CUT_ANGLE_DEG
