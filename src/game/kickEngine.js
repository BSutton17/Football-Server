// ── The unified kicking engine ([Special Teams][6][15][16][17]) ─────────────────
//
// Every kick — kickoff, punt, field goal, extra point — runs the SAME math here. `computeKick` turns
// the player's inputs PLUS the kicker's ratings into a raw shot; `calculateKickResult` then produces
// the full, kick-type-aware outcome (distance, landing, trajectory, hang time, make/miss).
//
// Player inputs (server-authoritative, normalized):
//   power — 0..1, the power meter captured at the kick ([10]).
//   angle — -1..1, the aiming arrow (0 = center, ±1 = ±30°) ([11][12]).
// Kicker ratings (0..99 — Kicker for FG/XP, Punter for punts; default until those players exist):
//   kickerPower    — [15] longer leg → more distance AND a higher floor (forgiving of a weak meter).
//   kickerAccuracy — [16] less angular error → the kick goes where it's aimed.

// [15] Distance floor (empty meter) and ceiling (full meter), each rising with the Power rating.
const FLOOR_MIN = 10, FLOOR_MAX = 40   // distance at power 0, for rating 0 → 99
const CEIL_MIN  = 45, CEIL_MAX  = 75   // distance at power 1, for rating 0 → 99

// [16] Worst-case angular error (normalized) at Accuracy 0; shrinks to ~0 at Accuracy 99.
const MAX_ANGULAR_ERROR = 0.4

// How far off-line a full deflection (|finalAngle| = 1) pushes the ball at the target.
export const MAX_PUSH_YARDS = 14

// Hang time (seconds) scales with distance — a bigger boot hangs longer (used by returns later).
const HANG_MIN = 1.6, HANG_MAX = 4.6

// Half-width of the uprights at the target — a field goal / extra point is good only if the ball
// stays within this laterally (and has the distance).
export const UPRIGHT_HALF_WIDTH = 6

// Defaults until Kicker / Punter players are added to rosters.
export const DEFAULT_KICK_POWER    = 75
export const DEFAULT_KICK_ACCURACY = 75

// [15][16] Raw shot: distance from (meter power × Power rating), lateral push from (aim ± an
// Accuracy-scaled error). Returns the realized trajectory too.
export function computeKick(
  { power = 0, angle = 0, kickerPower = DEFAULT_KICK_POWER, kickerAccuracy = DEFAULT_KICK_ACCURACY } = {},
  rng = Math.random,
) {
  const p   = clamp01(power)
  const r   = clamp01((kickerPower ?? DEFAULT_KICK_POWER) / 99)
  const acc = clamp01((kickerAccuracy ?? DEFAULT_KICK_ACCURACY) / 99)

  // [15] A better leg raises both ends of the range, so even a poorly-timed meter still travels.
  const floor    = FLOOR_MIN + r * (FLOOR_MAX - FLOOR_MIN)
  const ceil     = CEIL_MIN  + r * (CEIL_MAX  - CEIL_MIN)
  const distance = floor + p * (ceil - floor)

  // [16] The aim is nudged by an error that high Accuracy all but eliminates.
  const error      = (rng() * 2 - 1) * (1 - acc) * MAX_ANGULAR_ERROR
  const finalAngle = clampSigned(clampSigned(angle) + error)
  const pushYards  = finalAngle * MAX_PUSH_YARDS

  return { distance, pushYards, finalAngle }
}

// ── [17] Full result calculator ──────────────────────────────────────────────────
//
// The single outcome for any kick, from the user input, kicker ratings, field position, and kick
// type. `yardLine` is the spot (offense-relative); `requiredDistance` is the FG/XP distance to clear.
// [21] How far a flat (no-backspin) punt rolls forward after it lands.
const PUNT_ROLL_YARDS = 6
// [22] Backspin pulls the downed spot BACK by a random amount in this range after it lands.
const PUNT_BACKSPIN_MIN = 1
const PUNT_BACKSPIN_MAX = 5
// [23] A full deflection (|finalAngle| = 1) launches the punt at this angle off straight; the punt's
// total distance then splits into a downfield (cos) and lateral (sin) component.
const PUNT_MAX_ANGLE_RAD = (30 * Math.PI) / 180

// [18] ballX / uprightsX are absolute field-X positions: the hash the ball is spotted on and the
// (centered) goalposts. fieldWidth (sideline-to-sideline) enables out-of-bounds punt detection ([24]).
export function calculateKickResult(
  { kickType, power = 0, angle = 0, kickerPower, kickerAccuracy, yardLine = 50, requiredDistance = 0,
    ballX = null, uprightsX = null, backspin = false, fieldWidth = null } = {},
  rng = Math.random,
) {
  const { distance, pushYards, finalAngle } = computeKick({ power, angle, kickerPower, kickerAccuracy }, rng)
  const hangTime = computeHangTime(clamp01(power), distance)

  const result = { kickType, distance, pushYards, finalAngle, hangTime }

  if (kickType === 'punt') {
    // [23] 2D trajectory: aiming wide trades downfield distance for lateral placement (a directional
    // / coffin-corner punt). The total distance decomposes by the launch angle.
    const angleRad  = finalAngle * PUNT_MAX_ANGLE_RAD
    const originX   = ballX ?? (fieldWidth != null ? fieldWidth / 2 : 0)
    const downfield = distance * Math.cos(angleRad)   // air carry, downfield
    const lateral   = distance * Math.sin(angleRad)   // air carry, lateral

    // In flight order, where does the ball first leave the field of play?
    //   tGoal — fraction of the carry at which it reaches the goal line (→ [25] air touchback)
    //   tSide — fraction at which it crosses a sideline (→ [24] out of bounds)
    const tGoal = downfield > 0 ? (100 - yardLine) / downfield : Infinity
    let tSide = Infinity
    if (fieldWidth != null && lateral !== 0) {
      const sideline = lateral > 0 ? fieldWidth : 0
      const t = (sideline - originX) / lateral
      if (t >= 0) tSide = t
    }

    let outOfBounds = false
    let touchback   = false
    let roll        = 0
    let landSpot    = yardLine + downfield   // initial (air) landing point, before any roll
    let landX       = originX + lateral
    let carry       = downfield

    if (tGoal <= 1 && tGoal <= tSide) {
      // [25] The ball comes down in the end zone IN THE AIR → immediate touchback, no roll/return.
      touchback = true
      carry     = 100 - yardLine
      landX     = originX + lateral * tGoal
    } else if (tSide <= 1 && tSide < tGoal) {
      // [24] It crosses a sideline first → out of bounds, downed at the crossing (no roll/return).
      outOfBounds = true
      carry       = downfield * tSide
      landSpot    = yardLine + carry
      landX       = lateral > 0 ? fieldWidth : 0
    } else {
      // Lands in the field → roll applies; a roll INTO the end zone is a (bounce) touchback.
      // [21][22] Flat rolls FORWARD; backspin pulls BACK 1–5 yards.
      roll     = backspin ? -(PUNT_BACKSPIN_MIN + rng() * (PUNT_BACKSPIN_MAX - PUNT_BACKSPIN_MIN)) : PUNT_ROLL_YARDS
      landSpot = yardLine + downfield + roll
      if (landSpot >= 100) touchback = true
    }

    result.backspin    = !!backspin
    result.rollYards   = roll                               // + forward (flat), − backward (backspin); 0 on TB/OOB
    result.outOfBounds = outOfBounds                        // [24] no return possible
    result.touchback   = touchback                          // [25] no return possible (air or bounce)
    result.downfieldDistance = carry
    result.landingYardLine = touchback
      ? 20                                                  // touchback → receiving team's own 20
      : Math.max(1, Math.min(99, 100 - landSpot))           // receiving team's frame
    if (ballX != null) result.landingX = landX              // [23] absolute lateral landing
  } else {
    // [18] Field goal / extra point: the goalposts are centered, so a kick from a hash has to be
    // pushed back toward midfield to split them — a left-hash kick angles in from the left, and vice
    // versa. lateralOffset is how far center sits from the ball.
    const lateralOffset = (uprightsX != null && ballX != null) ? uprightsX - ballX : 0
    result.lateralOffset = lateralOffset
    result.good = isKickGood({ distance, pushYards }, requiredDistance, lateralOffset)
  }
  return result
}

// [19] Hang time grows with BOTH the leg (distance) and how cleanly it was struck (meter power) — a
// long, high kick hangs longest. Drives punt-return outcomes later.
function computeHangTime(power, distance) {
  const distNorm = clamp01(distance / CEIL_MAX)
  const blend    = 0.6 * distNorm + 0.4 * clamp01(power)   // distance-led, power-boosted
  return HANG_MIN + blend * (HANG_MAX - HANG_MIN)
}

// Field goal / extra point: good with the distance AND when the ball splits the uprights — i.e. the
// realized push lands within an upright half-width of the (offset) goalpost center ([18]).
export function isKickGood(raw, requiredDistance, lateralOffset = 0) {
  return raw.distance >= requiredDistance && Math.abs(raw.pushYards - lateralOffset) <= UPRIGHT_HALF_WIDTH
}

function clamp01(v)     { return Math.max(0, Math.min(1, v)) }
function clampSigned(v) { return Math.max(-1, Math.min(1, v)) }
