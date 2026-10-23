// ── PLAYS panel cooldowns ([play cooldown]) ─────────────────────────────────────
//
// "Once a play is recommended, it cannot be recommended again for 5 plays. If a play is selected it
// cannot be recommended again for 7 plays. This is only plays not shells and carries through change
// of possession."
//
// Counted in SNAPS — every play run by either team (`state.snapCount`, bumped at the snap) — so a
// play recommended on your last snap of a drive is still cooling when you get the ball back, as
// asked. Kept per seat: one player's menu never touches the other's.

export const RECOMMENDED_COOLDOWN = 5
export const SELECTED_COOLDOWN = 7

function table(state, slot) {
  if (!state.playCooldown) state.playCooldown = [{}, {}]
  return (state.playCooldown[slot] ??= {})
}

function rest(state, slot, playId, plays) {
  const t = table(state, slot)
  const until = (state.snapCount ?? 0) + plays
  t[playId] = Math.max(t[playId] ?? 0, until)   // a longer cooldown is never shortened by a shorter one
}

// Plays this seat may not be shown right now.
//
// ⚠️ INCLUSIVE. Recommended before snap N (snapCount N−1), a play sits out the next five plays —
// the pre-snaps where snapCount is N … N+4 — and is back when snapCount reaches N+5. `until` is the
// last snapCount it sits out, so the test is `>=`; `>` let it back one play early.
export function coolingPlays(state, slot) {
  const now = state.snapCount ?? 0
  const out = new Set()
  for (const [id, until] of Object.entries(table(state, slot))) if (until >= now) out.add(id)
  return out
}

export function noteRecommended(state, slot, playIds) {
  for (const id of playIds) rest(state, slot, id, RECOMMENDED_COOLDOWN)
}

export function noteSelected(state, slot, playId) {
  rest(state, slot, playId, SELECTED_COOLDOWN)
}
