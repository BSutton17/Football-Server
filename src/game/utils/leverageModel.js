// Leverage model — determines who has the positional and directional advantage
// in a blocker-vs-defender engagement.
//
// Inside leverage: the blocker is positioned between the defender and the ball.
//   The blocker can push the defender AWAY from the ball, widening the pocket
//   or opening a running lane.
//
// Outside leverage: the defender has a better angle — they are on the near side
//   of the blocker relative to the ball and can work toward it.
//
// Score: +1 = offense has full inside leverage, -1 = defense has full advantage.
// PushX/pushY: the direction the defender should be steered when offense has leverage.

// Weights for the two leverage components.
const POSITION_WEIGHT = 0.65  // where the blocker stands relative to the ball
const DRIVE_WEIGHT    = 0.35  // whether the blocker's body is moving into the defender

// ── Helpers ───────────────────────────────────────────────────────────────────

function len(x, y) { return Math.sqrt(x * x + y * y) }

// Returns normalized {nx, ny} or a zero vector if magnitude is negligible.
function norm(x, y) {
  const l = len(x, y)
  return l > 0.001 ? { nx: x / l, ny: y / l } : { nx: 0, ny: 0 }
}

function dot(ax, ay, bx, by) { return ax * bx + ay * by }

// ── Public API ────────────────────────────────────────────────────────────────

// Computes leverage for a single blocker-vs-defender pair.
//
//   blocker  — { x, y, vx, vy }
//   defender — { x, y }
//   ballRef  — { x, y } — position of the QB or active ball carrier
//
// Returns:
//   score         — float in [-1, 1]; positive = offense advantage
//   side          — 'inside' | 'outside' | 'balanced'
//   pushX, pushY  — unit vector: direction to steer the defender under offense leverage
//   positionScore — raw position component (before weighting)
//   driveScore    — raw drive component (before weighting)
export function computeLeverage(blocker, defender, ballRef) {
  // ── Vector: defender → ball ──────────────────────────────────────────────────
  const toBallX = ballRef.x - defender.x
  const toBallY = ballRef.y - defender.y
  const toBall  = norm(toBallX, toBallY)

  // ── Vector: defender → blocker ───────────────────────────────────────────────
  const toBlockX = blocker.x - defender.x
  const toBlockY = blocker.y - defender.y
  const toBlock  = norm(toBlockX, toBlockY)

  // If vectors are degenerate (players on top of each other) return neutral.
  if ((toBall.nx === 0 && toBall.ny === 0) || (toBlock.nx === 0 && toBlock.ny === 0)) {
    return { score: 0, side: 'balanced', pushX: 0, pushY: 0, positionScore: 0, driveScore: 0 }
  }

  // ── Position score ───────────────────────────────────────────────────────────
  // dot(defender→ball, defender→blocker):
  //   +1 = blocker is exactly in the direction of the ball from the defender → inside
  //   -1 = blocker is on the opposite side from the ball → outside
  const positionScore = dot(toBall.nx, toBall.ny, toBlock.nx, toBlock.ny)

  // ── Drive score ──────────────────────────────────────────────────────────────
  // Is the blocker's velocity directed into the defender?
  // dot(blocker velocity, blocker→defender):
  //   +1 = driving hard into the defender (maximum drive leverage)
  //   -1 = moving away (losing ground)
  const velLen = len(blocker.vx, blocker.vy)
  let driveScore = 0
  if (velLen > 0.1) {
    // Direction from blocker toward defender
    const toDef = norm(defender.x - blocker.x, defender.y - blocker.y)
    const vel   = norm(blocker.vx, blocker.vy)
    driveScore  = dot(vel.nx, vel.ny, toDef.nx, toDef.ny)
  }

  // ── Combined leverage score ──────────────────────────────────────────────────
  const raw   = positionScore * POSITION_WEIGHT + driveScore * DRIVE_WEIGHT
  const score = Math.max(-1, Math.min(1, raw))

  // ── Leverage side ────────────────────────────────────────────────────────────
  // Cross product of (defender→ball) × (defender→blocker) tells which side the
  // blocker is on relative to the ball direction.  Sign determines left vs right.
  const cross = toBall.nx * toBlock.ny - toBall.ny * toBlock.nx
  const side  = positionScore > 0.25  ? 'inside'
              : positionScore < -0.25 ? 'outside'
              : 'balanced'

  // ── Push direction ───────────────────────────────────────────────────────────
  // When offense has inside leverage, the ideal push steers the defender AWAY from
  // the ball (along -toBall), widening the pocket or opening a gap.
  // When leverage is balanced or outside, the push is perpendicular to the approach
  // (the block slows the defender but doesn't redirect them cleanly).
  let pushX, pushY
  if (positionScore > 0.1) {
    // Inside: drive defender away from the ball
    pushX = -toBall.nx
    pushY = -toBall.ny
  } else {
    // Outside / balanced: push perpendicular; cross sign picks the correct side
    const sign = cross >= 0 ? 1 : -1
    pushX = -toBall.ny * sign
    pushY =  toBall.nx * sign
  }

  return { score, side, pushX, pushY, positionScore, driveScore }
}
