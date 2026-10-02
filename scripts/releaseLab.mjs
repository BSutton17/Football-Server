// ── When does the quarterback let it go, and how much play exists then? ─────
//
//   NODE_ENV=test node scripts/releaseLab.mjs [plays] [down] [dist] [yard]
//   NODE_ENV=test QB_DEVELOP_GATE=0 node scripts/releaseLab.mjs ...        (the other arm)
//
// ⚠️ YARDS ARE THE WRONG PRIMARY METRIC FOR THIS ONE. The complaint was behavioural — "the QB is
// still throwing very fast and not letting plays develop" — so the thing to measure is the RELEASE,
// and how much of the route distribution had declared at that moment. A change that gained yards
// without moving those two numbers would not be the fix that was asked for.
//
// The report from a real game, for reference: a median release at 1.05s of board time with about 1.3
// receivers declared, and 7 of 13 throws going out with two or fewer in existence.
import { createTrainingGame, destroyTrainingGame, runPlay, HASHES } from '../src/training/game.js'

const N = Number(process.argv[2] ?? 150)
const down = Number(process.argv[3] ?? 3)
const distance = Number(process.argv[4] ?? 8)
const yardLine = Number(process.argv[5] ?? 40)
const MODE = process.env.ARM_MODE ?? 'manual'

const releases = []
const declared = []
const bestOpen = []
let sacks = 0, noThrow = 0

for (let i = 0; i < N; i++) {
  const ctx = createTrainingGame({ seed: 90000 + i, mode: MODE })
  try {
    const off = ctx.state.possession
    // The AI's own picture is the honest place to read "how many have declared" — it is what the
    // decision was actually made on, rather than a server-side truth it never saw.
    // ⚠️ FRAMES, NOT A FIELD ON THE BRAIN. `liveFor` and `boardTime` are closure-local in the
    // controller and read as undefined from out here, which printed a release time of 0.00s and would
    // have had me reporting that the quarterback throws on the snap.
    let lastFrame = null
    let frames = 0
    const inbox = ctx.seats[off].emit
    ctx.seats[off].emit = (e, p) => {
      if (e === 'positions_update') { lastFrame = p; frames++ }
      return inbox(e, p)
    }

    let fired = null
    const orig = ctx.seats[off].fire.bind(ctx.seats[off])
    ctx.seats[off].fire = (e, p) => {
      if (e === 'throw_to_receiver' && fired == null) {
        const catchers = (lastFrame ?? []).filter(x => x.ready != null)
        // ⚠️ THE SHARE OF THROWS THAT CLEAR THE STEP IS THE METRIC THAT PAYS. The catch model is a step
        // at OPENNESS_OPEN: 0.55 and 0.64 are the same 45% throw, and 0.66 is 95%. A mean-openness
        // comparison measures a difference the engine is blind to -- and nearly got reported as a result.
        const open = catchers.map(x => x.openness).filter(v => typeof v === 'number')
        fired = {
          t: frames * 0.05,                 // the sim tick is 50ms, and frames only arrive while live
          ready: catchers.filter(x => x.ready).length,
          total: catchers.length,
          bestOpen: open.length ? Math.max(...open) : null,
        }
      }
      return orig(e, p)
    }

    const r = runPlay(ctx, { down, distance, yardLine, ballX: HASHES[i % 3], forcePlayType: 'pass' })
    if (r.outcome === 'no_snap' || r.outcome === 'hung') continue
    if (r.outcome === 'sack') sacks++
    if (!fired) { noThrow++; continue }
    if (fired.t != null) releases.push(fired.t)
    declared.push(fired.ready)
    if (fired.bestOpen != null) bestOpen.push(fired.bestOpen)
  } finally { destroyTrainingGame(ctx) }
}

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null)
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1] }
const f = (v, d = 2) => (v == null ? '-' : v.toFixed(d))

console.log(`\n  ${MODE}, ${down} & ${distance}  —  ${declared.length} throws, ${noThrow} never thrown, ${sacks} sacks`)
console.log(`    release          mean ${f(mean(releases))}s   median ${f(median(releases))}s`)
console.log(`    declared at it   mean ${f(mean(declared))}   median ${f(median(declared))}`)
console.log(`    thrown with 2 or fewer declared: ${Math.round(100 * declared.filter(d => d <= 2).length / Math.max(1, declared.length))}%`)
console.log(`    thrown with 1 or fewer declared: ${Math.round(100 * declared.filter(d => d <= 1).length / Math.max(1, declared.length))}%\n`)
