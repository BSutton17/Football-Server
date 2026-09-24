// ── The defensive action space, widened ([deep]) ────────────────────────────
//
// The first action space let a network choose a SHELL and nothing else, so the best it could ever
// do was pick a better item from a ten-item menu. Measured, that whole menu was worth about three
// points of spread — which is why training plateaued early and why the champion settled on playing
// quarters on every early down. There was nothing deeper to find.
//
// This widens it. The shell stays as the PRIOR — the network still picks one, `expandShell` still
// turns it into eleven legal assignments, and the constraint mask still applies — and on top of
// that the network adjusts EACH DEFENDER individually:
//
//   • send him instead (a coverage player becomes a rusher), or drop him into coverage
//   • move his zone's centre
//   • shade his man inside / outside / over / under
//   • line him up somewhere other than the shell's default spot
//
// With every delta at zero this reproduces the shell exactly, which is the point: the playbook is a
// starting position, not a cage. Evolution discovers where deviating pays, and with enough range it
// reaches coverages that have no name.
//
// ⚠️ ONE GENOME, QUERIED REPEATEDLY. The network is NOT given seventy outputs, one block per
// defender. A fully-connected genome of that shape starts with ~2800 connections against the old
// 560, and speciation already broke once at 560 because compatibility distance collapses to an
// average weight difference over hundreds of genes. Instead the same small network is asked one
// question at a time: first "what shell?", then "what about THIS defender?" once per man. A flag
// input says which question it is being asked. That keeps the genome small, lets it generalise
// across players, and gets coordination for free — every defender is perturbing one coherent shell.

import { observe, OBSERVATION_SIZE } from './observation.js'
import { decode as decodeShell, ACTION_SIZE } from './action.js'
import { FIELD } from '../constants.js'
import { canCover } from '../ai/assignments.js'

export const DEEP_DEFENSE_VERSION = 'v1'

// ── Inputs ────────────────────────────────────────────────────────────────────
//
// The base situation, a flag saying which question this is, then the context of the one defender
// being asked about. On the shell query the player block is all zeros.
export const PLAYER_CONTEXT_FIELDS = [
  'isPlayerQuery',     // 0 on the shell query, 1 on a per-defender query
  'posCB', 'posS', 'posLB',
  'typeMan', 'typeZone', 'typeBlitz', 'typeSpy',
  'ownX',              // his alignment relative to the ball, -1..1
  'ownDepth',          // how far off the ball he is, 0..1
  'jobX',              // his man/landmark's lateral spot relative to the ball
  'jobDepth',          // …and its depth
]

export const DEEP_OBSERVATION_SIZE = OBSERVATION_SIZE + PLAYER_CONTEXT_FIELDS.length

// ── Outputs ───────────────────────────────────────────────────────────────────
export const DELTA_FIELDS = [
  'keep', 'send', 'drop',      // leave him alone / rush him / put him in coverage
  'shadeH',                    // < 0 inside, > 0 outside, dead zone in the middle
  'shadeV',                    // < 0 under, > 0 over the top
  'zoneDx', 'zoneDy',          // move the zone landmark
  'alignDx', 'alignDy',        // line up off the shell's spot
]

export const DEEP_ACTION_SIZE = ACTION_SIZE + DELTA_FIELDS.length

// How far a delta can move things. Wide enough to invent a look the playbook does not contain,
// narrow enough that a random network still produces recognisable football.
const ZONE_SHIFT = 8      // yards a zone centre may move
const ALIGN_SHIFT = 4     // yards a defender may line up off his spot
const SHADE_DEADZONE = 0.25   // below this the network is not asking for a shade at all
const SWITCH_MARGIN = 0.15    // how clearly it must prefer send/drop over keep

// A signed value in -1..1 from a 0..1 output.
const signed = (v) => Math.max(-1, Math.min(1, (v ?? 0.5) * 2 - 1))
const unit = (v) => Math.max(0, Math.min(1, v ?? 0))

// Builds the input vector. `player` null asks the SHELL question; otherwise it asks about that one
// defender, given the assignment the shell already gave him.
export function observeDeep(k, { roster, player = null, assignment = null, ballX = FIELD.WIDTH / 2 } = {}) {
  const base = observe(k, { roster })
  const ctx = new Array(PLAYER_CONTEXT_FIELDS.length).fill(0)

  if (player) {
    const halfWidth = FIELD.WIDTH / 2
    ctx[0] = 1
    ctx[1] = player.label === 'CB' ? 1 : 0
    ctx[2] = player.label === 'S' ? 1 : 0
    ctx[3] = player.label === 'LB' ? 1 : 0
    const t = assignment?.type
    ctx[4] = t === 'man' ? 1 : 0
    ctx[5] = t === 'zone' ? 1 : 0
    ctx[6] = t === 'blitz' ? 1 : 0
    ctx[7] = t === 'spy' ? 1 : 0
    ctx[8] = Math.max(-1, Math.min(1, ((player.x ?? ballX) - ballX) / halfWidth))
    ctx[9] = Math.max(0, Math.min(1, ((player.y ?? k.yardLine) - k.yardLine) / 25))

    // Where his job is: the receiver he has, or the landmark he is responsible for.
    let jx = null, jy = null
    if (t === 'man' && assignment?.target) { jx = assignment.target.x; jy = assignment.target.y }
    else if (t === 'zone') { jx = assignment?.zoneCenterX; jy = assignment?.zoneCenterY }
    if (jx != null) ctx[10] = Math.max(-1, Math.min(1, (jx - ballX) / halfWidth))
    if (jy != null) ctx[11] = Math.max(0, Math.min(1, (jy - k.yardLine) / 25))
  }

  return [...base, ...ctx]
}

// Reads the per-defender adjustments out of a network's outputs.
export function decodeDelta(outputs) {
  const d = outputs.slice(ACTION_SIZE)
  const [keep, send, drop, shadeH, shadeV, zoneDx, zoneDy, alignDx, alignDy] = d

  // Type change only when it clearly beats leaving him alone — a network that is ambivalent should
  // not be reshuffling the coverage.
  let change = null
  const k = unit(keep)
  if (unit(send) > k + SWITCH_MARGIN && unit(send) >= unit(drop)) change = 'send'
  else if (unit(drop) > k + SWITCH_MARGIN) change = 'drop'

  const h = signed(shadeH), v = signed(shadeV)
  let shade = null
  if (Math.abs(h) >= Math.abs(v) && Math.abs(h) > SHADE_DEADZONE) shade = h < 0 ? 'in' : 'out'
  else if (Math.abs(v) > SHADE_DEADZONE) shade = v < 0 ? 'under' : 'over'

  return {
    change,
    shade,
    zoneDx: signed(zoneDx) * ZONE_SHIFT,
    zoneDy: signed(zoneDy) * ZONE_SHIFT,
    alignDx: signed(alignDx) * ALIGN_SHIFT,
    alignDy: signed(alignDy) * ALIGN_SHIFT,
  }
}

export { decodeShell }

// ── The projection ────────────────────────────────────────────────────────────
//
// ⚠️ THIS IS THE PART THAT KEEPS THE WIDENED SPACE HONEST.
//
// With free per-player adjustment a network can ask for nonsense: everybody rushing, a receiver
// with nobody on him, an empty box against two tight ends, a zone landmark in the stands. The old
// narrow space could not express any of that, so `expandShell` alone was enough.
//
// The rule is unchanged though — MASK, DO NOT PENALIZE. An illegal wish is repaired into the
// nearest legal one BEFORE the play runs, not scored badly afterwards. Penalising would spend
// generations teaching the network a rule the projection can simply enforce, and it would make the
// fitness landscape lumpy for no benefit.
//
// The rules are the user's own constraints, which have governed this AI from the start: never leave
// a receiver uncovered, never empty the box against heavy personnel, legal man matchups only.
const MAX_EXTRA_RUSHERS = 2     // beyond what the shell already sends
const BOX_DEPTH = 6             // yards past the LOS that still counts as "in the box"
const BOX_WIDTH = 9             // …and how far either side of the ball

export function projectAssignments(assignments, { receivers, oppHeavy, losY, ballX, warnings = [] }) {
  const out = new Map(assignments)

  // 1. Zone landmarks stay on the field. A deep zone asked for 130 yards downfield is refused by
  //    the server outright, and a refused assignment silently turns that defender into a rusher —
  //    which is how a safety once vanished from a coverage without anything being logged.
  for (const [id, a] of out) {
    if (a.type !== 'zone') continue
    out.set(id, {
      ...a,
      zoneCenterX: Math.max(0, Math.min(FIELD.WIDTH, a.zoneCenterX ?? ballX)),
      zoneCenterY: Math.max(-10, Math.min(110, a.zoneCenterY ?? losY)),
    })
  }

  // 2. A shade only means something on a man assignment.
  for (const [id, a] of out) {
    if (a.type !== 'man' && a.manCommit) out.set(id, { ...a, manCommit: null })
  }

  // 3. Nobody may be left alone. A receiver with no man on him needs SOMEONE in coverage; if the
  //    deltas sent everybody, put the most recently converted rusher back.
  // ⚠️ REVERT WHOLESALE, never field by field. Converting a man to a blitz nulls his targetId and
  // his zone data; restoring only `type` therefore produced a "man" assignment covering nobody, and
  // the formation check reported "defender net_lb2 (LB) has no assignment" on a sixth of all plays.
  // Every modified assignment carries the original, and undoing a change means putting that back.
  const revert = (a) => ({ ...(a.orig ?? a), alignDx: a.alignDx, alignDy: a.alignDy })

  const manned = new Set([...out.values()].filter(a => a.type === 'man').map(a => a.targetId))
  const coverageCount = [...out.values()].filter(a => a.type === 'zone' || a.type === 'man').length
  const uncovered = receivers.filter(r => !manned.has(r.id))
  if (uncovered.length > 0 && coverageCount === 0) {
    // Everyone rushing with receivers live is not a defense. Put converted rushers back until
    // somebody is covering somebody.
    for (const [id, a] of out) {
      if (a.convertedBy !== 'send') continue
      out.set(id, revert(a))
      warnings.push(`projection: ${id} put back in coverage — nobody was covering anyone`)
      break
    }
  }

  // 4. Cap the extra pressure. A network that discovers "send everyone" would be rediscovering the
  //    exact exploit the blitz-speed fix just removed.
  const converted = [...out.entries()].filter(([, a]) => a.convertedBy === 'send')
  if (converted.length > MAX_EXTRA_RUSHERS) {
    for (const [id, a] of converted.slice(MAX_EXTRA_RUSHERS)) {
      out.set(id, revert(a))
      warnings.push(`projection: ${id} kept in coverage — extra rushers capped at ${MAX_EXTRA_RUSHERS}`)
    }
  }

  // 5. Never zero in the box against heavy personnel — the user's original constraint.
  if (oppHeavy) {
    const inBox = [...out.values()].filter(a => {
      const y = a.alignY ?? losY
      const x = a.alignX ?? ballX
      return (y - losY) <= BOX_DEPTH && Math.abs(x - ballX) <= BOX_WIDTH
    }).length
    if (inBox === 0) {
      // Pull the shallowest defender back down into the box rather than inventing a new one.
      const shallow = [...out.entries()].sort((a, b) => (a[1].alignY ?? 0) - (b[1].alignY ?? 0))[0]
      if (shallow) {
        out.set(shallow[0], { ...shallow[1], alignY: losY + 4, alignX: ballX })
        warnings.push(`projection: ${shallow[0]} moved into the box — heavy personnel, nobody there`)
      }
    }
  }

  return { assignments: out, warnings }
}

// Is a man matchup one the constraints allow? Deltas never reassign targets, so this is a guard
// against a future change rather than a live repair — but it is cheap and it states the rule.
// Delegates to assignments.js so there is one authority for "a corner does not cover a tight end".
export function manMatchupLegal(defenderLabel, receiverLabel) {
  return canCover(defenderLabel, receiverLabel)
}
