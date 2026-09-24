// WHY IS BLITZING OVERPOWERED? ([training])
//
//   npm run training:blitzlab [plays-per-shell]
//
// The headroom tool said a six-man blitz beats every other call by 3.5 points. This one asks why,
// by tracking the mechanism per tick rather than the outcome per play.
//
// The football question behind it: a blitz trades COVERAGE for PRESSURE. Six rushers leaves five
// defenders on five receivers with nobody over the top, so somebody should come open fast and the
// quarterback should make the defense pay. If blitzing is free, one of those halves is broken —
// either the pressure arrives unopposed, or the offense can't cash in the coverage it won.
//
// So for each shell we measure both halves:
//   PRESSURE  — rushers sent, how many the protection actually accounts for, time to the QB
//   COVERAGE  — how open receivers get, and whether the ball is out before the rush lands

import { createTrainingGame, destroyTrainingGame, applySituation } from './game.js'
import { buildSlate } from './slate.js'
import { SHELLS, extraRushers } from '../ai/playbook/coverages.js'
import { choosePersonnel } from '../ai/defense.js'
import { callOffense } from '../ai/offense.js'
import { CONCEPTS } from '../ai/playbook/concepts.js'
import { isRusher } from '../game/systems/passRush.js'
import { tick } from '../game/simulation.js'
import { PHASE } from '../game/stateMachine.js'
import { estimateOpenness } from '../ai/reads.js'
import { serializeGameState } from '../game/serialization.js'

const PER_SHELL = Number(process.argv[2] ?? 14)
const SHELL_IDS = process.argv[3] ? [process.argv[3]] : Object.keys(SHELLS)
const CONCEPT = process.argv[4] ?? null
const slate = buildSlate({ size: PER_SHELL, generation: 900, seed: 4242 })

// Hold the OFFENSE's concept fixed too, so a shell can be measured against one specific answer.
// Everything else about the call (formation, personnel, run/pass mix) is left to the heuristic.
function forceConcept(ctx, conceptId) {
  if (!conceptId) return
  ctx.brains[0].overrideOffensiveCall = (k, rng, ballX) => {
    const call = callOffense(k, rng, ballX)
    if (call.playType === 'run') return call        // a run has no concept to force
    return { ...call, conceptId, conceptName: CONCEPTS[conceptId]?.name ?? conceptId,
             routes: CONCEPTS[conceptId]?.routes ?? call.routes }
  }
}

function forceShell(ctx, shellId) {
  if (!shellId) return
  ctx.brains[1].overrideDefensiveCall = (k) => ({
    shellId,
    shellName: SHELLS[shellId]?.name ?? shellId,
    personnel: choosePersonnel(k, k.ballX),
    extraRushers: extraRushers(shellId),
    why: 'blitzlab',
  })
}

// Runs one play by hand so the state can be read every tick.
function probe(ctx, situation, shellId, conceptId) {
  const { io, state, seats } = ctx
  applySituation(state, situation)
  const off = state.possession, def = 1 - off
  forceShell(ctx, shellId)
  forceConcept(ctx, conceptId)

  io.clear()
  seats[def].emit('game_state', serializeGameState(state, def))
  seats[off].emit('game_state', serializeGameState(state, off))
  for (let i = 0; i < 40 && state.phase === PHASE.PRE_SNAP; i++) {
    seats[off].emit('play_clock_update', { playClock: 3 })
  }
  if (state.phase !== PHASE.COUNTDOWN) return null
  seats[off].fire('snap_ball')
  if (state.phase !== PHASE.LIVE) return null

  const isPass = state.playDesign?.playType !== 'run'
  const rushers = [...state.defensePlayers.values()].filter(d => isRusher(state, d))
  const rusherIds = new Set(rushers.map(r => r.id))

  let firstPressure = null, ticks = 0, threwAt = null
  let peakOpen = 0, openAtThrow = null, unblockedPeak = 0

  while (state.phase === PHASE.LIVE && ticks < 120) {
    tick(ctx.roomId, io)
    ticks++
    const t = ticks * 0.05

    // A rusher is ACCOUNTED FOR when some blocker is engaged with it. Anything else is running free.
    const engagedWith = new Set()
    for (const o of state.offensePlayers.values()) {
      if (o.engagedWithId) engagedWith.add(o.engagedWithId)
    }
    const free = [...rusherIds].filter(id => {
      const d = state.defensePlayers.get(id)
      return d && !engagedWith.has(id) && !d.isEngaged
    }).length
    if (t >= 0.8 && t <= 1.2) unblockedPeak = Math.max(unblockedPeak, free)

    const qb = [...state.offensePlayers.values()].find(p => p.label === 'QB')
    if (qb && firstPressure == null) {
      for (const id of rusherIds) {
        const d = state.defensePlayers.get(id)
        if (d && Math.hypot(d.x - qb.x, d.y - qb.y) <= 3) { firstPressure = t; break }
      }
    }

    if (isPass && qb) {
      const defs = [...state.defensePlayers.values()]
      let best = 0
      for (const o of state.offensePlayers.values()) {
        if (!['WR', 'TE', 'RB'].includes(o.label)) continue
        best = Math.max(best, estimateOpenness(o, defs, qb))
      }
      peakOpen = Math.max(peakOpen, best)
      if (state.targetReceiverId && threwAt == null) { threwAt = t; openAtThrow = best }
    }
  }

  return {
    isPass,
    rushers: rushers.length,
    unblocked: unblockedPeak,
    pressure: firstPressure,
    threwAt,
    peakOpen,
    openAtThrow,
    ticks,
  }
}

const rows = []
for (const shellId of SHELL_IDS) {
  const got = []
  for (const s of slate.situations) {
    const ctx = createTrainingGame({ seed: s.seed })
    try {
      const r = probe(ctx, { ...s, seed: s.seed, possession: 0 }, shellId, CONCEPT)
      if (r) got.push(r)
    } finally { destroyTrainingGame(ctx) }
  }
  const passes = got.filter(r => r.isPass)
  const avg = (a, f) => a.length ? a.reduce((x, r) => x + (f(r) ?? 0), 0) / a.length : 0
  const rate = (a, f) => a.length ? a.filter(f).length / a.length : 0
  const withP = passes.filter(r => r.pressure != null)
  const threw = passes.filter(r => r.threwAt != null)
  rows.push({
    shellId,
    n: passes.length,
    rushers: avg(passes, r => r.rushers),
    unblocked: avg(passes, r => r.unblocked),
    pressure: withP.length ? avg(withP, r => r.pressure) : null,
    pressureRate: rate(passes, r => r.pressure != null),
    threwAt: threw.length ? avg(threw, r => r.threwAt) : null,
    throwRate: rate(passes, r => r.threwAt != null),
    peakOpen: avg(passes, r => r.peakOpen),
    openAtThrow: threw.length ? avg(threw, r => r.openAtThrow) : null,
  })
}

const f = (v, d = 2) => v == null ? '  -  ' : v.toFixed(d).padStart(5)
console.log(`\n── Pressure vs coverage, ${PER_SHELL} situations per shell (pass plays only) ──\n`)
console.log('  shell           n  rush  FREE  press  p-rate  throw  t-rate  peakOpen  openAtThrow')
for (const r of rows.sort((a, b) => b.unblocked - a.unblocked)) {
  console.log(
    `  ${r.shellId.padEnd(13)} ${String(r.n).padStart(2)}  ` +
    `${f(r.rushers, 1)} ${f(r.unblocked, 2)} ${f(r.pressure)}  ${f(r.pressureRate)}  ` +
    `${f(r.threwAt)}  ${f(r.throwRate)}     ${f(r.peakOpen)}        ${f(r.openAtThrow)}`
  )
}
console.log(`
  rush        = rushers sent
  FREE        = rushers with NO blocker engaged, ~1s after the snap
  press/p-rate= seconds to a rusher within 3yd of the QB, and how often that happens
  throw/t-rate= seconds until the ball is released, and how often it is released at all
  peakOpen    = best receiver openness reached at any point in the play
  openAtThrow = how open the best receiver was when the ball actually went
`)
