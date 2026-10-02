// ── What did a re-solve actually change? ([authored]) ───────────────────────
//
//   node scripts/compareSolve.mjs <oldTable.json> <newTable.json>
//
// Run share per bucket, side by side. A re-solve is a 1.1-million-down job and the only way to know
// whether it was worth running is to look at what moved — and the run/pass balance is the part a player
// actually sees, because "why is it running on 3rd and 6" is how a bad mix gets reported.
import { readFileSync } from 'node:fs'
import { loadPlaybook } from '../src/playbook/store.js'

const book = loadPlaybook()
const typeOf = (id) => book.plays?.[id]?.playType ?? '?'
const load = (p) => JSON.parse(readFileSync(p, 'utf8'))
const [, , aPath, bPath] = process.argv

const runShare = (mix) => {
  let run = 0, total = 0
  for (const [id, p] of Object.entries(mix ?? {})) {
    total += p
    if (typeOf(id) === 'run') run += p
  }
  return total > 0 ? run / total : null
}

const A = load(aPath).offense ?? {}
const B = load(bPath).offense ?? {}
const keys = [...new Set([...Object.keys(A), ...Object.keys(B)])].sort()

console.log('\n  bucket                      run% old   run% new    change')
console.log('  ' + '-'.repeat(60))
for (const k of keys) {
  const a = runShare(A[k]), b = runShare(B[k])
  const f = (v) => (v == null ? '   -' : `${(100 * v).toFixed(0).padStart(4)}%`)
  const d = a != null && b != null ? `${(100 * (b - a) >= 0 ? '+' : '')}${(100 * (b - a)).toFixed(0)}pp` : ''
  console.log(`  ${k.padEnd(28)} ${f(a)}     ${f(b)}      ${d.padStart(6)}`)
}
console.log('')

// ── What the solve CAN move ──────────────────────────────────────────────────
//
// ⚠️ THE RUN SHARE IS NOT A SOLVED QUANTITY. `runShareConstraint` pins it to `runShare()` from
// situation.js — a hand-tuned prior — because, as solve.js says in as many words, the split "is the one
// thing this model is bad at". The solve decides WHICH run and WHICH pass. So a run-share column that
// comes back identical across a re-solve is the system working, not a bug, and anybody expecting a
// re-solve to change the run/pass balance is looking at the wrong file.
//
// What it can move is the distribution WITHIN each type, and the defense. Total variation distance is
// the honest summary: 0 means nothing moved, 1 means nothing in common.
const tv = (a, b) => {
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])
  let d = 0
  for (const k of keys) d += Math.abs((a?.[k] ?? 0) - (b?.[k] ?? 0))
  return d / 2
}
const within = (mix, want) => {
  const out = {}
  let total = 0
  for (const [id, p] of Object.entries(mix ?? {})) {
    const isRun = typeOf(id) === 'run'
    if ((want === 'run') !== isRun) continue
    out[id] = p; total += p
  }
  for (const k of Object.keys(out)) out[k] /= total || 1
  return out
}

console.log('  bucket                      within-run moved   within-pass moved')
console.log('  ' + '-'.repeat(60))
for (const k of keys) {
  if (!A[k] || !B[k]) continue
  console.log(`  ${k.padEnd(28)} ${tv(within(A[k], 'run'), within(B[k], 'run')).toFixed(2).padStart(10)}` +
    `         ${tv(within(A[k], 'pass'), within(B[k], 'pass')).toFixed(2).padStart(10)}`)
}

const Ad = load(aPath).defense ?? {}, Bd = load(bPath).defense ?? {}
const shared = Object.keys(Ad).filter(k => Bd[k])
const dd = shared.map(k => tv(Ad[k], Bd[k]))
const mean = dd.length ? dd.reduce((x, y) => x + y, 0) / dd.length : null
console.log(`\n  defense: ${shared.length} shared situation+formation pairs, mean shell-mix movement ${mean?.toFixed(2) ?? '-'}`)
console.log(`  offense buckets: ${Object.keys(A).length} old, ${Object.keys(B).length} new, ${keys.filter(k => A[k] && B[k]).length} shared\n`)
