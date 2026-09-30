// ── Reading the field ([offline]) ────────────────────────────────────────────
//
// How open is a receiver? On EASY the server answers that for you: every receiver arrives with an
// `openness` score. On MEDIUM and HARD it does not — `HIDES_OPENNESS` withholds it from the
// offense, which is the entire point of those difficulties. A human on medium looks at the picture
// and judges it themselves.
//
// So must the AI. Without this it simply never throws: the first version gated on
// `openness >= 0.55`, `openness` was `undefined` on a medium room, and the quarterback stood in the
// pocket until he was sacked. Twice, in the first two plays of a real game.
//
// Everything here is computed from positions the AI is already sent, so it works identically on
// every difficulty — and on easy it defers to the server's number, which is the true one.

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
export function rankTargets(k, { noise = 0, rng = Math.random } = {}) {
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
      const score = shortOfSticks ? noisy * shortReach(p, k, mustConvert) : noisy
      return { ...p, score, rankScore: score * depthPreference(p, k), trueScore, estimated: p.openness == null, shortOfSticks }
    })
    // ⚠️ ORDERED BY `rankScore`, JUDGED BY `score` — see depthPreference.
    .sort((a, b) => b.rankScore - a.rankScore)
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

function shortReach(p, k, mustConvert = true) {
  const need = Math.max(1, k.distance ?? 10)
  const gained = (p.y ?? 0) - (k.yardLine ?? 0)
  const fraction = Math.max(0, Math.min(1, gained / need))
  const floor = mustConvert ? SHORT_FLOOR : SHORT_FLOOR_EARLY
  return floor + (1 - floor) * fraction
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
