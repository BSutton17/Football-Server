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

const enabled = () =>
  process.env.NODE_ENV !== 'production' && process.env.ENABLE_DEV_REVEAL === '1'

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
