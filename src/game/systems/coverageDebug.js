import { opennessBreakdown } from '../utils/openness.js'
import { opennessTier }      from '../utils/passOutcome.js'

// ── Coverage / openness debug logging ([coverage feedback]) ───────────────────────
//
// On a live PASS play, logs each receiver: the openness COLOR it resolves to (the same
// green/yellow/red the client shows), and — when it's in MAN coverage — the defender's technique
// against it: the cushion, the receiver/defender vertical speeds, and whether the corner is
// CLOSING the cushion improperly ("downhill" on a vertical) or has been BEATEN over the top. Lets
// us catch off-man corners driving down at a vertical release instead of running with the route.
// On by default while we tune coverage; set COVERAGE_DEBUG=0 to silence, always off under tests.

// Retired by default ([pocket] — replaced by the OL/DL line tracer). Opt back in with COVERAGE_DEBUG=1.
const ENABLED = process.env.COVERAGE_DEBUG === '1' && process.env.NODE_ENV !== 'test'

const RECEIVER_LABELS = new Set(['WR', 'TE', 'RB'])
const REVEAL_DELAY     = 1.3   // seconds — must match serialization's openness reveal gate
const LOG_EVERY_TICKS  = 10    // ~0.5s at 20 Hz — readable cadence

const n = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '?')

function colorFor(openness) {
  const tier = opennessTier(openness)
  return tier === 'open' ? 'GREEN' : tier === 'covered' ? 'YELLOW' : 'RED'
}

// Man-coverage technique against the receiver `rec` by defender `def`, given play direction `dir`.
// cushion > 0 → defender is on top (downfield) of the receiver; < 0 → the receiver has climbed
// past it (beaten over the top). wrVy/cbVy are downfield speeds.
function manTechnique(def, rec, dir) {
  const cushion = (def.y - rec.y) * dir
  const dist    = Math.hypot(def.x - rec.x, def.y - rec.y)
  const wrVy    = (rec.vy ?? 0) * dir
  const cbVy    = (def.vy ?? 0) * dir
  const closing = wrVy - cbVy   // >0 → receiver gaining, cushion shrinking

  let flag
  if (cushion <= 0)                              flag = '<<< WR BEAT CB (over the top)'
  else if (cbVy < -0.3 && wrVy > 1)              flag = '<<< DOWNHILL (CB driving down on a vertical)'
  else if (wrVy > 1 && closing > 1.5)            flag = 'WR closing the cushion'
  else if (wrVy > 1)                             flag = 'running with (on top)'
  else                                           flag = 'trailing'

  return `dist=${n(dist)} cushion=${n(cushion)} wrVy=${n(wrVy)} cbVy=${n(cbVy)} Δ=${n(closing)}/s  ${flag}`
}

export function runCoverageDebug(state, _io, _dt) {
  if (!ENABLED) return
  if (state.playDesign?.playType !== 'pass') return

  state._covDebugTick = (state._covDebugTick ?? 0) + 1
  if (state._covDebugTick % LOG_EVERY_TICKS !== 0) return

  const defenders = [...state.defensePlayers.values()]
  let qb = null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') { qb = p; break }
  }

  // Map each man-covered receiver to its defender, so the log is receiver-centric.
  const manOn = new Map()   // receiverId -> defender
  for (const d of defenders) {
    const cov = state.defenseCoverage.get(d.id)
    if (cov?.type === 'man' && cov.targetId) manOn.set(cov.targetId, d)
  }

  const lines = []
  for (const r of state.offensePlayers.values()) {
    if (!RECEIVER_LABELS.has(r.label ?? '')) continue

    const b        = opennessBreakdown(r, defenders, qb)
    const color    = colorFor(b.openness)
    const revealed = (r.routeWaypointIdx ?? 0) >= 1 || (r.routeElapsed ?? 0) >= REVEAL_DELAY
    const beat     = b.beaten > 0 ? ` BEATEN ${n(b.beaten, 2)}` : ''
    const lane     = b.frontDist != null ? ` laneAhead=${n(b.frontDist)} (defender in the throwing lane)` : ''

    const def = manOn.get(r.id)
    const cover = def
      ? `man ${def.id}(${def.label}): ${manTechnique(def, r, state.direction)}`
      : 'zone/other'

    lines.push(
      `${r.id}(${r.label}) route=${r.route ?? '-'} open=${n(b.openness, 2)} ${color}${revealed ? '' : ' (pre-reveal)'}${beat}${lane}\n` +
      `      ${cover}`,
    )
  }

  if (lines.length) {
    console.log(`[cov t=${state.tick}]\n` + lines.map(l => '  ' + l).join('\n'))
  }
}
