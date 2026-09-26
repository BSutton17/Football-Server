// ── Solving the playbook ([authored]) ───────────────────────────────────────
//
//   npm run solve [samplesPerCell] [buckets]
//   FRESH=1 ...   ignore a saved run and start over
//
// Plays authored plays against authored shells in the real engine, situation by situation, and
// turns the results into the table `select.js` reads.
//
// ⚠️ IT SOLVES THE BUCKETS THAT ACTUALLY HAPPEN. Measured over real drives, 21 situation buckets
// occur at all and NINE cover 90% of snaps. Spreading the same compute evenly over all 48 would
// buy precision in fourth-and-sixteen-on-the-goal-line — which happens approximately never — at
// the cost of first-and-ten, which is a third of the game. Buckets left unsolved keep the prior,
// which the selector already falls back to cleanly.
//
// ⚠️ CHECKPOINTS EVERY 100,000 DOWNS. An earlier overnight run lost ~50 generations because the
// machine turned off and the resumable state lagged, so this used to save after EVERY subgame —
// 204 of them, each rewriting ~1.6 MB of state and rebuilt table. That is a third of a gigabyte of
// writes per shard for work that is only ever read once, and with six shards running it is the
// noisiest thing on the disk.
//
// A hundred thousand downs is a few minutes of work and the most a crash can cost. The table is no
// longer rebuilt on every save either: it is pure post-processing over the subgames, so it is
// written once at the end, and `mergeSolve` rebuilds it from the saved state anyway.

import { writeFileSync, readFileSync, existsSync, mkdirSync, renameSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadPlaybook } from '../playbook/store.js'
import { createTrainingGame, destroyTrainingGame, playDown } from './game.js'
import { startNextPlay, resolveDecision } from '../game/eventQueue.js'
import { PHASE } from '../game/stateMachine.js'
import { playValue, solveSubgame, buildTable } from '../ai/playcall/solve.js'
import { situationKey, describeSituation } from '../ai/playcall/situation.js'

const SAMPLES = Number(process.argv[2] ?? 8)
const MAX_BUCKETS = Number(process.argv[3] ?? 12)

const dir = process.env.SOLVE_DIR ?? 'training-output/solve'
mkdirSync(dir, { recursive: true })
const statePath = join(dir, 'state.json')
const tablePath = join(dir, 'table.json')
const logPath = join(dir, 'progress.log')

// The process writes its own log — never pipe this through grep or tee. A dead downstream stage
// fills the stdout pipe and every console.log then BLOCKS, which looks exactly like a healthy
// process doing nothing.
const NOISE = /^\[(game|ai|line|solo|socket|halftime)/
const realLog = console.log.bind(console)
console.log = (...args) => {
  const line = args.join(' ')
  if (NOISE.test(line)) return
  realLog(line)
  try { appendFileSync(logPath, line + String.fromCharCode(10)) } catch { /* never stop a run */ }
}

function saveJson(path, data) {
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(data))
  renameSync(tmp, path)        // atomic: a truncated table would be worse than none
}

// ── The situations worth solving ────────────────────────────────────────────
//
// Measured rather than assumed: play real drives and count where snaps actually land.
function realSituations(limit) {
  const seen = new Map()
  for (let g = 0; g < 40; g++) {
    const ctx = createTrainingGame({ seed: 5000 + g })
    try {
      for (let i = 0; i < 12; i++) {
        const st = ctx.state
        const key = situationKey({ down: st.down, distance: st.distance, yardLine: st.yardLine })
        if (!seen.has(key)) seen.set(key, { key, n: 0, sample: { down: st.down, distance: st.distance, yardLine: st.yardLine } })
        seen.get(key).n++
        if (!playDown(ctx, {}).ok) break
        if (st.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
        if (st.decisionPending) break
      }
    } finally { destroyTrainingGame(ctx) }
  }
  return [...seen.values()].sort((a, b) => b.n - a.n).slice(0, limit)
}

// ── What a possession is worth, measured ────────────────────────────────────
//
// The one constant in the value function that is not raw yardage. Measured from the engine so a
// turnover is charged what losing the ball actually costs here, rather than a number I picked.
function measurePossessionValue() {
  // ⚠️ THE DRIVE HAS TO BE ALLOWED TO FINISH. Stopping at the fourth-down menu ends every drive
  // after three plays and measured a possession at 8 yards — which would have charged a turnover
  // about one first down, when losing the ball plainly costs far more than that. The menu is
  // answered so the drive runs to a real conclusion.
  let yards = 0, drives = 0
  for (let g = 0; g < 16; g++) {
    const ctx = createTrainingGame({ seed: 6000 + g })
    try {
      const start = ctx.state.yardLine
      let last = start
      const openingSlot = ctx.state.possession
      for (let i = 0; i < 40; i++) {
        if (ctx.state.decisionPending) resolveDecision(ctx.state, ctx.io, 'go_for_it', { quiet: true })
        const r = playDown(ctx, {})
        if (!r.ok) break
        // The drive is over when the ball changes hands, however it happened.
        if (ctx.state.possession !== openingSlot) break
        last = ctx.state.yardLine
        if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      }
      yards += Math.max(0, last - start)
      drives++
    } finally { destroyTrainingGame(ctx) }
  }
  return drives ? Math.max(1, yards / drives) : 25
}

// ── One matchup ─────────────────────────────────────────────────────────────
//
// Force a specific play against a specific shell from a specific spot, and report what happened.
function samplePlay({ situation, playId, shellId, seed, possessionValue }) {
  const ctx = createTrainingGame({ seed })
  try {
    const st = ctx.state
    st.down = situation.down
    st.distance = situation.distance
    st.yardLine = situation.yardLine

    // The same seam the measurement tools use: replace the CALL and inherit everything else — the
    // legality clamps, the alignment, the hash — so a forced call is as legal as a chosen one.
    //
    // ⚠️ WHICH SEAT HAS THE BALL IS DECIDED BY THE SEED, NOT BY SLOT 0. This forced the play onto
    // brain 0 and the shell onto brain 1 unconditionally, and about 38% of seeds open with slot 1
    // on offense — so in better than a third of every cell's samples the play went to the DEFENSE
    // and the shell to the OFFENSE. Both were ignored, the down was played with two freely chosen
    // calls, and the result was recorded as the value of a matchup that never happened.
    //
    // Nothing about it looked wrong from outside: the play ran, `ok` came back true, and a
    // perfectly ordinary number went into the payoff matrix.
    const offense = ctx.state.possession
    ctx.brains[offense].forceAuthoredPlay = playId
    ctx.brains[1 - offense].forceAuthoredShell = shellId

    const r = playDown(ctx, {})
    if (!r.ok) return null
    return playValue({
      yards: r.yards ?? 0,
      turnover: !!r.turnover,
      touchdown: r.outcome === 'touchdown',
      firstDown: (r.yards ?? 0) >= situation.distance,
      // Without the down, failing to convert is free — see playValue.
      down: situation.down,
    }, { possessionValue })
  } catch {
    return null
  } finally {
    destroyTrainingGame(ctx)
  }
}

// ── Run ─────────────────────────────────────────────────────────────────────

const book = loadPlaybook()
const plays = Object.entries(book.plays).map(([id, p]) => ({ ...p, id }))
const shells = Object.entries(book.shells).map(([id, s]) => ({ ...s, id }))
const byFormation = new Map()
for (const p of plays) {
  if (!byFormation.has(p.formationId)) byFormation.set(p.formationId, [])
  byFormation.get(p.formationId).push(p)
}

// The run/pass split is set from the situation rather than left to the solve — see withRunShare.
const playType = (id) => (book.plays[id]?.playType === 'run' ? 'run' : 'pass')

console.log(`[solve] ${plays.length} plays across ${byFormation.size} formations, ${shells.length} shells`)

let done = []
if (!process.env.FRESH && existsSync(statePath)) {
  try {
    const saved = JSON.parse(readFileSync(statePath, 'utf8'))
    done = saved.subgames ?? []
    console.log(`[solve] RESUMING with ${done.length} subgame(s) already solved`)
  } catch (err) {
    console.log(`[solve] saved state unreadable (${err.message}); starting over`)
  }
}
const alreadyDone = new Set(done.map(d => `${d.situation}|${d.formation}`))

console.log('[solve] measuring what a possession is worth...')
const possessionValue = measurePossessionValue()
console.log(`[solve] a possession is worth ${possessionValue.toFixed(1)} yards in this engine`)

console.log('[solve] measuring which situations actually happen...')
const allSituations = realSituations(MAX_BUCKETS)

// ── Sharding ───────────────────────────────────────────────────────────
//
// SHARD=i/n solves every nth bucket starting at i, so n copies of this can run side by side on a
// machine with cores to spare. One pass over the real playbook takes hours on a single core and
// the buckets do not interact — each is its own game — so this is close to free speed.
//
// ⚠️ EACH SHARD NEEDS ITS OWN SOLVE_DIR. They checkpoint to `state.json` by name; pointed at the
// same directory they would overwrite each other's work, and the last one to finish would look
// like a complete solve while holding a twelfth of it. `scripts/mergeSolve.mjs` puts them back
// together.
//
// The bucket list itself is measured from fixed seeds, so every shard derives the SAME ordered
// list and the slices line up without the shards having to agree on anything at run time.
const SHARD = process.env.SHARD ?? null
let situations = allSituations
if (SHARD) {
  const [iRaw, nRaw] = SHARD.split('/')
  const index = Number(iRaw), count = Number(nRaw)
  if (!Number.isInteger(index) || !Number.isInteger(count) || count < 1 || index < 0 || index >= count) {
    throw new Error(`SHARD must be "i/n" with 0 <= i < n; got "${SHARD}"`)
  }
  situations = allSituations.filter((_, i) => i % count === index)
  console.log(`[solve] SHARD ${index + 1} of ${count}: ${situations.length} of ${allSituations.length} buckets`)
  if (!situations.length) {
    console.log('[solve] nothing in this shard; exiting cleanly')
    process.exit(0)
  }
}
const totalCells = situations.length * plays.length * shells.length * SAMPLES
console.log(`[solve] ${situations.length} buckets x ${plays.length} plays x ${shells.length} shells x ${SAMPLES} = ${totalCells.toLocaleString()} plays to simulate`)

// How many simulated downs may pass between checkpoints. The most a crash can cost.
const CHECKPOINT_EVERY_DOWNS = 100_000

const started = Date.now()
let simulated = 0
let savedAt = 0

for (const sit of situations) {
  for (const [formationId, formationPlays] of byFormation) {
    const tag = `${sit.key}|${formationId}`
    if (alreadyDone.has(tag)) continue

    const estimates = formationPlays.map(() => shells.map(() => 0))
    const counts = formationPlays.map(() => shells.map(() => 0))

    for (let pi = 0; pi < formationPlays.length; pi++) {
      for (let si = 0; si < shells.length; si++) {
        let sum = 0, n = 0
        for (let s = 0; s < SAMPLES; s++) {
          const v = samplePlay({
            situation: sit.sample,
            playId: formationPlays[pi].id,
            shellId: shells[si].id,
            seed: (pi * 7919 + si * 104729 + s * 31) >>> 0,
            possessionValue,
          })
          simulated++
          if (v != null) { sum += v; n++ }
        }
        if (n) { estimates[pi][si] = sum / n; counts[pi][si] = n }
      }
    }

    const solved = solveSubgame({ estimates, counts })
    done.push({
      situation: sit.key,
      formation: formationId,
      plays: formationPlays.map(p => p.id),
      shells: shells.map(s => s.id),
      offense: solved.offense,
      defense: solved.defense,
      value: solved.value,
      confident: solved.confident,
      coverage: solved.coverage,
    })

    const mins = (Date.now() - started) / 60000
    const pct = simulated / totalCells
    const eta = pct > 0 ? (mins / pct - mins) : 0
    console.log(
      `  ${describeSituation(sit.sample).padEnd(26)} ${formationId.padEnd(22)} ` +
      `value ${solved.value.toFixed(1).padStart(6)} coverage ${(solved.coverage * 100).toFixed(0).padStart(3)}% ` +
      `${solved.confident ? 'ok  ' : 'thin'} | ${(pct * 100).toFixed(1)}% done, ~${eta.toFixed(0)} min left`
    )
    if (solved.diagnosis?.warning) console.log(`      ${solved.diagnosis.warning}`)

    // Save on a downs budget rather than per subgame — see the note at the top. Only the state:
    // the table is derived from it and is written once at the end.
    if (simulated - savedAt >= CHECKPOINT_EVERY_DOWNS) {
      try {
        saveJson(statePath, { subgames: done, possessionValue })
        savedAt = simulated
        console.log(`      checkpoint: ${done.length} subgames, ${simulated.toLocaleString()} downs`)
      } catch (err) {
        console.log(`      checkpoint FAILED: ${err.message}`)
      }
    }
  }
}

// The run is over: save the state one last time (the budget may not have come round again) and
// build the table from it.
saveJson(statePath, { subgames: done, possessionValue })
const table = buildTable(done, { playType })
saveJson(tablePath, table)
const mins = (Date.now() - started) / 60000
console.log(`\n── Done: ${done.length} subgames in ${mins.toFixed(1)} min ──`)
console.log(`  ${Object.keys(table.offense).length} situations solved for the offense`)
console.log(`  ${Object.keys(table.defense).length} situation+formation pairs solved for the defense`)
console.log(`  table written to ${tablePath}`)
