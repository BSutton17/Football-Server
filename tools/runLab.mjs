// ── Run lab ──────────────────────────────────────────────────────────────────
//
// How many yards does a run gain, by the angle it is called at? Runs the REAL simulation systems
// in the real order — blocking, push, collision, tackle detection — and reports the result.
//
// This exists because "running outside is the only thing that works" is a claim about a
// DISTRIBUTION, not about one play. A single carry tells you nothing; the shape of gain-by-angle
// across many carries tells you whether the interior is actually blocked.
//
//   node tools/runLab.mjs                    # gain by run angle
//   node tools/runLab.mjs --carries 200      # more samples per angle
//   node tools/runLab.mjs --ol 90 --dl 70    # a dominant line (watch the pancakes)
//   node tools/runLab.mjs --verbose          # per-angle detail

process.env.LINE_DEBUG = '0'
process.env.RUN_DEBUG  = '0'

const { runEngagement }        = await import('../src/game/systems/engagement.js')
const { runPassRush }          = await import('../src/game/systems/passRush.js')
const { runPancake }           = await import('../src/game/systems/pancake.js')
const { runMovement }          = await import('../src/game/systems/movement.js')
const { runPushForce }         = await import('../src/game/systems/pushForce.js')
const { runCollisionResponse } = await import('../src/game/systems/collisionResponse.js')
const { SIM, FIELD }           = await import('../src/constants.js')

const DT = SIM.TICK_MS / 1000
const LOS = 25, MID = FIELD.WIDTH / 2, EZ = FIELD.END_ZONE_DEPTH, LOSY = LOS + EZ
const TICKS = 70          // 3.5s — long enough for the run to be decided

const argv = process.argv.slice(2)
const optOf = (k, d) => { const i = argv.indexOf('--' + k); return i >= 0 ? Number(argv[i + 1]) : d }
const has = (k) => argv.includes('--' + k)

const CARRIES = optOf('carries', 120)
const OL_STR  = optOf('ol', 80)
const DL_STR  = optOf('dl', 86)

// A balanced I-formation run against a 4-3 front.
function build(runAngle, seedRng) {
  const off = new Map(), def = new Map(), cov = new Map()
  const olR = { strength: OL_STR, runBlock: OL_STR, passBlock: OL_STR, speed: 55, acceleration: 38 }
  const dlR = { strength: DL_STR, passRush: DL_STR, speed: 65, acceleration: 42 }

  off.set('qb', { id: 'qb', label: 'QB', x: MID, y: LOSY - 2, vx: 0, vy: 0 })
  ;[-3.5, -1.75, 0, 1.75, 3.5].forEach((dx, i) =>
    off.set('ol' + i, { id: 'ol' + i, label: 'OL', x: MID + dx, y: LOSY - 0.5, vx: 0, vy: 0, ratings: olR }))
  off.set('te1', { id: 'te1', label: 'TE', x: MID + 5.5, y: LOSY - 0.5, vx: 0, vy: 0, ratings: { ...olR, strength: OL_STR - 8 } })
  off.set('rb1', { id: 'rb1', label: 'RB', x: MID, y: LOSY - 5, vx: 0, vy: 0,
    ratings: { speed: 90, acceleration: 90, runPower: 82, vision: 85, strength: 65 } })
  off.set('wr1', { id: 'wr1', label: 'WR', x: 6,  y: LOSY, vx: 0, vy: 0 })
  off.set('wr2', { id: 'wr2', label: 'WR', x: 47, y: LOSY, vx: 0, vy: 0 })

  ;[-4, -1.5, 1.5, 4].forEach((dx, i) =>
    def.set('dl' + i, { id: 'dl' + i, label: 'DL', x: MID + dx, y: LOSY + 1, vx: 0, vy: 0, ratings: dlR, isEngaged: false }))
  ;[-6, 0, 6].forEach((dx, i) => {
    const id = 'lb' + i
    def.set(id, { id, label: 'LB', x: MID + dx, y: LOSY + 5, vx: 0, vy: 0, isEngaged: false,
      ratings: { strength: 72, speed: 80, acceleration: 78, awareness: 70, vision: 70 } })
    cov.set(id, { type: 'zone', zoneType: 'hook', zoneCenterX: MID + dx, zoneCenterY: LOS + 5 })
  })
  ;[6, 47].forEach((x, i) => {
    const id = 'cb' + i
    def.set(id, { id, label: 'CB', x, y: LOSY + 7, vx: 0, vy: 0, isEngaged: false,
      ratings: { strength: 60, speed: 92, acceleration: 90, awareness: 70 } })
    cov.set(id, { type: 'man', targetId: 'wr' + (i + 1) })
  })
  ;[-8, 8].forEach((dx, i) => {
    const id = 's' + i
    def.set(id, { id, label: 'S', x: MID + dx, y: LOSY + 12, vx: 0, vy: 0, isEngaged: false,
      ratings: { strength: 68, speed: 88, acceleration: 85, awareness: 75 } })
    cov.set(id, { type: 'zone', zoneType: 'deep', zoneCenterX: MID + dx, zoneCenterY: LOS + 15 })
  })

  return {
    roomId: 'runlab', direction: 1, yardLine: LOS, ballX: MID,
    offensePlayers: off, defensePlayers: def, defenseCoverage: cov,
    playerFatigue: new Map(),
    playDesign: { playType: 'run', runAngle, runnerId: 'rb1' },
    ballCarrierId: 'rb1', tick: 0, tackleEnqueued: false, _rng: seedRng,
  }
}

// A small deterministic PRNG so a run of the lab is reproducible.
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// One carry. Returns yards gained past the LOS and what ended it.
function carry(runAngle, rng) {
  const s = build(runAngle, rng)
  const rb = s.offensePlayers.get('rb1')
  let pancakes = 0
  let best = 0

  for (let i = 1; i <= TICKS; i++) {
    runEngagement(s, null, DT)
    runPassRush(s, null, DT)
    runPancake(s, null, DT, rng)
    runMovement(s, null, DT)
    runPushForce(s, null, DT)
    runCollisionResponse(s, null, DT)
    s.tick = i

    for (const d of s.defensePlayers.values()) {
      if ((d.pancakedFor ?? 0) > 0 && !d._counted) { d._counted = true; pancakes++ }
    }

    const gained = (rb.y - LOSY) * s.direction
    if (gained > best) best = gained

    // Tackle: any non-pancaked defender touching the carrier ends it.
    let down = false
    for (const d of s.defensePlayers.values()) {
      if ((d.pancakedFor ?? 0) > 0) continue
      if (Math.hypot(d.x - rb.x, d.y - rb.y) <= 1.5) { down = true; break }
    }
    if (down) break
  }
  return { gain: best, pancakes }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const ANGLES = [
  ['far left  (-40)', -40], ['off tackle L (-22)', -22], ['inside L (-10)', -10],
  ['dive     (0)', 0],
  ['inside R (+10)', 10], ['off tackle R (+22)', 22], ['far right (+40)', 40],
]

console.log(`\nrun lab — ${CARRIES} carries per angle, OL strength ${OL_STR} vs DL strength ${DL_STR}`)
console.log(`(${TICKS} ticks @ ${SIM.TICK_RATE} Hz, ball on the ${LOS})\n`)
console.log('   call                   mean    median     stuffed   10+ yds   pancakes')
console.log('   ' + '-'.repeat(74))

const rows = []
for (const [label, angle] of ANGLES) {
  const gains = [], pans = []
  for (let c = 0; c < CARRIES; c++) {
    const r = carry(angle, mulberry(1000 + c * 17 + angle))
    gains.push(r.gain); pans.push(r.pancakes)
  }
  gains.sort((a, b) => a - b)
  const mean = gains.reduce((a, b) => a + b, 0) / gains.length
  const med  = gains[Math.floor(gains.length / 2)]
  const stuffed = gains.filter(g => g < 1).length / gains.length
  const big     = gains.filter(g => g >= 10).length / gains.length
  const pk      = pans.reduce((a, b) => a + b, 0) / pans.length
  rows.push({ label, angle, mean, med, stuffed, big, pk })
  console.log('   ' + label.padEnd(22) +
    mean.toFixed(2).padStart(6) + med.toFixed(2).padStart(10) +
    (stuffed * 100).toFixed(0).padStart(10) + '%' +
    (big * 100).toFixed(0).padStart(9) + '%' +
    pk.toFixed(2).padStart(11))
}

const inside  = rows.filter(r => Math.abs(r.angle) <= 10)
const outside = rows.filter(r => Math.abs(r.angle) >= 22)
const mn = (a) => a.reduce((s, r) => s + r.mean, 0) / a.length
console.log('\n   INSIDE  (|angle| <= 10): ' + mn(inside).toFixed(2) + ' yds')
console.log('   OUTSIDE (|angle| >= 22): ' + mn(outside).toFixed(2) + ' yds')
console.log('   inside / outside ratio : ' + (mn(inside) / mn(outside)).toFixed(2) +
            '   (1.00 = equally viable)\n')
