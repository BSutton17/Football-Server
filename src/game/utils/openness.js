import { ratingOf } from '../../data/ratings.js'

// ── Receiver openness engine ([169]–[174]) ───────────────────────────────────────
//
// Quantifies how open a pass catcher is, in [0, 1]: 0 = blanketed, 1 = wide open. It is the
// value catch and interception probabilities derive from, and folds together:
//   • separation    — distance to the nearest defender ([170], the dominant factor)
//   • leverage       — inside / outside / trail position of that defender relative to the
//                      throwing lane ([171]); a defender that can break on the ball hurts most
//   • closing speed  — defenders rapidly closing on the target shrink the real window ([172])
//   • safety help    — safeties / overlapping deep defenders over the top ([173])
//   • zone awareness — heady defenders react faster, exerting more influence on the lane ([174])

const SMOTHERED_DIST     = 1.0   // yd — a defender this tight blankets the receiver (openness 0)
// Softened from 7 → 5.5 ([openness feedback]): real separation reads open. A receiver now shows
// green (openness ≥ 0.66) at ~4 yds of cushion and yellow at ~2.5, instead of needing 5+ to break
// green — so a receiver who isn't being run down by a defender reads as a throwable window.
const WIDE_OPEN_DIST     = 5.5   // yd — nearest defender this far leaves the receiver fully open
const BRACKET_RADIUS     = 4.0   // yd — a second defender inside this range tightens the coverage
const BRACKET_FALLOFF    = 0.6   // each extra bracketing defender keeps this fraction of openness
const LEVERAGE_PENALTY   = 0.35  // max openness cut when the nearest defender is squarely in the lane
const CLOSING_PENALTY    = 0.3   // max openness cut from a fast-closing nearest defender ([172])
const CLOSING_REF_SPEED  = 7.0   // yd/s of closing speed that yields the full closing penalty
const SAFETY_HELP_RADIUS = 9.0   // yd within which a safety provides help over the top ([173])
const SAFETY_HELP_FALLOFF = 0.7  // each helping safety keeps this fraction of openness

// "Beat your man" ([coverage feedback]): a moving receiver whose nearest defender is TRAILING his
// path has the ball led into open grass in front of him — so the window opens up even when the
// trail is step-for-step tight. Only a defender in the path AHEAD of the receiver truly contests.
const BEATEN_MIN_SPEED = 2.0   // yd/s — the receiver must be running a route for this read
const BEATEN_BOOST     = 0.9   // how strongly a fully-trailing (beaten) defender opens the window

// A defender sitting in the throwing lane AHEAD of the receiver contests the catch even when the
// receiver has beaten his trailing man — so the window is capped by separation to that front
// defender ([coverage feedback]: a WR shouldn't read open running straight at a hook-zone LB).
const LANE_HALF_WIDTH   = 2.5   // yards either side of the receiver's heading that counts as "the lane"
const LANE_AHEAD_MIN    = 0.3   // dot-with-heading threshold for a defender to count as "in front"

// A defender IN FRONT means different things by route ([coverage feedback]):
//   • a route that breaks BACK toward the ball (comeback / curl) works UNDERNEATH that defender —
//     the window opens up, the WR isn't running into them.
//   • a go / deep route runs straight INTO that defender, who then has position on the deep ball —
//     so it's HEAVILY contested, not merely contested.
const BREAK_BACK_ROUTES = new Set(['comeback', 'curl', 'return'])
const DEEP_GO_ROUTES    = new Set(['go', 'seam', 'post', 'corner', 'wheel', 'deep_cross', 'fade'])
const BREAK_BACK_BOOST  = 0.6   // how strongly a defender-in-front opens a comeback/curl window
const GO_FRONT_PENALTY  = 0.45  // extra cut to a go/deep window when a defender sits in the deep lane

function clamp01(v) {
  return Math.max(0, Math.min(1, v))
}

// [174] Higher-awareness defenders read and react faster, so they exert more influence on the
// passing window. Maps awareness 0→0.6, 99→1.0 — a multiplier on a defender's openness penalty.
function awarenessFactor(defender) {
  const a = ratingOf(defender, 'awareness') ?? 55
  return 0.6 + 0.4 * (a / 99)
}

// Closing speed of a defender toward the receiver (yd/s); negative if it's falling away.
function closingSpeed(d, receiver) {
  const dx = receiver.x - d.x
  const dy = receiver.y - d.y
  const len = Math.hypot(dx, dy) || 1
  return (d.vx ?? 0) * (dx / len) + (d.vy ?? 0) * (dy / len)
}

// receiver  — { x, y }
// defenders — array of full defender objects ({ x, y, vx, vy, label })
// qb        — { x, y } | null (the passer, for the leverage read)
export function computeReceiverOpenness(receiver, defenders, qb = null) {
  return opennessBreakdown(receiver, defenders, qb).openness
}

// Same computation as computeReceiverOpenness, but also returns the per-factor contributions so the
// coverage/openness debug log can justify WHY a receiver came out the color it did.
//   nearestId/nearestLabel/nearestDist — the closest defender and how tight it is ([170])
//   align    — leverage: >0 the nearest defender is inside the throwing lane (ball-side), <0 trailing/beaten ([171])
//   closing  — closing speed of the nearest defender toward the receiver, yd/s ([172])
//   safeties — helping safeties over the top ([173]); bracket — other crowding defenders
export function opennessBreakdown(receiver, defenders, qb = null) {
  if (!defenders || defenders.length === 0) {
    return { openness: 1, nearestId: null, nearestLabel: null, nearestDist: Infinity, align: 0, closing: 0, safeties: 0, bracket: 0 }
  }

  let nearest = null
  let nearestDist = Infinity
  for (const d of defenders) {
    const dist = Math.hypot(d.x - receiver.x, d.y - receiver.y)
    if (dist < nearestDist) { nearestDist = dist; nearest = d }
  }

  // [170] Base openness: separation from the nearest defender on a linear ramp.
  let openness = clamp01((nearestDist - SMOTHERED_DIST) / (WIDE_OPEN_DIST - SMOTHERED_DIST))

  const aware = awarenessFactor(nearest)

  // [171] Leverage: a defender between the receiver and the QB (inside the throwing lane) can
  // break on the ball and contests most; one trailing behind the receiver (beaten) barely does.
  let align = 0
  if (qb) {
    const toQbX = qb.x - receiver.x, toQbY = qb.y - receiver.y
    const toDfX = nearest.x - receiver.x, toDfY = nearest.y - receiver.y
    const lenQb = Math.hypot(toQbX, toQbY) || 1
    const lenDf = Math.hypot(toDfX, toDfY) || 1
    align = (toQbX * toDfX + toQbY * toDfY) / (lenQb * lenDf)   // 1 = inside (toward QB), -1 = trail
    if (align > 0) openness *= 1 - LEVERAGE_PENALTY * align * aware
  }

  // [172] Closing speed: a defender bearing down on the target collapses the real window.
  const closing = closingSpeed(nearest, receiver)
  if (closing > 0) openness *= 1 - CLOSING_PENALTY * Math.min(1, closing / CLOSING_REF_SPEED) * aware

  // [173] Safety help: safeties/overlapping deep defenders over the top shrink dangerous windows.
  let safeties = 0
  for (const d of defenders) {
    if (d === nearest || d.label !== 'S') continue
    if (Math.hypot(d.x - receiver.x, d.y - receiver.y) <= SAFETY_HELP_RADIUS) safeties++
  }
  if (safeties > 0) openness *= Math.pow(SAFETY_HELP_FALLOFF, safeties)

  // Bracket: every additional non-safety defender crowding the receiver tightens it further.
  let bracket = 0
  for (const d of defenders) {
    if (d === nearest || d.label === 'S') continue
    if (Math.hypot(d.x - receiver.x, d.y - receiver.y) <= BRACKET_RADIUS) bracket++
  }
  if (bracket > 0) openness *= Math.pow(BRACKET_FALLOFF, bracket)

  // "Beat your man": for a receiver actually running a route, measure where the nearest defender
  // sits relative to his DIRECTION OF TRAVEL — the way the ball is led. A defender trailing behind
  // that heading is beaten; the throw goes in front of him, so the window opens regardless of how
  // tight the trail is. (Stationary/settled receivers skip this and rely on raw separation.)
  let ahead = 0   // +1 nearest defender is in the path ahead (contests), -1 fully trailing (beaten)
  let frontDist = Infinity   // nearest defender sitting in the throwing lane ahead of the receiver
  const rv = Math.hypot(receiver.vx ?? 0, receiver.vy ?? 0)
  if (rv > BEATEN_MIN_SPEED) {
    const hx = receiver.vx / rv, hy = receiver.vy / rv
    const tx = nearest.x - receiver.x, ty = nearest.y - receiver.y
    const tl = Math.hypot(tx, ty) || 1
    ahead = (hx * tx + hy * ty) / tl

    // Scan ALL defenders for one parked in the lane ahead — it contests regardless of the nearest.
    for (const d of defenders) {
      const dx = d.x - receiver.x, dy = d.y - receiver.y
      const dl = Math.hypot(dx, dy) || 1
      const aheadDot = (hx * dx + hy * dy) / dl          // >0 in front along the heading
      const lateral  = Math.abs(-hy * dx + hx * dy)      // perpendicular distance from the heading line
      if (aheadDot >= LANE_AHEAD_MIN && lateral <= LANE_HALF_WIDTH && dl < frontDist) frontDist = dl
    }
  }

  const beaten = Math.max(0, -ahead)   // 0 (defender even/ahead) … 1 (defender directly behind)
  if (beaten > 0) openness = clamp01(openness + beaten * BEATEN_BOOST * (1 - openness))

  // A defender in the lane ahead — read by route. On a comeback/curl the receiver breaks BACK
  // underneath them (the window opens); on a go/deep route the receiver runs INTO them and the deep
  // ball is heavily contested; otherwise the window is simply capped by the separation to them.
  if (frontDist < Infinity) {
    if (BREAK_BACK_ROUTES.has(receiver.route)) {
      openness = clamp01(openness + BREAK_BACK_BOOST * (1 - openness))
    } else {
      let frontOpen = clamp01((frontDist - SMOTHERED_DIST) / (WIDE_OPEN_DIST - SMOTHERED_DIST))
      if (DEEP_GO_ROUTES.has(receiver.route)) frontOpen *= GO_FRONT_PENALTY   // heavily contested
      openness = Math.min(openness, frontOpen)
    }
  }

  return {
    openness: clamp01(openness),
    nearestId: nearest.id ?? null, nearestLabel: nearest.label ?? null, nearestDist,
    align, closing, safeties, bracket, ahead, beaten,
    frontDist: Number.isFinite(frontDist) ? frontDist : null,
  }
}
