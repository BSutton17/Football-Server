// ── HOW MUCH DOES THE OFFENSIVE CALL ACTUALLY MATTER? ───────────────────────
//
//   node src/training/offenseHeadroom.mjs [situations]
//
// The offensive mirror of headroom.mjs, and the question three training harnesses could not
// answer about themselves: 600 generations of offensive evolution produced nothing better than
// the hand-written offense. That has two completely different explanations —
//
//   (a) the search failed, or
//   (b) there was nothing to find.
//
// Holding the call FIXED and playing the whole slate with it separates them. If every fixed call
// scores about the same, then no play-caller can win by choosing well, a flat result is CORRECT,
// and more training is wasted compute — the lever is engine balance instead.
//
// ⚠️ Scored in SERIES points, on the same slate roundrobin.mjs uses, so these numbers sit directly
// beside that table. Positive is good FOR THE OFFENSE (the round robin printed the defense's
// score; this prints the offense's). The old headroom.mjs reports yards-vs-par from the retired
// per-play harness and its numbers are NOT comparable to these.
//
// Two levers are measured separately, because they are different decisions:
//   RUN/PASS — the coarse choice, forced for every down.
//   CONCEPT  — the fine choice, forced with the play type held at pass so concepts are compared
//              against each other rather than diluted by a shared pool of run plays.

import { readFileSync } from 'node:fs'
import { playPairing } from './coevolve.js'
import { buildSlate } from './slate.js'
import { CONCEPTS } from '../ai/playbook/concepts.js'
import { callOffense, chooseRunAngle } from '../ai/offense.js'
import { createTrainingGame, destroyTrainingGame, TRAINING_DIFFICULTY } from './game.js'
import { createDeepDefenseBrain } from './deepBrainDefense.js'
import { syntheticRoster } from '../ai/roster.js'
import { runSeries, scoreSeries } from './series.js'

const SIZE = Number(process.argv[2] ?? 24)
const slate = buildSlate({ size: SIZE, generation: 31337, seed: 616161 })
const installed = JSON.parse(readFileSync('src/ai/brains/hard-defense.json', 'utf8')).genome

// Replaces the CALL and inherits everything else — the formation build, the legality clamps, the
// hash. Exactly the integration point a trained brain uses, so a forced call is no more or less
// legal than a heuristic one.
function makeOverride({ playType, conceptId }) {
  if (!playType && !conceptId) return null
  return (k, rng, ballX) => {
    const call = callOffense(k, rng, ballX)
    if (playType === 'run') {
      // A run needs a lane; a call that was going to be a pass carries no angle.
      const lane = chooseRunAngle(k, ballX, rng)
      return { ...call, playType: 'run', conceptId: null, conceptName: null, runAngle: lane.angle }
    }
    const next = playType ? { ...call, playType } : { ...call }
    if (!conceptId) return next
    // A run has no concept to force. Leaving it alone is what lets LEVER 3 hold the heuristic's
    // own run/pass mix while replacing only the passing concept.
    if (next.playType === 'run') return next
    return { ...next, conceptId, conceptName: CONCEPTS[conceptId]?.name ?? conceptId,
             routes: CONCEPTS[conceptId]?.routes ?? next.routes }
  }
}

// One row of the table: the forced offense against one defense, over the whole slate.
// Returns the OFFENSE's mean series score.
function run(override, defenseGenome) {
  let total = 0, n = 0, broken = 0
  for (const s of slate.situations) {
    const ctx = createTrainingGame({ seed: s.seed, difficulty: TRAINING_DIFFICULTY })
    try {
      if (defenseGenome) {
        const brain = createDeepDefenseBrain({
          socket: ctx.seats[1], slot: 1, roster: syntheticRoster('net'),
          genome: defenseGenome, seed: s.seed,
        })
        ctx.brains[1] = brain
        ctx.seats[1].onEventHandler = brain
        ctx.seats[1].emit = (e, p) => { try { brain.onEvent(e, p) } catch { /* never stop the run */ } }
      }
      if (override) ctx.brains[0].overrideOffensiveCall = override
      const r = runSeries(ctx, { ...s, possession: 0 })
      if (!r.ok) { broken++; continue }
      total += scoreSeries(r); n++
    } finally { destroyTrainingGame(ctx) }
  }
  return { mean: n ? total / n : NaN, broken }
}

const DEFENSES = [['vs heuristic', null], ['vs shipped r266', installed]]

function table(title, rows) {
  console.log(`\n── ${title} — ${SIZE} series, OFFENSE's mean series score (higher is better for the offense) ──\n`)
  console.log(`  CALL             ${DEFENSES.map(([l]) => l.padStart(16)).join('')}`)
  const out = []
  for (const [label, override] of rows) {
    const cells = DEFENSES.map(([, dg]) => run(override, dg))
    out.push({ label, cells })
    const brk = cells.reduce((a, c) => a + c.broken, 0)
    console.log(`  ${label.padEnd(16)} ${cells.map(c => c.mean.toFixed(2).padStart(16)).join('')}` +
                (brk ? `   (⚠️ ${brk} broken excluded)` : ''))
  }
  // The spread is the ceiling on what choosing well can win, per defense.
  DEFENSES.forEach(([l], i) => {
    const vals = out.map(r => r.cells[i].mean).filter(v => Number.isFinite(v))
    const best = Math.max(...vals), worst = Math.min(...vals)
    const bestRow = out.find(r => r.cells[i].mean === best)
    console.log(`    ${l}: best ${bestRow.label} ${best.toFixed(2)} | worst ${worst.toFixed(2)} | SPREAD ${(best - worst).toFixed(2)}`)
  })
  return out
}

console.log(`\n  slate: roundrobin slate (size ${SIZE}, generation 31337, seed 616161) — nothing trained on it`)

table('LEVER 1: run / pass', [
  ['heuristic mix', null],
  ['always pass', makeOverride({ playType: 'pass' })],
  ['always run', makeOverride({ playType: 'run' })],
])

table('LEVER 2: concept (play type held at pass)', [
  ['heuristic mix', null],
  ...Object.keys(CONCEPTS).map(id => [id, makeOverride({ playType: 'pass', conceptId: id })]),
])

// ⚠️ THE ACTIONABLE ONE. Lever 2 forces all-pass, which is not a configuration anyone would
// ship. This keeps the heuristic's own run/pass mix and replaces ONLY the passing concept, so a
// row that beats 'heuristic mix' is a change that could go into the shipped offense today.
table('LEVER 3: concept inside the heuristic run/pass mix', [
  ['heuristic mix', null],
  ...Object.keys(CONCEPTS).map(id => [id, makeOverride({ conceptId: id })]),
])

console.log(`\n  The SPREAD is the ceiling on what any play-caller can win by choosing well. A situational`)
console.log(`  caller beats the best FIXED call only by exploiting situation-to-situation variation on`)
console.log(`  top of it, so the spread is an optimistic bound, not a target.`)
console.log(`  A spread near zero means a flat training result was the CORRECT answer.\n`)
