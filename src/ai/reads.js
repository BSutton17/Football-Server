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
    if (p.carrier) { qb = p; continue }        // whoever has the ball is the passer
    if (p.ready != null) own.push(p)           // only pass catchers carry `ready`
  }

  return own
    .filter(p => p.ready)
    .map(p => {
      // The server's number when it was sent, our own estimate when it was withheld. On easy these
      // agree closely; on medium and hard only the estimate exists.
      const trueScore = p.openness ?? estimateOpenness(p, defenders, qb)
      const score = noise ? clamp01(trueScore + (rng() * 2 - 1) * noise) : trueScore
      return { ...p, score, trueScore, estimated: p.openness == null }
    })
    .sort((a, b) => b.score - a.score)
}

function clamp01(v) { return Math.max(0, Math.min(1, v)) }
