// ── Lining an authored defense up against what it sees ([authored]) ─────────
//
// An authored formation says where the eleven START. A real defense does not stand there: the
// corner walks out to whoever is split wide, the zones slide toward the strength, and against a
// blitz somebody presses to make the quick game late. This turns the drawn picture into the one
// the defense actually shows, using only what it is allowed to know.
//
// ⚠️ NOTHING HAPPENS UNTIL THE OFFENSE HAS SET. Every adjustment here reads where the receivers
// are, so making it while they are still being placed means aligning to a formation that does not
// exist yet — and then twitching as the rest arrive. `k.offenseSet` is the engine's own word for
// "the adjust window opens"; this refuses to do anything before it.
//
// ⚠️ THIS IS ALIGNMENT, NOT A NEW CALL. The shell was chosen already and is not revisited. A
// defense that re-decided its coverage every time a receiver moved would be re-deciding on
// information the offense controls, which is how motion becomes a free way to read the defense.
//
// ⚠️ AND IT STILL NEVER SEES THE PLAY CALL. Where receivers stand is public; what they are about
// to run is not. Everything below reads positions and personnel only.

import { slotLabel } from './authored.js'

// How close a pressing defender gets to the line. Deliberately not zero — the offside rule holds
// a defender's centre a full radius back, and pressing from on top of the line is a flag.
const PRESS_DEPTH = 1.5

// A blitz is what makes pressing worth it: with a four-man rush the quarterback has time, and a
// corner pressing with nobody getting home is just a corner with his back turned.
//
// ⚠️ FIVE, COUNTED PLAINLY — and NOT "a non-lineman is rushing", which is the clever-looking
// version and is wrong. In a 3-4 the fourth rusher IS a linebacker; that is what a 3-4 is. Running
// that definition over the real playbook flagged twenty ordinary coverages as blitzes, every one
// of them a three-man front with an edge linebacker making up a perfectly normal four-man rush.
// What makes a blitz a blitz is the number coming, not who they are.
const BLITZ_RUSHERS = 5

// How far a zone may slide toward the offense. A zone that chases the formation completely is not
// a zone any more — it is man coverage with extra steps, and it vacates the area it was meant to
// hold.
const MAX_ZONE_SLIDE = 4

// How far a man defender may travel laterally from where he was drawn. Unbounded, a corner drawn
// at the numbers would sprint across the formation to reach a receiver on the far hash and leave
// the picture unrecognisable.
const MAX_MAN_TRAVEL = 14

// Deeper than this behind the line and a player is in the backfield, not split out.
const BACKFIELD_DEPTH = 2

export function readyToAlign(k) {
  return Boolean(k?.offenseSet)
}

// Is this shell bringing pressure? Five or more coming.
export function isBlitz(shell) {
  const rushers = Object.values(shell?.assignments ?? {}).filter(a => a?.job === 'rush').length
  return rushers >= BLITZ_RUSHERS
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

// Who each man defender has. Uses the shell's authored role when it names one, and otherwise pairs
// by field side and position the way `matchMen` does — a corner takes the widest, a linebacker
// takes what is left inside.
function pairMan(manSlots, receivers, ballX) {
  const pairs = new Map()
  const free = [...receivers].sort((a, b) => a.x - b.x)
  // Corners first, from the outside in; then everybody else, inside out.
  const corners = manSlots.filter(s => slotLabel(s.slot) === 'CB')
  const rest = manSlots.filter(s => slotLabel(s.slot) !== 'CB')

  for (const d of [...corners].sort((a, b) => a.dx - b.dx)) {
    if (!free.length) break
    // ⚠️ `dx` is an OFFSET from the ball, so the side test is against ZERO, not against ballX.
    // Comparing it to the absolute hash made every offset look negative, so every corner took the
    // leftmost receiver — which put a corner on the running back while linebackers ran with the
    // outside receivers. Exactly the matchup `matchMen` exists to prevent.
    const idx = d.dx < 0 ? 0 : free.length - 1
    pairs.set(d.slot, free.splice(idx, 1)[0])
  }
  for (const d of rest.sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))) {
    if (!free.length) break
    // Inside defenders take the nearest remaining receiver.
    let best = 0
    for (let i = 1; i < free.length; i++) {
      if (Math.abs(free[i].x - (ballX + d.dx)) < Math.abs(free[best].x - (ballX + d.dx))) best = i
    }
    pairs.set(d.slot, free.splice(best, 1)[0])
  }
  return pairs
}

// ── The adjustment ──────────────────────────────────────────────────────────
//
// Returns one row per defender: where he actually lines up, and — for a zone — where his zone
// ended up. Callers that are not ready yet get the authored picture back untouched, which is the
// correct thing to show while the offense is still walking out.
export function alignAuthored({ formation, shell, receivers, ballX, losY, ready = true }) {
  const spots = formation?.spots ?? []
  const assignments = shell?.assignments ?? {}

  const base = spots.map(s => ({
    slot: s.slot,
    label: slotLabel(s.slot),
    job: assignments[s.slot]?.job ?? 'rush',
    dx: s.dx,
    depth: s.depth,
    x: ballX + s.dx,
    y: losY + s.depth,
    zone: assignments[s.slot]?.zone ?? null,
    zoneCenter: assignments[s.slot]?.center ?? null,
    pressing: false,
    covers: null,
  }))

  // ⚠️ Not ready is not a failure — it is the normal state while the offense is still setting.
  if (!ready || !receivers?.length) return base

  const blitzing = isBlitz(shell)
  const manSlots = base.filter(d => d.job === 'man')
  const pairs = pairMan(manSlots, receivers, ballX)

  return base.map(d => {
    if (d.job === 'man') {
      const target = pairs.get(d.slot)
      if (!target) return d
      // Travel to him, but not so far that the drawn formation stops being recognisable.
      const x = clamp(target.x, d.x - MAX_MAN_TRAVEL, d.x + MAX_MAN_TRAVEL)

      // ⚠️ FORWARD ONLY. The authored depth is a CEILING, not a suggestion: a defender may creep up
      // to press, and may never drop off deeper than he was drawn. Letting him back up would let
      // alignment quietly rewrite the coverage — a corner drawn at 5 bailing to 12 is playing a
      // different call than the one that was chosen.
      const wantsPress = blitzing
      const depth = wantsPress ? Math.min(d.depth, PRESS_DEPTH) : d.depth
      return { ...d, x, y: losY + depth, depth, pressing: depth < d.depth, covers: target.id }
    }

    if (d.job === 'zone') {
      // Slide toward the receivers on his side, so the zone sits over the route distribution
      // rather than over grass — but only a little, or it stops being a zone.
      // ⚠️ ONLY THE ONES SPLIT OUT. A back standing beside the quarterback is on somebody's side of
      // the ball but is not part of the receiver distribution a zone should sit over — counting him
      // dragged a flat-zone corner four yards inside, away from the receiver he was there for.
      const side = receivers.filter(r =>
        r.y >= losY - BACKFIELD_DEPTH && (d.dx < 0 ? r.x < ballX : r.x >= ballX))
      if (!side.length) return d
      const meanX = side.reduce((a, r) => a + r.x, 0) / side.length
      const slide = clamp(meanX - d.x, -MAX_ZONE_SLIDE, MAX_ZONE_SLIDE)
      const zoneCenter = d.zoneCenter
        ? { dx: d.zoneCenter.dx + slide, depth: d.zoneCenter.depth }
        : null
      // A zone defender never creeps forward the way a man defender does; his depth is the shell.
      return { ...d, x: d.x + slide, zoneCenter }
    }

    return d
  })
}
