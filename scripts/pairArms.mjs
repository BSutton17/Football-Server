// Pairs two tableArm outputs by seed and reports the difference with its standard error.
import { readFileSync } from 'node:fs'
const [, , aPath, bPath, label] = process.argv
const parse = (p) => new Map(readFileSync(p, 'utf8').trim().split('\n').filter(Boolean)
  .map(l => { const [s, y, c] = l.split(','); return [s, { y: +y, c: +c }] }))
const A = parse(aPath), B = parse(bPath)
const dy = [], dc = []
let ay = 0, by = 0, ac = 0, bc = 0, n = 0
for (const [seed, a] of A) {
  const b = B.get(seed); if (!b) continue
  n++; ay += a.y; by += b.y; ac += a.c; bc += b.c
  dy.push(b.y - a.y); dc.push(b.c - a.c)
}
const st = (d) => {
  const m = d.reduce((x, y) => x + y, 0) / d.length
  const v = d.reduce((acc, x) => acc + (x - m) ** 2, 0) / (d.length - 1)
  return { m, se: Math.sqrt(v / d.length) }
}
const y = st(dy), c = st(dc)
const verdict = (m, se) => (Math.abs(m) > 2 * se ? 'REAL' : 'noise')
console.log(`${label}  (${n} paired plays)`)
console.log(`   A: ${(ay / n).toFixed(2)} yds  ${Math.round(100 * ac / n)}% converted`)
console.log(`   B: ${(by / n).toFixed(2)} yds  ${Math.round(100 * bc / n)}% converted`)
console.log(`   B-A yards      ${y.m >= 0 ? '+' : ''}${y.m.toFixed(3)} ± ${y.se.toFixed(3)}  ${verdict(y.m, y.se)}`)
console.log(`   B-A conversion ${c.m >= 0 ? '+' : ''}${(100 * c.m).toFixed(1)}pp ± ${(100 * c.se).toFixed(1)}pp  ${verdict(c.m, c.se)}`)
