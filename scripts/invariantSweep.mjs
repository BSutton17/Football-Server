// ── Things that should never be true ([sweep]) ─────────────────────────────
//
//   NODE_ENV=test node scripts/invariantSweep.mjs [downs]
//
// A bug hunt that plays REAL downs through the real engine and checks, every tick and every
// whistle, the things that are never allowed to happen. It exists because most of the faults found
// in this project did not throw, did not log, and produced perfectly ordinary-looking numbers — a
// defense with ten men, a quarterback with 24 yards of range, a receiver playing safety. None of
// those would be caught by a unit test nobody thought to write; all of them are caught by asking
// "is this state legal?" a few hundred thousand times.
//
// ⚠️ IT REPORTS, IT DOES NOT ASSERT. Every violation is counted with one worked example, because a
// count tells you whether something is a rarity or the normal case, and the example tells you where
// to look. A sweep that stopped at the first problem would find one bug per run.
//
// ⚠️ SINGLE PROCESS ON PURPOSE. It is meant to be runnable while a solve has the other cores.

import { createTrainingGame, destroyTrainingGame, playDown } from '../src/training/game.js'
import { startNextPlay, resolveDecision } from '../src/game/eventQueue.js'
import { PHASE } from '../src/game/stateMachine.js'
import { getGame } from '../src/game/gameState.js'
import { FIELD, RULES } from '../src/constants.js'
import { serializeGameState, serializePositions } from '../src/game/serialization.js'

const DOWNS = Number(process.argv[2] ?? 400)
// ⚠️ MANUAL MODE IS A DIFFERENT ENGINE PATH, not a display option — the play freezes and resumes
// through the stoppage framework and throws are only legal while frozen. Sweeping only automatic
// leaves all of that unchecked.
const MODE = process.argv[3] ?? 'automatic'

// A player is a yard across, so anything under this is two bodies in one place.
const MIN_GAP = 1.0
// The field, with the end zones, plus a hair of slack for the clamps.
const MIN_X = -0.5, MAX_X = FIELD.WIDTH + 0.5
const MIN_Y = -10.5, MAX_Y = FIELD.LENGTH + 0.5

const found = new Map()
function report(key, detail) {
  const row = found.get(key) ?? { n: 0, first: detail }
  row.n++
  found.set(key, row)
}

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

// ── Per-tick checks, run on the live field ────────────────────────────────
function checkTick(st, tag) {
  const all = [...st.offensePlayers.values(), ...st.defensePlayers.values()]

  for (const p of all) {
    if (!finite(p.x) || !finite(p.y)) { report('position is NaN', `${tag} ${p.id} (${p.x},${p.y})`); continue }
    if (!finite(p.vx ?? 0) || !finite(p.vy ?? 0)) report('velocity is NaN', `${tag} ${p.id}`)
    if (p.x < MIN_X || p.x > MAX_X) report('player off the side of the field', `${tag} ${p.id} x=${p.x.toFixed(1)}`)
    if (p.y < MIN_Y || p.y > MAX_Y) report('player off the end of the field', `${tag} ${p.id} y=${p.y.toFixed(1)}`)
    const speed = Math.hypot(p.vx ?? 0, p.vy ?? 0)
    // Nobody in football runs at 15 yards a second. A number above it is a physics escape.
    if (speed > 15) report('impossible speed', `${tag} ${p.id} ${speed.toFixed(1)} yd/s`)
  }

  // Coverage that points at nobody. The engine rushes anyone with no assignment, so a dangling
  // target is a free rusher AND an uncovered receiver, with nothing on screen to say so.
  for (const [id, cov] of st.defenseCoverage ?? []) {
    if (!st.defensePlayers.has(id)) { report('coverage for a defender not on the field', `${tag} ${id}`); continue }
    if (cov?.type === 'man' && cov.targetId && !st.offensePlayers.has(cov.targetId)) {
      report('man coverage on a receiver who is not there', `${tag} ${id} -> ${cov.targetId}`)
    }
    if (cov?.type === 'zone' && (!finite(cov.zoneCenterX) || !finite(cov.zoneCenterY))) {
      report('zone with no landmark', `${tag} ${id}`)
    }
  }

  // Two defenders told to cover the same man is a receiver nobody else has.
  const manTargets = new Map()
  for (const [id, cov] of st.defenseCoverage ?? []) {
    if (cov?.type !== 'man' || !cov.targetId) continue
    if (manTargets.has(cov.targetId)) {
      report('two defenders on the same receiver', `${tag} ${id} and ${manTargets.get(cov.targetId)} both on ${cov.targetId}`)
    }
    manTargets.set(cov.targetId, id)
  }
}

// ── Pre-snap checks ───────────────────────────────────────────────────────
function checkPreSnap(st, tag) {
  const off = [...st.offensePlayers.values()]
  const def = [...st.defensePlayers.values()]
  if (off.length && off.length !== 11) report(`offense fields ${off.length}, not 11`, tag)
  if (def.length && def.length !== 11) report(`defense fields ${def.length}, not 11`, tag)

  // Two bodies in one place, on either side.
  for (const side of [off, def]) {
    for (let i = 0; i < side.length; i++) {
      for (let j = i + 1; j < side.length; j++) {
        const d = Math.hypot(side[i].x - side[j].x, side[i].y - side[j].y)
        if (d < MIN_GAP) report('two team-mates in the same spot', `${tag} ${side[i].id}/${side[j].id} ${d.toFixed(2)}yd`)
      }
    }
  }

  // Offside: a defender across the line before the snap.
  const losY = st.direction === 1 ? st.yardLine + FIELD.END_ZONE_DEPTH : FIELD.LENGTH - FIELD.END_ZONE_DEPTH - st.yardLine
  for (const d of def) {
    if ((losY - d.y) * st.direction > 0.3) report('defender lined up offside', `${tag} ${d.id}`)
  }
  // …and an offensive player illegally downfield before the snap.
  for (const o of off) {
    if ((o.y - losY) * st.direction > 0.3) report('offensive player past the line pre-snap', `${tag} ${o.id}`)
  }
}

// ── Whistle-to-whistle checks ─────────────────────────────────────────────
function checkBetween(before, after, r, tag) {
  if (!finite(after.clock) || after.clock < 0) report('clock is negative or NaN', `${tag} ${after.clock}`)
  if (after.clock > before.clock && after.quarter === before.quarter) {
    report('clock went backwards within a quarter', `${tag} ${before.clock} -> ${after.clock}`)
  }
  if (!finite(after.yardLine) || after.yardLine < 0 || after.yardLine > 100) {
    report('ball off the field', `${tag} yardLine ${after.yardLine}`)
  }
  if (![1, 2, 3, 4].includes(after.down)) report('illegal down', `${tag} down ${after.down}`)
  if (!finite(after.distance) || after.distance <= 0) report('illegal distance', `${tag} distance ${after.distance}`)

  // A score can only move by the amounts football allows.
  for (const slot of [0, 1]) {
    const gained = (after.score?.[slot] ?? 0) - (before.score?.[slot] ?? 0)
    if (gained < 0) report('score went down', `${tag} slot ${slot}`)
    else if (gained && ![1, 2, 3, 6, 7, 8].includes(gained)) {
      report('impossible scoring play', `${tag} slot ${slot} +${gained}`)
    }
  }

  // A first down resets the chains; a failure does not.
  if (after.down === 1 && after.distance > RULES.FIRST_DOWN_YARDS + 0.001 && after.yardLine + after.distance < 100) {
    report('first and more than ten in open field', `${tag} 1 & ${after.distance.toFixed(1)}`)
  }
  if (r.outcome === 'hung') report('play never ended', tag)
  if (r.outcome === 'no_snap') report('offense never snapped it', `${tag} ${(r.problems ?? []).join('; ')}`)
  for (const p of r.problems ?? []) {
    if (!/never ended|never set|snap refused/.test(p)) report(`formation: ${p.replace(/\d+/g, 'N')}`, tag)
  }
}

// ── State that must not survive the whistle ──────────────────────────────
//
// Per-play flags are the quietest class of bug in this engine: nothing throws, the next play simply
// starts believing something about the last one. The coverage map surviving `startNextPlay` was
// exactly this, and it took a sweep to see it.
function checkHygiene(st, tag) {
  if (![0, 1].includes(st.possession)) report('possession is not a seat', `${tag} ${st.possession}`)

  for (const slot of [0, 1]) {
    const t = st.timeouts?.[slot]
    if (!finite(t) || t < 0 || t > 3) report('illegal timeout count', `${tag} slot ${slot} has ${t}`)
  }

  if (!finite(st.playClock) || st.playClock < 0 || st.playClock > RULES.PLAY_CLOCK_NEW_DRIVE + 0.001) {
    report('play clock out of range', `${tag} ${st.playClock}`)
  }
  if (!finite(st.quarter) || st.quarter < 1 || st.quarter > RULES.QUARTERS) {
    report('illegal quarter', `${tag} ${st.quarter}`)
  }

  // Everything below belongs to ONE play and must be gone by the next one.
  if (st.phase === PHASE.PRE_SNAP) {
    if (st.ballCarrierId) report('a ball carrier before the snap', `${tag} ${st.ballCarrierId}`)
    if (st.activeThrow) report('a throw still in the air pre-snap', tag)
    if (st.interceptionReturn) report('an interception return still flagged pre-snap', tag)
    if (st.qbScrambling) report('the quarterback still scrambling pre-snap', tag)
    if (st.pendingClockBurn) report('an unspent clock burn pre-snap', `${tag} ${st.pendingClockBurn}`)
    if (st.runAngleAdjusted) report('the run adjustment already used pre-snap', tag)
    for (const [id, cov] of st.defenseCoverage ?? []) {
      if (!st.defensePlayers.has(id)) report('coverage for a defender not on the field', `${tag} ${id}`)
    }
  }

  // A kick and a scrimmage play cannot both be happening.
  if (st.specialTeams && st.phase === PHASE.LIVE && !st.twoPointActive) {
    report('a kick is up while the ball is live', tag)
  }
}

// ── What each side is TOLD ────────────────────────────────────────────────
//
// ⚠️ "THE DEFENSE NEVER SEES THE PLAY CALL" is the oldest rule in this codebase and the easiest to
// break by accident — a field added to the wrong serializer leaks it with nothing to say so. So
// both viewers' payloads are inspected on every play rather than trusted.
function checkSerialization(st, tag) {
  for (const slot of [0, 1]) {
    let gs
    try { gs = serializeGameState(st, slot) } catch (err) {
      report(`serializeGameState threw: ${String(err?.message).slice(0, 60)}`, tag); continue
    }
    for (const [key, v] of Object.entries(gs)) {
      if (typeof v === 'number' && !Number.isFinite(v)) report(`game_state.${key} is not finite`, `${tag} slot ${slot}`)
    }
    const isDefender = st.possession !== slot
    if (isDefender) {
      if (gs.playType != null) report('the DEFENSE was told the play type', `${tag} ${gs.playType}`)
      if (gs.devReveal && gs.devReveal.play) report('the DEFENSE was given the offense play', tag)
    }

    let pos
    try { pos = serializePositions(st, slot) } catch (err) {
      report(`serializePositions threw: ${String(err?.message).slice(0, 60)}`, tag); continue
    }
    for (const p of pos) {
      if (!finite(p.x) || !finite(p.y)) report('serialized position is not finite', `${tag} ${p.id}`)
      if (p.openness != null && (p.openness < 0 || p.openness > 1 || !finite(p.openness))) {
        report('openness outside 0..1', `${tag} ${p.id} ${p.openness}`)
      }
      // A route is the play call. The defense may see WHERE somebody is, never where he is going.
      if (isDefender && (p.route != null || p.drawnRoute != null)) {
        report('the DEFENSE was sent a route', `${tag} ${p.id}`)
      }
    }
  }
}

// ── The sweep ─────────────────────────────────────────────────────────────
let played = 0, games = 0
const snapshot = (st) => ({ clock: st.clock, quarter: st.quarter, yardLine: st.yardLine, down: st.down, distance: st.distance, score: [...(st.score ?? [0, 0])] })

for (let g = 0; played < DOWNS; g++) {
  const ctx = createTrainingGame({ seed: 60000 + g, mode: MODE })
  games++
  try {
    for (let i = 0; i < 14 && played < DOWNS; i++) {
      const st = ctx.state
      // ⚠️ THE COMPUTER ANSWERS ITS OWN FOURTH DOWNS HERE. Forcing 'go_for_it' is convenient and
      // means punts, field goals and extra points are never swept at all — which is most of the
      // code that touches the score and the clock. Only a menu the AI leaves hanging is resolved.
      if (st.decisionPending) {
        const before = st.decisionPending
        ctx.seats[st.possession].emit('game_state', serializeGameState(st, st.possession))
        if (st.decisionPending === before) resolveDecision(st, ctx.io, 'go_for_it', { quiet: true })
      }
      const tag = `${MODE} g${g} d${i} (${st.down}&${Math.round(st.distance)} at ${Math.round(st.yardLine)})`
      checkSerialization(st, tag)
      checkHygiene(st, tag)

      const before = snapshot(st)
      // Tick-by-tick, through the harness's telemetry hook — it is handed the live state and must
      // not write to it, which is why nothing below assigns.
      const r = playDown(ctx, { onTick: (live) => checkTick(live, tag) })
      const after = getGame(ctx.roomId) ?? st
      if (r.ok || r.outcome !== 'no_snap') checkBetween(before, after, r, tag)
      played++
      if (!r.ok) break
      if (after.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      // The next play, once it is on the grass.
      const next = getGame(ctx.roomId)
      if (next?.phase === PHASE.PRE_SNAP) { checkPreSnap(next, tag); checkHygiene(next, `${tag} next`) }
    }
  } catch (err) {
    report(`THREW: ${String(err?.message ?? err).slice(0, 80)}`, `g${g}`)
  } finally {
    destroyTrainingGame(ctx)
  }
}

console.log(`\n── Swept ${played} ${MODE} downs across ${games} games ──\n`)
if (!found.size) {
  console.log('  nothing found.')
} else {
  const rows = [...found.entries()].sort((a, b) => b[1].n - a[1].n)
  for (const [key, row] of rows) {
    console.log(`  ${String(row.n).padStart(6)}  ${key}`)
    console.log(`          e.g. ${row.first}`)
  }
}
