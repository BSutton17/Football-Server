// ── Showing both play calls, for looking at alignment ([dev reveal]) ────────
//
// A tool for one job: the author wants to screenshot what the computer actually lined up in, next to
// what it should have been, and send both back. That is impossible while the opponent's call is
// hidden, which it is — correctly — every other second of this game's life.
//
// ⚠️ THREE GATES, AND ALL OF THEM MATTER. "The defense never sees the play call" is the oldest rule
// in this codebase and the one most worth protecting, so this cannot be one flag away from leaking:
//
//   1. NOT IN PRODUCTION. `NODE_ENV === 'production'` refuses outright.
//   2. OPT IN. `ENABLE_DEV_REVEAL=1` must be set; absent, nothing is ever attached.
//   3. SOLO ONLY. In a two-human room this would hand one player the other's call, so a room with
//      two people in it never reveals regardless of the first two.
//
// The payload is also the AI's side only. Revealing the human's own call back to them would be
// harmless but pointless, and keeping the direction one-way means there is no version of this that
// helps anybody compete.

import { getRoom } from './roomManager.js'
import { isAiSocketId } from '../ai/virtualSocket.js'
import { devFlag } from './devFlags.js'

// Gates 1 and 2 (not production, and opted in) both live in devFlag — see devFlags.js. Gate 3, solo
// only, is specific to this feature and is checked at each call site below.
const enabled = () => devFlag('ENABLE_DEV_REVEAL')

// What the computer is doing this play, as data a screenshot can be taken of. Null whenever any gate
// says no, which is the normal case.
export function serializeDevReveal(state, viewerSlot) {
  if (!enabled()) return null
  if (!state?.solo) return null                    // solo rooms only
  if (viewerSlot == null) return null

  const aiSlot = 1 - viewerSlot
  const aiHasBall = state.possession === aiSlot

  return {
    aiRole: aiHasBall ? 'offense' : 'defense',
    // The computer's own call. On offense that is the play it set; on defense the shell it aligned
    // to, with every assignment, which is the thing being inspected.
    play: aiHasBall ? revealOffense(state) : null,
    shell: aiHasBall ? null : revealDefense(state),
  }
}

// ── Pushing it at the right moment ([dev reveal]) ───────────────────────────
//
// ⚠️ THE SNAPSHOT ON `game_state` IS TOO EARLY TO BE USEFUL, AND THAT NEARLY WASTED AN EVENING OF
// SCREENSHOTS. `game_state` is broadcast when the play BEGINS. The computer's defense cannot line up
// until it has seen the offense, so at that instant `defensePlayers` and `defenseCoverage` are empty
// or still hold the last play's picture — the overlay drew either nothing or a lie, and a lie is
// worse, because the whole point of the tool is to photograph where the AI actually stood.
//
// So the reveal is also PUSHED, on the same events the alignment itself fires (place_player and
// assign_coverage from the computer's seat). The human's overlay therefore tracks the computer live:
// drag a receiver, watch the defense answer it. Chatty by design — seven small payloads per
// re-align, pre-snap only, dev only, solo only — because "always current" is the property that
// makes a screenshot worth acting on.
export function pushDevReveal(io, state, roomId) {
  if (!enabled()) return
  if (!state?.solo) return
  const room = getRoom(roomId)
  if (!room) return
  for (const [slot, socketId] of room.players.entries()) {
    // ⚠️ HUMAN SEATS, IDENTIFIED AS SUCH. The first version of this skipped "the seat that just
    // acted" instead, which is backwards: the human is the one placing receivers, so it skipped the
    // human and mailed the computer a description of its own opponent. A test caught it; the rule
    // that is actually meant is "not a computer", so that is the rule it asks.
    if (!socketId || isAiSocketId(socketId)) continue
    const reveal = serializeDevReveal(state, slot)
    if (reveal) io.to(socketId).emit('dev_reveal', reveal)
  }
}

function revealOffense(state) {
  const design = state.playDesign
  if (!design) return null
  return {
    playType: design.playType ?? null,
    runAngle: design.runAngle ?? null,
    name: state.aiCallName ?? null,
    // Position and route per man, so the drawing can be compared with what it should have been.
    players: (design.players ?? []).map(p => ({
      id: p.id,
      label: p.label ?? null,
      x: p.x,
      y: p.y,
      route: p.drawnRoute ?? null,
      blocking: p.route === 'block',
    })),
  }
}

function revealDefense(state) {
  const out = []
  for (const p of state.defensePlayers?.values() ?? []) {
    const cov = state.defenseCoverage?.get(p.id) ?? null
    out.push({
      id: p.id,
      label: p.label ?? null,
      x: p.x,
      y: p.y,
      job: cov?.type ?? 'rush',
      covers: cov?.targetId ?? null,
      zone: cov?.zoneType ?? null,
      zoneCenterX: cov?.zoneCenterX ?? null,
      zoneCenterY: cov?.zoneCenterY ?? null,
      shade: cov?.manCommit ?? null,
    })
  }
  return { name: state.aiCallName ?? null, players: out }
}
