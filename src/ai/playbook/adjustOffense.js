// ── What the offense does with a play once it sees the field ([authored]) ───
//
// The play was chosen already. This is everything that happens between choosing it and snapping
// it: which way round to line it up, and whether to keep somebody in to block.
//
// ⚠️ NEITHER DECISION CHANGES THE PLAY. A flipped Mesh is still Mesh, and a back kept in is still
// the same call with one fewer receiver. If either could turn one play into another, the play the
// solver chose and the play that actually runs would be different things, and every number the
// solver produced would be about a play that never happened.

import { slotLabel } from './authored.js'

const FIELD_WIDTH = 53.33

// How close to the sideline a player may be drawn before he is out of room to work. A receiver on
// the numbers still needs a release and a stem; one standing on the paint has neither.
const SIDELINE_MARGIN = 4

// ── Flipping ────────────────────────────────────────────────────────────────
//
// ⚠️ THE BALL IS NOT ALWAYS IN THE MIDDLE. Formations are authored as offsets from the hash, so a
// set drawn with everybody to the left is fine from the right hash and crushed against the paint
// from the left one. Flipping is the answer, and it is free: the formation and every route are
// stored as offsets, so mirroring is a sign change rather than a redraw.

// How badly this formation is squeezed against a sideline, in yards of overhang. Zero means
// everybody has room.
export function crowding(formation, ballX, { mirror = false } = {}) {
  let worst = 0
  for (const s of formation?.spots ?? []) {
    const x = ballX + (mirror ? -s.dx : s.dx)
    worst = Math.max(worst, SIDELINE_MARGIN - x, x - (FIELD_WIDTH - SIDELINE_MARGIN))
  }
  return Math.max(0, worst)
}

// ⚠️ ONLY WHEN IT STRICTLY HELPS. Flipping a symmetric formation achieves nothing and makes the
// picture jump around for no reason; flipping one that is already fine can only make it worse.
// The test is whether mirroring actually relieves the squeeze.
export function shouldFlip(formation, ballX) {
  return crowding(formation, ballX, { mirror: true }) < crowding(formation, ballX) - 1e-9
}

// ── Keeping somebody in ─────────────────────────────────────────────────────
//
// ⚠️ THE MATH IS BLOCKERS AGAINST RUSHERS, not a feeling about pressure. Five linemen block five
// rushers; a sixth rusher has nobody, and that is a free run at the quarterback no matter how good
// the protection is. Keeping a back in makes it five on six rather than five on five plus a free
// runner — and costs a receiver, which is why it is not done by default.
const LINEMEN = 5

// Who to keep in, in order of who is least missed. A back is the conventional answer: he is the
// shortest route in most concepts, and a tight end is more often part of the picture.
const KEEP_IN_ORDER = ['RB', 'TE']

export function blockersFor(play) {
  let n = LINEMEN
  for (const a of Object.values(play?.assignments ?? {})) if (a?.kind === 'block') n++
  return n
}

// Returns the slot to keep in, or null to run the play as drawn.
export function keepInToBlock(play, formation, { rushers = 4 } = {}) {
  if (!play || play.playType !== 'pass') return null
  if (rushers <= blockersFor(play)) return null

  const running = new Set(
    Object.entries(play.assignments ?? {})
      .filter(([, a]) => a?.kind === 'route')
      .map(([slot]) => slot))

  for (const want of KEEP_IN_ORDER) {
    // Prefer somebody already running a route — converting a blocker to a blocker helps nobody.
    const slot = (formation?.spots ?? [])
      .map(s => s.slot)
      .find(s => slotLabel(s) === want && running.has(s))
    if (slot) return slot
  }
  return null
}

// ⚠️ NEVER TO ZERO RECEIVERS. A protection that keeps everybody in has nobody to throw to, which
// is a sack with extra steps. The last route is not available to be blocked.
export function applyKeepIn(play, slot) {
  if (!slot) return play
  const routes = Object.entries(play.assignments ?? {}).filter(([, a]) => a?.kind === 'route')
  if (routes.length <= 1) return play
  return {
    ...play,
    assignments: { ...play.assignments, [slot]: { kind: 'block' } },
  }
}

// ── The whole pre-snap adjustment ───────────────────────────────────────────
//
// Returns the play as it will actually be run, plus whether it is mirrored. The caller hands the
// mirror flag to `layoutAuthored` and `routeFor`, which already know how to apply it.
export function adjustOffense(play, formation, { ballX, rushers = 4 } = {}) {
  const mirror = shouldFlip(formation, ballX)
  const keepIn = keepInToBlock(play, formation, { rushers })
  return { play: applyKeepIn(play, keepIn), mirror, keptIn: keepIn }
}
