// Mirrors Client/src/constants/simulation.ts — server is authoritative, so these are
// the values that actually govern gameplay. Keep both files in sync manually.
//
// World coordinate system (server-absolute):
//   Origin: back-left corner of the south end zone
//   X: 0 = left sideline → 53.33 = right sideline          (yards, west→east)
//   Y: 0 = south EZ back → 120 = north EZ back             (yards, south→north)
//   Play field: Y 10–110  |  South EZ: Y 0–10  |  North EZ: Y 110–120
//   direction:  1 = offense advances northward (Y increases)
//              -1 = offense advances southward (Y decreases)
// Clients receive offense-relative Y: own goal line = 0, opponent goal line = 100.

export const FIELD = {
  WIDTH: 53.33,      // sideline to sideline, yards
  LENGTH: 120,       // full field including both end zones, yards
  END_ZONE_DEPTH: 10,
  PLAY_LENGTH: 100,  // between the two goal lines
}

// Hash marks (the two center tick columns drawn by the renderer at 0.35 / 0.65 of the width). A
// dead ball outside a hash is spotted ON that hash; between them it keeps its exact lateral spot.
export const HASH = {
  LEFT:  FIELD.WIDTH * 0.35,   // ≈ 18.67
  RIGHT: FIELD.WIDTH * 0.65,   // ≈ 34.67
}

// Center of the field — the lateral spot after a kickoff / touchback (score, safety, punt).
export const FIELD_CENTER_X = FIELD.WIDTH / 2

export const RULES = {
  DOWNS: 4,
  FIRST_DOWN_YARDS: 10,
  QUARTERS: 4,
  QUARTER_SECONDS: 300,   // 5 minutes per quarter
  TD_POINTS: 7,
  SAFETY_POINTS: 2,
  TD_POINTS: 6,           // [Special Teams][51] touchdown — 6, then an extra-point / 2-pt try
  TWO_POINT_POINTS: 2,    // [Special Teams][51] successful two-point conversion
  FG_POINTS: 3,           // [Special Teams] successful field goal
  XP_POINTS: 1,           // [Special Teams] successful extra point
  XP_YARD_LINE: 75,       // [Special Teams][52] extra point is kicked from the opponent's 25 (own 75)
  TWO_POINT_YARD_LINE: 97,// [Special Teams][55] two-point try is snapped from the opponent's 3
  CONVERSION_SECONDS: 5,  // [Special Teams][51] post-TD decision timer before defaulting to the XP
  KICKOFF_YARD_LINE: 25,         // opening drive / game-start spot
  KICKOFF_RESULT_YARD_LINE: 30,  // [Special Teams][5] receiving team's spot after an (automatic) kickoff
  TOUCHBACK_YARD_LINE: 20,       // [Special Teams][38] receiving offense's spot after a punt touchback
  MISSED_FG_MIN_YARD_LINE: 20,   // [Special Teams][45] missed-FG spot floor — no closer than the own 20
  PLAY_CLOCK_SECONDS: 30,        // normal play clock
  PLAY_CLOCK_NEW_DRIVE: 45,      // first play of a drive — extra time to set the formation
  DELAY_OF_GAME_YARDS: 5,        // [delay of game] play-clock expiry → 5-yard penalty, replay the down
  TIMEOUTS_PER_HALF: 3,          // [70] timeouts each team gets per half (reset at halftime)
  TIMEOUT_SECONDS: 6,            // [69] how long a called timeout freezes play before auto-resuming
}

// Tick rate — read from TICK_RATE env variable at startup.
// Valid range: 10–60 Hz.  Falls back to 20 Hz if missing or out of range.
// TICK_MS is derived from TICK_RATE so both values are always consistent.
const _raw = parseInt(process.env.TICK_RATE ?? '20', 10)
const _rate = Number.isFinite(_raw) && _raw >= 10 && _raw <= 60 ? _raw : 20

if (_raw !== _rate) {
  console.warn(`[config] TICK_RATE=${process.env.TICK_RATE} is invalid — falling back to ${_rate} Hz`)
}

export const SIM = {
  TICK_RATE: _rate,
  TICK_MS:   Math.round(1000 / _rate),  // e.g. 20 Hz → 50 ms, 30 Hz → 33 ms
}

// ── Game mode ([manual]) ──────────────────────────────────────────────────────
//
// 'automatic' — the original game: the offense hits HIKE and the play runs itself to the whistle.
// 'manual'    — traditional electric football: after the defensive window the offense holds a GO
//               button. Players move only while it is held; releasing freezes the whole play
//               (including the game clock) so the offense can read the field and pick a receiver.
//               Throws are legal ONLY while frozen — you cannot throw into moving traffic.
//
// The mode is fixed by whoever CREATES the room and is authoritative for it: a player who tries to
// join with the other mode selected is rejected rather than silently switched.

export const GAME_MODE = {
  AUTOMATIC: 'automatic',
  MANUAL:    'manual',
}

// ── Manual-mode difficulty ([manual]) ────────────────────────────────────────
//
// Chosen by the room creator and applied to whichever team currently has the ball. It ONLY ever
// hides information from the offense — the defense always sees the true openness colors.
//
// 'easy'   — pass catchers are colored by openness ([169]) exactly as in automatic mode.
// 'medium' — as hard, except that while the play is FROZEN the offense is shown the route art in
//            faded yellow, so it can see where its receivers are heading without being told how
//            open they are.
// 'hard'   — pass catchers keep their normal team color all the way through the play. Openness is
//          never sent to the offense, so the read has to come from watching the field. Readiness
//          is still signalled, but only as a brightness change: a receiver that hasn't declared its
//          route yet renders faded, and lights up to full color once it is throwable ([68]).

export const DIFFICULTY = {
  EASY:   'easy',
  MEDIUM: 'medium',
  HARD:   'hard',
}

// [medium] Difficulties that withhold the openness read from the offense. Medium hides it exactly
// as hard does — the difference is purely that medium draws the route art back in while the play is
// frozen, which is a client-side courtesy and changes nothing the server sends.
export const HIDES_OPENNESS = new Set([DIFFICULTY.MEDIUM, DIFFICULTY.HARD])

// ── Manual-mode timing ([manual]) ────────────────────────────────────────────

export const MANUAL = {
  // Real electric football bans "jittering" — flicking the switch on and off to nudge players a few
  // inches at a time. Every GO press therefore commits to at least this many seconds of movement,
  // so a tap costs the same as a short hold and rapid tapping buys nothing.
  MIN_HOLD_SECONDS: 0.75,

  // After a pass is released the outcome is already decided, but it is withheld behind an "It is…"
  // banner for a random spell in this range to build suspense. The whole sim is frozen for it.
  SUSPENSE_MIN_SECONDS: 1,
  SUSPENSE_MAX_SECONDS: 3,

  // Once the result is revealed, a catch or an interception holds on screen this long before the
  // run-after-catch / return resumes. An incompletion ends the play, so it needs no hold.
  RESULT_HOLD_SECONDS: 2,
}

// ── Quarter length ([quarter length]) ────────────────────────────────────────
//
// The host picks how long a quarter runs before the game starts. RULES.QUARTER_SECONDS stays the
// default for anything that never made a choice (an older client, a direct initGame in a test).
export const QUARTER_MINUTES_MIN = 3
export const QUARTER_MINUTES_MAX = 6
export const QUARTER_MINUTES_DEFAULT = 5

// Clamp an arbitrary client value to a whole number of minutes inside the allowed band.
export function clampQuarterMinutes(minutes) {
  const n = Math.round(Number(minutes))
  if (!Number.isFinite(n)) return QUARTER_MINUTES_DEFAULT
  return Math.max(QUARTER_MINUTES_MIN, Math.min(QUARTER_MINUTES_MAX, n))
}

// ── Pausing ([pause]) ────────────────────────────────────────────────────────
//
// A player-called pause freezes everything until it is lifted. Its real purpose is life
// interrupting a game, so while it is up a disconnected player's seat is held far longer than the
// usual reconnect window — a locked phone must not end the match.
export const PAUSE_RECONNECT_WINDOW_MS = 10 * 60 * 1000

// ── Committed man coverage ([man commit]) ────────────────────────────────────
//
// A man defender normally holds whatever leverage he happened to align with and plays it honestly.
// These let the defence COMMIT: tell him to take away one thing and fully sell out to it.
//
//   in    — sit to the receiver's inside (ball side), taking away slants, digs and posts
//   out   — sit to his outside, taking away outs, corners and comebacks
//   over  — play over the top, taking away everything deep
//   under — sit underneath in front of him, taking away the short and intermediate stuff
//
// The point is that each is a real bet. Committing inside leaves the out wide open; committing over
// the top leaves the hitch uncovered; committing underneath means a go route runs straight past.
// Guess right and the route is dead, guess wrong and it is a big play — which is the whole appeal
// of playing man aggressively.
export const MAN_COMMITS = new Set(['in', 'out', 'over', 'under'])

// Valid values for route and coverage assignments.
// Must stay in sync with Client/src/types/routes.ts.
export const ROUTE_TYPES = new Set([
  'flat', 'drag', 'quick_out', 'slant', 'zig',
  'curl', 'out', 'comeback', 'dig', 'return', 'cross',
  'go', 'post', 'corner', 'seam', 'wheel', 'deep_cross',
  'angle', 'delay',
  'swing', 'check_down', 'flare', 'texas', 'screen',
  'block',
  // [route draw] A route the player drew by hand. It carries its own waypoints rather than being
  // looked up in ROUTE_DEF, so the name is only a marker that geometry — not a template — governs it.
  'custom',
])

export const COVERAGE_TYPES = new Set(['man', 'zone', 'blitz', 'spy'])
export const ZONE_TYPES     = new Set(['flat', 'deep', 'curl', 'hook'])

export const PLAYER = {
  RADIUS:         0.75,  // yards — collision detection hitbox and visual size
  CONTACT_RADIUS: 1.5,   // yards center-to-center — bodies are touching (RADIUS * 2)
  MAX_SPEED:      8.0,   // yards per second (~16 mph, tuned for gameplay pace)
}
