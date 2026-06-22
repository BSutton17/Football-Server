// ── Debug logging ──────────────────────────────────────────────────────────────
//
// The old run-game / coverage traces are RETIRED — runDebugOn() is now always false, so every
// previously-gated log is silenced (their call sites become no-ops). The kept exports are stubs so
// existing imports keep working without touching every call site.
//
// In their place is a focused OFFENSIVE-LINE / DEFENSIVE-LINE tracer for tuning pass protection and
// the pocket: each OL's set depth / target / engagement, and each DL's leverage, win-meter,
// engagement lock, and shed state. Enable with LINE_DEBUG=1 (off under tests).

export function runDebugOn() { return false }

// Retired loggers — no-ops (kept so callers don't need editing).
export function logRbVision()      {}
export function logPlayer()        {}
export function logBlock()         {}
export function logRunAssignment() {}
export function logEngagements()   {}

// ── OL / DL line tracer ([pocket]) ──────────────────────────────────────────────

// On by default while we tune the pocket ([pocket]); silence with LINE_DEBUG=0, always off in tests.
const LINE_DEBUG = process.env.LINE_DEBUG !== '0' && process.env.NODE_ENV !== 'test'
const OL_LABELS = new Set(['OL', 'C', 'G', 'T'])
const DL_LABELS = new Set(['DL', 'DE', 'DT', 'NT'])
const LOG_EVERY = 10   // ticks (~0.5s at 20 Hz) — throttle so the trace is readable

export function lineDebugOn() { return LINE_DEBUG }

const f = (v) => (typeof v === 'number' ? v.toFixed(1) : '?')

// Logs OL and DL position/velocity and the pass-protection state driving the pocket.
export function logLine(state) {
  if (!LINE_DEBUG) return
  if (state.playDesign?.playType !== 'pass') return
  if ((state.tick ?? 0) % LOG_EVERY !== 0) return

  const ol = []
  for (const p of state.offensePlayers.values()) {
    if (!OL_LABELS.has(p.label)) continue
    ol.push(
      `${p.id}(${p.label}) pos=(${f(p.x)},${f(p.y)}) v=(${f(p.vx)},${f(p.vy)}) ` +
      `setY=${f(p.passBlockAnchorY)} blocking=${p.blockTargetId ?? '-'} eng=${p.engagedWithId ?? '-'}`
    )
  }

  const dl = []
  for (const d of state.defensePlayers.values()) {
    if (!DL_LABELS.has(d.label)) continue
    dl.push(
      `${d.id}(${d.label}) pos=(${f(d.x)},${f(d.y)}) v=(${f(d.vx)},${f(d.vy)}) ` +
      `eng=${d.engagedWithId ?? '-'} lev=${f(d.leverageScore)} meter=${f(d.rushWinMeter)} ` +
      `lock=${f(d.engageElapsed)} shed=${d.shedBlock ? 'Y' : 'n'}`
    )
  }

  console.log(
    `[line t=${state.tick}]\n  OL: ${ol.join('\n      ') || '(none)'}\n  DL: ${dl.join('\n      ') || '(none)'}`
  )
}
