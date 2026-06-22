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

export const RULES = {
  DOWNS: 4,
  FIRST_DOWN_YARDS: 10,
  QUARTERS: 4,
  QUARTER_SECONDS: 300,   // 5 minutes per quarter
  TD_POINTS: 7,
  SAFETY_POINTS: 2,
  KICKOFF_YARD_LINE: 25,
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

// Valid values for route and coverage assignments.
// Must stay in sync with Client/src/types/routes.ts.
export const ROUTE_TYPES = new Set([
  'flat', 'drag', 'quick_out', 'slant', 'zig',
  'curl', 'out', 'comeback', 'dig', 'return', 'cross',
  'go', 'post', 'corner', 'seam', 'wheel', 'deep_cross',
  'angle', 'delay',
  'swing', 'check_down', 'flare', 'texas', 'screen',
  'block',
])

export const COVERAGE_TYPES = new Set(['man', 'zone', 'blitz', 'spy'])
export const ZONE_TYPES     = new Set(['flat', 'deep', 'curl', 'hook'])

export const PLAYER = {
  RADIUS:         0.75,  // yards — collision detection hitbox and visual size
  CONTACT_RADIUS: 1.5,   // yards center-to-center — bodies are touching (RADIUS * 2)
  MAX_SPEED:      8.0,   // yards per second (~16 mph, tuned for gameplay pace)
}
