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

import { layoutAuthored, routeFor, slotLabel, shellsWithPersonnel } from './authored.js'
import { alignAuthored, clampFieldY } from './alignAuthored.js'
import { adjustOffense } from './adjustOffense.js'
import { chooseOffensivePlay, chooseDefensiveShell, offenseLookOf } from '../playcall/select.js'
import { expectedRushers, adjustmentsFor } from '../playcall/tendencies.js'

// Who should cover this assignment, best first. A man defender has to run with the person in
// front of him, so the body matters; a zone defender covers grass and can be anyone.
//
// Exported because the AI fills its own defense from the roster here, while the SHELLS panel
// sends the shape to the client and IT fills the spots — two fillers, one rule, or the shell a
// player loads covers differently from the shell the computer runs.
export function coverOrder(job, targetLabel, drawnLabel) {
  if (job !== 'man' || !targetLabel) return [drawnLabel]
  const t = String(targetLabel).toUpperCase()
  if (t === 'WR') return ['CB', 'S', 'LB']       // a receiver needs a corner
  // ⚠️ A LINEBACKER TAKES THE TIGHT END, NOT A SAFETY. This had it the other way round, and it was
  // wrong twice over.
  //
  // In football: two safeties on two tight ends is a bad matchup in the run game, and the tight end
  // is exactly who a linebacker is built for — he has to be able to play the run from that spot
  // whatever the offense does with it.
  //
  // And structurally: a roster carries THREE safeties. Against two tight ends this took two of them
  // for man coverage, leaving one for a two-deep shell — so the second deep slot found nobody, was
  // silently skipped, and the defense took the field with TEN MEN. Reported as exactly that, on a
  // screenshot where both tight ends were covered by safeties.
  //
  // ⚠️ IT COSTS SOMETHING, AND THAT WAS THE AUTHOR'S CALL TO MAKE. Measured over 1,200 downs, a
  // safety on the tight end defends the PASS better — 3.91 yds/play against 4.05 — which is no
  // surprise, he is the faster cover man. It gives back explosive plays (2.3% -> 2.1%) and it is
  // the right run fit, which is what was asked for.
  if (t === 'TE') return ['LB', 'S', 'CB']
  return ['LB', 'S', 'CB']                       // a back belongs to a linebacker
}

export function hasAuthoredOffense(book) {
  return Object.keys(book?.plays ?? {}).length > 0 && Object.keys(book?.formations ?? {}).length > 0
}

export function hasAuthoredDefense(book) {
  return Object.keys(book?.shells ?? {}).length > 0 && Object.keys(book?.defFormations ?? {}).length > 0
}

const withIds = (map) => Object.entries(map ?? {}).map(([id, v]) => ({ ...v, id }))

const FIELD_WIDTH = 53.33
const clampToField = (x) => Math.max(0.5, Math.min(FIELD_WIDTH - 0.5, x))

// How far in front of the defender an unlandmarked zone sits, by kind. Only used when a shell was
// authored without a centre — a drawn one always wins.
const DEFAULT_ZONE_DEPTH = { flat: 2, curl: 5, hook: 4, deep: 8 }

// ── Offense ─────────────────────────────────────────────────────────────────
//
// Pick a play for the situation, then decide how to line it up.
export function callAuthoredOffense(book, k,
  { ballX, rng = Math.random, solved = null, adjust = null, recent = null }) {
  const plays = withIds(book.plays)
  if (!plays.length) return null

  const situation = { down: k.down, distance: k.distance, yardLine: k.yardLine }
  const play = chooseOffensivePlay(plays, situation, { solved: solved?.offense, rng, recent })
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
  // With the personnel of the formation each is drawn from — see shellsWithPersonnel. Without it
  // the selector's personnel prior is a constant and the defense answers every look the same way.
  const shells = shellsWithPersonnel(book)
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
  // ⚠️ MAN COVERAGE GETS THE RIGHT BODY, NOT THE DRAWN ONE. The shell says which SPOT covers a
  // receiver; it cannot know that the offense would come out in four wides. Filling strictly by
  // the drawn label put a linebacker on a slot receiver in Cover 1 and left the corners standing
  // on tight ends. Matching personnel matters everywhere, but in man it is the whole call: a zone
  // defender covers grass and can be anyone, while a man defender has to run with the person in
  // front of him.
  //
  // So a man assignment is filled by who can actually cover its target, best available first, and
  // only falls back to the drawn position when the cupboard is bare. Everything else — where he
  // stands, what he is told to do — is unchanged, so this substitutes players without altering
  // the shell that was authored.
  for (const row of rows) {
    // ⚠️ The linemen are auto-placed by the engine and are not ours to position or assign. They
    // are in the authored formation so it can be SEEN whole in the sandbox; here they are skipped.
    if (row.label === 'DL') continue

    const target = row.job === 'man' ? receivers.find(r => r.id === row.covers) : null
    let pick = null
    for (const want of [...coverOrder(row.job, target?.label, row.label), row.label]) {
      pick = (byPos[want] ?? []).find(p => !used.has(p.id))
      if (pick) break
    }
    // ⚠️ ELEVEN MEN, WHATEVER IT TAKES. A slot whose preferred positions are all already on the
    // field used to be skipped, and skipping it means playing a man short — which was reported from
    // a real game ("there are only 10 people on the field"). A safety playing a linebacker's spot is
    // a bad matchup; a spot with NOBODY IN IT is an uncovered receiver or an unmanned zone, and there
    // is no version of that which is better.
    if (!pick) {
      pick = roster.find(p => !used.has(p.id))
      if (pick) {
        console.warn(`[defense] ${row.slot} wanted ${coverOrder(row.job, target?.label, row.label).join('/')}` +
          `, took a ${pick.label ?? pick.position} — the preferred positions are all out there already`)
      }
    }
    if (!pick) continue      // genuinely nobody left: the roster is short, not the matcher
    used.add(pick.id)

    out.push({
      id: pick.id,
      // The player's own position, not the slot's — a corner filling a linebacker's spot is still
      // a corner, and his ratings and the card the client draws have to agree with that.
      label: pick.label ?? pick.position ?? row.label,
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
    // ⚠️ A MAN DEFENDER WITH NOBODY TO COVER IS NOT A MAN DEFENDER. Six in man against five
    // receivers leaves one spare, and sending him out with a null target left him with no
    // assignment at all — which the engine reads as "rush", so the spare quietly became a free
    // runner and the hole he was standing in went unmanned with nothing on screen to say so.
    //
    // A spare man defender is the free player every Cover 1 has. He spies, which is what he is
    // actually for.
    if (!target) return { type: 'spy' }
    return {
      type: 'man',
      targetId: target.id,
      manCommit: row.shade === 'none' ? null : row.shade,
    }
  }
  if (row.job === 'zone') {
    // ⚠️ A ZONE CENTRE IS ALWAYS A NUMBER. `assign_coverage` validates it as one, so a shell whose
    // zone was authored without a landmark sent null and had the whole assignment REFUSED — which
    // left that defender with no job at all, and the engine rushes anyone it has no assignment
    // for. One unlandmarked zone silently became a free rusher and an empty hook zone.
    //
    // Falling back to the defender's own spot is what the engine would have computed anyway: a
    // zone with no landmark is a zone centred on the man playing it.
    const depthBelow = row.zoneCenter ? row.zoneCenter.depth - row.depth : DEFAULT_ZONE_DEPTH[row.zone] ?? 4
    // ⚠️ THE AUTHORED LANDMARK WAS BEING THROWN AWAY. This used the defender's own x for every
    // zone, so a shell that placed a deep safety's zone dead centre (`center.dx: 0`) got a landmark
    // wherever his BODY happened to end up after sliding toward the formation — twelve yards off
    // the middle against a three-receiver side. The shell's horizontal intent was simply discarded,
    // and only the depth of it survived.
    //
    // `alignAuthored` already slides `zoneCenter.dx` along with the body, so the authored landmark
    // arrives here correctly adjusted. Falling back to the defender's own spot is still right when
    // a shell was authored WITHOUT a landmark: an unlandmarked zone is one centred on the man
    // playing it.
    return {
      type: 'zone',
      zoneType: row.zone ?? 'hook',
      zoneCenterX: clampToField(row.zoneCenterX ?? row.x),
      // ⚠️ AND THE LANDMARK HAS TO BE ON THE FIELD TOO. A deep zone near the goal line landed past
      // the back of the end zone, `assign_coverage` refused the whole assignment, and the engine
      // rushes anyone it has no assignment for — a red-zone shell became a blitz with holes in it.
      zoneCenterY: clampFieldY(row.y + depthBelow),
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
