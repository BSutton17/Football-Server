import { FIELD } from '../../constants.js'

// ── RB vision raycast ([154], [priority 3]) ───────────────────────────────────
//
// The ball carrier "sees" the field by casting a dense fan of rays through a 90° cone
// toward the goal. A running lane is an AREA of open space, not just the longest ray — so
// each lane is scored, not merely measured:
//
//   laneScore = freeSpace − nearbyDefenders − nearbyBlockers + leverage + angle
//
//   freeSpace      — clear grass ahead before the ray hits ANY body (defender or blocker)
//   nearbyDefenders— congestion from defenders flanking the lane (heavily penalized)
//   nearbyBlockers — congestion from blockers / piles in the lane (the RB runs to grass,
//                    not into traffic)
//   leverage       — alignment with the called run gap
//   angle          — preference for north-south (vertical) movement over bouncing wide
//
// A shorter, clean, downhill lane beats a longer one choked with bodies.

const RAY_COUNT       = 31             // rays across the cone (~3° apart)
const CONE_HALF_ANGLE = Math.PI / 4    // 45° each way → 90° cone
const RAY_MAX         = 15             // yards the carrier looks ahead
const LANE_HALFWIDTH  = 1.5            // yards either side of a ray a body occupies (blocks the ray)
const SIDELINE_MARGIN = 1              // keep lanes inside the field

// Lane congestion: bodies ahead and within this band of the ray crowd the lane.
const DENSITY_RANGE = 10   // yards ahead a body still counts toward congestion
const DENSITY_BAND  = 3    // yards either side of the ray a body counts toward congestion

// laneScore weights (freeSpace is normalized to [0,1] so the terms are comparable).
const W_SPACE = 1.0    // open grass — the primary driver
const W_DEF   = 0.6    // free defenders flanking the lane hurt the most (the real tacklers)
const W_PILE  = 0.4    // engaged OL/DL piles crowd the lane — run around them, not through
const W_BLOCK = 0.3    // free teammates / traffic in the lane hurt, but less
const W_LEV   = 0.45   // run toward the called gap
const W_ANGLE = 0.35   // run north-south, not sideways
const W_STICK = 0.35   // stay committed to the current heading — decisive cuts, no oscillating

// Engaged-blocker handling ([run feedback]). A lineman actively engaging a defender is NOT a
// clear lane — the OL/DL pile physically occupies the path, and it's the back's job to find the
// best route AROUND it. So an engaged blocker walls a ray exactly like a defender does. As the OL
// drives the pile downfield ([priority 5] + the higher run push), the space it vacates at the LOS
// opens up, and the back follows the push through it — yielding short, grinding gains.

// ── Vision interval ([155]) ───────────────────────────────────────────────────
//
// How often the ball carrier re-reads the field, set by its vision rating (0–99):
// an elite (99) back re-evaluates every 0.25 s; a poor (0) back only every 2 s,
// committing to a stale lane in between and missing developing creases.
const VISION_INTERVAL_FAST = 0.25  // seconds between reads at vision 99
const VISION_INTERVAL_SLOW = 2.0   // seconds between reads at vision 0

export function visionInterval(vision) {
  const v = Math.max(0, Math.min(99, vision ?? 55))
  return VISION_INTERVAL_SLOW - (v / 99) * (VISION_INTERVAL_SLOW - VISION_INTERVAL_FAST)
}

// Component of (point − carrier) along the ray (how far ahead) and perpendicular to it.
function project(carrier, ray, point) {
  const dx = point.x - carrier.x
  const dy = point.y - carrier.y
  return {
    along: dx * ray.x + dy * ray.y,
    side:  Math.abs(-dx * ray.y + dy * ray.x),
  }
}

// Clear grass along one ray: distance to the nearest body (defender OR blocker) standing in
// the lane, or to the sideline, capped at RAY_MAX. Blockers obstruct now — the carrier runs
// to open space beside the pile, not into its own blockers' backs.
function clearDistance(carrier, ray, obstacles) {
  let clear = RAY_MAX

  if (ray.x > 1e-6)       clear = Math.min(clear, (FIELD.WIDTH - SIDELINE_MARGIN - carrier.x) / ray.x)
  else if (ray.x < -1e-6) clear = Math.min(clear, (SIDELINE_MARGIN - carrier.x) / ray.x)
  clear = Math.max(0, clear)

  for (const o of obstacles) {
    const { along, side } = project(carrier, ray, o)
    if (along <= 0 || along >= clear) continue
    if (side > LANE_HALFWIDTH) continue
    clear = along
  }
  return clear
}

// Congestion from a set of bodies near a lane: bodies ahead of the carrier and within the
// density band contribute more the closer they sit to the ray and the nearer they are.
function laneDensity(carrier, ray, bodies) {
  let density = 0
  for (const b of bodies) {
    const { along, side } = project(carrier, ray, b)
    if (along <= 0 || along > DENSITY_RANGE || side > DENSITY_BAND) continue
    density += (1 - side / DENSITY_BAND) * (1 - along / DENSITY_RANGE)
  }
  return density
}

// Returns the best running lane within the forward cone:
//   { dirX, dirY, clear, space, score, angle, rays }
// dir        — +1 (carrier advancing toward higher y) or −1
// biasAngle  — the called run angle in radians (0 = straight ahead)
// currentDir — the carrier's committed heading {x, y} (or null); lanes aligned with it get a
//              stickiness bonus so the back commits to a lane and cuts decisively ([priority 7]).
// Defenders/blockers carry engagement state (set by runEngagement) so the RB reads where the
// piles actually are and finds the best route around them ([run feedback]).
export function findRunningLane(carrier, defenders, blockers, dir, biasAngle = 0, currentDir = null) {
  const engagedBlockers = blockers.filter(b => b.isEngaged)   // OL locked on a DL — occupy the lane
  const freeBlockers    = blockers.filter(b => !b.isEngaged)  // unblocked teammates — soft traffic
  const freeDefenders   = defenders.filter(d => !d.isEngaged) // the real tacklers — avoid them

  // Bodies that WALL a ray: every defender at its spot, plus any OL actively engaging a defender.
  // The engaged OL/DL pile is a moving wall; the back runs around it (and into the space it
  // vacates as the line drives it downfield), never straight through it.
  const stoppers = []
  for (const d of defenders)       stoppers.push({ x: d.x, y: d.y })
  for (const b of engagedBlockers) stoppers.push({ x: b.x, y: b.y })

  // Congestion — the OL + DL tied up together crowd the lane (but are blocked, so lighter than a
  // free defender).
  const piles = [...engagedBlockers, ...defenders.filter(d => d.isEngaged)]

  const rays = []
  let best = null

  for (let i = 0; i < RAY_COUNT; i++) {
    const frac  = RAY_COUNT === 1 ? 0 : (i / (RAY_COUNT - 1)) * 2 - 1   // −1 … 1
    const angle = frac * CONE_HALF_ANGLE
    const ray   = { x: Math.sin(angle), y: Math.cos(angle) * dir }

    const clear    = clearDistance(carrier, ray, stoppers)
    const defD     = laneDensity(carrier, ray, freeDefenders)    // free defenders flanking the lane
    const pileD    = laneDensity(carrier, ray, piles)            // engaged OL/DL clogging the lane
    const blkD     = laneDensity(carrier, ray, freeBlockers)     // free teammates = mild traffic
    const leverage = Math.cos(angle - biasAngle)
    const angleT   = Math.cos(angle)
    const stick    = currentDir ? Math.max(0, ray.x * currentDir.x + ray.y * currentDir.y) : 0

    const score = W_SPACE * (clear / RAY_MAX)
                - W_DEF   * defD
                - W_PILE  * pileD
                - W_BLOCK * blkD
                + W_LEV   * leverage
                + W_ANGLE * angleT
                + W_STICK * stick

    const r = { dirX: ray.x, dirY: ray.y, clear, space: clear, score, angle }
    rays.push(r)
    if (!best || r.score > best.score) best = r
  }
  // `rays` carries every evaluated lane for the debug visualizer ([163]).
  return { ...best, rays }
}
