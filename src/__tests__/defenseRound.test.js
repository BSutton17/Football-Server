import { describe, it, expect, afterEach } from '@jest/globals'
import { initGame, deleteGame, getLosY } from '../game/gameState.js'
import { initLivePhase } from '../game/systems/init.js'
import { transition, PHASE } from '../game/stateMachine.js'
import { createFakeIo } from '../headless/harness.js'
import { enqueue, processQueue, EVENT, pickCatcher, isScrambleSack } from '../game/eventQueue.js'
import { pressureThrowMods, PRESSURE_CATCH_PENALTY, HEAVY_PRESSURE_CATCH_PENALTY, HEAVY_PRESSURE_INT,
  incompletionReason, resolvePass, OVERTHROW_AIR_YARDS } from '../game/utils/passOutcome.js'
import { revealLabel } from '../game/manual.js'
import { computeReceiverOpenness } from '../game/utils/openness.js'
import { runPassRush } from '../game/systems/passRush.js'
import { computeZoneCoordination } from '../game/systems/movement.js'
import { FIELD } from '../constants.js'

// ── [pick reach] An interception needs a defender who can reach the ball ──────────
//
// A safety eight yards away was credited with picking off Brock Bowers at the sideline, and
// teleported onto him to do it — the pick went to the nearest defender anywhere on the field.
describe('[pick reach] who can intercept', () => {
  const receiver = { x: 50, y: 40 }

  it('⚠️ NOBODY, when the nearest defender is eight yards away — the Brock Bowers pick', () => {
    expect(pickCatcher([{ id: 's3', x: 50, y: 48.1 }], receiver)).toBeNull()
  })

  it('the nearest defender within reach', () => {
    const near = { id: 'cb1', x: 52, y: 41 }
    const nearer = { id: 'lb1', x: 50.5, y: 40.5 }
    expect(pickCatcher([near, nearer, { id: 's1', x: 50, y: 60 }], receiver)).toBe(nearer)
  })
})

// ── [scramble sack] A scrambling QB brought down behind the line is sacked ──────────
const ROOMS = []
afterEach(() => { for (const id of ROOMS.splice(0)) deleteGame(id) })

function startPlay(roomId, playType = 'pass') {
  ROOMS.push(roomId)
  const state = initGame(roomId, 0, { seed: 7 })
  state.yardLine = 30
  const los = 10 + state.yardLine
  state.playDesign = { playType, runAngle: 0, players: [] }
  state.offensePlayers.set('qb1', { id: 'qb1', label: 'QB', x: 26.5, y: los - 5, vx: 0, vy: 0, isEngaged: false })
  state.offensePlayers.set('wr1', { id: 'wr1', label: 'WR', x: 8, y: los, vx: 0, vy: 0, isEngaged: false })
  // A linebacker, not a lineman: the auto-placed front is not on the roster and is not in the box score.
  state.defensePlayers.set('lb1', { id: 'lb1', label: 'LB', x: 30, y: los - 4, vx: 0, vy: 0, isEngaged: false })
  initLivePhase(state)
  transition(state, PHASE.COUNTDOWN)
  transition(state, PHASE.LIVE)
  return state
}

function tackleQb(roomId, state, yardsBehind) {
  const io = createFakeIo()
  state.ballCarrierId = 'qb1'          // he left the pocket: he is the runner now
  const y = getLosY(state) - yardsBehind * state.direction
  enqueue(roomId, EVENT.TACKLE, { carrierId: 'qb1', x: 30, y })
  processQueue(roomId, state, io)
  // Box-score lines are keyed `slot:id`.
  return (id) => [...state.stats.players.entries()].find(([k]) => k.endsWith(`:${id}`))?.[1]
}

describe('[scramble sack] the QB tackled behind the line on a pass play', () => {
  it('⚠️ IS A SACK, even in scramble mode', () => {
    const state = startPlay('scramble-sack')
    const line = tackleQb('scramble-sack', state, 4)
    expect(line('lb1')?.sacks).toBe(1)
    expect(line('lb1')?.tfl).toBe(1)                 // a sack is a tackle for loss
    expect(line('qb1')?.sacksTaken).toBe(1)
    expect(line('qb1')?.carries ?? 0).toBe(0)        // not a run
  })

  it('…but a scramble past the line is a run', () => {
    const state = startPlay('scramble-run')
    expect(isScrambleSack(state, 'qb1', getLosY(state) + 3)).toBe(false)
  })

  it('…and a designed QB run is never a sack', () => {
    const state = startPlay('qb-run', 'run')
    expect(isScrambleSack(state, 'qb1', getLosY(state) - 4)).toBe(false)
  })

  it('…and only the quarterback — a receiver caught behind the line is tackled for a loss', () => {
    const state = startPlay('wr-loss')
    expect(isScrambleSack(state, 'wr1', getLosY(state) - 4)).toBe(false)
  })
})

// ── [pressure throw] A rusher in the QB's face makes the throw worse ─────────────────
describe('[pressure throw] pressure reaches the ball', () => {
  it('a clean pocket changes nothing', () => {
    expect(pressureThrowMods({ qbPressureCount: 0, qbUnderHeavyPressure: false })).toEqual({ catchBonus: -0, intDelta: 0 })
  })

  it('each rusher within range costs catch rate, two at most', () => {
    expect(pressureThrowMods({ qbPressureCount: 1 }).catchBonus).toBeCloseTo(-PRESSURE_CATCH_PENALTY)
    expect(pressureThrowMods({ qbPressureCount: 5 }).catchBonus).toBeCloseTo(-2 * PRESSURE_CATCH_PENALTY)
  })

  it('one about to make contact costs more, and can be picked', () => {
    const m = pressureThrowMods({ qbPressureCount: 1, qbUnderHeavyPressure: true })
    expect(m.catchBonus).toBeCloseTo(-(PRESSURE_CATCH_PENALTY + HEAVY_PRESSURE_CATCH_PENALTY))
    expect(m.intDelta).toBe(HEAVY_PRESSURE_INT)
  })
})

// ── [zone break] A zone defender breaks on the ball while it is in the air ───────────
describe('[zone break] zone defenders close on the throw', () => {
  const qb = { id: 'qb', label: 'QB', x: 26, y: 40 }
  const receiver = { id: 'wr1', label: 'WR', x: 26, y: 60 }      // a twenty-yard throw
  const defender = { id: 'lb1', label: 'LB', x: 30, y: 60 }      // four yards off him

  it('⚠️ THE SAME CUSHION IS TIGHTER AGAINST A ZONE DEFENDER — he sees the throw', () => {
    const zone = computeReceiverOpenness(receiver, [defender], qb, { zoneIds: new Set(['lb1']) })
    const man = computeReceiverOpenness(receiver, [defender], qb, { zoneIds: new Set() })
    expect(zone).toBeLessThan(man - 0.3)
  })

  it('a quick throw barely changes — the ball is out before he can move', () => {
    const quick = { id: 'wr2', label: 'WR', x: 26, y: 46 }
    const def = { id: 'lb1', label: 'LB', x: 30, y: 46 }
    const zone = computeReceiverOpenness(quick, [def], qb, { zoneIds: new Set(['lb1']) })
    const man = computeReceiverOpenness(quick, [def], qb, { zoneIds: new Set() })
    expect(man - zone).toBeLessThan(0.15)
  })

  // "Players that are wide open are being read as a pass break up." He breaks to the CATCH POINT.
  it('⚠️ A RECEIVER RUNNING AWAY FROM HIS ZONE KEEPS HIS SEPARATION — no closing on a man who is leaving', () => {
    const away = { ...receiver, vx: -7, vy: 0 }                    // running away from the defender's side
    const zone = computeReceiverOpenness(away, [defender], qb, { zoneIds: new Set(['lb1']) })
    const man = computeReceiverOpenness(away, [defender], qb, { zoneIds: new Set() })
    expect(zone).toBeCloseTo(man, 6)
  })

  it('…while one running INTO the zone is closed on harder than one standing still', () => {
    const into = { ...receiver, vx: 6, vy: 0 }
    const still = computeReceiverOpenness(receiver, [defender], qb, { zoneIds: new Set(['lb1']) })
    const runningIn = computeReceiverOpenness(into, [defender], qb, { zoneIds: new Set(['lb1']) })
    expect(runningIn).toBeLessThanOrEqual(still)
  })
})

// ── [incompletion reason] A miss is named for what caused it ─────────────────────────
describe('[incompletion reason] broken up, overthrown, inaccurate or dropped', () => {
  const share = (field, want) => {
    let n = 0
    for (let i = 0; i < 1000; i++) if (incompletionReason(field, i / 1000) === want) n++
    return n / 1000
  }

  it('⚠️ NOBODY NEAR HIM, NOTHING BROKEN UP — the misleading case', () => {
    expect(share({ tier: 'covered', contestDist: 6, airYards: 8 }, 'broken_up')).toBe(0)
  })

  it('a defender on him breaks most of them up', () => {
    expect(share({ tier: 'smothered', contestDist: 1.0, airYards: 8 }, 'broken_up')).toBeGreaterThan(0.6)
  })

  it('a defender in the throwing line or over the top counts as on him', () => {
    expect(share({ tier: 'smothered', contestDist: 6, contested: true, airYards: 8 }, 'broken_up')).toBeGreaterThan(0.6)
  })

  it('a deep miss by the passer sails over him; a short one is off target', () => {
    const open = { tier: 'covered', contestDist: 9 }
    expect(share({ ...open, airYards: OVERTHROW_AIR_YARDS + 5 }, 'overthrown')).toBeGreaterThan(0.3)
    expect(share({ ...open, airYards: OVERTHROW_AIR_YARDS + 5 }, 'inaccurate')).toBe(0)
    expect(share({ ...open, airYards: 6 }, 'inaccurate')).toBeGreaterThan(0.3)
    expect(share({ ...open, airYards: 6 }, 'overthrown')).toBe(0)
  })

  it('a poor arm and a rusher in his face are the passer’s misses; poor hands are drops', () => {
    const base = { tier: 'covered', contestDist: 9, airYards: 6 }
    const good = share({ ...base, qbAccuracy: 95 }, 'inaccurate')
    expect(share({ ...base, qbAccuracy: 40 }, 'inaccurate')).toBeGreaterThan(good)
    expect(share({ ...base, qbAccuracy: 95, pressureCount: 2 }, 'inaccurate')).toBeGreaterThan(good)
    expect(share({ ...base, receiverCatch: 40 }, 'drop')).toBeGreaterThan(share({ ...base, receiverCatch: 95 }, 'drop'))
  })

  it('⚠️ NAMING THE MISS SPENDS NO RANDOMNESS — the seeded stream and the result are unchanged', () => {
    for (const roll of [0.1, 0.5, 0.7, 0.95]) {
      let calls = 0
      const rng = () => { calls++; return roll }
      const plain = resolvePass({ openness: 0.5 }, () => roll)
      const named = resolvePass({ openness: 0.5, field: { contestDist: 2, airYards: 10 } }, rng)
      expect(calls).toBe(1)
      expect(named.outcome).toBe(plain.outcome)
    }
  })

  it('manual mode announces each one', () => {
    expect(revealLabel('incomplete', 'overthrown')).toBe('Overthrown!')
    expect(revealLabel('incomplete', 'inaccurate')).toBe('Inaccurate throw!')
    expect(revealLabel('incomplete', 'drop')).toBe('Dropped!')
    expect(revealLabel('incomplete', 'broken_up')).toBe('Broken up!')
  })
})

// ── [blitz momentum] A blitzer gets home faster than a lineman of the same rating ─────
describe('[blitz momentum] the blitzer hits the gap with a running start', () => {
  function engaged(label, type) {
    const d = { id: `${label}1`, label, x: 26, y: 36, isEngaged: true, engagedWithId: 'ol1', leverageScore: 0, ratings: { passRush: 62 } }
    const state = {
      playDesign: { playType: 'pass' },
      offensePlayers: new Map([['ol1', { id: 'ol1', label: 'OL', ratings: { strength: 88 } }]]),
      defensePlayers: new Map([[d.id, d]]),
      defenseCoverage: new Map(type ? [[d.id, { type }]] : []),
    }
    for (let i = 0; i < 20; i++) runPassRush(state, null, 0.05)   // one second locked up
    return d.rushWinMeter ?? 0
  }

  it('⚠️ A BLITZING LINEBACKER WINS HIS REP FAR FASTER than a lineman of the same rating', () => {
    const lineman = engaged('DL', null)
    expect(engaged('LB', 'blitz')).toBeGreaterThan(lineman * 3)
  })
})

// ── [zone pass-off] Only abandon the zone if nobody else is heading there ─────────────
describe('[zone pass-off] a zone defender passes his man off rather than chase him', () => {
  const toRel = (absY) => absY - FIELD.END_ZONE_DEPTH
  function build({ zoners = [], men = [], receivers }) {
    const defensePlayers = new Map(), defenseCoverage = new Map(), offensePlayers = new Map()
    for (const d of zoners) {
      defensePlayers.set(d.id, { id: d.id, label: 'LB', x: d.x, y: d.y, vx: 0, vy: 0 })
      defenseCoverage.set(d.id, { type: 'zone', zoneType: 'hook', zoneCenterX: d.cx, zoneCenterY: toRel(d.cy) })
    }
    for (const d of men) {
      defensePlayers.set(d.id, { id: d.id, label: 'CB', x: d.x, y: d.y, vx: 0, vy: 0 })
      defenseCoverage.set(d.id, { type: 'man', targetId: d.target })
    }
    for (const r of receivers) offensePlayers.set(r.id, { id: r.id, label: 'WR', x: r.x, y: r.y, vx: r.vx ?? 0, vy: r.vy ?? 0 })
    return { defensePlayers, defenseCoverage, offensePlayers }
  }

  it('helps on a loose receiver when nobody else is near him', () => {
    const state = build({ zoners: [{ id: 'z1', x: 10, y: 50, cx: 10, cy: 50 }], receivers: [{ id: 'wr1', x: 25, y: 50 }] })
    const out = computeZoneCoordination(state, 40, 1)
    expect(out.get('z1').threat?.id).toBe('wr1')
    expect(out.get('z1').helping).toBe(true)
  })

  it('⚠️ STAYS HOME when a teammate is already closer to him', () => {
    const state = build({
      zoners: [{ id: 'z1', x: 10, y: 50, cx: 10, cy: 50 }],
      men: [{ id: 'm1', x: 24, y: 50, target: 'wr1' }],
      receivers: [{ id: 'wr1', x: 25, y: 50 }],
    })
    const out = computeZoneCoordination(state, 40, 1)
    expect(out.get('z1').threat).toBeNull()
    expect(out.get('z1').helping).toBe(false)
  })

  it('carries his man when nobody is coming to take him', () => {
    const state = build({
      zoners: [{ id: 'z1', x: 20, y: 50, cx: 20, cy: 50 }],
      receivers: [{ id: 'wr1', x: 24, y: 50, vx: 6 }],
    })
    const out = computeZoneCoordination(state, 40, 1)
    expect(out.get('z1').threat?.id).toBe('wr1')
    expect(out.get('z1').contested).toBe(false)     // the zone stretches — he carries
  })

  it('⚠️ PASSES HIM OFF when he is running into a teammate\'s zone', () => {
    const state = build({
      zoners: [{ id: 'z1', x: 20, y: 50, cx: 20, cy: 50 }, { id: 'z2', x: 30, y: 50, cx: 30, cy: 50 }],
      receivers: [{ id: 'wr1', x: 24, y: 50, vx: 6 }],
    })
    const out = computeZoneCoordination(state, 40, 1)
    expect(out.get('z1').threat?.id).toBe('wr1')
    expect(out.get('z1').contested).toBe(true)      // no stretch: he releases at the edge of his zone
  })
})
