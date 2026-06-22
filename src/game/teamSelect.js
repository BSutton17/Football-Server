// ── Pregame team selection ([268][269]) ────────────────────────────────────────
//
// After both players join a room they enter team selection BEFORE the game state/loop exist.
// This module is the server's authoritative record of each slot's pick and whether it's locked.
// When both slots are locked, the caller starts the actual game (initGame + startGameLoop).
//
//   selection: { picks: [slot0TeamId|null, slot1TeamId|null], locked: [bool, bool] }
//
// A slot may change its provisional pick freely; changing a pick clears that slot's lock, so a
// player can never be "locked" on a team they've since browsed away from.

const selections = new Map()   // Map<roomId, selection>

export function beginTeamSelect(roomId) {
  const selection = { picks: [null, null], locked: [false, false] }
  selections.set(roomId, selection)
  return selection
}

export function getTeamSelect(roomId) {
  return selections.get(roomId) ?? null
}

// Provisional pick — the slot is browsing/considering this team. Clears the slot's lock.
export function setPick(roomId, slot, teamId) {
  const sel = selections.get(roomId)
  if (!sel || slot !== 0 && slot !== 1) return null
  sel.picks[slot]  = teamId
  sel.locked[slot] = false
  return sel
}

// Final pick — the slot has committed to this team.
export function lockPick(roomId, slot, teamId) {
  const sel = selections.get(roomId)
  if (!sel || slot !== 0 && slot !== 1) return null
  sel.picks[slot]  = teamId
  sel.locked[slot] = true
  return sel
}

export function bothLocked(roomId) {
  const sel = selections.get(roomId)
  return !!sel && sel.locked[0] && sel.locked[1]
}

export function clearTeamSelect(roomId) {
  selections.delete(roomId)
}
