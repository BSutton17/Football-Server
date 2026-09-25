// ── Running an authored play in the real engine ([authored]) ────────────────
//
// The bridge. Everything upstream of here — the sandbox, the selector, the alignment layer —
// produced authored formations, plays and shells. Nothing downstream knew they existed: the
// controller still built its offense out of the hand-written CONCEPTS table and its defense out of
// SHELLS, so 126 authored plays and 94 authored shells had never once been snapped.
//
// ⚠️ THIS CHANGES NOTHING ABOUT THE PROTOCOL. An authored play goes out as the same `place_player`
// and `set_offense` a phone sends, with the same validation in front of it; an authored shell goes
// out as the same `assign_coverage`. The engine cannot tell the difference and does not need to —
// which is also why the authored path could be added without touching the simulation at all.
//
// ⚠️ ROUTES TRAVEL AS `drawnRoute`, NOT AS A ROUTE NAME. The hand-written concepts pick from a
// fixed table of named routes; an authored play carries the actual shape somebody drew, as offsets
// from wherever that slot lines up. The payload has always supported it — it is how a human's
// hand-drawn route reaches the server — so authored plays ride a path that already works.

import { layoutAuthored, routeFor, slotLabel } from './authored.js'
import { alignAuthored } from './alignAuthored.js'
import { adjustOffense } from './adjustOffense.js'
import { chooseOffensivePlay, chooseDefensiveShell, offenseLookOf } from '../playcall/select.js'
import { expectedRushers, adjustmentsFor } from '../playcall/tendencies.js'

export function hasAuthoredOffense(book) {
  return Object.keys(book?.plays ?? {}).length > 0 && Object.keys(book?.formations ?? {}).length > 0
}

export function hasAuthoredDefense(book) {
  return Object.keys(book?.shells ?? {}).length > 0 && Object.keys(book?.defFormations ?? {}).length > 0
}

const withIds = (map) => Object.entries(map ?? {}).map(([id, v]) => ({ ...v, id }))

// ── Offense ─────────────────────────────────────────────────────────────────
//
// Pick a play for the situation, then decide how to line it up.
export function callAuthoredOffense(book, k, { ballX, rng = Math.random, solved = null, adjust = null }) {
  const plays = withIds(book.plays)
  if (!plays.length) return null

  const situation = { down: k.down, distance: k.distance, yardLine: k.yardLine }
  const play = chooseOffensivePlay(plays, situation, { solved: solved?.offense, rng })
  if (!play) return null

  const formation = { ...book.formations[play.formationId], id: play.formationId }
  if (!formation?.spots) return null

  // How many the defense is likely to send, which is what decides whether a back stays in. Comes
  // from what this opponent has actually been doing, not from a guess.
  const rushers = adjust ? expectedRushers(adjust) : 4
  const { play: adjusted, mirror, keptIn } = adjustOffense(play, formation, { ballX, rushers })

  return { play: adjusted, formation, mirror, keptIn, playType: play.playType }
}

// Turn the call into the players the controller will place. Shaped exactly like the hand-written
// `buildFormation` output so the emit code is shared.
export function buildAuthoredOffense(call, { losY, ballX, roster }) {
  const { play, formation, mirror } = call
  const spots = layoutAuthored(formation, { losY, ballX, mirror })

  // Best available at each position, exactly as the hand-written path fills its spots.
  const byPos = {}
  for (const p of roster) (byPos[p.label ?? p.position] ??= []).push(p)
  for (const group of Object.values(byPos)) group.sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0))

  const used = new Set()
  const players = []
  for (const spot of spots) {
    const group = byPos[spot.label] ?? []
    const pick = group.find(p => !used.has(p.id))
    if (!pick) continue
    used.add(pick.id)

    const assignment = play.assignments?.[spot.slot]
    players.push({
      id: pick.id,
      label: spot.label,
      x: spot.x,
      y: spot.y,
      ratings: pick.ratings,
      xFactor: pick.xFactor,
      // ⚠️ A BLOCKER CARRIES NO ROUTE AT ALL, not an empty one. The engine reads "has a drawn
      // route" as "is running it", so an empty array would send him nowhere at full speed.
      drawnRoute: assignment?.kind === 'route' ? routeFor(play, spot.slot, { mirror }) : undefined,
      route: assignment?.kind === 'block' ? 'block' : undefined,
      slot: spot.slot,
    })
  }
  return players
}

// ── Defense ─────────────────────────────────────────────────────────────────
//
// ⚠️ THE SHELL IS CHOSEN AFTER SEEING THE FORMATION, which is the whole information structure.
// `offenseLookOf` carries the formation and the personnel that comes with it — and nothing else,
// because the play itself is not the defense's to know.
export function callAuthoredDefense(book, k, { ballX, receivers, rng = Math.random, solved = null, adjust = null }) {
  const shells = withIds(book.shells)
  if (!shells.length) return null

  // What the offense is showing, derived from who is actually on the field rather than from any
  // authored formation — the defense sees players, not a playbook entry.
  const look = { id: formationLookId(receivers), ...personnelOf(receivers) }

  const situation = { down: k.down, distance: k.distance, yardLine: k.yardLine }
  const shell = chooseDefensiveShell(shells, situation, look, { solved: solved?.defense, adjust, rng })
  if (!shell) return null

  const formation = { ...book.defFormations[shell.formationId], id: shell.formationId }
  if (!formation?.spots) return null
  return { shell, formation, look }
}

// A stable name for the shape the offense is showing. Personnel plus how many are split to each
// side — enough to key a solved table on, without pretending to know which authored formation it
// came from.
export function formationLookId(receivers) {
  const p = personnelOf(receivers)
  return `${p.wr}wr${p.te}te${p.rb}rb`
}

function personnelOf(receivers) {
  const out = { wr: 0, te: 0, rb: 0 }
  for (const r of receivers ?? []) {
    const label = (r.label ?? '').toLowerCase()
    if (label === 'wr') out.wr++
    else if (label === 'te') out.te++
    else if (label === 'rb') out.rb++
  }
  return out
}

// Where the eleven stand and what each is doing, ready to be emitted.
export function buildAuthoredDefense(call, { losY, ballX, receivers, roster, adjust = null }) {
  const rows = alignAuthored({
    formation: call.formation,
    shell: call.shell,
    receivers,
    ballX,
    losY,
    ready: true,
    adjust,
  })

  const byPos = {}
  for (const p of roster) (byPos[p.label ?? p.position] ??= []).push(p)
  for (const group of Object.values(byPos)) group.sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0))

  const used = new Set()
  const out = []
  for (const row of rows) {
    // ⚠️ The linemen are auto-placed by the engine and are not ours to position or assign. They
    // are in the authored formation so it can be SEEN whole in the sandbox; here they are skipped.
    if (row.label === 'DL') continue
    const group = byPos[row.label] ?? []
    const pick = group.find(p => !used.has(p.id))
    if (!pick) continue
    used.add(pick.id)

    out.push({
      id: pick.id,
      label: row.label,
      x: row.x,
      y: row.y,
      ratings: pick.ratings,
      xFactor: pick.xFactor,
      coverage: coverageFor(row, receivers),
    })
  }
  return out
}

// One defender's assignment, in the shape `assign_coverage` wants.
function coverageFor(row, receivers) {
  if (row.job === 'man') {
    const target = receivers.find(r => r.id === row.covers)
    return {
      type: 'man',
      targetId: target?.id ?? null,
      manCommit: row.shade === 'none' ? null : row.shade,
    }
  }
  if (row.job === 'zone') {
    return {
      type: 'zone',
      zoneType: row.zone ?? 'hook',
      zoneCenterX: row.zoneCenter ? row.x : null,
      zoneCenterY: row.zoneCenter ? row.y + (row.zoneCenter.depth - row.depth) : null,
    }
  }
  // blitz and spy are coverage TYPES in this engine rather than placements.
  return { type: row.job === 'rush' ? 'blitz' : 'spy' }
}

// The halftime read on whoever is on the other side, or null before there is anything to read.
export function readOpponent(state, mySlot) {
  if (!state?.tendencies) return null
  const adj = adjustmentsFor(state.tendencies, { opponentSlot: 1 - mySlot })
  return { ...adj, preferUnderneath: adj.underneathBias > 0.12 }
}

export { offenseLookOf }
