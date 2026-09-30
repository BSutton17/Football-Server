// ── Reading a play-by-play report ([analytics]) ─────────────────────────────
//
//   node scripts/readAnalytics.mjs <plays.jsonl>            # a digest of the whole game
//   node scripts/readAnalytics.mjs <plays.jsonl> 14         # everything about play 14
//
// The JSONL is the record; this is the way to look at it without reading 2MB of JSON by hand.
// The digest is one line per play plus a few aggregates that have caught real bugs before —
// sack rate, how long the quarterback held it, how often anybody was open when he let go.

import { readFileSync } from 'node:fs'

const file = process.argv[2]
const only = process.argv[3] ? Number(process.argv[3]) : null
if (!file) {
  console.error('usage: node scripts/readAnalytics.mjs <plays.jsonl> [playNumber]')
  process.exit(1)
}

const plays = readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l))
if (!plays.length) { console.log('empty report'); process.exit(0) }

const n2 = (v) => (v == null ? '  -  ' : String(v).padStart(5))

if (only != null) {
  const p = plays.find(x => x.play === only)
  if (!p) { console.error(`no play ${only} (file has ${plays.length})`); process.exit(1) }
  console.log(JSON.stringify(p, null, 2))
  process.exit(0)
}

console.log(`${plays.length} plays\n`)
console.log('  #   situation           call                      defense                   result')
console.log('  ' + '-'.repeat(100))
for (const p of plays) {
  const s = p.situation
  const sit = `Q${s.quarter} ${s.down}&${Math.round(s.distance)} @${Math.round(s.yardLine)}`.padEnd(18)
  const call = `${p.offense.playType ?? '?'} ${p.offense.playName ?? p.offense.playId ?? ''}`.slice(0, 24).padEnd(25)
  const def = `${p.defense.shellName ?? p.defense.shellId ?? '?'}`.slice(0, 24).padEnd(25)
  const res = `${p.result?.outcome ?? '?'} ${n2(p.result?.yards)}`
  console.log(`  ${String(p.play).padStart(3)} ${sit} ${call} ${def} ${res}`)
}

// ── Aggregates worth having in front of you ────────────────────────────────
const passes = plays.filter(p => p.offense.playType === 'pass')
const sacks = plays.filter(p => p.result?.outcome === 'SACK')
const throws = plays.flatMap(p => p.decisions.filter(d => d.kind === 'throw'))
const helds = plays.flatMap(p => p.decisions.filter(d => d.kind === 'held'))
const aways = plays.flatMap(p => p.decisions.filter(d => d.kind === 'throwaway'))
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f2 = (v) => (v == null ? '-' : v.toFixed(2))

// How open was ANYBODY at the moment of each throw, and at the moment of each sack? The gap
// between those two is the quarterback's decision quality in one number.
const bestAt = (p, t) => {
  const tick = p.ticks.reduce((best, k) => (Math.abs(k.t - t) < Math.abs((best?.t ?? 1e9) - t) ? k : best), null)
  const vals = (tick?.open ?? []).map(o => o[1]).filter(v => v != null)
  return vals.length ? Math.max(...vals) : null
}
const openOnThrow = []
const openOnSack = []
for (const p of plays) {
  for (const d of p.decisions) if (d.kind === 'throw') { const v = bestAt(p, d.t); if (v != null) openOnThrow.push(v) }
  if (p.result?.outcome === 'SACK') {
    const peak = Math.max(0, ...p.ticks.flatMap(k => (k.open ?? []).map(o => o[1]).filter(v => v != null)))
    if (Number.isFinite(peak)) openOnSack.push(peak)
  }
}

console.log(`
  ── totals ──
   plays              ${plays.length}   (${passes.length} pass, ${plays.length - passes.length} run)
   yards / play       ${f2(mean(plays.map(p => p.result?.yards ?? 0)))}
   sacks              ${sacks.length}  (${Math.round(100 * sacks.length / Math.max(1, passes.length))}% of pass plays)
   throwaways         ${aways.length}
   throws             ${throws.length}   mean hold ${f2(mean(throws.map(t => t.elapsed)))}s, mean score ${f2(mean(throws.map(t => t.score)))} vs bar ${f2(mean(throws.map(t => t.bar)))}
   held samples       ${helds.length}   mean best available while waiting ${f2(mean(helds.map(h => h.best)))}
   open when he threw ${f2(mean(openOnThrow))}
   PEAK open on plays he was SACKED on ${f2(mean(openOnSack))}   <- if this is high he had somebody and missed it
`)
