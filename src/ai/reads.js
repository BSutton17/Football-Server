// ── Reading the field ([offline]) ────────────────────────────────────────────
//
// How open is a receiver? The server now answers that for a computer seat on EVERY difficulty: see
// the note in serialization.js. `estimateOpenness` below is what it used to have to do instead, and
// it remains the fallback — for AI_SEES_OPENNESS=0, and for any seat the server does not answer for.
//
// ⚠️ THE ESTIMATE WAS NOT GOOD ENOUGH, AND THAT IS WHY THE READ IS NOW SENT. It is separation
// plus a lane check. The engine's number also weighs leverage, closing speed, bracketing and safety
// help, and — the part that decided it — it is the number the throw is RESOLVED on, so the
// quarterback was choosing a receiver on one read and being judged on another. Paired on identical
// seeds, pass plays only: a quarter of his pass plays ended in a SACK on the estimate (26% on 2nd
// and 8, 29% on 3rd and 10) against 4% and 11% on the true read, worth about two to three yards a
// play. Measured by scripts/opennessArm.mjs.
//
// The history is worth keeping, because a worse version of this cost two plays of a real game: the
// first version gated on `openness >= 0.55`, `openness` was `undefined` on a medium room, and the
// quarterback simply stood in the pocket until he was sacked.

// Yards of separation at which a receiver counts as fully open. Roughly the point where a defender
// can no longer make a play on an instantly-resolved pass.
const OPEN_SEPARATION = 6

// A defender closer to the throwing line than this is in the way, however far he is from the
// receiver. An instant pass has no arc to clear him with.
const LANE_WIDTH = 2.2

// How far along the QB→receiver line a defender has to be to count as blocking it. A defender
// right on the passer is a rusher; one right on the receiver is ordinary coverage, already priced
// in by the separation term. Matches the band the engine's own lane check uses.
const LANE_MIN = 0.12
const LANE_MAX = 0.85

// The AI's own estimate of how open a receiver is, 0 (smothered) to 1 (wide open).
//
// Two terms, because they are two different ways of being covered:
//   SEPARATION — how far the nearest defender is. A receiver with nobody near him is open.
//   THE LANE   — whether anybody stands between the passer and him. A receiver can have five yards
//                of separation and still be unthrowable with a linebacker in the window.
export function estimateOpenness(receiver, defenders, qb) {
  if (!receiver) return 0

  let nearest = Infinity
  for (const d of defenders) {
    const dist = Math.hypot(d.x - receiver.x, d.y - receiver.y)
    if (dist < nearest) nearest = dist
  }
  const separation = nearest === Infinity ? 1 : clamp01(nearest / OPEN_SEPARATION)

  // No passer to throw from (shouldn't happen mid-play) — separation is the whole story.
  if (!qb) return separation

  const blocked = laneBlocked(qb, receiver, defenders)
  return blocked ? Math.min(separation, 0.2) : separation
}

// Is somebody standing in the throwing lane?
function laneBlocked(qb, receiver, defenders) {
  const vx = receiver.x - qb.x
  const vy = receiver.y - qb.y
  const len2 = vx * vx + vy * vy
  if (len2 < 1) return false

  for (const d of defenders) {
    // Where along the line this defender sits, 0 at the passer and 1 at the receiver.
    const t = ((d.x - qb.x) * vx + (d.y - qb.y) * vy) / len2
    if (t < LANE_MIN || t > LANE_MAX) continue
    // Perpendicular distance from the line.
    const px = qb.x + vx * t
    const py = qb.y + vy * t
    if (Math.hypot(d.x - px, d.y - py) <= LANE_WIDTH) return true
  }
  return false
}

// Every receiver worth throwing to right now, best first.
//
// `ready` is the engine's own gate and is NOT optional: a receiver who has not declared his route
// is not a legal target, and a pass at one is almost always a drop. It arrives on every difficulty,
// precisely so a hard-mode client still knows who is live.
// [difficulty] `noise` is how badly this tier MISREADS the picture — a handicap, never a peek. It
// perturbs the score AFTER the read is computed and before the sort, so a worse quarterback ranks
// the wrong receiver first some of the time. It cannot reveal anything: the inputs are unchanged,
// and the only thing noise can do to a ranking is make it worse.
//
// `trueScore` is kept alongside so telemetry and tests can see what the read actually was versus
// what this tier thought it was.
export function rankTargets(k, { noise = 0, rng = Math.random, decay = 0 } = {}) {
  const own = []
  const defenders = []
  let qb = null

  for (const p of k.live.values()) {
    if (p.team === 'd') { defenders.push(p); continue }
    // ⚠️ THE PASSER IS FLAGGED `qb`, NOT `carrier` — a quarterback in the pocket is not the ball
    // carrier by the engine's definition, so this found nobody on every pass play and
    // `estimateOpenness` was being handed a null passer on every read.
    if (p.qb || p.carrier) { qb = p; continue }
    if (p.ready != null) own.push(p)           // only pass catchers carry `ready`
  }

  // ⚠️ ON THIRD DOWN, OPEN IS NOT THE SAME AS USEFUL. This ranked purely by how open somebody was,
  // so on 3rd and 15 the wide-open checkdown at four yards beat the covered receiver at sixteen
  // every time — the quarterback took the completion and the drive ended anyway. "On 3rd and long
  // the qb is too quick to throw it short instead of going for the first down."
  //
  // A PENALTY on being short of the sticks rather than a bonus for being past them, because the
  // scores are compared against a patience/pressure bar: inflating them would make him throw
  // EARLIER, which is the opposite of what is wanted. Discounting the checkdown makes him hold the
  // ball and look for the conversion, and the bar still falls with time and pressure, so a
  // checkdown remains better than a sack once nothing else has come open.
  //
  // It needs no distance test of its own. On 3rd and 1 the sticks are a yard away and almost
  // everybody is past them, so this does nothing; the further the sticks, the more it bites.
  const sticks = (k.yardLine ?? 0) + (k.distance ?? 10)
  const mustConvert = (k.down ?? 1) >= 3

  return own
    .filter(p => p.ready)
    .map(p => {
      // The server's number when it was sent, our own estimate when it was withheld. On easy these
      // agree closely; on medium and hard only the estimate exists.
      const trueScore = p.openness ?? estimateOpenness(p, defenders, qb)
      const noisy = noise ? clamp01(trueScore + (rng() * 2 - 1) * noise) : trueScore
      // A yard of slack, so somebody standing on the marker counts as past it.
      const shortOfSticks = (p.y ?? 0) < sticks - 1
      const score = shortOfSticks ? noisy * shortReach(p, k, mustConvert, decay) : noisy
      const tier = tierOf(p, k, noisy, mustConvert)
      const entry = { ...p, score, tier, trueScore, estimated: p.openness == null, shortOfSticks }
      return { ...entry, rankScore: orderKey(entry, score * depthPreference(p, k)) }
    })
    // ⚠️ ORDERED BY `rankScore`, JUDGED BY `score` — see depthPreference and tierOf.
    .sort((a, b) => b.rankScore - a.rankScore)
}

// ── How far along the play is ([qb]) ───────────────────────────────
//
// The fraction of this formation's pass catchers who have DECLARED -- broken off their route, so the
// engine will accept a throw at them. 0 at the snap, 1 once the whole distribution is live.
//
// ⚠️ THIS IS THE NUMBER THAT EXPLAINS "THE QB THROWS TOO FAST AND DOES NOT LET PLAYS DEVELOP".
// From a real game's report, averaged over the computer's pass plays:
//
//     board time   0.5s   0.8s   1.05s   1.4s   1.6s
//     declared     0.14   0.93   ~1.3    2.16   2.64
//
// He released at a MEDIAN of 1.05s, where about one and a third receivers existed as targets, and on
// 7 of 13 throws there were two or fewer. He was not choosing the short man over the first down -- at
// that moment there was nobody else to choose. Which is also why the tiering below cannot fix it: it
// reorders the declared, and almost nobody had declared.
export function developedFraction(k) {
  let total = 0, ready = 0
  for (const p of k.live.values()) {
    if (p.team === 'd') continue
    if (p.qb || p.carrier) continue
    if (p.ready == null) continue        // only pass catchers carry `ready`
    total++
    if (p.ready) ready++
  }
  return total === 0 ? 1 : ready / total
}

// ── Looking for the first down before looking for the easy throw ([qb]) ─────
//
// Asked for: "make the QB prefer to pick up a first down, especially on 3rd down, instead of just
// throwing checkdowns. In fact checkdowns should usually be the last thing the QB considers."
//
// So the read is TIERED rather than weighted, because a weight can always be outvoted by a wide-open
// checkdown and that is the behaviour being complained about:
//
//     2  past the sticks        — the throw that ends the series
//     1  a real gain short of them
//     0  a checkdown            — at, behind, or barely past the line of scrimmage
//
// Within a tier it is openness that decides, exactly as before. Between tiers the tier decides, so a
// receiver who converts is taken ahead of a more open man who does not.
//
// ⚠️ A TIER HAS TO BE EARNED, OR THIS JUST THROWS INTERCEPTIONS. A blanketed receiver past the
// marker is not a conversion, he is a turnover, so a tier above the bottom is claimed only by somebody
// at least minimally throwable. Below that floor he sorts on openness with the checkdowns, which is
// where a covered man belongs.
//
// ⚠️ AND THIS ORDERS, IT DOES NOT RELEASE. `score` still reaches the patience/pressure bar
// untouched, so none of this makes him throw EARLIER or hold LONGER — see the note on
// depthPreference, which exists for the same reason. When the bar has fallen far enough that only the
// checkdown clears it, he takes the checkdown. That is the difference between "last thing he
// considers" and "a sack".
//
// ⚠️ ON 3RD AND 1 IT DOES NOTHING, and should not: everybody is past the sticks, so every
// receiver is tier 2 and openness decides the whole read. The shorter the distance the less this says.
const CHECKDOWN_YARDS = 3

// How open a receiver must be before his depth counts for anything. Lower on a down that must
// convert: there a tight window past the marker is worth more than a comfortable one short of it,
// which is the whole point. On 1st and 2nd a checkdown is a perfectly good football play, so the
// conversion has to be a real one before it jumps the queue.
const TIER_FLOOR = Number(process.env.QB_TIER_FLOOR ?? 0.30)
const TIER_FLOOR_EARLY = Number(process.env.QB_TIER_FLOOR_EARLY ?? 0.45)

function tierOf(p, k, noisy, mustConvert) {
  if (process.env.QB_CONVERT_FIRST === '0') return 0     // the off switch, for A/B in two processes
  const gained = (p.y ?? 0) - (k.yardLine ?? 0)
  const need = Math.max(1, k.distance ?? 10)
  if (noisy < (mustConvert ? TIER_FLOOR : TIER_FLOOR_EARLY)) return 0
  // ⚠️ CONVERTING IS CHECKED FIRST. On 3rd and 1 a one-yard catch is both a conversion and a
  // checkdown by the yardage, and it is the conversion that matters.
  if (gained >= need - 1) return 2
  return gained <= CHECKDOWN_YARDS ? 0 : 1
}

// How a tier and a score combine into one sortable number.
//
// ⚠️ ONE AUTHORITY, BECAUSE THERE ARE TWO PLACES THAT SORT. controller.js re-ranks in a manual
// room on where each receiver is HEADING, and it sorted on the score alone — so every ordering
// preference in this file was silently discarded in the only mode the game is actually played in.
// Scores live in [0, 1], so a whole point is a clean break between tiers.
export function orderKey(t, score = t.score) {
  return (t.tier ?? 0) + clamp01(score)
}

// ── Preferring the throw that is worth more ([qb]) ──────────────────────────
//
// The ranking above is openness and nothing else: how much SPACE a man has, never what catching it
// would be worth. Wide open at three yards outranks moderately open at eighteen, on every down, and
// the only thing pulling the other way is the short-of-the-sticks discount — which does nothing at
// all on first and ten, because three yards and eighteen yards are both short of the marker.
//
// ⚠️ THIS MULTIPLIES THE ORDER, NOT THE BAR, AND THE DISTINCTION IS THE WHOLE POINT.
// `controller.js` does two separate things with this list: it throws to `targets[0]`, and it decides
// whether to throw AT ALL by testing `targets[0].score` against a patience/pressure bar. A depth
// bonus folded into `score` would do both — it would reorder the reads AND make him release
// earlier, because every receiver would clear the bar sooner. Two changes, one number, and no way
// to tell afterwards which one moved the yards. So the preference lands on `rankScore`, which only
// sorts, and `score` reaches the bar untouched.
//
// Weight 0 is exactly today's behaviour and is the default: this is inert until measured.
function depthPreference(p, k) {
  const weight = Number(process.env.QB_DEPTH_WEIGHT ?? 0)   // per call: a module-load read makes every trial identical
  if (!weight) return 1
  const air = (p.y ?? 0) - (k.yardLine ?? 0)
  if (!(air > 0)) return 1
  return 1 + weight * clamp01(air / DEPTH_FULL_YARDS)
}

// Air yards at which the depth preference is at full strength; beyond this it stops growing, so a
// forty-yard heave is not preferred over a twenty-yard in-cut by another factor of two.
const DEPTH_FULL_YARDS = 20

// ⚠️ HOW FAR SHORT, NOT MERELY SHORT. A flat discount for being inside the sticks treated a
// ten-yard catch on 3rd and 12 the same as a two-yard one, and the quarterback stopped throwing it
// at all — which is wrong twice over: it makes 4th and 2 instead of 4th and 10, and eating a sack
// is worse than either. A test caught it.
//
// So the discount scales with the fraction of the needed yardage the catch actually covers. Nearly
// there keeps nearly all its value; a checkdown at the line of scrimmage keeps the floor.
const SHORT_FLOOR = 0.40

// ⚠️ AND IT APPLIES ON EVERY DOWN, NOT ONLY THE ONES THAT MUST CONVERT.
//
// Gated to third and fourth, first and second had no notion that a completion at the line of
// scrimmage is worth less than one past the sticks — so the first receiver to read open, two yards
// downfield a second after the snap, cleared the bar and got the ball. Measured across every passing
// play and coverage, binned by how long he held it:
//
//     held        n     net yds
//     < 1.5s     678      1.72
//     1.5-2.5s   343      4.88
//     2.5-3.5s    45      8.17
//
// ⚠️ AND THAT TABLE IS CONFOUNDED — IT IS NOT A REASON TO WAIT. Throws at two and a half seconds are
// worth more because they are throws on plays where somebody came open late, not because holding the
// ball caused it. Making him hold longer moved 10% of his throws out of the worst bin and changed
// the yardage not at all: -0.007 +/- 0.258 over 1,320 holdout dropbacks (confirmShortDiscount.mjs).
// The release knobs are the same story — searched across the book with a held-out split, and the
// winner reversed sign at four times the sample (trainQB.mjs, confirmQB.mjs).
//
// So this is kept for the BEHAVIOUR that was asked for — a quarterback who does not throw at the
// first body to come open two yards downfield — and not because it gains yards. It does not.
//
// The discount is gentler on an early down, because a checkdown on 1st and 10 is a perfectly good
// football play and a checkdown on 3rd and 12 is a punt. It also fades with the bar: once time and
// pressure have brought the bar down, the short throw is available again, which is exactly when a
// quarterback should take it.
const SHORT_FLOOR_EARLY = Number(process.env.QB_EARLY_FLOOR ?? 0.70)

// ⚠️ A SIX-YARD THROW ON 3RD AND 8 WAS SCORING 0.81 AND CLEARING THE BAR INSTANTLY.
//
// This is the measurement that redirected the whole change. Asked to stop the quarterback "throwing
// checkdowns instead of picking up the first down", the obvious reading is that he favours the back in
// the flat. He does not. 48 throws on 3rd and 8, by air yards:
//
//     mean 6.2 yds    past the sticks 17%    at-or-behind 3 yards 8%
//     6 6 11 6 5 6 6 11 9 6 3 10 6 5 6 6 6 6 6 6 9 16 6 7 6 6 6 3 3 3 6 5 6 4 6 ...
//
// It is a six-yard throw, over and over, which is the depth a route is at when it first DECLARES. He
// was not choosing the short man over the first down; he was releasing before anybody could get to the
// marker. A true checkdown was 8% of his throws.
//
// The LINEAR discount is why. Six yards of an eight-yard need is three quarters of the way there, so
// it kept 85% of its value and sailed over the bar. Raised to a power, the same throw keeps 61%, and
// the nearly-there throw is still barely touched -- which preserves the thing the flat version got
// right, that a ten-yard catch on 3rd and 12 is not a two-yard one.
//
// Both knobs are env-overridable and read PER CALL, because they were swept (a module-load read makes
// every trial in a run identical, which has cost a measurement here before).
const SHORT_CURVE = 2.5

// How far into his patience the insistence on a conversion starts to let go. See shortReach.
const FADE_START = 0.7

function shortReach(p, k, mustConvert = true, decay = 0) {
  const need = Math.max(1, k.distance ?? 10)
  const gained = (p.y ?? 0) - (k.yardLine ?? 0)
  const fraction = clamp01(gained / need)
  if (!mustConvert) return SHORT_FLOOR_EARLY + (1 - SHORT_FLOOR_EARLY) * fraction
  // ⚠️ ONE OFF SWITCH FOR THE WHOLE CHANGE, so the control arm of an A/B is the OLD behaviour and
  // not a half-reverted version of the new one. Turning off only the curve left the fade in place, the
  // control moved under me, and a baseline measured twice came back 18% and then 16%.
  if (process.env.QB_CONVERT_FIRST === '0') return SHORT_FLOOR + (1 - SHORT_FLOOR) * fraction
  const floor = Number(process.env.QB_SHORT_FLOOR ?? SHORT_FLOOR)
  const curve = Number(process.env.QB_SHORT_CURVE ?? SHORT_CURVE)
  const demand = floor + (1 - floor) * Math.pow(fraction, curve)
  // ⚠️ AND THE DEMAND RELAXES AS THE PLAY AGES, WHICH IS WHAT KEEPS THIS FROM BEING SACKS.
  //
  // The curve alone bought the conversions and charged for them: on 3rd and 12 it took the sack rate
  // from 11% to 23% over 300 held-out plays, because he held out for twelve yards that nobody was ever
  // going to cover. Raising the floor did not help -- the cost is in the curve, not the floor.
  //
  // `decay` is the controller's own measure of how much play is left (readDecay), the SAME number the
  // openness bar falls on: 0 at the snap, 1 once his patience is spent or the rush is on him. At 0 he
  // insists on the first down; at 1 the discount is gone entirely and he takes the completion. That is
  // the difference between "a checkdown is the last thing he considers" and "a checkdown is a sack".
  // Nothing relaxes until he is FADE_START of the way through his patience: the fade from the snap
  // relaxed the demand almost at once (urgency or elapsed reaches it fast) and gave back four fifths of
  // the conversions it was there to win -- +2.3pp instead of +10.7pp, holdout.
  const start = Number(process.env.QB_FADE_START ?? FADE_START)
  const relax = clamp01((clamp01(decay) - start) / Math.max(1e-6, 1 - start))
  return demand + (1 - demand) * relax
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
