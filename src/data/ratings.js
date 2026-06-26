// All player attributes are rated on a 0–99 scale.
//   99 = elite / best possible
//   50 = average
//    0 = worst possible
//
// speed        — top running speed
// acceleration — how quickly the player reaches top speed (burst)
// stamina      — how slowly the stamina BAR drains (99 = barely tires, 0 = tires very fast)
//                Linemen (OL/DL) have no stamina rating — they never fatigue.
// routeRunning — precision and sharpness of cuts (99 = razor-sharp, 0 = sloppy)
// strength     — physical power in block/shed interactions; modifies push force magnitude
//                (99 = dominant, 0 = overpowered). All positions have a strength rating.
// passRush     — ability to win block fights and generate pressure as a pass rusher.
//                Biases effective leverage toward the defender when they outclass the blocker.
//                Primarily meaningful for DL and blitzing LBs; near-zero for skill positions.
// awareness    — coverage IQ: how early a defender reads and reacts to a route break
//                or a threat entering a zone. Drives man-coverage prediction and zone
//                recognition range. Safeties highest, corners high, linebackers middling.
// coverage     — ball-skills and positioning in coverage: how cleanly a defender
//                anticipates and breaks on a receiver. Drives zone-defender lead/timing.
// vision       — field vision as a ball carrier: how often it re-reads the field for
//                open running lanes. Elite vision re-evaluates ~5×/sec, poor vision
//                only every few seconds (committing to a stale lane). RB/QB highest.

// catching — hands: how reliably a pass catcher secures the ball ([176]). High for skill
//            positions; DBs/LBs use it for interceptions; linemen near zero.
// accuracy — QB ball placement: how catchable a thrown pass is ([177]). Only meaningful for QBs.
// runPower — RB power to break tackles ([run power]). press — CB/S jam at the LOS vs a
// receiver's route running ([press]). passBlock/runBlock — OL blocking by play type ([OL block]).
const POSITION_RATINGS = {
  WR: { speed: 92, acceleration: 88, stamina: 82, routeRunning: 88, strength: 44, passRush:  0, awareness: 60, coverage: 50, vision: 70, catching: 90, accuracy: 30, runPower: 35, press: 0 },
  CB: { speed: 90, acceleration: 88, stamina: 80, routeRunning: 75, strength: 48, passRush: 32, awareness: 85, coverage: 88, vision: 60, catching: 72, accuracy: 30, runPower: 0, press: 78 },
  S:  { speed: 85, acceleration: 78, stamina: 78, routeRunning: 60, strength: 58, passRush: 38, awareness: 90, coverage: 84, vision: 62, catching: 74, accuracy: 30, runPower: 0, press: 68 },
  RB: { speed: 88, acceleration: 78, stamina: 72, routeRunning: 65, strength: 62, passRush: 15, awareness: 55, coverage: 45, vision: 82, catching: 74, accuracy: 35, runPower: 75, press: 0 },
  LB: { speed: 78, acceleration: 70, stamina: 72, routeRunning: 50, strength: 74, passRush: 62, awareness: 74, coverage: 66, vision: 58, catching: 58, accuracy: 30, runPower: 0, press: 0 },
  TE: { speed: 75, acceleration: 60, stamina: 65, routeRunning: 72, strength: 70, passRush: 20, awareness: 55, coverage: 45, vision: 60, catching: 84, accuracy: 30, runPower: 45, press: 0, passBlock: 68, runBlock: 72 },
  QB: { speed: 72, acceleration: 55, stamina: 68, routeRunning: 40, strength: 50, passRush:  0, awareness: 80, coverage: 40, vision: 80, catching: 55, accuracy: 86, runPower: 30, press: 0 },
  // Linemen — strength and passRush are their primary engagement attributes; pass/run block by play type
  DL: { speed: 65, acceleration: 42, stamina: 0, routeRunning: 0, strength: 86, passRush: 82, awareness: 45, coverage: 25, vision: 40, catching: 35, accuracy: 20 },
  T:  { speed: 58, acceleration: 40, stamina: 0, routeRunning: 0, strength: 82, passRush:  0, awareness: 35, coverage: 20, vision: 30, catching: 25, accuracy: 20, passBlock: 80, runBlock: 80 },
  G:  { speed: 55, acceleration: 38, stamina: 0, routeRunning: 0, strength: 82, passRush:  0, awareness: 35, coverage: 20, vision: 30, catching: 25, accuracy: 20, passBlock: 80, runBlock: 80 },
  C:  { speed: 55, acceleration: 38, stamina: 0, routeRunning: 0, strength: 78, passRush:  0, awareness: 45, coverage: 20, vision: 30, catching: 25, accuracy: 20, passBlock: 78, runBlock: 78 },
  OL: { speed: 55, acceleration: 38, stamina: 0, routeRunning: 0, strength: 80, passRush:  0, awareness: 35, coverage: 20, vision: 30, catching: 25, accuracy: 20, passBlock: 80, runBlock: 80 },
}

const DEFAULT_RATINGS = { speed: 65, acceleration: 55, stamina: 65, routeRunning: 55, strength: 60, passRush: 40, awareness: 55, coverage: 55, vision: 60, catching: 55, accuracy: 40, runPower: 30, press: 40, passBlock: 60, runBlock: 60 }

export function getRatings(label) {
  return POSITION_RATINGS[label ?? ''] ?? DEFAULT_RATINGS
}

// [293] Resolve a single rating for a specific field player. Prefers the player's own per-team
// rating (sent from the client and stored as `player.ratings[key]`, or as a flat `player[key]`
// override used by some movement paths), and falls back to the position-label baseline. This is the
// bridge that lets a team's actual roster ratings — speed, awareness, blocking, route running,
// pass rush, etc. — drive the simulation instead of generic position defaults.
export function ratingOf(player, key) {
  // [294] X-Factor passive buffs add a bonus on top of the base rating (e.g. High Point's +4
  // acceleration). The bonus is deliberately NOT clamped to 99 — the spec allows it to exceed 99.
  const bonus = player?.ratingBonus?.[key] ?? 0

  const fromRatings = player?.ratings?.[key]
  if (fromRatings != null) return fromRatings + bonus
  const flat = player?.[key]
  if (typeof flat === 'number') return flat + bonus
  return getRatings(player?.label)[key] + bonus
}

// ── Strength modifier ─────────────────────────────────────────────────────────
//
// Returns a push-force multiplier in [0.55, 1.45] based on how much stronger
// the blocker is than the defender.  The complement (2 - modifier) gives the
// opponent's effective multiplier, so the two values always sum to exactly 2.
//
//   strMod > 1.0 → blocker is stronger  → they push harder, resist more
//   strMod < 1.0 → defender is stronger → blocker pushes less, gets pushed more
//   strMod = 1.0 → equal strength       → no modification
//
// Maximum swing is ±0.45 at the 99 vs 0 extreme.

const STRENGTH_ADVANTAGE_SCALE = 0.45

export function strengthModifier(blockerRating, defenderRating) {
  const diff = (blockerRating - defenderRating) / 99   // -1 to 1
  return Math.max(0.55, Math.min(1.45, 1.0 + diff * STRENGTH_ADVANTAGE_SCALE))
}

// Pass-rush modifier: an additive bias applied to the block-fight leverage score.
// Positive return value → shifts effective leverage toward the defender (defense wins).
// Negative return value → shifts toward the blocker (offense holds the block).
//
// Elite rusher (passRush 95) vs weak blocker (strength 55):
//   bias ≈ +0.24 — a neutral block contest flips decisively to the rusher
// Average DL (82) vs average T (82): bias = 0 — purely leverage-driven
// Blitzing LB (62) vs T (82): bias ≈ -0.12 — blocker has a meaningful edge

const PASS_RUSH_ADVANTAGE_SCALE = 0.6

export function passRushModifier(rushRating, blockStrength) {
  const diff = (rushRating - blockStrength) / 99   // -1 to 1
  return diff * PASS_RUSH_ADVANTAGE_SCALE
}

// ── Conversion helpers ────────────────────────────────────────────────────────
// Maps a 0–99 rating to a real physics value using a linear range.

const MAX_ACCEL = 28   // yards/sec² at rating 99
const MIN_ACCEL = 5    // yards/sec² at rating 0

const MAX_SPEED = 9.5  // yards/sec at rating 99
const MIN_SPEED = 4.0  // yards/sec at rating 0

const MAX_DRAIN    = 5.0   // % stamina/sec lost at rating 0 (fragile)
const MIN_DRAIN    = 1.5   // % stamina/sec lost at rating 99 (iron horse)

const MAX_RECOVERY = 8     // % stamina regained per play at rating 99
const MIN_RECOVERY = 1     // % stamina regained per play at rating 0

export function accelFromRating(rating) {
  return MIN_ACCEL + (rating / 99) * (MAX_ACCEL - MIN_ACCEL)
}

export function speedFromRating(rating) {
  return MIN_SPEED + (rating / 99) * (MAX_SPEED - MIN_SPEED)
}

// Higher stamina rating → LOWER drain (player lasts longer)
export function drainFromStaminaRating(rating) {
  return MAX_DRAIN - (rating / 99) * (MAX_DRAIN - MIN_DRAIN)
}

// Higher stamina rating → MORE recovery between plays
export function recoveryFromStaminaRating(rating) {
  return MIN_RECOVERY + (rating / 99) * (MAX_RECOVERY - MIN_RECOVERY)
}

// Route running: how close a player must be to a waypoint before cutting to the next one.
// Low value = razor-sharp cut.  High value = rounded, sloppy cut.
const CUT_THRESHOLD_SHARP = 0.4   // yards at rating 99
const CUT_THRESHOLD_SLOPPY = 2.2  // yards at rating 0

// How much speed is retained when making a cut (1.0 = no loss, 0.5 = half speed).
const CUT_SPEED_BEST  = 0.95  // at rating 99
const CUT_SPEED_WORST = 0.55  // at rating 0

export function cutThresholdFromRating(rating) {
  return CUT_THRESHOLD_SLOPPY - (rating / 99) * (CUT_THRESHOLD_SLOPPY - CUT_THRESHOLD_SHARP)
}

export function cutSpeedRetentionFromRating(rating) {
  return CUT_SPEED_WORST + (rating / 99) * (CUT_SPEED_BEST - CUT_SPEED_WORST)
}

// ── Ball-carrier cut momentum ([159]) ───────────────────────────────────────────
//
// How much speed a ball carrier keeps when it plants and changes direction, governed by
// ACCELERATION: an explosive back (99) barely slows cutting, a sluggish one (0) loses
// nearly half its momentum. Re-acceleration afterward is also accel-driven (through the
// movement steering), so a faster accelerator both loses less on the cut and rebuilds
// speed quicker. This is the runner analogue of cutSpeedRetentionFromRating (routes).
const CUT_RETENTION_BEST  = 0.92  // fraction of speed kept on a hard cut at acceleration 99
const CUT_RETENTION_WORST = 0.55  // at acceleration 0

export function cutRetentionFromAccel(rating) {
  const r = Math.max(0, Math.min(99, rating ?? 55))
  return CUT_RETENTION_WORST + (r / 99) * (CUT_RETENTION_BEST - CUT_RETENTION_WORST)
}

// ── Pursuit ([160]) ──────────────────────────────────────────────────────────
//
// AWARENESS governs how well a defender chases down a ball carrier:
//   • reaction time — how long it takes to read the loose ball and commit to the chase.
//     Until then it flat-foot chases the carrier's current spot; a high-awareness defender
//     commits almost instantly, a low one hesitates and cedes ground.
//   • angle quality — once committed, how fully it anticipates the intercept point. An
//     elite pursuer takes the perfect cut-off angle; a poor one under-leads and tail-chases.
const PURSUIT_REACTION_SLOW = 0.5    // s to commit at awareness 0
const PURSUIT_REACTION_FAST = 0.05   // s to commit at awareness 99 (near-instant read)
const PURSUIT_LEAD_WORST    = 0.35   // fraction of the true intercept lead taken at awareness 0
const PURSUIT_LEAD_BEST     = 1.0    // full intercept anticipation at awareness 99

export function pursuitReactionTime(awareness) {
  const a = Math.max(0, Math.min(99, awareness ?? 55))
  return PURSUIT_REACTION_SLOW - (a / 99) * (PURSUIT_REACTION_SLOW - PURSUIT_REACTION_FAST)
}

export function pursuitLeadQuality(awareness) {
  const a = Math.max(0, Math.min(99, awareness ?? 55))
  return PURSUIT_LEAD_WORST + (a / 99) * (PURSUIT_LEAD_BEST - PURSUIT_LEAD_WORST)
}
