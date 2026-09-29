// ── What the defense can see ([defense]) ────────────────────────────────────
//
// The key both the solver and the live game use to name an offensive look.
//
// ⚠️ THIS EXISTS BECAUSE THE TWO DISAGREED, AND NOTHING SAID SO. The solved table was keyed by the
// offense's authored FORMATION (`late|short|normal|gun_deuce`) while the game looked it up by
// personnel (`late|short|normal|3wr1te1rb`). Not one of the 204 solved entries could ever match, so
// every lookup missed and the defense fell through to its prior on every snap of every game. Hours
// of solving reached nothing. There were no errors, because a miss is indistinguishable from an
// unsolved bucket.
//
// ⚠️ SO THERE IS ONE CORE AND TWO ADAPTERS, not two implementations. `lookFromSpots` reads authored
// formation spots, `lookFromReceivers` reads bodies on the grass, and both hand the same normalised
// entries to `lookIdFrom`. Anything else and these drift apart again, silently, exactly as before.
//
// The key cannot be the authored formation id: a HUMAN offense has no authored formation at all, so
// that key could never match a real opponent. And it cannot be personnel alone — 17 formations
// collapse to 3 personnel groupings, with empty, bunch, trips and pistol all becoming "3wr1te1rb",
// which throws away the run threat the defense most needs to see. So: personnel, the receiver
// split, and how many backs are actually in the backfield.

// A back is in the backfield rather than split out. This is the run-threat term: an offense with
// its back beside the quarterback and one with the same back flexed wide are different problems.
export const BACKFIELD_DEPTH = 3

// `entries` are { kind: 'wr' | 'te' | 'rb', dx: yards from the ball, depth: yards BEHIND the los }.
export function lookIdFrom(entries) {
  const c = { wr: 0, te: 0, rb: 0 }
  let left = 0, right = 0, backs = 0
  for (const e of entries ?? []) {
    if (c[e.kind] != null) c[e.kind]++
    if ((e.depth ?? 0) >= BACKFIELD_DEPTH) { backs++; continue }
    if ((e.dx ?? 0) < 0) left++
    else right++
  }
  // Strong side first, so a trips look is the same key whichever way it is flipped. The defense
  // aligns to strength; it does not care which hash the strength is on.
  const strong = Math.max(left, right)
  const weak = Math.min(left, right)
  return `${c.wr}${c.te}${c.rb}|${strong}x${weak}|${backs}b`
}

const kindOf = (s) => String(s ?? '').replace(/[0-9]/g, '').toLowerCase()

// From an authored formation's spots, whose dx and depth are already relative to ball and los.
export function lookFromSpots(spots) {
  return lookIdFrom((spots ?? []).map(s => ({
    kind: kindOf(s.slot ?? s.label),
    dx: s.dx ?? 0,
    depth: s.depth ?? 0,
  })))
}

// From bodies on the field. ⚠️ `depth` IS los MINUS y: the offensive backfield sits at a SMALLER y
// than the line of scrimmage, so subtracting the other way puts every back at a negative depth and
// the backfield count is silently always zero.
export function lookFromReceivers(receivers, { ballX = 0, losY = 0 } = {}) {
  return lookIdFrom((receivers ?? []).map(r => ({
    kind: kindOf(r.label ?? r.position),
    dx: (r.x ?? 0) - ballX,
    depth: losY - (r.y ?? 0),
  })))
}
