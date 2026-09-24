// ── What is this champion actually DOING? ([pingpong]) ──────────────────────
//
//   npm run training:inspect [round] [situations]      e.g. `... inspect 7 30`
//
// A fitness score says a champion wins. It does not say whether it is worth playing against, and
// those are different questions. The first trained defense in this project scored well and called
// the same coverage on 100% of early downs — excellent, and tedious, and trivially exploitable once
// a human notices.
//
// So this reports the three things a score cannot:
//
//   WHAT IT CALLS — the shell mix, sliced by situation. A mix that MOVES with down and distance is
//     situational football. One call everywhere is a button.
//   HOW IT USES THE WIDENED SPACE — how often it sends a coverage player, shades a matchup, moves a
//     zone. A champion that leaves every delta at zero has learned nothing the old action space
//     could not express, whatever it scores.
//   WHETHER IT IS CHEATING — plays that failed to run. A genome that wins by breaking the
//     simulation scores beautifully and is worthless.

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { createTrainingGame, destroyTrainingGame, runPlay } from './game.js'
import { buildSlate } from './slate.js'
import { createDeepDefenseBrain } from './deepBrainDefense.js'
import { createDeepOffenseBrain } from './deepBrainOffense.js'
import { syntheticRoster } from '../ai/roster.js'

const WANT = process.argv[2] ?? 'best'
const SIZE = Number(process.argv[3] ?? 30)
const DIR = process.env.OUT_DIR ?? 'training-output/pingpong-current'

const archivePath = join(DIR, 'archive.json')
if (!existsSync(archivePath)) { console.log(`No archive at ${archivePath}`); process.exit(0) }
const { archive } = JSON.parse(readFileSync(archivePath, 'utf8'))

const entry = WANT === 'best'
  ? archive.filter(a => a.side === 'defense').sort((a, b) => b.vsHeuristic - a.vsHeuristic)[0]
  : archive.find(a => a.round === Number(WANT))
if (!entry) { console.log(`No round ${WANT} in the archive`); process.exit(0) }

// A slate it has never trained on, selected on, or been benchmarked against.
const slate = buildSlate({ size: SIZE, generation: 55555, seed: 828282 })

const bucket = (s) => {
  if (s.down >= 3 && s.distance >= 7) return '3rd/4th & long'
  if (s.down >= 3) return '3rd/4th & short'
  if (s.distance >= 10) return 'early & long'
  return 'early & short'
}

// ⚠️ VARIETY LIVES IN THE DELTAS, NOT THE SHELL NAME.
//
// The best defense of the run called `cover_1` on 100% of snaps, which read as "one button" — but
// it also shaded every matchup, moved every zone landmark and adjusted every alignment. It had
// stopped using the shell as a call and started using it as a blank canvas, so counting shell names
// measures the wrong layer: two snaps both labelled cover_1 can be completely different defenses.
//
// The real question is whether the ADJUSTMENTS change — between snaps, and with the SITUATION. A
// defense that builds the same custom look every down is predictable whatever it is called.
const shapes = []
const byBucketShape = {}
const calls = {}, bySpot = {}, deltas = { send: 0, drop: 0, shade: 0, zoneMoved: 0, aligned: 0, total: 0 }
let invalid = 0, ran = 0
const problems = {}

for (const s of slate.situations) {
  const ctx = createTrainingGame({ seed: s.seed })
  try {
    const isDef = entry.side === 'defense'
    const slot = isDef ? 1 : 0
    const make = isDef ? createDeepDefenseBrain : createDeepOffenseBrain
    const brain = make({
      socket: ctx.seats[slot], slot,
      roster: syntheticRoster(isDef ? 'net' : 'off'),
      genome: entry.genome, seed: s.seed,
    })
    ctx.brains[slot] = brain
    ctx.seats[slot].emit = (e, p) => { try { brain.onEvent(e, p) } catch { /* keep tallying */ } }

    const r = runPlay(ctx, { ...s, seed: s.seed, possession: 0 })
    ran++
    if (!r.ok) { invalid++; for (const p of r.problems) problems[p] = (problems[p] ?? 0) + 1 }

    const call = brain.lastCall
    const id = isDef ? (call?.shellId ?? 'none') : `${call?.playType ?? '?'}/${call?.conceptId ?? 'run'}`
    calls[id] = (calls[id] ?? 0) + 1
    const b = bucket(s)
    bySpot[b] ??= {}
    bySpot[b][id] = (bySpot[b][id] ?? 0) + 1

    // ⚠️ The brain is constructed fresh INSIDE this loop, so its `adjustments` already hold only
    // this play's decisions. Slicing against a running counter — as if they accumulated — threw
    // away every play after the first, reporting 42 decisions where there were 1260.
    const mine = brain.adjustments ?? []

    // Quantised to 2-yard buckets so float noise does not read as variety.
    const q = (v) => Math.round((v ?? 0) / 2)
    const shape = mine.slice().sort((x, y) => String(x.id).localeCompare(String(y.id)))
      .map(a => `${a.change ?? '-'}${a.shade ?? '-'}${q(a.zoneDx)},${q(a.zoneDy)},${q(a.alignDx)},${q(a.alignDy)}`)
      .join('|')
    shapes.push(shape)
    ;(byBucketShape[bucket(s)] ??= []).push({ shape, mine })

    for (const a of mine) {
      deltas.total++
      if (a.change === 'send') deltas.send++
      if (a.change === 'drop') deltas.drop++
      if (a.shade) deltas.shade++
      if (Math.abs(a.zoneDx ?? 0) > 1 || Math.abs(a.zoneDy ?? 0) > 1) deltas.zoneMoved++
      if (Math.abs(a.alignDx ?? 0) > 1 || Math.abs(a.alignDy ?? 0) > 1) deltas.aligned++
    }
  } finally { destroyTrainingGame(ctx) }
}

const pct = (n, d) => `${Math.round(100 * n / (d || 1))}%`
const show = (t, n) => Object.entries(t).sort((a, b) => b[1] - a[1])
  .map(([k, v]) => `${k} ${pct(v, n)}`).join(', ')

console.log(`\n  round ${entry.round} ${entry.side} — ${SIZE} situations it has never seen`)
console.log(`  (scored ${entry.vsHeuristic?.toFixed(2)} against the heuristic during its round)\n`)
console.log(`  CALLS : ${show(calls, ran)}`)
console.log(`\n  by situation:`)
for (const [spot, t] of Object.entries(bySpot)) {
  const n = Object.values(t).reduce((a, b) => a + b, 0)
  console.log(`    ${spot.padEnd(16)} (${String(n).padStart(2)}) : ${show(t, n)}`)
}

console.log(`\n  USE OF THE WIDENED ACTION SPACE  (${deltas.total} per-player decisions)`)
console.log(`    sent a coverage player : ${pct(deltas.send, deltas.total)}`)
console.log(`    dropped a rusher       : ${pct(deltas.drop, deltas.total)}`)
console.log(`    shaded a matchup       : ${pct(deltas.shade, deltas.total)}`)
console.log(`    moved a zone landmark  : ${pct(deltas.zoneMoved, deltas.total)}`)
console.log(`    lined up off the spot  : ${pct(deltas.aligned, deltas.total)}`)

const distinct = Object.keys(calls).length
const top = Math.max(...Object.values(calls)) / ran
console.log(`\n  distinct calls : ${distinct}   most-used : ${pct(Math.max(...Object.values(calls)), ran)} of snaps`)
console.log(top > 0.85
  ? `  -> ONE BUTTON. Predictable, and a human will find it.`
  : distinct >= 3 ? `  -> varied; check that the mix MOVES between the buckets above.`
  : `  -> narrow.`)

// ── Is the DEFENSE varied, whatever it is called? ──
const distinctShapes = new Set(shapes).size
console.log(`\n  ACTUAL DEFENSES BUILT (shell name ignored, adjustments compared)`)
console.log(`    distinct looks : ${distinctShapes} across ${shapes.length} snaps`)
console.log(distinctShapes === 1
  ? `    -> ONE FIXED DEFENSE every snap. Predictable however it is labelled.`
  : distinctShapes >= shapes.length * 0.8
    ? `    -> a different look almost every snap.`
    : `    -> ${distinctShapes} recurring looks.`)

// Does it respond to the SITUATION? A defense playing identical depths and shades on 3rd-and-long
// and on 1st-and-10 is not reading anything, however many distinct looks it has.
console.log(`\n  DOES IT CHANGE WITH THE SITUATION?`)
const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0
for (const [bk, rows] of Object.entries(byBucketShape)) {
  const all = rows.flatMap(r => r.mine)
  const depth = avg(all.map(a => a.zoneDy ?? 0))
  const wide = avg(all.map(a => Math.abs(a.zoneDx ?? 0)))
  const dropped = all.filter(a => a.change === 'drop').length / (all.length || 1)
  const looks = new Set(rows.map(r => r.shape)).size
  console.log(`    ${bk.padEnd(16)} zone depth ${depth >= 0 ? '+' : ''}${depth.toFixed(1)}yd | spread ${wide.toFixed(1)}yd | dropped ${Math.round(100 * dropped)}% | ${looks} looks`)
}

console.log(`\n  INTEGRITY : ${invalid} of ${ran} plays failed to run`)
for (const [p, n] of Object.entries(problems).slice(0, 4)) console.log(`      ${n}x ${p}`)
console.log(invalid === 0 ? `      CLEAN — not winning by breaking the game.\n` : '')
