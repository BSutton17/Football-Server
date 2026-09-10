// ── Openness lab ─────────────────────────────────────────────────────────────
//
// How open do receivers actually get against each coverage shell? This runs the REAL movement
// system and the REAL openness engine tick by tick — no model of its own — and reports the number
// the QB would have seen, per receiver, per tick.
//
// `coverageLab.mjs` answers "what is this defender doing?". This answers "did it work?". They share
// the same scaffolding on purpose: a shell here is the same zone-landmark description you would
// give a defender in the coverage menu.
//
//   node tools/opennessLab.mjs                          # the full shell × concept matrix
//   node tools/opennessLab.mjs --shell cover2           # one shell, every concept, in detail
//   node tools/opennessLab.mjs --shell cover3 --concept verticals
//   node tools/opennessLab.mjs --list                   # what shells and concepts exist
//   node tools/opennessLab.mjs --csv out.csv            # per-receiver rows for a spreadsheet
//   node tools/opennessLab.mjs --jsonl out.jsonl        # every per-tick sample
//
// Reading the output: openness is 0–1 and the tiers are the same ones the QB sees as colours and
// the pass resolver rolls against — green ≥ 0.66, red < 0.33, yellow between. The headline column
// is the THROW WINDOW mean: the average openness across the window a QB realistically throws in
// (2.0–3.5s after the snap), which matters far more than a peak the receiver held for one tick.

process.env.LINE_DEBUG = '0'   // silence the OL/DL tracer

const { runMovement } = await import('../src/game/systems/movement.js')
const { computeReceiverOpenness, opennessBreakdown } = await import('../src/game/utils/openness.js')
const { opennessTier, OPENNESS_OPEN, OPENNESS_RED } = await import('../src/game/utils/passOutcome.js')
import { SIM, FIELD } from '../src/constants.js'
import { writeFileSync } from 'node:fs'

const DT   = SIM.TICK_MS / 1000
const LOS  = 25                       // offense-relative yard line the ball is on
const MID  = FIELD.WIDTH / 2
const EZ   = FIELD.END_ZONE_DEPTH
const LOSY = LOS + EZ                 // absolute Y of the line of scrimmage

// The span a QB realistically releases in. Before this the route hasn't developed; after it the
// pocket is gone. Averaging openness across it is the fair measure of "was he open?".
const THROW_FROM = 2.0
const THROW_TO   = 3.5
const SAMPLES    = [2.0, 2.5, 3.0, 3.5]

// ── Offensive building blocks ────────────────────────────────────────────────
// x is an absolute field coordinate; y is offense-relative and converted here.

// Named alignments, so formations are described the way a coach would rather than as bare numbers —
// and so the inner receivers actually sit in the seams the middle-of-field zones are defending.
// The field is 53.33 wide; NFL hashes are ~23.6 and ~29.8, the numbers ~9 and ~44.
const ALIGN = {
  farL:  4,           // split wide left
  numL:  10,          // on the left numbers
  slotL: MID - 5.5,   // left slot, just outside the hash — this is the seam
  slotR: MID + 5.5,   // right slot
  numR:  FIELD.WIDTH - 10,
  farR:  FIELD.WIDTH - 4,
}

const rec = (id, label, x, route, depthOffset = 0) => ({
  id, label, route, x, y: LOSY + depthOffset, vx: 0, vy: 0,
})
const wr  = (id, x, route) => rec(id, 'WR', x, route)
const te  = (id, x, route) => rec(id, 'TE', x, route)
const rb  = (id, x, route) => rec(id, 'RB', x, route, -5)
const qb  = () => ({ id: 'qb', label: 'QB', x: MID, y: LOSY - 6, vx: 0, vy: 0 })

// Five linemen, so the rush has something to beat and the pocket is real.
const oline = () => [-4, -2, 0, 2, 4].map((dx, i) =>
  ({ id: `ol${i}`, label: 'OL', route: 'block', x: MID + dx, y: LOSY - 1, vx: 0, vy: 0 }))

// ── Defensive building blocks ────────────────────────────────────────────────

// A zone defender and the landmark he is responsible for.
//
// Mind the two frames: the PLAYER's y is absolute (hence `+ EZ`), but the LANDMARK is
// offense-relative — `movement.js` converts it with `toAbsY` itself, so adding EZ here would bury
// every zone ten yards too deep. This is the same convention `coverageLab.mjs` uses.
const zone = (id, label, x, y, zoneType, cx = x, cy = y) => ({
  player: { id, label, x, y: y + EZ, vx: 0, vy: 0, isEngaged: false },
  cov: { type: 'zone', zoneType, zoneCenterX: cx, zoneCenterY: cy },
})
// A man defender locked to a receiver.
const man = (id, label, x, y, targetId) => ({
  player: { id, label, x, y: y + EZ, vx: 0, vy: 0, isEngaged: false },
  cov: { type: 'man', targetId },
})
// A pass rusher — no coverage entry at all, which is exactly how `isRusher()` identifies one.
const rush = (id, x) => ({
  player: { id, label: 'DL', x, y: LOSY + 1, vx: 0, vy: 0, isEngaged: false },
  cov: null,
})
const FRONT_FOUR = () => [rush('dl1', MID - 5), rush('dl2', MID - 2), rush('dl3', MID + 2), rush('dl4', MID + 5)]

// ── The shells ───────────────────────────────────────────────────────────────
//
// Each is a genuine 11: a four-man rush plus seven in coverage, with landmarks placed where that
// coverage actually puts them. Depths are relative to the LOS.

const SHELLS = {
  cover2: {
    name: 'Cover 2',
    blurb: '2 deep halves, 5 under — corners sink to the flats, safeties split the deep field',
    build: () => [
      ...FRONT_FOUR(),
      zone('cbL', 'CB', 4,       LOS + 5,  'flat', 6,       LOS + 7),
      zone('cbR', 'CB', 49,      LOS + 5,  'flat', 47,      LOS + 7),
      zone('sL',  'S',  MID - 13, LOS + 14, 'deep', MID - 13, LOS + 18),
      zone('sR',  'S',  MID + 13, LOS + 14, 'deep', MID + 13, LOS + 18),
      zone('lbW', 'LB', MID - 8, LOS + 5,  'curl', MID - 9, LOS + 9),
      zone('lbM', 'LB', MID,     LOS + 5,  'hook', MID,     LOS + 9),
      zone('lbS', 'LB', MID + 8, LOS + 5,  'curl', MID + 9, LOS + 9),
    ],
  },

  tampa2: {
    name: 'Tampa 2',
    blurb: 'Cover 2 with the Mike running the deep middle — closes the seam that beats Cover 2',
    build: () => [
      ...FRONT_FOUR(),
      zone('cbL', 'CB', 4,       LOS + 5,  'flat', 6,       LOS + 7),
      zone('cbR', 'CB', 49,      LOS + 5,  'flat', 47,      LOS + 7),
      zone('sL',  'S',  MID - 13, LOS + 14, 'deep', MID - 13, LOS + 18),
      zone('sR',  'S',  MID + 13, LOS + 14, 'deep', MID + 13, LOS + 18),
      zone('lbW', 'LB', MID - 8, LOS + 5,  'curl', MID - 9, LOS + 9),
      zone('lbM', 'LB', MID,     LOS + 5,  'deep', MID,     LOS + 18),   // the Tampa runner
      zone('lbS', 'LB', MID + 8, LOS + 5,  'curl', MID + 9, LOS + 9),
    ],
  },

  cover3: {
    name: 'Cover 3',
    blurb: '3 deep thirds, 4 under — corners bail, free safety takes the middle third',
    build: () => [
      ...FRONT_FOUR(),
      zone('cbL', 'CB', 5,       LOS + 7,  'deep', 8,       LOS + 20),
      zone('cbR', 'CB', 48,      LOS + 7,  'deep', 45,      LOS + 20),
      zone('fs',  'S',  MID,     LOS + 13, 'deep', MID,     LOS + 20),
      zone('ss',  'S',  MID + 9, LOS + 6,  'curl', MID + 10, LOS + 9),
      zone('lbW', 'LB', MID - 9, LOS + 5,  'curl', MID - 10, LOS + 9),
      zone('lbM', 'LB', MID - 2, LOS + 5,  'hook', MID - 2, LOS + 9),
      zone('lbS', 'LB', MID + 3, LOS + 5,  'hook', MID + 3, LOS + 9),
    ],
  },

  cover4: {
    name: 'Cover 4 (quarters)',
    blurb: '4 deep quarters, 3 under — nothing gets over the top, everything underneath is free',
    build: () => [
      ...FRONT_FOUR(),
      zone('cbL', 'CB', 5,       LOS + 7,  'deep', 7,       LOS + 18),
      zone('cbR', 'CB', 48,      LOS + 7,  'deep', 46,      LOS + 18),
      zone('sL',  'S',  MID - 8, LOS + 12, 'deep', MID - 8, LOS + 18),
      zone('sR',  'S',  MID + 8, LOS + 12, 'deep', MID + 8, LOS + 18),
      zone('lbW', 'LB', MID - 7, LOS + 4,  'curl', MID - 8, LOS + 7),
      zone('lbM', 'LB', MID,     LOS + 4,  'hook', MID,     LOS + 7),
      zone('lbS', 'LB', MID + 7, LOS + 4,  'curl', MID + 8, LOS + 7),
    ],
  },

  cover6: {
    name: 'Cover 6 (quarter-quarter-half)',
    blurb: 'Quarters to the field, Cover 2 to the boundary — the two halves behave differently',
    build: () => [
      ...FRONT_FOUR(),
      zone('cbL', 'CB', 5,       LOS + 7,  'deep', 7,       LOS + 18),   // quarters side
      zone('sL',  'S',  MID - 8, LOS + 12, 'deep', MID - 8, LOS + 18),
      zone('cbR', 'CB', 49,      LOS + 5,  'flat', 47,      LOS + 7),    // Cover 2 side
      zone('sR',  'S',  MID + 12, LOS + 13, 'deep', MID + 13, LOS + 18),
      zone('lbW', 'LB', MID - 7, LOS + 4,  'curl', MID - 8, LOS + 8),
      zone('lbM', 'LB', MID,     LOS + 4,  'hook', MID,     LOS + 8),
      zone('lbS', 'LB', MID + 7, LOS + 4,  'curl', MID + 8, LOS + 8),
    ],
  },

  // A man control, so the zone numbers have something to be compared against.
  cover1: {
    name: 'Cover 1 (man free)',
    blurb: 'Man across the board with a single deep safety — the non-zone baseline',
    build: (concept) => {
      const targets = concept.offense.filter(p => p.route && p.route !== 'block' && p.label !== 'QB')
      const spots = [[5, 6], [49, 6], [MID - 6, 4], [MID + 6, 4], [MID + 2, 3]]
      const labels = ['CB', 'CB', 'LB', 'LB', 'LB']
      const cover = targets.slice(0, 5).map((t, i) =>
        man(`m${i}`, labels[i], spots[i][0], LOS + spots[i][1], t.id))
      return [
        ...FRONT_FOUR(),
        ...cover,
        zone('fs', 'S', MID, LOS + 13, 'deep', MID, LOS + 18),
      ].slice(0, 11)
    },
  },
}

// ── The route concepts ───────────────────────────────────────────────────────
//
// 3 WR + 1 TE + 1 RB in every one, so WR and TE are always measured side by side under the same
// coverage on the same snap.

const CONCEPTS = {
  verticals: {
    name: 'Four verticals',
    blurb: 'The Cover 2 beater — the two seams attack the middle of the field between the safeties',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farL, 'go'), wr('wrZ', ALIGN.farR, 'go'), wr('wrS', ALIGN.slotL, 'seam'),
      te('te1', ALIGN.slotR, 'seam'), rb('rb1', MID + 3, 'flat'),
    ],
  },
  mesh: {
    name: 'Mesh',
    blurb: 'Crossers underneath — the classic zone-buster, and where hand-offs break down',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farL, 'cross'), wr('wrZ', ALIGN.farR, 'cross'), wr('wrS', ALIGN.numL, 'corner'),
      te('te1', ALIGN.slotR, 'drag'), rb('rb1', MID + 3, 'swing'),
    ],
  },
  smash: {
    name: 'Smash',
    blurb: 'Hitch under, corner over the top — a high/low read on the flat defender',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farL, 'curl'), wr('wrZ', ALIGN.farR, 'curl'), wr('wrS', ALIGN.slotL, 'corner'),
      te('te1', ALIGN.slotR, 'corner'), rb('rb1', MID + 3, 'flat'),
    ],
  },
  flood: {
    name: 'Flood',
    blurb: 'Three levels to one side — stresses a zone defender who can only cover one',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farR, 'go'), wr('wrZ', ALIGN.numR, 'out'), wr('wrS', ALIGN.farL, 'dig'),
      te('te1', ALIGN.slotR, 'flat'), rb('rb1', MID + 3, 'block'),
    ],
  },
  dagger: {
    name: 'Dagger',
    blurb: 'Seam clears the middle, dig works in behind it — a Cover 3 / Cover 4 answer',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farL, 'dig'), wr('wrZ', ALIGN.farR, 'go'), wr('wrS', ALIGN.slotL, 'seam'),
      te('te1', ALIGN.slotR, 'curl'), rb('rb1', MID + 3, 'flat'),
    ],
  },
  stick: {
    name: 'Stick',
    blurb: 'Quick game — the TE sits down at 7 while everything else clears out',
    offense: [
      qb(), ...oline(),
      wr('wrX', ALIGN.farL, 'slant'), wr('wrZ', ALIGN.farR, 'go'), wr('wrS', ALIGN.numL, 'out'),
      te('te1', ALIGN.slotR, 'curl'), rb('rb1', MID + 3, 'flat'),
    ],
  },
}

// ── Harness ──────────────────────────────────────────────────────────────────

function buildState(concept, shell) {
  const offensePlayers = new Map()
  for (const o of concept.offense) offensePlayers.set(o.id, { ...o })

  const defensePlayers  = new Map()
  const defenseCoverage = new Map()
  for (const d of shell.build(concept)) {
    defensePlayers.set(d.player.id, { ...d.player })
    if (d.cov) defenseCoverage.set(d.player.id, { ...d.cov })
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
  }
}

// The same lane context the serializer builds, so the short-pass throwing-lane rule applies here
// exactly as it does in a real game.
function laneCtx(state) {
  const zoneIds = new Set()
  for (const [id, cov] of state.defenseCoverage) if (cov?.type === 'zone') zoneIds.add(id)
  return { losY: LOSY, direction: 1, zoneIds }
}

const isReceiver = (p) => p.route && p.route !== 'block' && ['WR', 'TE', 'RB'].includes(p.label)

// Run one snap. Returns a per-receiver record of how open he was, tick by tick.
function runSnap(concept, shell, ticks) {
  const state = buildState(concept, shell)
  const ctx   = laneCtx(state)
  const qbP   = [...state.offensePlayers.values()].find(p => p.label === 'QB')
  const series = new Map()   // receiverId -> [{ t, openness, tier, nearestDist, nearestId }]

  for (let i = 1; i <= ticks; i++) {
    runMovement(state, null, DT)
    const t = +(i * DT).toFixed(2)
    const defenders = [...state.defensePlayers.values()]
    for (const p of state.offensePlayers.values()) {
      if (!isReceiver(p)) continue
      const o  = computeReceiverOpenness(p, defenders, qbP, ctx)
      const bd = opennessBreakdown(p, defenders, qbP, ctx)
      if (!series.has(p.id)) series.set(p.id, { label: p.label, route: p.route, samples: [] })
      series.get(p.id).samples.push({
        t, openness: o, tier: opennessTier(o),
        depth: +(p.y - LOSY).toFixed(2),
        nearestId: bd.nearestId, nearestDist: +bd.nearestDist.toFixed(2),
        align: +bd.align.toFixed(3), bracket: bd.bracket,
      })
    }
  }
  return series
}

// Condense one receiver's tick series into the numbers worth printing.
function summarize(entry) {
  const s = entry.samples
  const win = s.filter(r => r.t >= THROW_FROM && r.t <= THROW_TO)
  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0)
  const peak = s.reduce((best, r) => (r.openness > best.openness ? r : best), s[0])
  const share = (tier) => (win.length ? win.filter(r => r.tier === tier).length / win.length : 0)
  return {
    label: entry.label,
    route: entry.route,
    // Why he was open, using the openness engine's own inputs over the same window. Separation is
    // the dominant term (base = (dist - 1.0) / (5.5 - 1.0)); align < 0 means the nearest defender is
    // TRAILING, which opens the window hard via BEATEN_BOOST.
    sep: mean(win.map(r => r.nearestDist)),
    align: mean(win.map(r => r.align)),
    beatenShare: win.length ? win.filter(r => r.align < 0).length / win.length : 0,
    bracket: mean(win.map(r => r.bracket)),
    windowMean: mean(win.map(r => r.openness)),
    peak: peak.openness,
    peakAt: peak.t,
    openShare: share('open'),
    coveredShare: share('covered'),
    smotheredShare: share('smothered'),
    at: SAMPLES.map(target => {
      const r = s.reduce((best, x) => (Math.abs(x.t - target) < Math.abs(best.t - target) ? x : best), s[0])
      return { t: target, openness: r.openness, nearestId: r.nearestId, nearestDist: r.nearestDist }
    }),
  }
}

// ── Output ───────────────────────────────────────────────────────────────────

const f2 = (v) => v.toFixed(2)
const pctS = (v) => (v * 100).toFixed(0).padStart(3) + '%'
const tierMark = (o) => (o >= OPENNESS_OPEN ? 'OPEN ' : o < OPENNESS_RED ? 'SMOTH' : 'cont ')

function printDetail(conceptKey, shellKey, series) {
  const c = CONCEPTS[conceptKey], sh = SHELLS[shellKey]
  console.log(`\n${sh.name}  vs  ${c.name}`)
  console.log(`  ${sh.blurb}`)
  console.log(`  ${c.blurb}\n`)
  console.log('  receiver  pos route     win.mean  peak  @t     ' +
              SAMPLES.map(t => `t=${t.toFixed(1)}`).join('  ') + '    open/cont/smoth (in window)')
  console.log('  ' + '─'.repeat(112))
  const rows = [...series.entries()].map(([id, e]) => [id, summarize(e)])
  rows.sort((a, b) => b[1].windowMean - a[1].windowMean)
  for (const [id, r] of rows) {
    const at = r.at.map(a => `${f2(a.openness)}`).join('   ')
    console.log(
      `  ${id.padEnd(9)} ${r.label.padEnd(3)} ${String(r.route).padEnd(9)} ` +
      `${f2(r.windowMean).padStart(6)}  ${f2(r.peak)}  ${String(r.peakAt).padStart(4)}   ${at}     ` +
      `${pctS(r.openShare)}/${pctS(r.coveredShare)}/${pctS(r.smotheredShare)}   ${tierMark(r.windowMean)}`,
    )
  }
}

// The headline: average throw-window openness per shell, split by position.
function printMatrix(results) {
  const shellKeys = Object.keys(SHELLS)
  const conceptKeys = Object.keys(CONCEPTS)

  console.log('\n\n══ Throw-window openness by shell and concept ' + '═'.repeat(58))
  console.log(`   mean openness across ${THROW_FROM}–${THROW_TO}s, averaged over every eligible receiver`)
  console.log(`   green ≥ ${OPENNESS_OPEN}   red < ${OPENNESS_RED}\n`)
  console.log('   shell                       ' + conceptKeys.map(k => k.padStart(10)).join('') + '      mean')
  console.log('   ' + '─'.repeat(100))
  for (const sk of shellKeys) {
    const cells = conceptKeys.map(ck => {
      const rs = results.filter(r => r.shell === sk && r.concept === ck)
      return rs.length ? rs.reduce((a, r) => a + r.windowMean, 0) / rs.length : NaN
    })
    const mean = cells.reduce((a, b) => a + b, 0) / cells.length
    console.log('   ' + SHELLS[sk].name.padEnd(28) + cells.map(v => f2(v).padStart(10)).join('') +
                '    ' + f2(mean).padStart(6))
  }

  // The single number to tune against: how open receivers are against ZONE, with man excluded.
  const zoneShells = shellKeys.filter(k => k !== 'cover1')
  const zoneRows = results.filter(r => zoneShells.includes(r.shell))
  const zoneMean = zoneRows.length ? zoneRows.reduce((a, r) => a + r.windowMean, 0) / zoneRows.length : NaN
  const manRows  = results.filter(r => r.shell === 'cover1')
  const manMean  = manRows.length ? manRows.reduce((a, r) => a + r.windowMean, 0) / manRows.length : NaN
  console.log('\n   ZONE MEAN ' + f2(zoneMean) + '   (man baseline ' + f2(manMean) + ')   target 0.40')

  console.log('\n\n══ WR vs TE vs RB, by shell ' + '═'.repeat(76))
  console.log('   the same throw-window mean, split by position (all concepts pooled)\n')
  console.log('   shell                            WR        TE        RB      TE−WR')
  console.log('   ' + '─'.repeat(70))
  for (const sk of shellKeys) {
    const byPos = (pos) => {
      const rs = results.filter(r => r.shell === sk && r.label === pos)
      return rs.length ? rs.reduce((a, r) => a + r.windowMean, 0) / rs.length : NaN
    }
    const w = byPos('WR'), t = byPos('TE'), b = byPos('RB')
    const delta = t - w
    console.log('   ' + SHELLS[sk].name.padEnd(28) +
      f2(w).padStart(8) + f2(t).padStart(10) + f2(b).padStart(10) +
      `${delta >= 0 ? '+' : ''}${f2(delta)}`.padStart(11))
  }

  console.log('\n\n== WHY they are open ' + '='.repeat(74))
  console.log('   separation = yards to the nearest defender (fully open at 5.5, zero at 1.0)')
  console.log('   beaten%    = share of the window where that defender was TRAILING, not in front\n')
  console.log('   shell                        separation   beaten%   bracket    openness')
  console.log('   ' + '-'.repeat(74))
  for (const sk of shellKeys) {
    const rs = results.filter(r => r.shell === sk)
    if (!rs.length) continue
    const m = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length
    console.log('   ' + SHELLS[sk].name.padEnd(30) + f2(m('sep')).padStart(8) +
                pctS(m('beatenShare')).padStart(10) + f2(m('bracket')).padStart(10) +
                f2(m('windowMean')).padStart(12))
  }

  console.log('\n\n══ Where each position finds its openness ' + '═'.repeat(62))
  console.log('   share of throw-window ticks in each tier, pooled across every shell and concept\n')
  console.log('   position      open     contested   smothered      n')
  console.log('   ' + '─'.repeat(60))
  for (const pos of ['WR', 'TE', 'RB']) {
    const rs = results.filter(r => r.label === pos)
    if (!rs.length) continue
    const m = (k) => rs.reduce((a, r) => a + r[k], 0) / rs.length
    console.log('   ' + pos.padEnd(12) + pctS(m('openShare')).padStart(7) +
                pctS(m('coveredShare')).padStart(12) + pctS(m('smotheredShare')).padStart(12) +
                String(rs.length).padStart(7))
  }
}

// ── Main ─────────────────────────────────────────────────────────────────────

const argv  = process.argv.slice(2)
const optOf = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d }
const has   = (k) => argv.includes(`--${k}`)

if (has('list')) {
  console.log('\nshells:')
  for (const [k, v] of Object.entries(SHELLS)) console.log(`  ${k.padEnd(10)} ${v.name.padEnd(28)} ${v.blurb}`)
  console.log('\nconcepts:')
  for (const [k, v] of Object.entries(CONCEPTS)) console.log(`  ${k.padEnd(10)} ${v.name.padEnd(28)} ${v.blurb}`)
  process.exit(0)
}

const ticks     = Number(optOf('ticks', 90))          // 4.5s
const onlyShell = optOf('shell', null)
const onlyConc  = optOf('concept', null)
const csvPath   = optOf('csv', null)
const jsonlPath = optOf('jsonl', null)

const shellKeys   = onlyShell ? [onlyShell] : Object.keys(SHELLS)
const conceptKeys = onlyConc  ? [onlyConc]  : Object.keys(CONCEPTS)
for (const k of shellKeys)   if (!SHELLS[k])   { console.error(`unknown shell "${k}" — try --list`); process.exit(1) }
for (const k of conceptKeys) if (!CONCEPTS[k]) { console.error(`unknown concept "${k}" — try --list`); process.exit(1) }

const results = []
const allSamples = []

console.log(`\nopenness lab — ${shellKeys.length} shell(s) × ${conceptKeys.length} concept(s), ` +
            `${ticks} ticks @ ${SIM.TICK_RATE} Hz (${(ticks * DT).toFixed(1)}s), LOS on the ${LOS}`)

for (const sk of shellKeys) {
  for (const ck of conceptKeys) {
    const series = runSnap(CONCEPTS[ck], SHELLS[sk], ticks)
    if (onlyShell || onlyConc) printDetail(ck, sk, series)
    for (const [id, entry] of series) {
      const s = summarize(entry)
      results.push({ shell: sk, concept: ck, id, ...s })
      if (jsonlPath) for (const smp of entry.samples) allSamples.push({ shell: sk, concept: ck, id, label: entry.label, ...smp })
    }
  }
}

if (!onlyShell && !onlyConc) printMatrix(results)
else if (shellKeys.length > 1 || conceptKeys.length > 1) printMatrix(results)

if (csvPath) {
  const head = 'shell,concept,receiver,position,route,windowMean,peak,peakAt,openShare,coveredShare,smotheredShare'
  const lines = results.map(r => [
    r.shell, r.concept, r.id, r.label, r.route,
    r.windowMean.toFixed(4), r.peak.toFixed(4), r.peakAt,
    r.openShare.toFixed(4), r.coveredShare.toFixed(4), r.smotheredShare.toFixed(4),
  ].join(','))
  writeFileSync(csvPath, [head, ...lines].join('\n'))
  console.log(`\nwrote ${results.length} receiver rows → ${csvPath}`)
}
if (jsonlPath) {
  writeFileSync(jsonlPath, allSamples.map(r => JSON.stringify(r)).join('\n'))
  console.log(`wrote ${allSamples.length} per-tick samples → ${jsonlPath}`)
}
console.log('')
