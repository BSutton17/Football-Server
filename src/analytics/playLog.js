// ── Play-by-play analytics ([analytics]) ────────────────────────────────────
//
// A complete record of every play of every OFFLINE game, written as JSONL — one JSON object per
// play — so a real game can be read back afterwards and argued with, instead of diagnosing from
// memory of what it felt like.
//
// ⚠️ OFFLINE GAMES ONLY. A solo room is the one where both the question and the answer are ours:
// the human's opponent is the AI, so every decision in the file is a decision worth auditing.
// Recording a head-to-head would log a stranger's play calls to disk for no benefit.
//
// ⚠️ IT RESETS ON BOOT, WHICH IS ONCE PER DEPLOY. Heroku's filesystem is ephemeral, so the file
// does not survive a restart anyway — this makes that explicit rather than surprising, and means
// each push starts a clean report of the build it belongs to. The build's git SHA is stamped in
// the header so a report can never be mistaken for one from different code.
//
// ⚠️ IT MUST NEVER BREAK A GAME. Every entry point is wrapped: analytics failing is a lost report,
// not a lost play, and a thrown error inside the tick loop would take the room down.

import { appendFileSync, writeFileSync, mkdirSync, existsSync, readFileSync, statSync } from 'node:fs'
import { computeReceiverOpenness } from '../game/utils/openness.js'
import { isReceiverReady } from '../game/serialization.js'
import { RECEIVER_LABELS } from '../ai/knowledge.js'
import { ratingOf } from '../data/ratings.js'
import { join } from 'node:path'
import { execSync } from 'node:child_process'

const DIR = process.env.ANALYTICS_DIR ?? join(process.cwd(), 'analytics-output')
const FILE = join(DIR, 'plays.jsonl')
const META = join(DIR, 'meta.json')

// Off entirely with ANALYTICS=0, for anyone who does not want the write.
//
// ⚠️ AND OFF UNDER TEST UNLESS ASKED FOR. The suite builds solo games, so it recorded real
// plays into the repo's analytics-output and left a phantom play sitting at the top of the next
// real report, stamped with whatever commit the suite happened to run on. Tests should not write
// files as a side effect. ANALYTICS=1 turns it back on for a test that is actually about this.
const ENABLED = process.env.ANALYTICS === '1'
  ? true
  : (process.env.ANALYTICS !== '0' && process.env.NODE_ENV !== 'test')

// ⚠️ SAMPLE STRIDE, NOT EVERY TICK. 22 players at 20 Hz for a 5-second play is 2,200 position
// records a snap and about 130,000 a game; at a stride of 2 it is half that and nothing about the
// play is lost, since nobody crosses a meaningful distance in 50ms. Raise it if a file gets
// unwieldy; the ticks are stamped with real elapsed time so the stride never has to be guessed.
const TICK_STRIDE = Number(process.env.ANALYTICS_TICK_STRIDE ?? 2)

// A hard ceiling so a long session cannot fill the dyno's disk. Past it, plays stop being written
// and the header says so — silently truncating a report is worse than a short one.
const MAX_BYTES = Number(process.env.ANALYTICS_MAX_BYTES ?? 64 * 1024 * 1024)

let ready = false
let stopped = false
let written = 0

// ⚠️ THE BUILD HAS TO BE KNOWABLE BEFORE THE FIRST SNAP. meta.json is only written once recording
// starts, so "is the tracker up, and is it the code I just pushed?" was unanswerable until after a
// game had been played -- which is exactly the wrong way round for a pre-flight check.
//
// ⚠️ AND `git rev-parse` DOES NOT WORK ON A DYNO. The slug has no .git directory, so the SHA is
// only available where the repo is. HEROKU_SLUG_COMMIT covers it when dyno metadata is enabled;
// where neither works, the process START TIME still answers the real question — a server booted
// after the push is running the push.
const BOOT_AT = new Date().toISOString()
let BUILD_SHA = null
function buildSha() {
  if (BUILD_SHA !== null) return BUILD_SHA
  BUILD_SHA = process.env.HEROKU_SLUG_COMMIT?.slice(0, 7)
    ?? process.env.SOURCE_VERSION?.slice(0, 7)
    ?? (() => {
      try { return execSync('git rev-parse --short HEAD', { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim() }
      catch { return 'unknown' }
    })()
  return BUILD_SHA
}

export function buildInfo() {
  return { bootedAt: BOOT_AT, uptimeSeconds: Math.round(process.uptime()), commit: buildSha(), recording: ENABLED && !stopped }
}

const live = new Map()   // roomId -> the play being recorded

function boot() {
  if (ready || !ENABLED) return
  ready = true
  try {
    mkdirSync(DIR, { recursive: true })
    const sha = buildSha()
    const meta = { startedAt: new Date().toISOString(), commit: sha, tickStride: TICK_STRIDE, node: process.version }
    writeFileSync(META, JSON.stringify(meta, null, 2))
    writeFileSync(FILE, '')      // a new build gets a clean report
    console.log(`[analytics] recording offline play-by-play to ${FILE} (build ${sha}, stride ${TICK_STRIDE})`)
  } catch (err) {
    stopped = true
    console.warn(`[analytics] disabled: ${err.message}`)
  }
}

// Only solo rooms, and only once the file is usable.
export function isRecording(state) {
  if (!ENABLED || stopped) return false
  if (!state?.solo) return false
  boot()
  return !stopped
}

const r2 = (n) => (Number.isFinite(n) ? Math.round(n * 100) / 100 : null)

// ⚠️ PLAY NUMBERS RESTART EVERY GAME, because the counter lives on the game state. A report
// containing three games therefore had three plays numbered 1 and no way to tell them apart. The
// room id plus the moment the first record was written names a game uniquely.
function gameTag(state) {
  if (!state.analyticsGameTag) state.analyticsGameTag = `${state.roomId ?? 'room'}@${Date.now().toString(36)}`
  return state.analyticsGameTag
}

// Everything about one player, pre-snap: where he is, and what he was told to do.
function offenseSnapshot(state) {
  const out = []
  for (const p of state.offensePlayers?.values() ?? []) {
    out.push({
      id: p.id, label: p.label, x: r2(p.x), y: r2(p.y),
      route: p.route ?? null,
      // The drawn shape, which is the actual instruction — a route NAME does not say where it goes.
      drawnRoute: (p.drawnRoute ?? p.routeDrawn ?? null)?.map(w => ({ dx: r2(w.dx), dd: r2(w.dd) })) ?? null,
      routeTraits: p.routeTraits ?? null,
      routeDepthScale: r2(p.routeDepthScale),
      ...ratingsOf(p),
    })
  }
  return out
}

// Which side of his man a defender is standing on, from the ball's point of view: 'inside' is
// between the receiver and the ball, 'outside' is beyond him. Only meaningful in man coverage.
function shadeOf(p, c, state) {
  const targetId = c?.targetId
  if (!targetId) return null
  const man = state.offensePlayers?.get(targetId)
  if (!man) return null
  const ball = state.ballX ?? 26.67
  const dFromBall = Math.abs(p.x - ball)
  const mFromBall = Math.abs(man.x - ball)
  if (Math.abs(dFromBall - mFromBall) < 0.35) return 'head-up'
  return dFromBall < mFromBall ? 'inside' : 'outside'
}

// How far off that man he is, in yards, signed toward the ball. The number behind the word.
function leverageOf(p, c, state) {
  const man = c?.targetId ? state.offensePlayers?.get(c.targetId) : null
  if (!man) return null
  const ball = state.ballX ?? 26.67
  const sign = man.x >= ball ? 1 : -1
  return (man.x - p.x) * sign
}

// Every defender, plus the COVERAGE he was actually given — the job, the man, the zone's kind and
// where its middle sits. This is the part that answers "why was nobody covering the flat".
function defenseSnapshot(state) {
  const out = []
  const cov = state.defenseCoverage ?? new Map()
  for (const p of state.defensePlayers?.values() ?? []) {
    const c = cov.get(p.id) ?? {}
    // ⚠️ A LINEMAN IS NOT "NO ASSIGNMENT". `defenseCoverage` only holds men in coverage, so the
    // four down linemen came back with a null job -- a third of every row in the first real report
    // looked like missing data when it was just the pass rush.
    const rushing = !c.type && !c.job && (p.label === 'DL' || p.label === 'DE' || p.label === 'DT' || p.label === 'NT')
    out.push({
      id: p.id, label: p.label, x: r2(p.x), y: r2(p.y),
      job: c.type ?? c.job ?? (rushing ? 'rush' : null),   // the live map calls it `type`; shells call it `job`
      targetId: c.targetId ?? null,          // man coverage: who he has
      zoneType: c.zoneType ?? null,          // deep / flat / hook / curl ...
      zoneCenterX: r2(c.zoneCenterX),
      zoneCenterY: r2(c.zoneCenterY),
      zoneDepth: r2(c.zoneCenterY != null && state.yardLine != null ? Math.abs(c.zoneCenterY - state.yardLine) : null),
      manCommit: c.manCommit ?? null,
      // ⚠️ SHADE IS DERIVED, NOT STORED. There is no `shade` field on a pre-snap defender --
      // reading one recorded null for all 374 defenders in the first real report. What exists is
      // his position relative to the man he is covering, which is what a shade IS: inside or
      // outside leverage, measured from the ball.
      shade: shadeOf(p, c, state),
      leverage: r2(leverageOf(p, c, state)),
      ...ratingsOf(p),
    })
  }
  return out
}

// ⚠️ THE RATING THE SIM USED, NOT THE RAW FIELD. This logged `p.ratings?.speed ?? null`, and the
// engine does not read ratings that way -- `ratingOf` falls back to the POSITION BASELINE when a player
// has none. So a corner with no roster was recorded as `speed: null` while actually running at 90.
//
// That made `null` mean two different things, and the ambiguity hid a real bug for a whole game: every
// one of the computer's 332 player records came back with no speed, which reads as a logging gap and was
// in fact a synthetic roster (see ai/roster.js). `hasRatings` is what separates the two now -- the
// number is always what the simulation used, and the flag says whether it came from a real player.
function ratingsOf(p) {
  return {
    ovr: p.ratings?.ovr ?? null,
    speed: r2(ratingOf(p, 'speed')),
    hasRatings: !!p.ratings,
  }
}

// Every eligible receiver's openness, as the offense reads it.
function openness(state) {
  const out = []
  try {
    const defenders = [...(state.defensePlayers?.values() ?? [])]
    let qb = null
    for (const p of state.offensePlayers?.values() ?? []) if (p.label === 'QB') { qb = p; break }
    for (const p of state.offensePlayers?.values() ?? []) {
      if (!RECEIVER_LABELS.has(p.label)) continue
      const ready = isReceiverReady(p)
      out.push([p.id, ready ? r2(computeReceiverOpenness(p, defenders, qb)) : null, ready ? 1 : 0])
    }
  } catch { /* a sample is not worth a crash */ }
  return out
}

// Called at the snap. Opens a record; nothing is written until the whistle.
// What was CALLED, as opposed to what is on the field.
//
// ⚠️ THE AI'S BRAINS ARE NOT ON THE STATE -- they live in the controller's closure, attached to
// its socket. The controller stashes its call on the game as `aiCall`, beside the display string
// it already set there, and that is the only structured record of it.
function callOf(state) {
  const c = state.aiCall ?? {}
  return {
    playId: c.offense?.playId ?? null,
    // ⚠️ NO FALLBACK TO `aiCallName`. That string is shared: the controller writes the OFFENSIVE
    // call into it when the computer has the ball and the DEFENSIVE call when it does not. Falling
    // back to it meant every human-offense play in the first real report was labelled with the
    // computer's coverage -- "run COVER 1 / NICKEL WIDE" -- which reads like a play call and is not
    // one. A human's offense has no authored play, and null says so honestly.
    playName: c.offense?.playName ?? null,
    formationId: c.offense?.formationId ?? null,
    shellId: c.defense?.shellId ?? null,
    shellName: c.defense?.shellName ?? null,
    defFormationId: c.defense?.defFormationId ?? null,
    look: c.defense?.look ?? null,
  }
}

export function beginPlay(state, extra = null) {
  if (!isRecording(state)) return
  try {
    const call = state.playDesign ?? {}
    extra = extra ?? callOf(state)
    live.set(state.roomId, {
      play: (state.analyticsPlayNo = (state.analyticsPlayNo ?? 0) + 1),
      at: new Date().toISOString(),
      game: gameTag(state),
      kind: 'play',
      situation: {
        quarter: state.quarter, clock: r2(state.clock),
        down: state.down, distance: r2(state.distance), yardLine: r2(state.yardLine),
        score: Array.isArray(state.score) ? [...state.score] : state.score,
        possession: state.possession,
        mode: state.mode, difficulty: state.difficulty,
        ballX: r2(state.ballX),
      },
      offense: {
        playType: call.playType ?? null,
        runAngle: call.runAngle ?? null,
        playId: extra.playId ?? null,
        playName: extra.playName ?? null,
        formationId: extra.formationId ?? null,
        players: offenseSnapshot(state),
      },
      defense: {
        shellId: extra.shellId ?? null,
        shellName: extra.shellName ?? null,
        defFormationId: extra.defFormationId ?? null,
        look: extra.look ?? null,
        players: defenseSnapshot(state),
      },
      ticks: [],
      decisions: [],
      events: [],
      _tick: 0,
    })
  } catch { /* never break a play */ }
}

// Called every LIVE tick. Positions, openness, and who has the ball.
export function samplePlay(state) {
  const rec = live.get(state?.roomId)
  if (!rec) return
  try {
    if ((rec._tick++ % TICK_STRIDE) !== 0) return
    const t = r2(state.livePlayElapsed ?? 0)
    const pos = []
    for (const p of state.offensePlayers?.values() ?? []) pos.push([p.id, r2(p.x), r2(p.y)])
    for (const p of state.defensePlayers?.values() ?? []) pos.push([p.id, r2(p.x), r2(p.y)])
    rec.ticks.push({
      t,
      pos,
      // Per-receiver openness — the number the throw decision is made on. Computed here with the
      // engine's own function rather than read off a debug system that is normally switched off.
      open: openness(state),
      carrier: state.ballCarrierId ?? null,
      scrambling: !!state.qbScrambling,
      pressure: state.qbPressureCount ?? null,
    })
  } catch { /* never break a tick */ }
}

// An AI decision: what he saw, what the bar was, and what he did about it.
export function noteDecision(state, decision) {
  const rec = live.get(state?.roomId)
  if (!rec) return
  try { rec.decisions.push({ t: r2(state.livePlayElapsed ?? 0), ...decision }) } catch { /* ignore */ }
}

// Anything discrete: a throw, a catch, a sack, a scramble, a penalty.
export function noteEvent(state, type, data = {}) {
  const rec = live.get(state?.roomId)
  if (!rec) return
  try { rec.events.push({ t: r2(state.livePlayElapsed ?? 0), type, ...data }) } catch { /* ignore */ }
}

// Called at the whistle. Writes the play and closes the record.
export function endPlay(state, result = {}) {
  const rec = live.get(state?.roomId)
  if (!rec) return
  live.delete(state.roomId)
  if (stopped) return
  try {
    // The two numbers any analysis starts from. Derived here rather than left to the reader:
    // `yards` is the field-position delta across the play, and `outcome` is the last terminal
    // event the engine fired -- the events array has the whole sequence if the detail is wanted.
    // ⚠️ THE LAST TERMINAL EVENT IS NOT THE OUTCOME, AND A REAL GAME'S REPORT LOGGED A PICK AS A
    // TACKLE BECAUSE OF IT. An interception fires THROW -> INTERCEPTION -> TACKLE: the tackle ends the
    // RETURN, not the play, so reading backwards found it and the record said "TACKLE". The only hint
    // that anything had happened was `yards: null`, and anybody counting interceptions off this file
    // would have counted none.
    //
    // So the outcome is the most DEFINING event in the sequence rather than the last one. A turnover or
    // a score defines a play whatever happens afterwards; a sack outranks the tackle that is part of
    // it; the ordinary endings come last.
    const PRECEDENCE = ['TOUCHDOWN', 'SAFETY', 'INTERCEPTION', 'TURNOVER_ON_DOWNS', 'SACK', 'OUT_OF_BOUNDS', 'PASS_INCOMPLETE', 'TACKLE']
    const seen = new Set(rec.events.map(e => e.type))
    const outcome = PRECEDENCE.find(t => seen.has(t)) ?? null
    rec.result = {
      ...result,
      outcome,
      // ⚠️ AND WHETHER THE BALL CHANGED HANDS IS STATED, not left to be inferred from a null.
      // A SAFETY is resolved inside onSack/onTackle without enqueuing an event of its own, so it cannot
      // be NAMED here — a real game produced a record reading `TACKLE` on 1st and 10 from the offense's
      // own 1, with possession flipped and nothing else to say so. This flag is what makes that visible.
      possessionChanged: state.possession !== rec.situation.possession,
      // ⚠️ END MINUS START IS ONLY THE GAIN WHEN THE DRIVE SURVIVES THE PLAY. A touchdown resets
      // the field for the kickoff and a turnover flips the frame, so the raw delta read 0 on a
      // 19-yard scoring run and something meaningless on a pick. Scores are measured to the goal
      // line; a change of possession gets null rather than a number that looks real and is not.
      yards: (() => {
        const start = rec.situation.yardLine ?? 0
        if (outcome === 'TOUCHDOWN') return r2(100 - start)
        if (state.possession !== rec.situation.possession) return null
        return r2((state.yardLine ?? 0) - start)
      })(),
      endDown: state.down, endDistance: r2(state.distance), endYardLine: r2(state.yardLine),
      endScore: Array.isArray(state.score) ? [...state.score] : state.score,
      endPossession: state.possession,
      ticksRecorded: rec.ticks.length,
    }
    delete rec._tick
    if (written > MAX_BYTES) {
      if (!stopped) { stopped = true; console.warn(`[analytics] stopped: ${FILE} passed ${MAX_BYTES} bytes`) }
      return
    }
    const line = JSON.stringify(rec) + '\n'
    written += Buffer.byteLength(line)
    appendFileSync(FILE, line)
  } catch (err) {
    console.warn(`[analytics] write failed: ${err.message}`)
  }
}

// ── Special teams ───────────────────────────────────────────────────────────
//
// ⚠️ A KICK IS NOT A PLAY, AND THE REPORT COULD NOT SEE ONE. Every record is opened at the snap
// and written at the whistle, both hooked on the LIVE -> DEAD transition. Special teams never enters
// LIVE: a punt or a field goal is resolved out of PRE_SNAP by the kick clock. So the first real
// report contained no kick of any kind -- the event types in a whole quarter were THROW,
// PASS_COMPLETE, PASS_INCOMPLETE, SACK, TACKLE and TOUCHDOWN, nothing else.
//
// That mattered the moment a punt misbehaved in a real game and there was nothing in the file to
// look at. A kick gets its own record, written when it resolves.
export function recordKick(state, kick) {
  if (!isRecording(state)) return
  if (stopped) return
  try {
    const rec = {
      play: (state.analyticsPlayNo = (state.analyticsPlayNo ?? 0) + 1),
      at: new Date().toISOString(),
      game: gameTag(state),
      kind: 'kick',
      situation: {
        quarter: state.quarter, clock: r2(state.clock),
        down: state.down, distance: r2(state.distance), yardLine: r2(state.yardLine),
        score: Array.isArray(state.score) ? [...state.score] : state.score,
        possession: state.possession, mode: state.mode, difficulty: state.difficulty,
      },
      kick,
    }
    const line = JSON.stringify(rec) + '\n'
    written += Buffer.byteLength(line)
    appendFileSync(FILE, line)
  } catch (err) {
    console.warn(`[analytics] kick write failed: ${err.message}`)
  }
}

// A room went away mid-play: drop it rather than leaking the record.
export function dropPlay(roomId) { live.delete(roomId) }

// ── Reading it back ─────────────────────────────────────────────────────────
export function analyticsPaths() { return { dir: DIR, file: FILE, meta: META } }

export function analyticsSummary() {
  if (!existsSync(FILE)) return { exists: false, plays: 0, bytes: 0, meta: null }
  const bytes = statSync(FILE).size
  let plays = 0
  try {
    const raw = readFileSync(FILE, 'utf8')
    plays = raw ? raw.split('\n').filter(Boolean).length : 0
  } catch { /* size alone is still useful */ }
  let meta = null
  try { meta = JSON.parse(readFileSync(META, 'utf8')) } catch { /* fine */ }
  return { exists: true, plays, bytes, meta, stopped }
}
