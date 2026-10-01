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

// [15] Distance floor (empty meter) and ceiling (full meter), each rising with the Power rating. The
// ceiling here is the fallback for kickoffs (automatic); punts and field goals cap their full-meter
// distance per kick type via maxKickDistance below.
const FLOOR_MIN = 10, FLOOR_MAX = 40   // distance at power 0, for rating 0 → 99

// WARNING: THE FLOOR WAS DOING MOST OF THE KICKING. At FLOOR_MAX 40 a 75-Power punter started from
// 32.7 yards before touching the meter, so the whole meter was worth only 14 yards and a half-full
// bar still produced a 40-yard punt. Reported as "even when the meter is half full in the green the
// ball goes way too far".
//
// A punt gets its own, much lower floor: a badly-timed punt should be a bad punt. The leg still
// matters -- it sets both ends -- it simply no longer does the work the player was supposed to do.
const PUNT_FLOOR_MIN = 8, PUNT_FLOOR_MAX = 22

// WARNING: AND THE METER IS NOT LINEAR ANY MORE. Linear meant half a meter bought half the range,
// which is exactly the forgiving feel being complained about. Squaring it makes the top of the bar
// where the distance lives: at half power a punt now travels about a quarter of the way up its
// range rather than half.
const PUNT_POWER_CURVE = 2.0
const CEIL_MIN  = 45, CEIL_MAX  = 75   // distance at power 1, for rating 0 → 99

// [max range] Full-meter distance cap by kick type, scaling with the Power rating:
//   punt  — 99 Power → 55 yds; −0.35 yds per point of Power below 99.
//   FG/XP — 99 Power → 65 yds; −0.35 yds per point of Power below 99.
// Kickoffs (automatic) return null → the default CEIL model above. Floored so even a weak leg gets a
// short chip rather than a zero/negative distance.
//
// ⚠️ THE FIELD-GOAL FALLOFF WAS −1.5 A POINT, WHICH MEANT NOBODY COULD KICK ONE. A 75-rated kicker
// — the DEFAULT, used whenever a roster has no specialist — came out at 60 − 24×1.5 = TWENTY-FOUR
// YARDS of range at a full meter. Not 24 yards of field position: 24 yards of kick, which is the
// seven yard line. Every attempt from anywhere else was short, for the computer and for a human
// alike. Measured before the fix: forty attempts each from the 20, 25, 30, 35, 40, 45 and 50 yard
// lines, zero good, every one of them short, including a 37-yarder.
//
// At −0.35 a point the default kicker reaches 56 yards and a 90 reaches 62, which is roughly what a
// professional does. The rating still matters — seventeen yards of range separates a 50 from a 99 —
// it just no longer decides that field goals are not part of the game.
//
// ⚠️ THE PUNT CEILING WAS 70 AND A FULL METER SIMPLY HIT IT. At −11 yds a point the ceiling for a
// 95-Power punter is 70 − 4 = 66, and 66-yard punts were what the player got, every time — because
// the meter drains slowly enough that a full one is the normal outcome rather than a good one. A
// punt is not supposed to be a ceiling test; the NFL gross average is high 40s.
//
// Now the same shape as the field goal: a 99 reaches 55 at a PERFECT meter, a 75 reaches 46.6, and
// with the faster drain below the ordinary punt lands in the 40s where it belongs.
const MIN_MAX_DISTANCE = 15
export const PUNT_RANGE_AT_99 = 55
export const PUNT_RANGE_PER_POINT = 0.35
export const FG_RANGE_AT_99 = 65
export const FG_RANGE_PER_POINT = 0.35
export function maxKickDistance(kickType, kickerPower = DEFAULT_KICK_POWER) {
  const below = Math.max(0, 99 - (kickerPower ?? DEFAULT_KICK_POWER))
  if (kickType === 'punt')  return Math.max(MIN_MAX_DISTANCE, PUNT_RANGE_AT_99 - below * PUNT_RANGE_PER_POINT)
  if (kickType === 'field_goal' || kickType === 'extra_point') {
    return Math.max(MIN_MAX_DISTANCE, FG_RANGE_AT_99 - below * FG_RANGE_PER_POINT)
  }
  return null
}

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
  { power = 0, angle = 0, kickerPower = DEFAULT_KICK_POWER, kickerAccuracy = DEFAULT_KICK_ACCURACY, maxDistance = null, kickType = null } = {},
  rng = Math.random,
) {
  const p   = clamp01(power)
  const r   = clamp01((kickerPower ?? DEFAULT_KICK_POWER) / 99)
  const acc = clamp01((kickerAccuracy ?? DEFAULT_KICK_ACCURACY) / 99)

  // [15][max range] A better leg raises both ends of the range, so even a poorly-timed meter still
  // travels. The full-meter ceiling is the per-type cap when provided (punt / FG), else the default
  // rating-scaled ceiling (kickoffs). The floor can't exceed the ceiling.
  const ceil     = maxDistance != null ? maxDistance : CEIL_MIN + r * (CEIL_MAX - CEIL_MIN)
  // A punt is the kick the player actually has to time, so it gets the lower floor and the curve.
  // Field goals keep the forgiving mapping: a 45-yarder that falls two yards short of the posts is
  // already punished by missing, and the distance there is a pass/fail gate rather than a feel.
  const isPunt   = kickType === 'punt'
  const fMin     = isPunt ? PUNT_FLOOR_MIN : FLOOR_MIN
  const fMax     = isPunt ? PUNT_FLOOR_MAX : FLOOR_MAX
  const floor    = Math.min(fMin + r * (fMax - fMin), ceil)
  const curved   = isPunt ? Math.pow(p, PUNT_POWER_CURVE) : p
  const distance = floor + curved * (ceil - floor)

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
// [33] A bounced (Let It Bounce) punt rolls forward this many yards toward the receiving goal.
export const PUNT_BOUNCE_MIN_YARDS = 3
export const PUNT_BOUNCE_MAX_YARDS = 10
// [34] Backspin pulls the downed spot BACK by a random amount in this range after the bounce.
export const PUNT_BACKSPIN_MIN = 3
export const PUNT_BACKSPIN_MAX = 8
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
  const maxDistance = maxKickDistance(kickType, kickerPower)   // [max range] per-type full-meter cap
  const { distance, pushYards, finalAngle } = computeKick({ power, angle, kickerPower, kickerAccuracy, maxDistance, kickType }, rng)
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

    let outOfBounds  = false
    let airTouchback = false
    let landSpot     = yardLine + downfield   // where the ball first comes down (the AIR landing)
    let landX        = originX + lateral
    let carry        = downfield

    if (tGoal <= 1 && tGoal <= tSide) {
      // [25] The ball comes down in the end zone IN THE AIR → immediate touchback, no roll/return.
      airTouchback = true
      carry        = 100 - yardLine
      landSpot     = yardLine + carry
      landX        = originX + lateral * tGoal
    } else if (tSide <= 1 && tSide < tGoal) {
      // [24] It crosses a sideline first → out of bounds, downed at the crossing (no roll/return).
      // [36] This IS the coffin corner: aiming toward the sideline near the opponent's territory makes
      // the ball cross OOB (downed at the crossing) BEFORE it can reach the end zone for a touchback —
      // pinning the opponent deep. It's not a separate mechanic: a skilled punter angles the kick and
      // their Accuracy (small angular error) lands it where aimed; a wild leg sprays off the corner.
      outOfBounds = true
      carry       = downfield * tSide
      landSpot    = yardLine + carry
      landX       = lateral > 0 ? fieldWidth : 0
    }
    // Otherwise it lands in the field of play — the AIR landing above stands. The roll/bounce and any
    // backspin are NOT applied here: they're resolved when the receiving team chooses Let It Bounce
    // ([33][34]). At kick time only the air touchback and out-of-bounds are decided.

    result.backspin     = !!backspin                        // [21] kicker's setup choice, used at [34]
    result.outOfBounds  = outOfBounds                       // [24] no return possible
    result.airTouchback = airTouchback                      // [29] came down IN the end zone — no menu
    result.touchback    = airTouchback                      // a bounce touchback is decided later ([33])
    result.downfieldDistance = carry
    result.landingYardLine = airTouchback
      ? 20                                                  // touchback → receiving team's own 20
      : Math.max(1, Math.min(99, 100 - landSpot))           // air landing, receiving frame
    if (ballX != null) result.landingX = landX              // [23] absolute lateral landing
    // [27] Projected (AIR) landing in the receiving frame — where the ball first comes down, BEFORE
    // any roll. Shown to the receiving team as a preview; the final bounce distance is NOT revealed.
    result.previewLandingYardLine = Math.max(0, Math.min(100, 100 - (yardLine + carry)))
  } else {
    // [18][42] Field goal / extra point — the COMPLETE trajectory. Every input feeds the result:
    //   power + kicker Power → distance (the leg);  user aim + kicker Accuracy → pushYards (the
    //   sideways drift);  field position → requiredDistance (via fieldGoalDistance).
    // [18] The goalposts are centered, so a kick from a hash must angle back toward midfield to split
    // them. lateralOffset = how far center sits from the ball — the drift the kick has to "cover".
    const lateralOffset = (uprightsX != null && ballX != null) ? uprightsX - ballX : 0
    result.lateralOffset = lateralOffset

    // Two independent components of "good":
    //   hasDistance   — the leg cleared the crossbar (distance ≥ the required distance).
    //   lateralAtGoal — where the ball crosses the uprights plane relative to their CENTER: the
    //                   realized push minus the offset it had to cover. 0 = dead center, ± = right/left.
    const hasDistance    = distance >= requiredDistance
    const lateralAtGoal  = pushYards - lateralOffset
    const splitsUprights = Math.abs(lateralAtGoal) <= UPRIGHT_HALF_WIDTH

    result.hasDistance    = hasDistance
    result.lateralAtGoal  = lateralAtGoal
    result.splitsUprights = splitsUprights
    result.good           = hasDistance && splitsUprights   // ≡ isKickGood(...)
    // Why it missed — drives the play readout and the flight render. Short is reported first (a short
    // kick that's also off-line is fundamentally short).
    result.missReason = result.good ? null
      : !hasDistance      ? 'short'
      : lateralAtGoal < 0 ? 'wide_left'
      :                     'wide_right'
    // Absolute X where the ball crosses the uprights plane (for rendering the flight), when we know
    // the field geometry. = uprightsX + lateralAtGoal.
    if (ballX != null) result.goalCrossX = ballX + pushYards
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

// [31][32] A punt return from the catch spot. Yards are shaped by the returner's ability (more =
// farther), the hang time (a high, floaty punt lets the coverage close → fewer yards), and the
// punter's leg (a big boot can outkick its coverage for a touch more room), plus randomness.
// [32] A rare (~1%) breakaway is flagged as a touchdown, with the returner's ability and a low hang
// nudging that small chance.
//
// ⚠️ THE SHAPE IS SKEWED, NOT A BELL CURVE, AND THAT IS THE POINT. This used to be
// `mean ± 6` around a mean near 10, which made a ten-yard return the ORDINARY result and a short one
// impossible — nothing under 0, and almost nothing under 4. A real punt return is usually swallowed
// for very little, occasionally loses ground, and rarely breaks. So a flat roll is passed through a
// power curve (`RETURN_SKEW`) that piles the mass up at the bottom: the mean is ~4 yards, HALF land
// in 1–3, and double digits are the exception rather than the expectation.
//
// Returns can now be NEGATIVE (tackled behind the catch). They can never produce a safety — the
// caller spots the ball with a clamp to the receiving team's own 1 (see clampSpot in
// resolvePuntReturn), so the worst possible return on a catch at the 2 is first-and-10 at the 1.
export const PUNT_RETURN_MAX_YARDS = 20
export const PUNT_RETURN_MIN_YARDS = -4      // tackled behind the catch; never deep enough to matter
export const PUNT_RETURN_TD_BASE   = 0.01

// The median of the positive branch is 1 + 19 * 0.5^SKEW — at 4.0 that is ~2.2 yards, which is the
// "usually 1–3" the shape is tuned for. Skill lowers the exponent rather than adding a bonus, so a
// better returner reaches the tail more often instead of everyone gaining a flat amount.
const RETURN_SKEW       = 4.0
const RETURN_SKEW_SWING = 1.2      // ± by skill edge
const RETURN_NEG_CHANCE = 0.12     // share of returns that lose ground, before skill
const RETURN_NEG_SWING  = 0.08

export function computePuntReturn(
  { hangTime = 2.5, returnerRating = DEFAULT_KICK_ACCURACY, punterPower = DEFAULT_KICK_POWER } = {},
  rng = Math.random,
) {
  const ret  = clamp01(returnerRating / 99)
  const hang = clamp01((hangTime - HANG_MIN) / (HANG_MAX - HANG_MIN))   // 0 (line drive) … 1 (booming)
  const leg  = clamp01(punterPower / 99)

  // One skill number in −1…1, centred so a default returner against a default punt sits at ~0. It
  // moves BOTH knobs in the same direction, which keeps yardage monotone in every input: a better
  // returner (or a lower hang) is never worse off at the same roll.
  const edge = clampSigned((ret - 0.76) * 1.4 - (hang - 0.35) * 1.6 + (leg - 0.76) * 0.5)
  const skew = Math.max(1, RETURN_SKEW - edge * RETURN_SKEW_SWING)
  const neg  = clamp01(RETURN_NEG_CHANCE - edge * RETURN_NEG_SWING)

  const u = rng()
  let yards
  if (u < neg) {
    // Lost ground. Spread over the floor…0, worst at the lowest roll.
    yards = Math.round(PUNT_RETURN_MIN_YARDS * (1 - u / neg))
  } else {
    const v = (u - neg) / (1 - neg)                   // re-spread the rest of the roll over 1…cap
    yards = Math.round(1 + (PUNT_RETURN_MAX_YARDS - 1) * Math.pow(v, skew))
  }
  yards = Math.max(PUNT_RETURN_MIN_YARDS, Math.min(PUNT_RETURN_MAX_YARDS, yards))

  // [32] ~1% house chance, lifted by ability and a low (line-drive) hang, kept small.
  const tdChance  = PUNT_RETURN_TD_BASE * (0.5 + ret) * (1.4 - hang)
  const touchdown = rng() < tdChance

  return { yards, touchdown, tdChance }
}

// [33][34][35] How far a Let-It-Bounce punt rolls forward (toward the receiving goal) after it lands.
// Two independent effects combine into one net displacement:
//   [33] forwardRoll  — the live ball rolls 3–10 yards forward (toward the receiving goal).
//   [34] backspinPull — if the punt had backspin, it then checks the ball back 3–8 yards.
// [35] The final spot reflects BOTH: net = forwardRoll − backspinPull. The two are drawn separately
// (independent under Math.random), so a big roll can outrun a small bite of backspin, or a strong
// backspin can overcome a short roll and leave the ball BEHIND the landing (net < 0). Backspin can
// only ever subtract — it never adds forward distance.
export function computePuntBounce({ backspin = false } = {}, rng = Math.random) {
  const forwardRoll  = PUNT_BOUNCE_MIN_YARDS + rng() * (PUNT_BOUNCE_MAX_YARDS - PUNT_BOUNCE_MIN_YARDS)
  const backspinPull = backspin ? PUNT_BACKSPIN_MIN + rng() * (PUNT_BACKSPIN_MAX - PUNT_BACKSPIN_MIN) : 0
  return forwardRoll - backspinPull                  // net forward roll, in yards toward the receiving goal
}

// [37] A rolling punt that comes to rest at or inside this line (the receiving team's own N) without
// backspin is treated as having carried into the end zone → touchback. Backspin keeps it out, so a
// backspin punt can legitimately be downed this deep.
export const PUNT_BOUNCE_TOUCHBACK_LINE = 8

// [33][34][35][37] Resolve where a Let-It-Bounce punt comes to rest, in the RECEIVING frame (0 = their
// goal line, 100 = the opponent's). The ball rolls from `airLanding` by the net bounce ([33][34][35]).
//   • rolls past the goal line (≤ 0)                          → touchback (own 20)
//   • [37] stops inside PUNT_BOUNCE_TOUCHBACK_LINE, no backspin → touchback (a no-backspin roll that
//     close would realistically trickle into the end zone)
//   • otherwise (incl. backspin keeping it out of the EZ)      → downed where it stops
// Returns { touchback, yardLine }.
export function resolvePuntBounce({ airLanding = 50, backspin = false } = {}, rng = Math.random) {
  const rest = airLanding - computePuntBounce({ backspin }, rng)
  if (rest <= 0) return { touchback: true, yardLine: 20 }
  if (!backspin && rest < PUNT_BOUNCE_TOUCHBACK_LINE) return { touchback: true, yardLine: 20 }
  return { touchback: false, yardLine: Math.max(1, Math.min(99, Math.round(rest))) }
}

// Field goal / extra point: good with the distance AND when the ball splits the uprights — i.e. the
// realized push lands within an upright half-width of the (offset) goalpost center ([18]).
export function isKickGood(raw, requiredDistance, lateralOffset = 0) {
  return raw.distance >= requiredDistance && Math.abs(raw.pushYards - lateralOffset) <= UPRIGHT_HALF_WIDTH
}

function clamp01(v)     { return Math.max(0, Math.min(1, v)) }
function clampSigned(v) { return Math.max(-1, Math.min(1, v)) }
