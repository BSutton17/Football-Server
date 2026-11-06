// ── Is this a legal field? ([field check]) ───────────────────────────────────
//
// "When loading in a save, or before each play the game should verify whether the field is in a legal
// position. No more than 11 on each side and the sides are on the correct sides."
//
// It exists because the server used to take a formation on trust. A client that came back from a save
// sent its defensive line to the yard line of a brand-new game, wherever the ball really was. The
// server stood them there, thirty yards on the wrong side of the ball, and the quarterback went down on
// every snap. The client is fixed, but a phone can be running an old copy of it, so the rule lives here.
//
// ⚠️ THE LIMITS ARE MEASURED, NOT GUESSED, so this can never touch a formation that was fine. Over 2,413
// computer snaps the offense was never closer than 0.8 behind the line, the defense never closer than
// 0.8 off it, the four auto-placed linemen always exactly 1.0 off it, and neither side above eleven. What
// a player may place by hand is the client's getPositionYBounds: an offense up to the line, a defense a
// body's width (PLAYER.RADIUS) off it.
//
// It repairs rather than refuses: refusing the snap would be a softlock, and a play with a defender moved
// back onside is a real play. Silence means the field was legal.

import { PLAYER } from '../constants.js'
import { getLosY } from './gameState.js'
import { FRONT_DEPTH, frontXs } from '../ai/playbook/front.js'

export const MAX_PER_SIDE = 11

const FLOAT_SLACK = 0.01       // yards converted between frames do not land exactly on a limit
const DL_ROW_SLACK = 0.25      // the auto-placed row only ever moves sideways, so any real depth change is wrong
const OFFENSE_LINE_DEPTH = 1   // the row the offensive line stands on, as the client's LINE_Y_OFFSET

const isAutoLineman = (id) => /^auto_dl\d+$/.test(id)
const isFixedOffense = (p) => p.label === 'OL' || p.label === 'QB'

// Most recently placed first, because the extra man is the last one who came on. Never anyone the game
// itself put there: the line and the quarterback are not substitutions.
function dropExtras(ids, limit, remove) {
  const extra = ids.length - limit
  if (extra <= 0) return []
  const dropped = ids.slice().reverse().slice(0, extra)
  for (const id of dropped) remove(id)
  return dropped
}

function legalizeDefense(state, los, dir, fixed) {
  const defense = state.defensePlayers
  if (!defense) return

  const droppable = [...defense.values()].filter(p => !isAutoLineman(p.id)).map(p => p.id)
  const room = Math.max(0, MAX_PER_SIDE - (defense.size - droppable.length))
  for (const id of dropExtras(droppable, room, (gone) => { defense.delete(gone); state.defenseCoverage?.delete(gone) })) {
    fixed.push(`defense had more than ${MAX_PER_SIDE}: took ${id} off`)
  }

  const ballX = state.ballX
  for (const p of defense.values()) {
    const depth = (p.y - los) * dir
    if (isAutoLineman(p.id)) {
      if (Math.abs(depth - FRONT_DEPTH) <= DL_ROW_SLACK) continue
      // A row that is somewhere else is lined up on some other ball, sideways as well.
      const spot = frontXs(4, ballX)[Number(p.id.slice('auto_dl'.length)) - 1]
      p.y = los + dir * FRONT_DEPTH
      if (ballX != null && spot != null) p.x = spot
      fixed.push(`${p.id} was ${depth.toFixed(1)} yards off the line: moved to the line`)
    } else if (depth < PLAYER.RADIUS - FLOAT_SLACK) {
      p.y = los + dir * FRONT_DEPTH
      fixed.push(`${p.id} (${p.label}) was offside by ${(PLAYER.RADIUS - depth).toFixed(1)}: moved back onside`)
    }
  }
}

// The offense is split: whoever was placed by hand is in the map, and the line and quarterback only exist
// in the set_offense payload until the snap. `design` is that payload, relative to the offense's own goal.
function legalizeOffense(state, los, dir, design, fixed) {
  const offense = state.offensePlayers
  if (!offense) return

  const designed = design.filter(p => p.team === 'o')
  const inDesign = new Set(designed.map(p => p.id))
  const total = () => new Set([...inDesign, ...offense.keys()]).size

  // Someone standing on the field who is not in the play at all goes first.
  for (const id of [...offense.keys()].reverse()) {
    if (total() <= MAX_PER_SIDE) break
    if (inDesign.has(id)) continue
    offense.delete(id)
    fixed.push(`offense had more than ${MAX_PER_SIDE}: took ${id} off`)
  }
  const droppable = designed.filter(p => !isFixedOffense(p)).map(p => p.id)
  const room = Math.max(0, droppable.length - (total() - MAX_PER_SIDE))
  const gone = new Set(dropExtras(droppable, room, (id) => { offense.delete(id); inDesign.delete(id) }))
  if (gone.size) {
    state.playDesign.players = state.playDesign.players.filter(p => !gone.has(p.id))
    for (const id of gone) fixed.push(`offense had more than ${MAX_PER_SIDE}: took ${id} off`)
  }

  for (const p of offense.values()) {
    const past = (p.y - los) * dir
    if (past > FLOAT_SLACK) {
      p.y = los - dir * OFFENSE_LINE_DEPTH
      fixed.push(`${p.id} (${p.label}) was ${past.toFixed(1)} past the line: moved back`)
    }
  }
  for (const p of designed) {
    if (offense.has(p.id) || gone.has(p.id)) continue
    const past = p.y - state.yardLine
    if (past > FLOAT_SLACK) {
      p.y = state.yardLine - OFFENSE_LINE_DEPTH
      fixed.push(`${p.id} (${p.label}) was ${past.toFixed(1)} past the line: moved back`)
    }
  }
}

// Puts the field right and says what it changed. `design` is left out on a load: a formation from before
// the save is not a play anyone is about to run.
export function enforceFieldLegality(state, { when = 'snap', design = state?.playDesign?.players ?? [] } = {}) {
  const fixed = []
  if (state?.yardLine == null) return fixed
  const los = getLosY(state)
  const dir = state.direction === 1 ? 1 : -1

  legalizeOffense(state, los, dir, design, fixed)
  legalizeDefense(state, los, dir, fixed)

  if (fixed.length && !state.headless) {
    console.warn(`[field] ${state.roomId} illegal field at the ${when}: ${fixed.join('; ')}`)
  }
  return fixed
}

// ── A loaded save ──────────────────────────────────────────────────────────

// What a game cannot go on without. Anything else in a save can be put right, but with no idea who has the
// ball or where it is there is nothing to put right from.
export function saveIsPlayable(saved) {
  return (saved?.possession === 0 || saved?.possession === 1)
    && Number.isFinite(saved?.yardLine)
}

// Which way this team attacks is fixed by who it is: slot 0 goes up the field and slot 1 down it, from
// kickoff on, because the two only ever flip together. Measured over 5,627 dead balls, they never disagreed.
export function directionFor(possession) {
  return possession === 0 ? 1 : -1
}

export function verifyLoadedGame(state, { prePlay = false } = {}) {
  const fixed = []
  const direction = directionFor(state.possession)
  if (state.direction !== direction) {
    state.direction = direction
    fixed.push('the teams were facing the wrong way: turned them around')
  }
  if (fixed.length) console.warn(`[field] ${state.roomId} illegal field on load: ${fixed.join('; ')}`)
  // Only a line-up can be judged. At a dead ball everyone is still standing wherever the last play left
  // them, which is not illegal, and the next play wipes them anyway.
  if (prePlay) fixed.push(...enforceFieldLegality(state, { when: 'load', design: [] }))
  return fixed
}
