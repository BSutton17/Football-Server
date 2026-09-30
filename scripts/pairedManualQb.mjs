// Is the AI actually worse against MAN coverage with the anticipation change, or is that noise?
// Paired on identical seeds: same play, same shell, same hash, both arms. The error bar is of the
// DIFFERENCE, which is far tighter than the spread of either arm.
const S = 'file:///C:/Users/Btpit/OneDrive/Desktop/Coding%20Projects/E-Football-Two/Server/src'
const { createTrainingGame, destroyTrainingGame, runPlay, HASHES } = await import(`${S}/training/game.js`)
const { loadPlaybook } = await import(`${S}/playbook/store.js`)
const { countJobs, classifyShell } = await import(`${S}/ai/playcall/shellShape.js`)

const N = Number(process.argv[2] ?? 200)
const KIND = process.argv[3] ?? 'man'
const book = loadPlaybook()
const pass = Object.entries(book.plays).filter(([, p]) => p.playType !== 'run').map(([id]) => id)
const shells = Object.entries(book.shells)
  .filter(([, s]) => countJobs(s).rush === 4 && classifyShell(s) === KIND).map(([id]) => id)

function arm(off, seed, playId, shellId, hash) {
  const prev = process.env.QB_NO_ANTICIPATE
  if (off) process.env.QB_NO_ANTICIPATE = '1'; else delete process.env.QB_NO_ANTICIPATE
  const ctx = createTrainingGame({ seed, difficulty: 'medium', mode: 'manual' })
  try {
    const o = ctx.state.possession
    ctx.brains[o].forceAuthoredPlay = playId
    ctx.brains[1 - o].forceAuthoredShell = shellId
    const r = runPlay(ctx, { down: 1, distance: 10, yardLine: 30, ballX: hash })
    if (r.outcome === 'no_snap' || r.outcome === 'hung') return null
    return { yards: r.yards ?? 0, sack: r.outcome === 'sack' ? 1 : 0 }
  } finally {
    destroyTrainingGame(ctx)
    if (prev === undefined) delete process.env.QB_NO_ANTICIPATE; else process.env.QB_NO_ANTICIPATE = prev
  }
}

const dy = [], ds = []
let offY = 0, onY = 0, offS = 0, onS = 0, n = 0
for (let i = 0; i < N; i++) {
  const seed = 96000 + i
  const playId = pass[i % pass.length]
  const shellId = shells[i % shells.length]
  const hash = HASHES[i % 3]
  const a = arm(true, seed, playId, shellId, hash)
  const b = arm(false, seed, playId, shellId, hash)
  if (!a || !b) continue
  n++
  offY += a.yards; onY += b.yards; offS += a.sack; onS += b.sack
  dy.push(b.yards - a.yards)
  ds.push(b.sack - a.sack)
}
const stats = (d) => {
  const m = d.reduce((x, y) => x + y, 0) / d.length
  const v = d.reduce((acc, x) => acc + (x - m) ** 2, 0) / (d.length - 1)
  return { m, se: Math.sqrt(v / d.length) }
}
const y = stats(dy), sk = stats(ds)
console.log(`\n4-man rush, ${KIND.toUpperCase()} coverage, manual, ${n} paired plays`)
console.log(`  anticipation OFF:  ${(offY / n).toFixed(2)} yds   ${Math.round(100 * offS / n)}% sacks`)
console.log(`  anticipation ON :  ${(onY / n).toFixed(2)} yds   ${Math.round(100 * onS / n)}% sacks`)
console.log(`  difference (on - off):`)
console.log(`     yards  ${y.m >= 0 ? '+' : ''}${y.m.toFixed(3)} \u00b1 ${y.se.toFixed(3)}   ${Math.abs(y.m) > 2 * y.se ? 'REAL' : 'indistinguishable from zero'}`)
console.log(`     sacks  ${sk.m >= 0 ? '+' : ''}${(100 * sk.m).toFixed(1)}pp \u00b1 ${(100 * sk.se).toFixed(1)}pp   ${Math.abs(sk.m) > 2 * sk.se ? 'REAL' : 'indistinguishable from zero'}`)
