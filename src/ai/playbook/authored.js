// ── The authored playbook ([authored]) ──────────────────────────────────────
//
// Formations, plays and shells drawn BY HAND in the dev sandbox, rather than invented by a
// network. The AI's job shrinks from "design football" to "choose which of these to call".
//
// ⚠️ WHY THIS REPLACED A LEARNED ACTION SPACE. Six hundred generations of a deep per-player action
// space produced an offense WORSE than the hand-written heuristic, and a defense that wins series
// while lining up in shapes that do not look like football. Both have one cause: every fitness we
// have used scores OUTCOMES, so nothing ever paid for looking like football, and the search duly
// found shapes that exploit the engine instead. Authoring removes that whole failure class — the
// AI can no longer invent a shape, only pick one a human vouched for.
//
// ⚠️ SLOTS ARE THE STABLE KEY, AND THAT IS THE WHOLE DESIGN. A play's routes are stored against
// `WR1`/`TE1`/`RB1`, never against a player id (which changes with the roster) and never against
// an alignment role like X or Z (which changes when the formation moves). That is what lets a
// formation be EDITED without erasing the plays built on it: move the spot, and the route — stored
// as offsets from wherever that slot starts — moves with it.
//
// Everything here is field-position independent for the same reason the hand-written table is:
// `dx` is yards from the BALL'S HASH and `depth` is yards behind the line of scrimmage, so one
// authored formation is correct from anywhere on the field and from either hash.

import { legalSpot } from './formations.js'

export const PLAYBOOK_VERSION = 1

// The offense fields five skill players; the five linemen and the quarterback are placed
// automatically and are never authored. The pool is the roster's, so a formation cannot ask for a
// fourth tight end that no team carries.
export const SLOT_POOL = { WR: 4, TE: 3, RB: 2 }
export const MAX_SKILL = 5

// The user's two categories. A sub-formation name ("Deuce", "U Off Trips Wk") is free text under
// one of them.
export const CATEGORIES = ['gun', 'pistol']

export const PLAY_TYPES = ['pass', 'run']

// `WR1` -> `WR`. The label is what the roster fills and what legalSpot clamps against.
export function slotLabel(slot) {
  return String(slot).replace(/[0-9]+$/, '')
}

export function slotsFor(pool = SLOT_POOL) {
  const out = []
  for (const [label, n] of Object.entries(pool)) for (let i = 1; i <= n; i++) out.push(`${label}${i}`)
  return out
}

const ALL_SLOTS = new Set(slotsFor())

function err(list, msg) { list.push(msg); return list }

// ── Validation ──────────────────────────────────────────────────────────────
//
// The sandbox shows these; the loader refuses anything that fails. An authored formation is data
// the engine trusts, so it is checked once here rather than defended against everywhere.
export function validateFormation(f) {
  const errors = []
  if (!f || typeof f !== 'object') return { ok: false, errors: ['formation is not an object'] }
  if (!f.name || !String(f.name).trim()) err(errors, 'needs a name')
  if (!CATEGORIES.includes(f.category)) err(errors, `category must be one of ${CATEGORIES.join(', ')}`)
  const spots = Array.isArray(f.spots) ? f.spots : []
  if (spots.length !== MAX_SKILL) err(errors, `needs exactly ${MAX_SKILL} skill players, got ${spots.length}`)

  const seen = new Set()
  const counts = {}
  for (const s of spots) {
    if (!ALL_SLOTS.has(s?.slot)) { err(errors, `unknown slot "${s?.slot}"`); continue }
    if (seen.has(s.slot)) err(errors, `slot ${s.slot} used twice`)
    seen.add(s.slot)
    const label = slotLabel(s.slot)
    counts[label] = (counts[label] ?? 0) + 1
    if (!Number.isFinite(s.dx)) err(errors, `${s.slot} dx must be a number`)
    if (!Number.isFinite(s.depth)) err(errors, `${s.slot} depth must be a number`)
    checkSpot(errors, s, 'offense')
  }
  for (const [label, n] of Object.entries(counts)) {
    if (n > (SLOT_POOL[label] ?? 0)) err(errors, `${n} ${label}s exceeds the roster pool of ${SLOT_POOL[label] ?? 0}`)
  }

  // ⚠️ The quarterback stands at (ballX, losY - 6). A back written at dx 0 / depth 6 lands exactly
  // on top of him and the two collide at the snap — the hand-written table shipped three
  // formations that did this before it was caught.
  for (const s of spots) {
    if (slotLabel(s.slot) === 'RB' && Math.abs(s.dx ?? 0) < 1.5 && Math.abs((s.depth ?? 0) - 6) < 1.5) {
      err(errors, `${s.slot} is stacked on the quarterback (dx ${s.dx}, depth ${s.depth}) — move him wider or deeper`)
    }
  }
  return { ok: errors.length === 0, errors }
}

export function validatePlay(p, formations) {
  const errors = []
  if (!p || typeof p !== 'object') return { ok: false, errors: ['play is not an object'] }
  if (!p.name || !String(p.name).trim()) err(errors, 'needs a name')
  if (!PLAY_TYPES.includes(p.playType)) err(errors, `playType must be one of ${PLAY_TYPES.join(', ')}`)
  const formation = formations?.[p.formationId]
  if (!formation) return { ok: false, errors: [...errors, `unknown formation "${p.formationId}"`] }

  const slots = new Set((formation.spots ?? []).map(s => s.slot))
  for (const slot of Object.keys(p.assignments ?? {})) {
    if (!slots.has(slot)) err(errors, `assignment for ${slot}, which is not in formation "${p.formationId}"`)
  }
  for (const [slot, a] of Object.entries(p.assignments ?? {})) {
    if (!a || typeof a !== 'object') { err(errors, `${slot} assignment is not an object`); continue }
    if (a.kind === 'route') {
      // Stored exactly as the client's beautifier emits and the server's place_player already
      // accepts: offsets from wherever the slot starts, which is what survives a formation edit.
      if (!Array.isArray(a.points) || a.points.length === 0) err(errors, `${slot} route has no points`)
      else for (const pt of a.points) {
        if (!Number.isFinite(pt?.dx) || !Number.isFinite(pt?.dd)) { err(errors, `${slot} route has a bad point`); break }
      }
      if (p.playType === 'run') err(errors, `${slot} has a route on a run play`)
    } else if (a.kind !== 'block' && a.kind !== 'carry') {
      err(errors, `${slot} has unknown assignment kind "${a.kind}"`)
    }
  }
  const carriers = Object.entries(p.assignments ?? {}).filter(([, a]) => a?.kind === 'carry')
  if (p.playType === 'pass' && carriers.length > 0) err(errors, 'a pass play cannot have a carrier')

  // ⚠️ A PASS WITH NOBODY RUNNING A ROUTE IS A SACK, and it is an easy one to save by accident —
  // pick a formation, name the play, forget to draw. It would sit in the playbook looking like a
  // real call and lose every time it came up, and the matrix would dutifully learn never to call
  // it rather than telling anyone it was a mistake.
  if (p.playType === 'pass') {
    const routes = Object.values(p.assignments ?? {}).filter(a => a?.kind === 'route')
    if (routes.length === 0) err(errors, 'a pass play needs at least one route — nobody is running one')
  }

  if (p.playType === 'run') {
    // ⚠️ A RUN STORES NO ANGLE. Authoring one lane per play would mean drawing the same run four
    // times — inside, off-tackle, outside each way — and would freeze a decision that is only
    // answerable once the defense has lined up. `chooseRunAngle` reads the box at the line, which
    // is the same information a real back is reading. So the play says RUN and the lane is found
    // at the snap.
    if (p.runAngle != null) {
      err(errors, 'a run does not store an angle — the lane is chosen at the line from the defensive front')
    }
    if (carriers.length > 1) err(errors, `a run has one carrier, got ${carriers.length}`)

    // ⚠️ SOMEBODY HAS TO BE ABLE TO TAKE THE HANDOFF. An empty set has no back, and a back split
    // out wide is a receiver whatever his label says — a run from either is a call that cannot be
    // run, and it would sit in the playbook looking legitimate.
    const eligible = backfieldBacks(formation)
    const reason = whyNoRun(formation)
    if (reason) {
      err(errors, `this formation cannot run — ${reason}`)
    } else if (carriers.length === 0) {
      // With one back there is nothing to say; with two, "run" is ambiguous and the sandbox has to
      // ask rather than guess which one gets it.
      const backs = (formation.spots ?? []).filter(s => slotLabel(s.slot) === 'RB')
      if (backs.length !== 1) {
        err(errors, `${backs.length} backs in this formation — mark which one carries`)
      }
    } else {
      const [slot] = carriers[0]
      if (!eligible.some(b => b.slot === slot)) {
        err(errors, `${slot} is not in the backfield and cannot take the handoff`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

// ── Putting an authored formation on the grass ──────────────────────────────
//
// The mirror of `layout()` for the hand-written table, and deliberately the same contract so the
// two can coexist while the playbook is migrated.
//
// ⚠️ MIRRORING DEFAULTS TO OFF. The hand-written table flips left/right at random, which is free
// variety when a formation is symmetric shorthand. An AUTHORED play was drawn a specific way —
// "Mesh Right" mirrored is a different play — so flipping is opt-in per play rather than automatic.
export function layoutAuthored(formation, { losY, ballX, mirror = false }) {
  if (!formation?.spots) return []
  return formation.spots.map((s, index) => {
    const dx = mirror ? -s.dx : s.dx
    const label = slotLabel(s.slot)
    const { x, y } = legalSpot(label, ballX + dx, losY - s.depth, losY)
    return { slot: s.slot, label, x, y, index }
  })
}

// Personnel counts, DERIVED rather than stored — a formation that says it wants two tight ends and
// lists one is a contradiction the sandbox should not be able to save.
export function personnelOf(formation) {
  const out = { WR: 0, TE: 0, RB: 0 }
  for (const s of formation?.spots ?? []) {
    const label = slotLabel(s.slot)
    if (label in out) out[label]++
  }
  return out
}

// A play's route for one slot, mirrored with the formation so the art and the simulated path agree.
export function routeFor(play, slot, { mirror = false } = {}) {
  const a = play?.assignments?.[slot]
  if (a?.kind !== 'route') return null
  return mirror ? a.points.map(pt => ({ dx: -pt.dx, dd: pt.dd })) : a.points
}

// -- Authored defensive formations and shells --------------------------------
//
// The defense mirrors the offense: a FORMATION is the alignment, and a SHELL is what those eleven
// players are told to do. How they behave once the ball is snapped:
//
//   MAN  -- the receiver can line up anywhere, so the defender covering him travels with him. The
//           authored spot is only where he STARTS. The engine already does this: "man defenders
//           travel with their receiver, zone defenders hold their landmark."
//   ZONE -- he holds the spot that was authored for him, adjusted for the ball's hash, so the
//           shell keeps the SHAPE it was drawn with.
//
// A DEFENSIVE FORMATION DECLARES ITS PERSONNEL. Three corners is nickel, four is dime. That is
// not a separate setting -- it falls out of which slots were placed, and it is exactly the signal
// the play-call solver conditions on, because personnel is public before the snap.
//
// THE FRONT IS FOUR, IN TWO PLACES. `autoDefense` in ai/controller.js and the `defenseAutoPlaced`
// table in Client/src/game/formation.ts both hard-code the same four linemen, and the comment
// there says they must match. Authored DL spots have to feed BOTH or the two sides draw
// different fronts.
//
// ⚠️ THE FRONT IS CHOSEN, THEN ALL ELEVEN ARE PLACED. A defensive formation picks a FRONT from the
// list below — the offensive mirror of Gun/Pistol — and the front decides how many linemen it
// fields. Those linemen are then PART OF THE FORMATION and can be slid along the line like any
// other defender, because shifting the front is a real defensive adjustment.
//
// (The five offensive linemen and the quarterback stay auto-placed: their spots are dictated by
// the snap, not by the call.)
//
// ⚠️ NICKEL AND DIME ARE NOT FRONTS, they are personnel — five and six defensive backs behind the
// same four linemen. They are listed as categories because that is how they are called, but the
// difference between them and 4-3 is WHO you place, not how many, and it is already derived from
// the slots you pick.
export const DEF_FRONTS = {
  '4-3':   { name: '4-3',   dl: 4, blurb: 'Four down, three linebackers. The base front.' },
  '3-4':   { name: '3-4',   dl: 3, blurb: 'Three down, four linebackers — one of them usually rushing.' },
  // ⚠️ FIVE DOWN, FOUR LINEMEN. The engine fields four and every roster carries exactly four, so
  // the fifth man on the ball is a LINEBACKER you align there and give a `rush` job — which is
  // what a real 5-2 does anyway. No roster change, no engine change.
  '5-2':   { name: '5-2',   dl: 4, blurb: 'Five on the ball — the fifth is a linebacker walked down.' },
  '3-3-5': { name: '3-3-5', dl: 3, blurb: 'Three down, three linebackers, five defensive backs.' },
  'nickel': { name: 'Nickel', dl: 4, blurb: 'Four down with a fifth defensive back for the third receiver.' },
  'dime':   { name: 'Dime',   dl: 4, blurb: 'Four down with six defensive backs. Obvious passing down.' },
}

export const DEFENDERS = 11
export const DEF_SLOT_POOL = { DL: 5, LB: 5, CB: 4, S: 3 }

// How many NON-lineman defenders a front leaves. The linemen are placed too, but their count is
// fixed by the front rather than chosen.
export function coverageFor(category) {
  const front = DEF_FRONTS[category]
  return front ? DEFENDERS - front.dl : DEFENDERS - 4
}

// ── Where a player may legally stand ────────────────────────────────────────
//
// ⚠️ MIRRORS `getPositionYBounds` IN Client/src/game/formation.ts, which is the rule the live game
// already enforces on every drag. Expressed here in authored terms (depth from the line) so a
// formation cannot be saved through the API that the game would never have let you drag into.
//
// The offense may not cross the line; the defense may not either, and its limit is a FULL PLAYER
// RADIUS back — a circle centred exactly on the line sits halfway across it and is offside.
const PLAYER_RADIUS = 0.5

export function depthBounds(label, side) {
  if (side === 'offense') {
    switch (label) {
      case 'WR': return { min: 0, max: 7 }
      case 'TE': return { min: 0, max: 5 }
      case 'RB': return { min: 2, max: 10 }
      default:   return { min: 0, max: 15 }
    }
  }
  switch (label) {
    case 'DL': return { min: PLAYER_RADIUS, max: 5 }
    case 'LB': return { min: PLAYER_RADIUS, max: 10 }
    case 'CB': return { min: PLAYER_RADIUS, max: 20 }
    case 'S':  return { min: PLAYER_RADIUS, max: 25 }
    default:   return { min: PLAYER_RADIUS, max: 15 }
  }
}

// Half the field either side of the ball, which is as far as anyone can be and still be on it.
const MAX_DX = 26

// A zone is a LANDMARK, not a player, so it is not bound by where a defender may line up — a deep
// third sits further downfield than the corner playing it ever starts.
const MAX_ZONE_DEPTH = 35

function checkSpot(errors, s, side) {
  const label = slotLabel(s.slot)
  const b = depthBounds(label, side)
  if (Number.isFinite(s.depth)) {
    if (s.depth < b.min) {
      err(errors, side === 'offense'
        ? `${s.slot} is across the line of scrimmage — the offense must stay behind it`
        : `${s.slot} is offside — the defense must stay on its own side of the line`)
    } else if (s.depth > b.max) {
      err(errors, `${s.slot} is ${s.depth} yards off the line; a ${label} may go ${b.max}`)
    }
  }
  if (Number.isFinite(s.dx) && Math.abs(s.dx) > MAX_DX) {
    err(errors, `${s.slot} is off the field (${s.dx} yards from the ball)`)
  }
}

export const SHELL_KINDS = ['man', 'zone']
export const JOBS = ['man', 'zone', 'rush', 'spy']
export const ZONE_TYPES = ['flat', 'curl', 'hook', 'deep']

// Man assignments name an ALIGNMENT ROLE, never a slot: the widest receiver left, the slot left,
// the tight end. That is what lets one shell work against every offensive formation instead of
// needing a version per formation. `null` leaves it to matchMen, which pairs by position and
// field side -- and is the default, because authoring matchups would have to be redone for every
// new offensive formation.
export const COVER_ROLES = ['X', 'SL', 'Y', 'SR', 'Z', 'RB']

// -- Leverage: the one thing the AI decides for itself -----------------------
//
// Shading is a real decision, but it cannot be a PER-DEFENDER one and still be solvable: five man
// defenders x four shades is 1,024 variants of every shell, which no payoff matrix can hold. So
// the choice is made once for the whole call -- three options per shell instead of a thousand.
export const LEVERAGES = ['auto', 'in', 'out']

const ALL_DEF_SLOTS = new Set(slotsFor(DEF_SLOT_POOL))

export function validateDefFormation(f) {
  const errors = []
  if (!f || typeof f !== 'object') return { ok: false, errors: ['formation is not an object'] }
  if (!f.name || !String(f.name).trim()) err(errors, 'needs a name')
  if (!DEF_FRONTS[f.category]) {
    err(errors, `front must be one of ${Object.keys(DEF_FRONTS).join(', ')}`)
  }

  const spots = Array.isArray(f.spots) ? f.spots : []
  if (spots.length !== DEFENDERS) {
    err(errors, `needs all ${DEFENDERS} defenders, got ${spots.length}`)
  }

  const seen = new Set()
  const counts = {}
  for (const s of spots) {
    if (!ALL_DEF_SLOTS.has(s?.slot)) { err(errors, `unknown slot "${s?.slot}"`); continue }
    if (seen.has(s.slot)) err(errors, `slot ${s.slot} used twice`)
    seen.add(s.slot)
    const label = slotLabel(s.slot)
    counts[label] = (counts[label] ?? 0) + 1
    if (!Number.isFinite(s.dx)) err(errors, `${s.slot} dx must be a number`)
    if (!Number.isFinite(s.depth)) err(errors, `${s.slot} depth must be a number`)
    checkSpot(errors, s, 'defense')
  }
  for (const [label, n] of Object.entries(counts)) {
    if (n > (DEF_SLOT_POOL[label] ?? 0)) {
      err(errors, `${n} ${label}s exceeds the ${DEF_SLOT_POOL[label] ?? 0} a roster carries`)
    }
  }
  // The front is chosen, so the number of linemen is not free.
  const front = DEF_FRONTS[f.category]
  if (front && spots.length === DEFENDERS && (counts.DL ?? 0) !== front.dl) {
    err(errors, `a ${f.category} fields ${front.dl} linemen, got ${counts.DL ?? 0}`)
  }
  return { ok: errors.length === 0, errors }
}

// Defensive personnel, DERIVED from who was placed. Three corners is nickel, four is dime.
export function defPersonnelOf(formation) {
  const out = { DL: 0, LB: 0, CB: 0, S: 0 }
  for (const s of formation?.spots ?? []) {
    const label = slotLabel(s.slot)
    if (label in out) out[label]++
  }
  return out
}

export function validateShell(s, formations) {
  const errors = []
  if (!s || typeof s !== 'object') return { ok: false, errors: ['shell is not an object'] }
  if (!s.name || !String(s.name).trim()) err(errors, 'needs a name')
  if (!SHELL_KINDS.includes(s.kind)) err(errors, `kind must be one of ${SHELL_KINDS.join(', ')}`)
  if (s.forcedLeverage != null && !['in', 'out'].includes(s.forcedLeverage)) {
    err(errors, 'forcedLeverage must be "in", "out", or null to let the AI choose')
  }

  const formation = formations?.[s.formationId]
  if (!formation) return { ok: false, errors: [...errors, `unknown defensive formation "${s.formationId}"`] }
  const slots = new Set((formation.spots ?? []).map(x => x.slot))

  let covers = 0
  for (const [slot, a] of Object.entries(s.assignments ?? {})) {
    if (!slots.has(slot)) { err(errors, `assignment for ${slot}, which is not in formation "${s.formationId}"`); continue }
    if (!a || !JOBS.includes(a.job)) { err(errors, `${slot} has unknown job "${a?.job}"`); continue }
    if (a.job === 'man') {
      covers++
      if (a.target != null && !COVER_ROLES.includes(a.target)) {
        err(errors, `${slot} is manned on "${a.target}", which is not an alignment role`)
      }
    } else if (a.job === 'zone') {
      covers++
      if (!ZONE_TYPES.includes(a.zone)) err(errors, `${slot} needs a zone type (${ZONE_TYPES.join(', ')})`)
      // ⚠️ WHERE the zone sits, not just what kind it is. A hook zone over the left hash and one
      // over the right are different coverages, and the shape of a shell is exactly the set of
      // these. Optional: without one the engine falls back to the landmark it would have computed.
      if (a.center != null) {
        if (!Number.isFinite(a.center.dx) || !Number.isFinite(a.center.depth)) {
          err(errors, `${slot} has a bad zone centre`)
        } else if (a.center.depth < 0) {
          // A zone may sit ON the line — a flat zone does — but never behind it.
          err(errors, `${slot}'s zone is behind the line of scrimmage`)
        } else if (a.center.depth > MAX_ZONE_DEPTH) {
          err(errors, `${slot}'s zone is ${a.center.depth} yards deep; ${MAX_ZONE_DEPTH} is the limit`)
        } else if (Math.abs(a.center.dx) > MAX_DX) {
          err(errors, `${slot}'s zone is off the field`)
        }
      }
    }
  }

  // NOBODY UNCOVERED. A shell that rushes everyone is legal JSON and an instant touchdown.
  if (Object.keys(s.assignments ?? {}).length && covers === 0) {
    err(errors, 'rushes and spies only -- nobody is covering anyone')
  }

  // NUDGES SAVE ONTO THE SHELL, not the formation. Cover 2 and Cover 3 out of one nickel formation
  // should be able to line up differently, so a shell carries its own alignment overrides and the
  // formation stays the base everything starts from.
  for (const [slot, at] of Object.entries(s.alignments ?? {})) {
    if (!slots.has(slot)) err(errors, `alignment for ${slot}, which is not in formation "${s.formationId}"`)
    else if (!Number.isFinite(at?.dx) || !Number.isFinite(at?.depth)) err(errors, `${slot} has a bad alignment`)
    // A nudge can put a defender offside just as easily as the formation can.
    else checkSpot(errors, { slot, dx: at.dx, depth: at.depth }, 'defense')
  }
  return { ok: errors.length === 0, errors }
}

// Where the eleven actually start: the formation, with this shell's nudges applied on top.
export function layoutDefense(formation, shell, { losY, ballX }) {
  return (formation?.spots ?? []).map((s, index) => {
    const at = shell?.alignments?.[s.slot] ?? s
    return {
      slot: s.slot,
      label: slotLabel(s.slot),
      x: ballX + at.dx,
      // Defenders stand in FRONT of the line, so depth counts the other way from the offense's.
      y: losY + at.depth,
      index,
    }
  })
}

// Every defensive option the AI chooses among: a shell crossed with the leverages it allows. This
// is the column set of the payoff matrix, and it is small on purpose.
export function shellOptions(shells) {
  const out = []
  for (const [id, s] of Object.entries(shells ?? {})) {
    if (s?.forcedLeverage) { out.push({ shellId: id, leverage: s.forcedLeverage }); continue }
    // A pure zone shell has no man defenders to shade, so three leverages would be three IDENTICAL
    // columns -- wasted simulation and duplicate strategies in the matrix.
    if (s?.kind === 'zone') { out.push({ shellId: id, leverage: 'auto' }); continue }
    for (const leverage of LEVERAGES) out.push({ shellId: id, leverage })
  }
  return out
}

// ── Not every formation can run the ball ────────────────────────────────────
//
// A run out of a formation carries no drawn information — no routes, and no lane, because the
// lane is read off the defensive front at the line. So there is nothing for a human to author,
// and making them create one by hand for every formation is fifteen identical clicks that can
// only be got wrong. Creating a formation therefore creates its run play too.
//
// ⚠️ EXCEPT WHERE THERE IS NOBODY TO HAND IT TO. An empty set has no back at all, and a back
// split out wide is a receiver who happens to be listed as an RB — neither can take a handoff. A
// run play generated for either is a call that cannot be run, and it will sit in the playbook
// looking legitimate: the solver will include it, lose with it, and learn to avoid it, when the
// truth is it was never a play.
//
// "In the backfield" is both things at once. Behind the line, and inside the formation: the
// tackles sit at ±3.5, so a back within about seven is still behind it and can be handed the ball.
// Wider than that and he is split out, whatever his label says.
const BACKFIELD_MIN_DEPTH = 2
const BACKFIELD_MAX_DX = 7

export function backfieldBacks(formation) {
  return (formation?.spots ?? []).filter(s =>
    slotLabel(s.slot) === 'RB'
    && Number.isFinite(s.depth) && s.depth >= BACKFIELD_MIN_DEPTH
    && Number.isFinite(s.dx) && Math.abs(s.dx) <= BACKFIELD_MAX_DX)
}

// Why this formation cannot run, in words, or null if it can.
export function whyNoRun(formation) {
  const backs = (formation?.spots ?? []).filter(s => slotLabel(s.slot) === 'RB')
  if (backs.length === 0) return 'no back in this formation'
  if (backfieldBacks(formation).length > 0) return null
  // Say which it is. "Split out" and "up on the line" are different mistakes and the message is
  // the only thing telling anyone what to move.
  const wide = backs.every(b => Math.abs(b.dx ?? 0) > BACKFIELD_MAX_DX)
  return wide ? 'the back is split out wide, not in the backfield'
    : 'the back is not behind the line'
}

export function autoRunPlay(formation, formationId) {
  if (whyNoRun(formation)) return null
  const eligible = backfieldBacks(formation)
  const allBacks = (formation?.spots ?? []).filter(s => slotLabel(s.slot) === 'RB')
  return {
    name: `${formation.name} Run`,
    formationId,
    playType: 'run',
    // One back and nothing to disambiguate: the validator resolves it. Otherwise name the carrier
    // explicitly — including when there are two backs but only one of them is actually back there.
    assignments: allBacks.length === 1 ? {} : { [eligible[0].slot]: { kind: 'carry' } },
  }
}

// `formations` and `plays` are the OFFENSE; `defFormations` and `shells` are the defense. They are
// kept apart because they validate against completely different rules — five skill players against
// eleven defenders — and because a play must only ever be built on an offensive formation.
// ── The five shells every formation starts with ─────────────────────────────
//
// A defensive formation is worth nothing until something is called out of it, and the first five
// calls are always the same five. Authoring them by hand for fourteen formations is seventy
// identical sittings, so they come free — and then they are ordinary shells, editable and
// deletable like any other. This is the defensive twin of the run play that comes with an
// offensive formation.
//
// ⚠️ THE LINEMEN ALWAYS RUSH. A down lineman dropping is a specific, unusual call; rushing is what
// he does unless told otherwise, so every generated shell starts him there and the editor seeds
// the same default. Nobody should have to click `rush` four times to describe a normal defense.
//
// The zone CENTRES here are ordinary landmarks — deep halves a quarter of the way out, thirds a
// third of the way out — not anything clever. Pressing Cover 2/3/4 in the editor recomputes them
// from where the defenders actually stand, which is better; these just make the saved shell look
// like the coverage it claims to be before anyone touches it.

const DEEP = 15
const UNDER_CURL = 10
const UNDER_HOOK = 8
const FLAT = 4

const byDx = (a, b) => a.dx - b.dx
const zone = (kind, dx, depth) => ({ job: 'zone', zone: kind, center: { dx, depth } })
const man = () => ({ job: 'man', target: null })

// Underneath work for whoever is left after the deep players are spoken for.
function fillUnderneath(out, players) {
  players.sort(byDx).forEach((p, i, all) => {
    if (all.length === 1) { out[p.slot] = zone('hook', 0, UNDER_HOOK); return }
    if (i === 0) out[p.slot] = zone('curl', -9, UNDER_CURL)
    else if (i === all.length - 1) out[p.slot] = zone('curl', 9, UNDER_CURL)
    else out[p.slot] = zone('hook', 0, UNDER_HOOK)
  })
}

export function autoShellsFor(formation, formationId) {
  const spots = formation?.spots ?? []
  const of = (label) => spots.filter(s => slotLabel(s.slot) === label).sort(byDx)
  const dl = of('DL'), cbs = of('CB'), safeties = of('S'), lbs = of('LB')
  if (!cbs.length && !safeties.length && !lbs.length) return []

  const rushers = () => Object.fromEntries(dl.map(d => [d.slot, { job: 'rush' }]))
  const shells = []
  const add = (name, kind, assignments) =>
    shells.push({ name, formationId, kind, forcedLeverage: null, assignments, alignments: {} })

  // COVER 2 — two deep halves, corners in the flats, everyone else underneath.
  {
    const a = rushers()
    const [s1, s2] = safeties
    if (s1) a[s1.slot] = zone('deep', s2 ? -13 : 0, DEEP)
    if (s2) a[s2.slot] = zone('deep', 13, DEEP)
    for (const cb of cbs) a[cb.slot] = zone('flat', cb.dx, FLAT)
    fillUnderneath(a, [...lbs, ...safeties.slice(2)])
    add('COVER 2', 'zone', a)
  }

  // COVER 3 — three deep thirds: both corners and a single high safety.
  {
    const a = rushers()
    const outside = [cbs[0], cbs[cbs.length - 1]].filter(Boolean)
    for (const cb of outside) a[cb.slot] = zone('deep', cb.dx < 0 ? -17 : 17, DEEP)
    const [free, ...rest] = safeties
    if (free) a[free.slot] = zone('deep', 0, DEEP + 1)
    fillUnderneath(a, [...lbs, ...rest, ...cbs.slice(1, -1)])
    add('COVER 3', 'zone', a)
  }

  // COVER 4 — four deep quarters: corners outside, safeties inside.
  {
    const a = rushers()
    const outside = [cbs[0], cbs[cbs.length - 1]].filter(Boolean)
    for (const cb of outside) a[cb.slot] = zone('deep', cb.dx < 0 ? -18 : 18, DEEP - 1)
    safeties.slice(0, 2).forEach((s, i) => { a[s.slot] = zone('deep', i === 0 ? -7 : 7, DEEP - 1) })
    fillUnderneath(a, [...lbs, ...safeties.slice(2), ...cbs.slice(1, -1)])
    add('COVER 4', 'zone', a)
  }

  // COVER 1 — man across the board with a single free safety over the top.
  {
    const a = rushers()
    const [free, ...rest] = safeties
    if (free) a[free.slot] = zone('deep', 0, DEEP + 1)
    for (const p of [...cbs, ...rest]) a[p.slot] = man()
    // One linebacker spies rather than chasing; the rest take a man.
    lbs.forEach((lb, i) => { a[lb.slot] = i === Math.floor(lbs.length / 2) ? { job: 'spy' } : man() })
    add('COVER 1', 'man', a)
  }

  // 2 MAN — man underneath, two safeties over the top.
  {
    const a = rushers()
    const [s1, s2] = safeties
    if (s1) a[s1.slot] = zone('deep', s2 ? -13 : 0, DEEP)
    if (s2) a[s2.slot] = zone('deep', 13, DEEP)
    for (const p of [...cbs, ...lbs, ...safeties.slice(2)]) a[p.slot] = man()
    add('2 MAN', 'man', a)
  }

  return shells
}

export function emptyPlaybook() {
  return { version: PLAYBOOK_VERSION, formations: {}, plays: {}, defFormations: {}, shells: {} }
}
