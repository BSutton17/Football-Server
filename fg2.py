import io

p = 'src/ai/specialTeams.js'
s = io.open(p, encoding='utf-8').read()

# ── the field-goal curve, to the numbers asked for ────────────────────────
old = """// Reuses the engine's own DEEP_YARDS for "deep", so a route the X-Factors call deep and a route
// the half-time read calls deep are the same thing.
const FG_AUTOMATIC_TO = 25      // a kick this short is as close to certain as anything in football
const FG_MAX = 0.99
const FG_NEAR_FALLOFF = 0.010   // per yard from 25 to 45
const FG_LONG_FROM = 45
const FG_LONG_FALLOFF = 0.028   // per yard past 45, where legs start to matter
const FG_FLOOR = 0.02           // never quite impossible

// Chance the AI makes a field goal of this KICK distance. Roughly:
//   30 yd 94%   35 yd 89%   40 yd 84%   45 yd 79%   50 yd 65%   55 yd 51%   60 yd 37%
export function fieldGoalChance(kickDistance) {
  const d = Math.max(0, kickDistance)
  const near = FG_MAX - Math.max(0, Math.min(d, FG_LONG_FROM) - FG_AUTOMATIC_TO) * FG_NEAR_FALLOFF
  const long = Math.max(0, d - FG_LONG_FROM) * FG_LONG_FALLOFF
  return clamp01(Math.max(near - long, FG_FLOOR))
}"""
new = """// ⚠️ THESE ARE THE RATES THAT WERE ASKED FOR, NOT A CURVE I FITTED. Stated as bands, so they can
// be checked against the request rather than reverse-engineered out of an equation:
//
//   inside 35  100%      inside 45  90%      inside 50  80%      inside 55  75%
//
// Interpolated WITHIN each band rather than stepped, because a cliff between 34 and 36 yards would
// be visible and strange. Past the last band it keeps falling at the same slope to a floor: a
// seventy-yard attempt is not 75%.
//
// The argument is the KICK distance (goal line + 17), which the caller already passes.
const FG_BANDS = [
  { to: 35, rate: 1.00 },
  { to: 45, rate: 0.90 },
  { to: 50, rate: 0.80 },
  { to: 55, rate: 0.75 },
]
const FG_BEYOND_FALLOFF = 0.03   // per yard past the last band
const FG_FLOOR = 0.05

export function fieldGoalChance(kickDistance) {
  const d = Math.max(0, kickDistance)
  const first = FG_BANDS[0]
  if (d <= first.to) return first.rate

  for (let i = 1; i < FG_BANDS.length; i++) {
    const lo = FG_BANDS[i - 1]
    const hi = FG_BANDS[i]
    if (d > hi.to) continue
    // Linear across the band, so it arrives exactly on the stated rate at the band's edge.
    const t = (d - lo.to) / (hi.to - lo.to)
    return clamp01(lo.rate + (hi.rate - lo.rate) * t)
  }

  const last = FG_BANDS[FG_BANDS.length - 1]
  return clamp01(Math.max(last.rate - (d - last.to) * FG_BEYOND_FALLOFF, FG_FLOOR))
}"""
assert old in s, 'fg anchor'
s = s.replace(old, new, 1)

# ── backspin on punts ─────────────────────────────────────────────────────
old_k = """  // Kicking. The meter is tapped up with alternating aim so the angle lands where it was aimed:
  // each tap adds power AND rotates, so an odd number of taps leaves the aim off-centre unless the
  // rotations cancel.
  if (st.kicking && st.phase === 'setup') {
    return { event: 'special_teams_input', payload: { aim: nextTap(st, k, rng) } }
  }"""
new_k = """  // ⚠️ BACKSPIN, WHICH THE COMPUTER NEVER USED. It is a punt-only setup toggle that checks the
  // ball up instead of letting it roll, and it is the difference between pinning somebody inside
  // the ten and watching the ball trickle into the end zone for a touchback. A human had it and the
  // AI did not, so the AI punted away field position it did not need to.
  //
  // Decided once per punt, before any power is built, and only when there is something to pin
  // against: from midfield the roll is worth more than the placement.
  if (st.kicking && st.kickType === 'punt' && st.backspin !== true && wantsBackspin(k)) {
    return { event: 'special_teams_input', payload: { backspin: true } }
  }

  // Kicking. The meter is tapped up with alternating aim so the angle lands where it was aimed:
  // each tap adds power AND rotates, so an odd number of taps leaves the aim off-centre unless the
  // rotations cancel.
  if (st.kicking && st.phase === 'setup') {
    return { event: 'special_teams_input', payload: { aim: nextTap(st, k, rng) } }
  }"""
assert old_k in s, 'kick anchor'
s = s.replace(old_k, new_k, 1)

old_f = """function clamp01(v) { return Math.max(0, Math.min(1, v)) }"""
new_f = """// Punting from far enough up the field that the ball would reach the end zone on the roll. Inside
// this the placement matters more than the extra yards, so the ball is checked up.
const BACKSPIN_FROM = 55        // own 55 and beyond, i.e. the opponent's 45 and in

function wantsBackspin(k) {
  return (k?.yardLine ?? 0) >= BACKSPIN_FROM
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }"""
assert old_f in s, 'clamp anchor'
io.open(p, 'w', encoding='utf-8').write(s.replace(old_f, new_f, 1))
print('patched')
