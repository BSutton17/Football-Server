// ── Coverage lab ─────────────────────────────────────────────────────────────
//
// A headless harness for watching coverage behave. It builds a scrimmage state, runs the REAL
// movement system tick by tick, and prints per-tick telemetry for every player: where they are,
// how fast and which way they are going, and — for zone defenders — which receiver they have
// claimed, whether they think their area is contested, and the exact spot they are steering to.
//
// This exists because coverage bugs are almost never visible in a still frame. "Defenders are
// swirly" is a statement about how an assignment CHANGES over time, so the thing you need to see is
// the assignment column ticking down the page next to the position columns.
//
//   node tools/coverageLab.mjs                     # list the scenarios
//   node tools/coverageLab.mjs cover2-verticals    # run one, printing a table
//   node tools/coverageLab.mjs cover2-verticals --ticks 60 --every 4
//   node tools/coverageLab.mjs cover2-verticals --jsonl out.jsonl   # full rows for analysis
//
// Adding a scenario is just another entry in SCENARIOS: offense with routes, defenders with zone
// landmarks. Landmarks are offense-relative (0 = own goal line), the same frame the client uses.

// Silence the OL/DL line tracer, which is on by default and would bury the coverage table.
process.env.LINE_DEBUG = '0'

const { runMovement } = await import('../src/game/systems/movement.js')
import { SIM, FIELD } from '../src/constants.js'
import { writeFileSync } from 'node:fs'

const DT  = SIM.TICK_MS / 1000
const LOS = 25              // offense-relative yard line the ball is on
const MID = FIELD.WIDTH / 2

// ── Scenario building blocks ─────────────────────────────────────────────────

const wr = (id, x, route, y = LOS) => ({
  id, label: 'WR', route, x, y: y + FIELD.END_ZONE_DEPTH, vx: 0, vy: 0,
})
const back = (id, x, route) => ({
  id, label: 'RB', route, x, y: LOS + FIELD.END_ZONE_DEPTH - 5, vx: 0, vy: 0,
})
const qb = () => ({ id: 'qb', label: 'QB', x: MID, y: LOS + FIELD.END_ZONE_DEPTH - 6, vx: 0, vy: 0 })

// A zone defender: id, label, where he starts, and the landmark he is responsible for.
const zone = (id, label, x, y, zoneType, cx, cy) => ({
  player: { id, label, x, y: y + FIELD.END_ZONE_DEPTH, vx: 0, vy: 0, isEngaged: false },
  cov: { type: 'zone', zoneType, zoneCenterX: cx, zoneCenterY: cy },
})

const SCENARIOS = {
  // The case that motivated the carry rule: everyone runs vertical, so nothing ever enters the
  // flat. The flat corners should stay with their receivers rather than releasing them to nobody.
  'cover2-verticals': {
    blurb: 'Cover 2 vs four verticals — nothing ever threatens the flats',
    offense: [qb(), wr('wr1', 6, 'go'), wr('wr2', 18, 'seam'), wr('wr3', 35, 'seam'), wr('wr4', 47, 'go')],
    defense: [
      zone('cbL', 'CB', 8,  LOS + 6,  'flat', 8,  LOS + 6),
      zone('cbR', 'CB', 45, LOS + 6,  'flat', 45, LOS + 6),
      zone('sL',  'S',  16, LOS + 16, 'deep', 16, LOS + 16),
      zone('sR',  'S',  37, LOS + 16, 'deep', 37, LOS + 16),
      zone('lbM', 'LB', MID, LOS + 7, 'hook', MID, LOS + 7),
    ],
  },

  // The regression case: a receiver sitting IN a defender's area while another runs at it from
  // outside. The defender must stay with the man in front of him, not abandon him for the arrival.
  'immediate-vs-arriving': {
    blurb: 'A receiver settled in the zone while another sprints toward it from outside',
    offense: [
      qb(),
      wr('nearMan', MID + 2, 'curl'),          // right in the LB's area
      wr('arriving', MID + 20, 'drag'),        // outside it, running across toward him
      wr('wide', 4, 'go'),
    ],
    defense: [ zone('lbM', 'LB', MID, LOS + 6, 'hook', MID, LOS + 6) ],
  },

  // Two adjacent zones and one receiver between them: exactly one should claim him.
  'seam-between-zones': {
    blurb: 'One receiver in the seam between two adjacent underneath zones',
    offense: [qb(), wr('seamer', MID, 'seam'), wr('flat', 8, 'flat')],
    defense: [
      zone('lbL', 'LB', MID - 5, LOS + 6, 'hook', MID - 5, LOS + 6),
      zone('lbR', 'LB', MID + 5, LOS + 6, 'hook', MID + 5, LOS + 6),
    ],
  },

  // Underneath crossers — the classic zone-buster, and where flip-flopping shows up worst.
  'mesh-crossers': {
    blurb: 'Two crossers running opposite ways through the underneath zones',
    offense: [qb(), wr('crossL', 8, 'cross'), wr('crossR', 45, 'cross'), back('rb', MID + 3, 'flat')],
    defense: [
      zone('lbL', 'LB', MID - 6, LOS + 6, 'hook', MID - 6, LOS + 6),
      zone('lbR', 'LB', MID + 6, LOS + 6, 'hook', MID + 6, LOS + 6),
      zone('cbL', 'CB', 8, LOS + 5, 'flat', 8, LOS + 5),
    ],
  },
}

// ── Harness ──────────────────────────────────────────────────────────────────

function buildState(scn) {
  const offensePlayers = new Map()
  for (const o of scn.offense) offensePlayers.set(o.id, { ...o })

  const defensePlayers  = new Map()
  const defenseCoverage = new Map()
  for (const d of scn.defense) {
    defensePlayers.set(d.player.id, { ...d.player })
    defenseCoverage.set(d.player.id, { ...d.cov })
  }

  return {
    direction: 1,
    yardLine: LOS,
    ballX: MID,
    offensePlayers,
    defensePlayers,
    defenseCoverage,
    playerFatigue: new Map(),
    playDesign: { playType: 'pass' },
    ballCarrierId: null,
    zoneTrace: true,          // make the zone branch record its decision each tick
  }
}

const f = (v, d = 1) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : '·')
const relY = (absY) => absY - FIELD.END_ZONE_DEPTH          // back to the offense-relative frame
const heading = (vx, vy) => (Math.hypot(vx, vy) < 0.15 ? '·' : `${Math.round(Math.atan2(vx, vy) * 180 / Math.PI)}°`)

function rowsFor(state, tick) {
  const rows = []
  const push = (p, side) => {
    const zt = p.zt ?? null
    rows.push({
      tick, t: +(tick * DT).toFixed(2), side,
      id: p.id, label: p.label, route: p.route ?? null,
      x: +p.x.toFixed(2), y: +relY(p.y).toFixed(2),
      vx: +(p.vx ?? 0).toFixed(2), vy: +(p.vy ?? 0).toFixed(2),
      speed: +Math.hypot(p.vx ?? 0, p.vy ?? 0).toFixed(2),
      wpIdx: p.routeWaypointIdx ?? null,
      phase: p.routePhase ?? null,
      threatId:  zt?.threatId  ?? null,
      declared:  zt?.declared  ?? null,
      contested: zt?.contested ?? null,
      radius:    zt?.radius    ?? null,
      mode:      zt?.mode      ?? null,
      targetX: zt ? +zt.targetX.toFixed(2) : null,
      targetY: zt ? +relY(zt.targetY).toFixed(2) : null,
    })
  }
  for (const p of state.offensePlayers.values()) push(p, 'O')
  for (const p of state.defensePlayers.values()) push(p, 'D')
  return rows
}

function printTable(rows, every) {
  const ticks = [...new Set(rows.map(r => r.tick))].filter(t => t % every === 0)
  console.log(
    'tick   t     id        pos    x      y     spd  hdg    | claim      dec cont rad   target',
  )
  console.log('─'.repeat(104))
  for (const t of ticks) {
    for (const r of rows.filter(r => r.tick === t)) {
      const left = `${String(r.tick).padEnd(6)} ${String(r.t).padEnd(5)} ${r.id.padEnd(9)} ${String(r.label).padEnd(6)} ` +
                   `${f(r.x).padStart(5)} ${f(r.y).padStart(6)} ${f(r.speed).padStart(4)} ${heading(r.vx, r.vy).padStart(5)}`
      const right = r.side === 'D' && r.mode
        ? ` | ${String(r.threatId ?? '—').padEnd(10)} ${r.declared ? 'Y' : 'n'}   ${r.contested === null ? '·' : r.contested ? 'Y' : 'n'}    ` +
          `${f(r.radius, 0).padStart(3)}   (${f(r.targetX)}, ${f(r.targetY)})`
        : r.side === 'O' ? ` | route=${r.route ?? '—'} wp=${r.wpIdx ?? '·'} ${r.phase ?? ''}` : ''
      console.log(left + right)
    }
    console.log('')
  }
}

// How often does each zone defender change its mind about who it is covering? This is the number
// that "swirly" actually refers to — a defender that reassigns every few ticks never gets anywhere.
function churnReport(rows) {
  const byDef = new Map()
  for (const r of rows) {
    if (r.side !== 'D' || !r.mode) continue
    if (!byDef.has(r.id)) byDef.set(r.id, [])
    byDef.get(r.id).push(r.threatId)
  }
  console.log('claim churn (how often each defender switched who it was covering)')
  console.log('─'.repeat(104))
  for (const [id, claims] of byDef) {
    let switches = 0
    for (let i = 1; i < claims.length; i++) if (claims[i] !== claims[i - 1]) switches++
    const seq = []
    for (const c of claims) { const v = c ?? '—'; if (seq[seq.length - 1] !== v) seq.push(v) }
    console.log(`  ${id.padEnd(8)} ${String(switches).padStart(3)} switches   ${seq.join(' → ')}`)
  }
  console.log('')
}

// ── Main ─────────────────────────────────────────────────────────────────────

const argv  = process.argv.slice(2)
const name  = argv.find(a => !a.startsWith('--'))
const optOf = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }

if (!name || !SCENARIOS[name]) {
  console.log('scenarios:')
  for (const [k, v] of Object.entries(SCENARIOS)) console.log(`  ${k.padEnd(24)} ${v.blurb}`)
  process.exit(name ? 1 : 0)
}

const scn   = SCENARIOS[name]
const ticks = Number(optOf('ticks', 50))
const every = Number(optOf('every', 5))
const jsonl = optOf('jsonl', null)

const state = buildState(scn)
const rows  = []
for (let i = 1; i <= ticks; i++) {
  runMovement(state, null, DT)
  rows.push(...rowsFor(state, i))
}

console.log(`\n${name} — ${scn.blurb}`)
console.log(`${ticks} ticks @ ${SIM.TICK_RATE} Hz (${(ticks * DT).toFixed(1)}s), LOS on the ${LOS}\n`)
printTable(rows, every)
churnReport(rows)

if (jsonl) {
  writeFileSync(jsonl, rows.map(r => JSON.stringify(r)).join('\n'))
  console.log(`wrote ${rows.length} rows → ${jsonl}`)
}
