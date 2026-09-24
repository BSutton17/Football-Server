// ── AI vs AI ([training]) ────────────────────────────────────────────────────
//
// A whole game with nobody watching: two virtual seats, no sockets, no timers. This is the thing
// training could not happen without — `createSoloRoom` seats exactly one computer against one
// human, so until now there was no way to run a play unattended.
//
// It is built out of the SAME parts a real game is: the real handlers, the real validators, the
// real tick. The only substitutions are the transport (a fake io) and the clock (an explicit
// loop). That is deliberate and it is the whole value of the thing — a training run that does not
// exercise the real engine teaches the AI to play a game nobody is shipping.
//
// Two things here are training-only and are marked as such:
//   • the SITUATION is written straight onto the game state (a slate has to be able to say
//     "3rd and 8 from the opponent's 35"), and
//   • the snap is fired directly rather than waiting out the countdown's real setTimeout chain.
// Everything else goes through the ordinary path.

import { createRoom, joinRoom, getRoom, leaveRoomBySlot } from '../game/roomManager.js'
import { initGame, getGame, deleteGame, resetPlay, getLosY } from '../game/gameState.js'
import { beginTeamSelect, clearTeamSelect } from '../game/teamSelect.js'
import { serializeGameState } from '../game/serialization.js'
import { callOffense, chooseRunAngle } from '../ai/offense.js'
import { PHASE, transition } from '../game/stateMachine.js'
import { stopGameLoop } from '../game/simulation.js'
import { makeRng } from '../game/utils/rng.js'
import { FIELD, HASH } from '../constants.js'

import { createVirtualSocket } from '../ai/virtualSocket.js'
import { registerAiSeat, clearAiSeats } from '../ai/seats.js'
import { createController } from '../ai/controller.js'
import { syntheticRoster } from '../ai/roster.js'

import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'

import { createFakeIo, stepUntil } from '../headless/harness.js'

// A play that has not ended in this many ticks is not going to. 40 seconds of game time is far
// beyond any real play, so hitting it means something is wrong — and the runner reports it rather
// than hanging, which is how a stuck play used to take the whole suite down.
const MAX_PLAY_TICKS = 800

// How long to wait for the two brains to finish lining up. Each is a cascade of synchronous event
// handlers, so this is a safety net against a controller that never sets, not a real delay.
const MAX_SETUP_ROUNDS = 6

let nextRoom = 1

// Stands up a game with a computer in BOTH seats.
//
//   seed        — makes the whole game replayable, including both AIs' decisions.
//   controllers — optionally override either brain (this is where a NEAT genome plugs in).
// ⚠️ THE TIER TRAINING RUNS AT, and it is not 'easy'.
//
// difficulty is a HANDICAP on the AI (ai/difficulty.js): easy gives the offense a noisy read of the
// field and a bad clock, and holds the defense to four vanilla shells. Training at easy would mean
// evolving a coordinator against a quarterback who misreads his receivers — it would learn to beat
// a bad passer, and the number on the screen would say it was working.
//
// Hard is also the tier a trained champion is INSTALLED into, so the exam and the job are the same.
// Everything downstream (the baseline that sets par, the rotating slate, the holdout) uses this.
export const TRAINING_DIFFICULTY = 'hard'

export function createTrainingGame({
  seed = 1,
  mode = 'automatic',
  difficulty = TRAINING_DIFFICULTY,
  rosters = null,
  controllers = {},
} = {}) {
  const roomId = String(9000 + (nextRoom++ % 900))
  const io = createFakeIo()
  const rng = makeRng(seed)

  // `solo: true` so the ROOM keeps the requested difficulty in automatic mode too; otherwise the
  // room says 'easy' while the game state says 'hard' and the two disagree for no good reason.
  const created = createRoom(roomId, `ai:${roomId}:0`, { mode, difficulty, seed, solo: true })
  if (created.error) throw new Error(`training room ${roomId}: ${created.error}`)

  const seats = [0, 1].map(slot => {
    const socket = createVirtualSocket(roomId, { slot, role: slot === 0 ? 'offense' : 'defense' })
    registerAiSeat(socket)
    registerRoomHandlers(io, socket)
    registerTeamSelectHandlers(io, socket)
    registerGameHandlers(io, socket)
    socket.data.roomId = roomId
    return socket
  })

  // Seat 0 created the room; seat 1 joins it, which is what assigns who opens on offense.
  const joined = joinRoom(roomId, seats[1].id, { mode, rng })
  if (joined.error) throw new Error(`training room ${roomId} join: ${joined.error}`)

  // Team selection exists to pick rosters, and a training game has no logos to choose between —
  // so it is begun and immediately cleared, and the game state is built directly. Going through
  // lock_team would work too but costs a round trip per game for nothing.
  beginTeamSelect(roomId)
  clearTeamSelect(roomId)

  const room = getRoom(roomId)
  const state = initGame(roomId, room.offenseSlot ?? 0, { mode, difficulty, seed })
  state.teams = ['AI0', 'AI1']

  // Brains. Each gets its own random stream so one seat's choices never shift the other's.
  const brains = seats.map((socket, slot) => {
    const supplied = controllers[slot]
    const brain = supplied ?? createController({
      socket,
      slot,
      roster: rosters?.[slot] ?? syntheticRoster(`ai${slot}`),
      seed: (seed ^ (slot === 0 ? 0x1f3b5d7 : 0x7d5b3f1)) >>> 0,
    })
    socket.onEventHandler = brain
    return brain
  })

  // Route each seat's inbox to its brain. createVirtualSocket captured `onEvent` at construction,
  // so the brains are attached by replacing `emit` — the same shape, just resolved later.
  seats.forEach((socket, slot) => {
    socket.emit = (event, payload) => {
      try { brains[slot].onEvent(event, payload) }
      catch (err) { console.error(`[training] seat ${slot} failed on ${event}:`, err?.message ?? err) }
    }
  })

  return { roomId, io, seats, brains, state, rng }
}

export function destroyTrainingGame(ctx) {
  clearAiSeats(ctx.roomId)
  if (getRoom(ctx.roomId)) { leaveRoomBySlot(ctx.roomId, 0); leaveRoomBySlot(ctx.roomId, 1) }
  stopGameLoop(ctx.roomId)
  deleteGame(ctx.roomId)
  clearTeamSelect(ctx.roomId)
}

// ── Running one play ──────────────────────────────────────────────────────────

// Writes a situation onto the game state. TRAINING ONLY — a slate has to be able to say "3rd and 8
// from the opponent's 35 with two minutes left", and no ordinary code path can put a game there.
export function applySituation(state, s) {
  resetPlay(state)
  state.possession = s.possession ?? state.possession
  state.direction = state.possession === 0 ? 1 : -1
  state.down = s.down ?? 1
  state.distance = s.distance ?? 10
  state.yardLine = s.yardLine ?? 25
  state.ballX = s.ballX ?? FIELD.WIDTH / 2
  state.quarter = s.quarter ?? 1
  state.clock = s.clock ?? 600
  state.score = s.score ? [...s.score] : [0, 0]
  state.newDrive = false
  state.playSerial = (state.playSerial ?? 0) + 1
  return state
}

// The hashes a ball can actually be spotted on, plus the middle. A slate that only ever used the
// middle would have missed the worst bug this AI has had — a formation pinned to FIELD.WIDTH/2
// while the real ball sat on a hash thirteen yards away.
export const HASHES = [HASH?.LEFT ?? FIELD.WIDTH * 0.25, FIELD.WIDTH / 2, HASH?.RIGHT ?? FIELD.WIDTH * 0.75]

// Runs ONE play from a situation and reports what happened.
//
// Returns { yards, ticks, outcome, ok, problems } — `problems` is the interesting field. A training
// harness that only reports yardage will happily average over a broken game, so every play is
// checked for the things that should never be true, and they come back with the result.
export function runPlay(ctx, situation) {
  const { io, state, seats } = ctx
  applySituation(state, situation)

  const startYardLine = state.yardLine
  const offenseSlot = state.possession
  const defenseSlot = 1 - offenseSlot

  // ⚠️ THE DEFENSE IS TOLD FIRST, AND THE ORDER IS LOAD-BEARING.
  //
  // A brain acts SYNCHRONOUSLY inside its own emit. So if the offense hears the new situation
  // first, it places all five receivers before the defense has heard anything — and the defense's
  // `game_state` then arrives as a NEW PLAY, which clears the picture it had just been given.
  // It lines up against an empty field and puts nobody out.
  //
  // Over a real network both clients get the play boundary before either can act, so this is an
  // artifact of delivering in-process rather than a bug in the AI. Telling the defense first
  // reproduces the real ordering.
  // [curriculum] A situation may DEMAND a run. Applied here rather than inside any one brain so it
  // binds the heuristic and every trained offense identically — and so the baseline measures par
  // against the same forcing the genomes face.
  if (situation.forcePlayType) {
    const off = seats[offenseSlot].onEventHandler ?? ctx.brains[offenseSlot]
    if (off) {
      const inner = off.overrideOffensiveCall
      off.overrideOffensiveCall = (k, rng, ballX) => {
        const call = inner ? inner(k, rng, ballX) : callOffense(k, rng, ballX)
        if (situation.forcePlayType !== 'run') return { ...call, playType: situation.forcePlayType }
        // A run needs a lane; a call that was going to be a pass carries no angle.
        const lane = chooseRunAngle(k, ballX, rng)
        return { ...call, playType: 'run', conceptId: null, conceptName: null, runAngle: lane.angle }
      }
    }
  }

  io.clear()
  seats[defenseSlot].emit('game_state', serializeGameState(state, defenseSlot))
  seats[offenseSlot].emit('game_state', serializeGameState(state, offenseSlot))

  // Nudge the play clock down so the offense stops waiting for its randomly chosen set moment.
  // (Training only — in a real game this is the point of the wait.)
  for (let i = 0; i < MAX_SETUP_ROUNDS && state.phase === PHASE.PRE_SNAP; i++) {
    seats[offenseSlot].emit('play_clock_update', { playClock: 3 })
  }

  const problems = []
  if (state.phase !== PHASE.COUNTDOWN) {
    problems.push(`offense never set (phase ${state.phase})`)
    return { yards: 0, ticks: 0, outcome: 'no_snap', ok: false, problems, startYardLine }
  }

  // Snap. Fired directly rather than waiting out the countdown's real setTimeout chain.
  seats[offenseSlot].fire('snap_ball')
  if (state.phase !== PHASE.LIVE) {
    problems.push('snap refused')
    return { yards: 0, ticks: 0, outcome: 'no_snap', ok: false, problems, startYardLine }
  }

  // ⚠️ Inspected AFTER the snap, not before. The five linemen and the quarterback are not placed
  // by anyone — they ride in the `set_offense` payload and only reach `state.offensePlayers` when
  // `initLivePhase` runs at the snap. Checking at COUNTDOWN counts five offensive players and
  // reports a formation bug on every single play.
  problems.push(...inspectFormation(state))

  // [spacing] How bunched the coverage is at the snap. Measured here because alignment is the one
  // thing the pre-snap brain actually controls; where defenders end up later is the engine's doing.
  const crowded = countCrowdedDefenders(state)

  const ticks = stepUntil(ctx.roomId, io, s => s.phase !== PHASE.LIVE, { maxTicks: MAX_PLAY_TICKS })
  const after = getGame(ctx.roomId)

  if (ticks === -1) {
    problems.push(`play never ended in ${MAX_PLAY_TICKS} ticks`)
    return { yards: 0, ticks: MAX_PLAY_TICKS, outcome: 'hung', ok: false, problems, startYardLine }
  }

  // Yardage from the OFFENSE's point of view. A turnover flips possession, so the reading has to
  // be taken against who had the ball when the play started, not who has it now.
  const endYardLine = after.possession === offenseSlot ? after.yardLine : 100 - after.yardLine
  const yards = endYardLine - startYardLine
  const turnover = after.possession !== offenseSlot

  return {
    yards,
    ticks,
    turnover,
    ...classify(io, ctx, offenseSlot, yards),
    crowded,
    ok: problems.length === 0,
    problems,
    startYardLine,
    offenseSlot,
    defenseSlot,
  }
}

// ── Bunched coverage ([spacing]) ─────────────────────────────────────────────
//
// Pairs of COVERAGE defenders standing on top of each other at the snap. Two men occupying one
// patch of grass cover one patch of grass, and the field they left is the field the offense throws
// into — so this is a real defensive failing that yardage alone punishes only slowly and noisily.
//
// ⚠️ THE FOUR DOWN LINEMEN ARE EXCLUDED, and not as a convenience. They are auto-placed at fixed
// spots exactly 2.0 yards apart (see autoDefense in ai/controller.js), so any threshold at or above
// that flags the standard front on every single snap. They are also not the brain's decision, and
// penalising a genome for something it did not choose teaches it nothing.
const CROWD_DISTANCE = 2.2      // yards; closer than this and two defenders are effectively one

export function countCrowdedDefenders(state) {
  const cover = [...state.defensePlayers.values()].filter(d => !String(d.id).startsWith('auto_dl'))
  let pairs = 0
  for (let i = 0; i < cover.length; i++) {
    for (let j = i + 1; j < cover.length; j++) {
      const dx = cover[i].x - cover[j].x
      const dy = cover[i].y - cover[j].y
      if (dx * dx + dy * dy < CROWD_DISTANCE * CROWD_DISTANCE) pairs++
    }
  }
  return pairs
}

// ⚠️ THE ENGINE HAS NO `pass_complete`, `sack` OR `interception` EVENT. Every scrimmage outcome
// arrives on ONE event, `play_result`, whose `outcome` is one of:
//   incomplete | interception | tackle | touchdown | safety | punt | field_goal | extra_point
// A CAUGHT pass that is then tackled reports as `tackle` — completion is not a distinct outcome,
// and neither is a sack. The first version of this guessed at event names that do not exist, so
// almost every play fell through to "tackle" and the reported completion rate was really just the
// touchdown rate. A fitness function fed on that would have been scoring noise.
//
// So the classification is DERIVED: `play_result` says how the play ended, `pass_thrown` says
// whether the ball ever left the quarterback's hand, and the offense's own call says what it was
// trying to do.
function classify(io, ctx, offenseSlot, yards) {
  const result = io.of('play_result').at(-1)?.payload
  const outcome = result?.outcome ?? 'unknown'
  const threw = io.of('pass_thrown').length > 0
  const playType = ctx.brains[offenseSlot]?.lastCall?.playType ?? 'unknown'
  const isPassPlay = playType === 'pass' || playType === 'rpo'

  return {
    outcome,
    detail: result?.detail ?? null,
    threw,
    playType,
    // The ball was caught and the play carried on from there.
    completed: threw && (outcome === 'tackle' || outcome === 'touchdown'),
    // A pass play that lost yards with the ball never thrown is a sack. The engine reports it as an
    // ordinary tackle, so there is nothing else to key off.
    sacked: isPassPlay && !threw && outcome === 'tackle' && yards < 0,
    firstDown: !!result?.firstDown,
  }
}

// ── The integrity check ───────────────────────────────────────────────────────
//
// What must be true of any legal pre-snap picture. This is the part that earns the harness its
// keep: thousands of unattended plays check these every time, and they are exactly the class of
// thing a person cannot see by playing — a line two yards off the ball, a twelfth man, a defender
// with no assignment quietly rushing the passer.
export function inspectFormation(state) {
  const problems = []
  const losY = getLosY(state)
  const dir = state.direction
  const offense = [...state.offensePlayers.values()]
  const defense = [...state.defensePlayers.values()]

  if (offense.length !== 11) problems.push(`offense has ${offense.length} players, not 11`)
  if (defense.length !== 11) problems.push(`defense has ${defense.length} players, not 11`)

  // Nobody across the line before the snap.
  for (const p of offense) {
    if ((p.y - losY) * dir > 0.1) problems.push(`offense ${p.id} (${p.label}) is across the LOS`)
  }
  for (const p of defense) {
    if ((p.y - losY) * dir < -0.1) problems.push(`defense ${p.id} (${p.label}) is offside`)
  }

  // ⚠️ The line must be ON THE BALL. This is the check that would have caught the ballX bug
  // immediately: the AI pinned its formation to the middle of the field while the ball sat on a
  // hash, so the whole line was up to thirteen yards from where it belonged.
  const ballX = state.ballX ?? FIELD.WIDTH / 2
  const ol = offense.filter(p => p.label === 'OL')
  if (ol.length === 5) {
    const centre = ol.reduce((a, p) => a + p.x, 0) / 5
    if (Math.abs(centre - ballX) > 2) {
      problems.push(`offensive line is centred on ${centre.toFixed(1)}, ball is on ${ballX.toFixed(1)}`)
    }
  }
  const dl = defense.filter(p => p.label === 'DL')
  if (dl.length === 4) {
    const centre = dl.reduce((a, p) => a + p.x, 0) / 4
    if (Math.abs(centre - ballX) > 2.5) {
      problems.push(`defensive front is centred on ${centre.toFixed(1)}, ball is on ${ballX.toFixed(1)}`)
    }
  }

  // Every coverage player needs a job. The engine rushes anyone it has no assignment for, so a
  // forgotten defender is an unplanned blitzer AND a hole where he was standing.
  for (const p of defense) {
    if (p.label === 'DL') continue
    if (!state.defenseCoverage.has(p.id)) problems.push(`defender ${p.id} (${p.label}) has no assignment`)
  }

  // Nobody stacked on anybody.
  const all = [...offense, ...defense]
  for (let i = 0; i < all.length; i++) {
    for (let j = i + 1; j < all.length; j++) {
      if (all[i].team === all[j].team) continue
      const gap = Math.hypot(all[i].x - all[j].x, all[i].y - all[j].y)
      if (gap < 0.3) problems.push(`${all[i].id} and ${all[j].id} are on the same spot`)
    }
  }

  // Duplicate ids across the two maps — one way a "twelfth man" can appear on screen.
  const ids = new Set()
  for (const p of all) {
    if (ids.has(p.id)) problems.push(`duplicate player id ${p.id}`)
    ids.add(p.id)
  }

  return problems
}
