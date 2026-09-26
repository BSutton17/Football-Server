// ── Where the down linemen line up ([alignment]) ──────────────────────────────
//
// Spacing is listed per count rather than computed, because the alignments genuinely differ: three
// is a nose with two ends, four is the base front.
//
// ⚠️ THE FRONT IS NOT PLACED WHERE THE SHELL DREW IT. The authored formations carry DL spots —
// NICKEL 3-3 MINT draws its four at -2.6/-0.2/2.2/4.8 — but nobody ever stands there: the linemen
// are auto-placed from the table below, on both the server (autoDefense) and the client
// (getDLPlayers). The drawn spots exist so a formation can be SEEN whole in the sandbox.
//
// That mattered: alignment was spacing the walked-down linebackers against the DRAWN linemen while
// the real ones stood somewhere else, so a gap that looked clear was an overlap on the field. 26 of
// 94 shells put two defenders within a body's width of each other, some of them 0.1 yards apart.
// Reported as "there is a LB that is down and actually overlapping a DL, that should never happen".
//
// ⚠️ MUST MATCH `DL_SPACING` in Client/src/game/formation.ts, or the two screens draw a different
// defense. It lived in two places already; a third copy inside the aligner is how they drift.
export const DL_SPACING = {
  3: [-3.0, 0, 3.0],
  4: [-3.25, -1.25, 1.25, 3.25],
}

// How far off the ball the auto-placed front stands. A single value, not the per-lineman depths the
// formations draw — `autoDefense` puts every lineman on the same line and so does the client.
export const FRONT_DEPTH = 1

// The absolute x of each lineman for a front of `count`, lined up on the ball.
export function frontXs(count, ballX) {
  return (DL_SPACING[count] ?? DL_SPACING[4]).map(dx => ballX + dx)
}
