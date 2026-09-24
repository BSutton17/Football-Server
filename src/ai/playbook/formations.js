// ── Offensive formations ([offline]) ─────────────────────────────────────────
//
// A formation is personnel plus spots. Both matter and they matter differently:
//
//   PERSONNEL tells the defense what to expect and dictates what it substitutes. Two tight ends
//   brings linebackers onto the field; four wide takes them off. That decision is made BEFORE the
//   defense sees where anyone is standing, which is exactly why it is worth making deliberately.
//
//   SPOTS decide whether the routes in a concept have room to work. Four verticals out of a bunch
//   is four receivers running into each other.
//
// Spots are offsets: `dx` yards from the ball's hash (negative is left), `depth` yards BEHIND the
// line of scrimmage (0 = on the line). They are clamped to the legal placement box before use —
// see `legalSpot`, which mirrors the client's getPositionYBounds. Keeping them as offsets means a
// formation is field-position independent and mirrors correctly from either hash.
//
// The offense picks 5 skill players from a pool of 4 WR, 3 TE, 2 RB (the 5 linemen and the
// quarterback are placed automatically), so every formation here uses exactly five.
//
// ⚠️ THE QUARTERBACK STANDS AT (ballX, losY − 6) and is not in this table. A back written at
// `dx: 0, depth: 6` therefore lands exactly on top of him, and one at depth 7 is a yard away —
// close enough that the two render as a stack and collide at the snap. Backs are offset either
// laterally (beside the quarterback, as in shotgun) or to depth 8+ (behind him, as in an
// I-formation). The first version of this table had three formations stacking the two.

export const FORMATIONS = {
  // ── Three receivers, a tight end, a back. The modern default. ─────────────
  trips: {
    name: 'Trips',
    personnel: { WR: 3, TE: 1, RB: 1 },
    blurb: 'Three to one side. Overloads a zone and forces the defense to declare its strength.',
    spots: [
      { label: 'WR', dx: -18, depth: 0 },
      { label: 'WR', dx: 12, depth: 0 },
      { label: 'WR', dx: 17, depth: 1 },
      { label: 'TE', dx: 6, depth: 0 },
      { label: 'RB', dx: -2, depth: 7 },
    ],
  },

  // ── Two by two. Balanced, hard to diagnose. ───────────────────────────────
  doubles: {
    name: 'Doubles',
    personnel: { WR: 4, TE: 0, RB: 1 },
    blurb: 'Two receivers each side. Balanced, so the defense cannot set its strength pre-snap.',
    spots: [
      { label: 'WR', dx: -18, depth: 0 },
      { label: 'WR', dx: -9, depth: 1 },
      { label: 'WR', dx: 9, depth: 1 },
      { label: 'WR', dx: 18, depth: 0 },
      { label: 'RB', dx: -2.5, depth: 7 },   // beside the quarterback, not on him
    ],
  },

  // ── Spread the field completely. Nobody left to block. ────────────────────
  empty: {
    name: 'Empty',
    personnel: { WR: 4, TE: 1, RB: 0 },
    blurb: 'Five out, nobody in the backfield. Maximum width — and no help in protection.',
    spots: [
      { label: 'WR', dx: -19, depth: 0 },
      { label: 'WR', dx: -10, depth: 1 },
      { label: 'TE', dx: 6, depth: 0 },
      { label: 'WR', dx: 12, depth: 1 },
      { label: 'WR', dx: 19, depth: 0 },
    ],
  },

  // ── Two tight ends. The run look, and the play-action look. ───────────────
  heavy: {
    name: 'Heavy',
    personnel: { WR: 1, TE: 2, RB: 2 },
    blurb: 'Two tight ends, two backs. Everything tight — a run formation the defense must respect.',
    spots: [
      { label: 'WR', dx: -17, depth: 0 },
      { label: 'TE', dx: -6, depth: 0 },
      { label: 'TE', dx: 6, depth: 0 },
      { label: 'RB', dx: -3, depth: 6 },    // offset, level with the quarterback
      { label: 'RB', dx: 0, depth: 9 },     // directly behind him, deep enough to be clear
    ],
  },

  // ── One back, one tight end, two receivers. The balanced base. ────────────
  base: {
    name: 'Base',
    personnel: { WR: 2, TE: 2, RB: 1 },
    blurb: 'Two tight ends on the line with receivers outside. Runs and passes look identical.',
    spots: [
      { label: 'WR', dx: -18, depth: 0 },
      { label: 'TE', dx: -6, depth: 0 },
      { label: 'TE', dx: 6, depth: 0 },
      { label: 'WR', dx: 18, depth: 0 },
      { label: 'RB', dx: 2.5, depth: 7 },    // beside the quarterback, not on him
    ],
  },

  // ── Bunch. Three tight together — traffic, rubs, and a nightmare for man. ─
  bunch: {
    name: 'Bunch',
    personnel: { WR: 3, TE: 1, RB: 1 },
    blurb: 'Three stacked tight to one side. Man coverage has to fight through its own traffic.',
    spots: [
      { label: 'WR', dx: -18, depth: 0 },
      { label: 'WR', dx: 8, depth: 1 },
      { label: 'WR', dx: 11, depth: 2 },
      { label: 'TE', dx: 11, depth: 0 },
      { label: 'RB', dx: -2, depth: 7 },
    ],
  },

  // ── Goal line. Everything compressed; there is no field to spread into. ───
  goal_line: {
    name: 'Goal Line',
    personnel: { WR: 1, TE: 3, RB: 1 },
    blurb: 'Three tight ends. Inside the five there is no room to throw, so take the extra blocker.',
    spots: [
      { label: 'TE', dx: -6, depth: 0 },
      { label: 'TE', dx: 6, depth: 0 },
      { label: 'TE', dx: 9, depth: 1 },
      { label: 'WR', dx: -16, depth: 0 },
      { label: 'RB', dx: 0, depth: 9 },     // deep back — dx 0 / depth 6 IS the quarterback's spot
    ],
  },
}

export const FORMATION_IDS = Object.keys(FORMATIONS)

// Mirrors the client's getPositionYBounds so the AI can only ever build a legal formation. Getting
// this wrong does not throw — it produces a formation the game quietly refuses, which is far
// harder to notice than a crash.
export function legalSpot(label, x, y, losY) {
  const EZ_BACK_OWN = -9.5
  let minY, maxY
  switch (label) {
    case 'WR': minY = Math.max(EZ_BACK_OWN, losY - 7); maxY = losY; break
    case 'TE': minY = Math.max(EZ_BACK_OWN, losY - 5); maxY = losY; break
    case 'RB': minY = Math.max(EZ_BACK_OWN, losY - 10); maxY = losY - 2; break
    default: minY = Math.max(EZ_BACK_OWN, losY - 15); maxY = losY; break
  }
  return {
    x: Math.max(1.5, Math.min(51.8, x)),
    y: Math.max(minY, Math.min(maxY, y)),
  }
}

// Turns a formation into real spots on the field. `mirror` flips it left-to-right, which is how
// one formation covers both strengths without writing it twice.
export function layout(formationId, { losY, ballX, mirror = false }) {
  const f = FORMATIONS[formationId]
  if (!f) return []
  return f.spots.map((s, i) => {
    const dx = mirror ? -s.dx : s.dx
    const { x, y } = legalSpot(s.label, ballX + dx, losY - s.depth, losY)
    return { label: s.label, x, y, index: i }
  })
}

// Personnel a formation needs, as the three counts the roster is picked against.
export function personnelFor(formationId) {
  return FORMATIONS[formationId]?.personnel ?? { WR: 3, TE: 1, RB: 1 }
}
