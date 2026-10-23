// ── Whole games, headless ([lab]) ────────────────────────────────────────────
//
//   NODE_ENV=test node scripts/fullGameLab.mjs [games] [--timeouts] [--fatigue] [--calls]
//
// Plays complete games with the computer on both sides, through the real engine, and reports on
// what happened. Built because questions like "does fatigue matter by the fourth quarter" and "does
// the computer call timeouts it should not" can only be answered over a whole game — a single down
// never reaches them.
//
// It drives training/game.js's playDown, which was written for one down at a time, so three of its
// shortcuts have to be patched for a game to run (each found the hard way):
//   1. playDown snaps back-to-back: NO PRE-SNAP TIME passes, so the clock only burns during live
//      plays (~2 s a snap) and a game never ends. The pre-snap time is charged here when the clock
//      is running (22 s a snap at normal tempo, ai/tempo.js, less the live play itself).
//   2. playDown always reports the play clock as 3, so a hurry-up set moment below 3 never arrives
//      and the offense "never sets". A stuck pre-snap gets the play clock nudged to 0.
//   3. The training seats do not hear timeout_started/ended from the fake io, so a stoppage is ended
//      here and timeout_ended delivered to every brain directly.
// Kicks are not driven by playDown, so 4th downs go for it and touchdowns go for two.
//
//   --timeouts  every timeout: who called it, who had the ball, the score from the caller's side
//   --fatigue   stamina of full-game players at the end of the half and of the game
//   --calls     the offense's run share by situation (quarter, clock, score from the offense's side)
//   --conversions  how often 3rd and 4th downs are converted, by yards to go. This lab goes for it on
//                  every 4th down, so it is the game's own conversion curve — the number the 4th-down
//                  decision in ai/specialTeams.js (CONVERSION_RATE) is meant to agree with.
//   --subs      the computer's substitutions (ai/substitutions.js): each seat's plan per position,
//               and for every snap, which stamina band each on-field skill player was in — by tier,
//               and by half — so "Grind it out" playing into the red and "Keep 'em fresh" never
//               leaving the green can be seen rather than assumed.

import { createTrainingGame, destroyTrainingGame, playDown } from '../src/training/game.js'
import { startNextPlay, resolveDecision, resolveConversion } from '../src/game/eventQueue.js'
import { PHASE } from '../src/game/stateMachine.js'
import { endStoppage } from '../src/game/pause.js'

const args = process.argv.slice(2)
const GAMES = Number(args.find(a => /^\d+$/.test(a)) ?? 6)
const WANT = { timeouts: args.includes('--timeouts'), fatigue: args.includes('--fatigue'), calls: args.includes('--calls'), conversions: args.includes('--conversions'), subs: args.includes('--subs') }
const LINE = new Set(['OL', 'DL', 'QB', 'C', 'G', 'T'])
const PRESNAP_SECONDS = 18

const pct = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN }
const band = v => v > 60 ? 'green' : v > 30 ? 'yellow' : 'red'
const fat = { half: [], late: [] }
const calls = new Map()      // situation label -> { runs, plays }
const conv = new Map()       // `${down}&${togo}` -> { made, tries }
const subBands = new Map()   // `${tier}|${half}` -> { green, yellow, red }
const subPlayers = new Map() // `${tier}` -> Set of `${game}:${slot}:${id}` who took a snap
const plansSeen = []

for (let g = 0; g < GAMES; g++) {
  const ctx = createTrainingGame({ seed: 77000 + g, difficulty: 'medium' })
  const snaps = new Map(), unitSnaps = new Map(), sideOf = new Map()
  let half = null, late = null, plays = 0, lastTo = null
  try {
    for (let i = 0; i < 3000; i++) {
      const st = ctx.state
      if (st.phase === PHASE.GAME_OVER) break

      // Only a DROP is a timeout; the counts going back up is the halftime reset.
      if (WANT.timeouts && st.timeouts && lastTo && (st.timeouts[0] < lastTo[0] || st.timeouts[1] < lastTo[1])) {
        const caller = st.timeouts[0] < lastTo[0] ? 0 : 1
        const margin = st.score[caller] - st.score[1 - caller]
        console.log(`TIMEOUT game ${g} | caller ${st.possession === caller ? 'HAS BALL ' : 'ON DEFENSE'} | caller margin ${String(margin).padStart(3)} | Q${st.quarter} ${String(Math.round(st.clock)).padStart(3)}s`)
      }
      lastTo = st.timeouts ? [...st.timeouts] : null

      if (st.stoppage) {
        const reason = st.stoppage.reason
        endStoppage(st)
        if (reason === 'timeout') for (const b of ctx.brains) b.onEvent('timeout_ended')
        continue
      }
      if (st.awaitingTransitionTap) { st.awaitingTransitionTap = false; startNextPlay(ctx.roomId, ctx.io, { quiet: true }); continue }
      if (st.decisionPending) { resolveDecision(st, ctx.io, 'go_for_it', { quiet: true }); continue }
      if (st.conversionPending) { resolveConversion(st, ctx.io, 'two_point'); if (st.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true }); continue }
      if (st.phase === PHASE.DEAD) { startNextPlay(ctx.roomId, ctx.io, { quiet: true }); continue }

      if (WANT.fatigue) {
        const sample = () => {
          const out = []
          for (const [key, n] of snaps) {
            const [slot] = key.split(':')
            if (n < 0.75 * (unitSnaps.get(`${slot}:${sideOf.get(key)}`) ?? 1)) continue
            const f = st.playerFatigue.get(key.slice(slot.length + 1))
            if (f && !LINE.has(f.label)) out.push({ label: f.label, stamina: f.stamina })
          }
          return out
        }
        if (st.quarter === 2) half = sample()
        if (st.quarter === 4) late = sample()
      }

      const possession = st.possession
      const situation = { q: st.quarter, clock: st.clock, margin: st.score[possession] - st.score[1 - possession], outs: st.timeouts?.[possession] ?? 0 }
      const before = { down: st.down, togo: st.distance, points: st.score[possession] }
      const r = playDown(ctx, {})
      // Converted = still our ball on a fresh 1st down, or six points on the board (a touchdown is
      // followed by a conversion menu, not a 1st down, so the down alone would call it a failure).
      if (WANT.conversions && r.ok && before.down >= 3) {
        const s = ctx.state
        const made = (s.score[possession] - before.points >= 6) || (s.possession === possession && s.down === 1)
        const key = `${before.down}&${Math.min(Math.ceil(before.togo), 11)}`   // the spot is fractional
        const c = conv.get(key) ?? { made: 0, tries: 0 }
        c.tries++; if (made) c.made++
        conv.set(key, c)
      }
      if (!r.ok) {
        if (ctx.state.phase === PHASE.PRE_SNAP) ctx.brains[ctx.state.possession].onEvent('play_clock_update', { playClock: 0 })
        if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
        continue
      }
      if (!ctx.state.clockStopped && ctx.state.phase === PHASE.DEAD) ctx.state.clock = Math.max(1, ctx.state.clock - PRESNAP_SECONDS)
      plays++

      if (WANT.calls) {
        const late4 = situation.q === 4 && situation.clock <= 120
        const label = !late4 ? 'normal'
          : situation.margin < 0 ? `Q4 <=2:00, BEHIND by ${-situation.margin <= 8 ? '1-8' : '9+'}`
          : situation.margin > 0 ? 'Q4 <=2:00, AHEAD' : 'Q4 <=2:00, TIED'
        const c = calls.get(label) ?? { runs: 0, plays: 0 }
        c.plays++; if (r.playType === 'run') c.runs++
        calls.set(label, c)
      }

      const onField = [...ctx.state.offensePlayers.values()].map(p => [possession, 'o', p])
        .concat([...ctx.state.defensePlayers.values()].map(p => [1 - possession, 'd', p]))

      // Stamina as the play STARTED — the fatigue map has already drained this snap, so this reads
      // a little low; the comparison between tiers is what it is for.
      if (WANT.subs) {
        if (plays === 1) plansSeen.push(...ctx.brains.map(b => b.subs?.plans).filter(Boolean))
        for (const [slot, , p] of onField) {
          if (LINE.has(p.label)) continue
          const tier = ctx.brains[slot]?.subs?.plans?.[p.label]
          const f = ctx.state.playerFatigue.get(p.id)
          if (!tier || !f) continue
          const key = `${tier}|${situation.q <= 2 ? '1st half' : '2nd half'}`
          const b = subBands.get(key) ?? { green: 0, yellow: 0, red: 0 }
          b[band(f.stamina)]++
          subBands.set(key, b)
          if (!subPlayers.has(tier)) subPlayers.set(tier, new Set())
          subPlayers.get(tier).add(`${g}:${slot}:${p.id}`)
        }
      }
      for (const [slot, side, p] of onField) {
        if (LINE.has(p.label)) continue
        const key = `${slot}:${p.id}`
        snaps.set(key, (snaps.get(key) ?? 0) + 1); sideOf.set(key, side)
      }
      for (const slot of [possession, 1 - possession]) {
        const side = slot === possession ? 'o' : 'd'
        unitSnaps.set(`${slot}:${side}`, (unitSnaps.get(`${slot}:${side}`) ?? 0) + 1)
      }
    }
  } finally { destroyTrainingGame(ctx) }
  if (half) fat.half.push(...half)
  if (late) fat.late.push(...late)
  console.error(`game ${g}: ${plays} plays`)
}

if (WANT.fatigue) {
  for (const [k, xs] of Object.entries(fat)) {
    const st = xs.map(x => x.stamina), n = st.length || 1
    const c = { green: 0, yellow: 0, red: 0 }; for (const v of st) c[band(v)]++
    console.log(`${k.padEnd(5)} n=${st.length}  median ${pct(st, 0.5).toFixed(0)}   green ${(100 * c.green / n).toFixed(0)}%  yellow ${(100 * c.yellow / n).toFixed(0)}%  red ${(100 * c.red / n).toFixed(0)}%`)
  }
}
if (WANT.subs) {
  const tiers = ['keep_em_fresh', 'have_a_break', 'grind_it_out']
  const count = {}
  for (const plan of plansSeen) for (const [pos, tier] of Object.entries(plan)) (count[pos] ??= {})[tier] = ((count[pos] ??= {})[tier] ?? 0) + 1
  console.log('plans drawn (seats):', JSON.stringify(count))
  for (const tier of tiers) {
    for (const half of ['1st half', '2nd half']) {
      const b = subBands.get(`${tier}|${half}`)
      if (!b) continue
      const n = b.green + b.yellow + b.red
      console.log(`${tier.padEnd(14)} ${half}  snaps ${String(n).padStart(5)}   green ${(100 * b.green / n).toFixed(0).padStart(3)}%  yellow ${(100 * b.yellow / n).toFixed(0).padStart(3)}%  red ${(100 * b.red / n).toFixed(0).padStart(3)}%`)
    }
    console.log(`${tier.padEnd(14)} players who took a snap: ${subPlayers.get(tier)?.size ?? 0}`)
  }
}
if (WANT.conversions) {
  for (const down of [3, 4]) {
    for (let togo = 1; togo <= 11; togo++) {
      const c = conv.get(`${down}&${togo}`)
      if (c) console.log(`${down}${down === 3 ? 'rd' : 'th'} & ${togo === 11 ? '11+' : String(togo).padEnd(3)}  ${(100 * c.made / c.tries).toFixed(0).padStart(3)}%   (${c.made}/${c.tries})`)
    }
  }
}
if (WANT.calls) {
  for (const [label, c] of calls) console.log(`${label.padEnd(26)} run ${(100 * c.runs / c.plays).toFixed(0).padStart(3)}%   (${c.plays} plays)`)
}
