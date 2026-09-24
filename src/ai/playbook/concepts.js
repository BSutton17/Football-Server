// ── Route concepts ([offline]) ───────────────────────────────────────────────
//
// A passing play is not five independent routes. It is a CONCEPT: a small set of routes that work
// together to put one defender in a position where he cannot be right. That is why the AI picks
// from named concepts rather than choosing five routes at random — random routes produce a picture
// that looks like football and defends like nothing.
//
// Concepts are written against ALIGNMENT ROLES, not player ids, so the same concept works from any
// formation and with any personnel:
//
//   X   — the widest receiver on the LEFT
//   SL  — the inside (slot) receiver on the left
//   Z   — the widest receiver on the RIGHT
//   SR  — the inside (slot) receiver on the right
//   Y   — the tight end
//   RB  — the back
//
// `resolveRoles` below does the mapping. A role with nobody in it is simply skipped, so a concept
// written for five receivers still runs — smaller — out of a two-receiver set.
//
// Every route name here must exist in ROUTE_DEF (server) and ROUTE_WAYPOINTS (client). Route art
// and the simulated path come from those two tables, and they must agree.

export const ROLES = ['X', 'SL', 'Y', 'SR', 'Z', 'RB']

export const CONCEPTS = {
  // ── Mesh — two shallow crossers rub past each other underneath ────────────
  // The crossing pair is the whole point: man coverage has to fight through traffic, and zone has
  // to pass them off while they are moving in opposite directions.
  mesh: {
    name: 'Mesh',
    blurb: 'Two shallow crossers rub underneath, a sit-down behind them, one man clearing it out.',
    beats: 'man',
    depth: 'short',
    routes: { X: 'drag', Z: 'drag', SL: 'curl', SR: 'corner', Y: 'flat', RB: 'check_down' },
  },

  // ── Flood — three to one side at three different depths ───────────────────
  // Stresses a zone vertically: one defender cannot cover the deep and the flat on the same side.
  flood: {
    name: 'Flood',
    blurb: 'Three routes to one side at three depths — the flat defender cannot have all of them.',
    beats: 'zone',
    depth: 'medium',
    strongSide: true,
    routes: { Z: 'corner', SR: 'out', Y: 'flat', X: 'comeback', SL: 'drag', RB: 'swing' },
  },

  // ── Bench — two routes breaking to the same sideline, high and low ────────
  bench: {
    name: 'Bench',
    blurb: 'Comeback outside, out underneath it — both to the sideline, where the help is not.',
    beats: 'zone',
    depth: 'medium',
    routes: { X: 'comeback', SL: 'out', Z: 'comeback', SR: 'out', Y: 'curl', RB: 'flare' },
  },

  // ── Smash — hitch under, corner over the top of it ────────────────────────
  // The classic high-low on the cornerback: he can sit on the short route or carry the corner, and
  // whichever he does is wrong.
  smash: {
    name: 'Smash',
    blurb: 'Curl underneath, corner over the top — the cornerback has to choose one.',
    beats: 'zone',
    depth: 'medium',
    routes: { X: 'curl', SL: 'corner', Z: 'curl', SR: 'corner', Y: 'seam', RB: 'check_down' },
  },

  // ── Four verticals — everybody deep ───────────────────────────────────────
  four_verts: {
    name: 'Four Verts',
    blurb: 'Everyone runs deep. Against two-deep safeties there are more verticals than defenders.',
    beats: 'zone',
    depth: 'deep',
    routes: { X: 'go', SL: 'seam', Y: 'seam', SR: 'seam', Z: 'go', RB: 'check_down' },
  },

  // ── Drag / shallow cross — one crosser with a dig behind him ──────────────
  drag: {
    name: 'Drag',
    blurb: 'A shallow crosser with a dig behind it — the quick answer to pressure.',
    beats: 'man',
    depth: 'short',
    routes: { X: 'drag', SL: 'dig', Z: 'go', SR: 'curl', Y: 'flat', RB: 'swing' },
  },

  // ── Stick — quick, decisive, and everywhere on third and short ────────────
  stick: {
    name: 'Stick',
    blurb: 'Tight end sits at the sticks, back to the flat outside him, receivers clear it out.',
    beats: 'zone',
    depth: 'short',
    routes: { Y: 'curl', RB: 'flat', X: 'go', Z: 'go', SL: 'slant', SR: 'slant' },
  },

  // ── Slants — the answer to pressure. Ball is out before it arrives ────────
  slants: {
    name: 'Slants',
    blurb: 'Everybody breaks inside, fast. The ball is gone before a blitz can get home.',
    beats: 'blitz',
    depth: 'short',
    routes: { X: 'slant', SL: 'slant', Z: 'slant', SR: 'slant', Y: 'drag', RB: 'check_down' },
  },

  // ── Levels — two in-breaking routes stacked at different depths ───────────
  levels: {
    name: 'Levels',
    blurb: 'Two in-breakers at different depths; the linebacker who takes one opens the other.',
    beats: 'zone',
    depth: 'medium',
    routes: { X: 'dig', SL: 'drag', Z: 'comeback', SR: 'slant', Y: 'curl', RB: 'flare' },
  },

  // ── Screen — hold and catch it behind the rush ────────────────────────────
  // Uses the stand-still screen route, which is throwable from the snap. Everyone else blocks or
  // clears out, because a screen is a blocking play that happens to start with a pass.
  screen: {
    name: 'Screen',
    blurb: 'Hold up, catch it behind the rush, and let the blockers get out in front.',
    beats: 'blitz',
    depth: 'behind',
    routes: { X: 'screen', SL: 'block', Z: 'go', SR: 'block', Y: 'block', RB: 'block' },
  },

  // ── Post-wheel — the shot play ────────────────────────────────────────────
  shot: {
    name: 'Shot',
    blurb: 'Post inside, wheel up the sideline behind it. Takes time, takes the top off.',
    beats: 'man',
    depth: 'deep',
    routes: { X: 'post', SL: 'wheel', Z: 'go', SR: 'post', Y: 'seam', RB: 'wheel' },
  },

  // ── Dump — maximum protection, two outlets. For when you just need the ball out ──
  max_protect: {
    name: 'Max Protect',
    blurb: 'Keep everyone in, two routes out. Nothing gets home; nothing gets open quickly either.',
    beats: 'blitz',
    depth: 'medium',
    routes: { X: 'comeback', Z: 'dig', Y: 'block', RB: 'block', SL: 'curl', SR: 'block' },
  },
}

export const CONCEPT_IDS = Object.keys(CONCEPTS)

// ── Mapping real receivers onto the roles ─────────────────────────────────────
//
// Reads the formation the way a coach would: widest in on each side, tight end by label, back by
// label. The `strongSide` flip matters for concepts that are one-sided (flood): the concept is
// written as though the strength is right, and mirrored when it is not.
export function resolveRoles(receivers, ballX, { strongSide = 1 } = {}) {
  const roles = new Map()   // playerId -> role

  const backs = receivers.filter(p => p.label === 'RB')
  const tes = receivers.filter(p => p.label === 'TE')
  const wrs = receivers.filter(p => p.label === 'WR')

  // Backs and tight ends take their own roles first — they are defined by what they are, not by
  // where they happen to be standing.
  if (backs[0]) roles.set(backs[0].id, 'RB')
  if (tes[0]) roles.set(tes[0].id, 'Y')

  // Anyone left over (a second back, a second tight end) is treated as a slot receiver, because
  // that is how they are actually used once they are not blocking.
  const extras = [...backs.slice(1), ...tes.slice(1)]

  const left = [...wrs, ...extras].filter(p => p.x < ballX).sort((a, b) => a.x - b.x)
  const right = [...wrs, ...extras].filter(p => p.x >= ballX).sort((a, b) => b.x - a.x)

  if (left[0]) roles.set(left[0].id, 'X')
  if (left[1]) roles.set(left[1].id, 'SL')
  if (right[0]) roles.set(right[0].id, 'Z')
  if (right[1]) roles.set(right[1].id, 'SR')

  // Anybody still unnamed gets the nearest free slot role so they are never left routeless — a
  // receiver with no route is a receiver standing still in the middle of a passing play.
  for (const p of receivers) {
    if (roles.has(p.id)) continue
    roles.set(p.id, p.x < ballX ? 'SL' : 'SR')
  }

  // Mirror a one-sided concept when the strength is left.
  if (strongSide === -1) {
    const mirror = { X: 'Z', Z: 'X', SL: 'SR', SR: 'SL' }
    for (const [id, role] of roles) if (mirror[role]) roles.set(id, mirror[role])
  }

  return roles
}

// Turns a concept into a route for every receiver. Anyone the concept has nothing to say about
// gets a safe check-down rather than nothing at all.
export function assignRoutes(conceptId, receivers, ballX, { strongSide = 1 } = {}) {
  const concept = CONCEPTS[conceptId]
  if (!concept) return new Map()

  const roles = resolveRoles(receivers, ballX, { strongSide: concept.strongSide ? strongSide : 1 })
  const out = new Map()
  for (const p of receivers) {
    const role = roles.get(p.id)
    out.set(p.id, concept.routes[role] ?? fallbackRoute(p.label))
  }
  return out
}

function fallbackRoute(label) {
  if (label === 'RB') return 'check_down'
  if (label === 'TE') return 'curl'
  return 'curl'
}
