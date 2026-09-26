import { describe, it, expect } from '@jest/globals'
import { createKnowledge, applyEvent, oppSkill } from '../ai/knowledge.js'
import { chooseShell, choosePersonnel, isPreventSituation, COVERAGE_ON_FIELD } from '../ai/defense.js'
import { callOffense, buildFormation, chooseRunAngle } from '../ai/offense.js'
import { expandShell, canCover } from '../ai/assignments.js'
import { SHELLS } from '../ai/playbook/coverages.js'
import { CONCEPTS, assignRoutes } from '../ai/playbook/concepts.js'
import { FORMATIONS, legalSpot, personnelFor, layout } from '../ai/playbook/formations.js'
import { fieldGoalChance, puntReturnChoice, fourthDownChoice } from '../ai/specialTeams.js'
import { ROUTE_TYPES } from '../constants.js'
import { makeRng } from '../game/utils/rng.js'

// [offline] The heuristic AI. These pin the HARD CONSTRAINTS from the design — the things that must
// never happen whatever the call — rather than the taste of any individual play call. Taste is
// allowed to change; a corner covering a tight end is not.

const BALL_X = 26.665
const LOS = 40

function situation({ down = 1, distance = 10, yardLine = 40, role = 'defense', quarter = 1, clock = 600,
  score = { own: 0, opp: 0 }, offense = [] } = {}) {
  const k = createKnowledge(role === 'defense' ? 1 : 0)
  k.role = role; k.down = down; k.distance = distance; k.yardLine = yardLine
  k.quarter = quarter; k.clock = clock; k.score = score
  for (const [id, label, x, y] of offense) {
    applyEvent(k, 'player_placed', { id, x, y: y ?? yardLine, label, team: role === 'defense' ? 'o' : 'd' })
  }
  return k
}

const SPREAD = [['wr1', 'WR', 6], ['wr2', 'WR', 18], ['wr3', 'WR', 46], ['te1', 'TE', 33], ['rb1', 'RB', 26]]
const HEAVY = [['te1', 'TE', 21], ['te2', 'TE', 32], ['wr1', 'WR', 6], ['rb1', 'RB', 25], ['rb2', 'RB', 28]]
const FOUR_WIDE = [['wr1', 'WR', 5], ['wr2', 'WR', 12], ['wr3', 'WR', 42], ['wr4', 'WR', 48], ['rb1', 'RB', 26]]

const DEFENDERS = [
  { id: 'cb1', label: 'CB' }, { id: 'cb2', label: 'CB' }, { id: 'cb3', label: 'CB' },
  { id: 's1', label: 'S' }, { id: 's2', label: 'S' },
  { id: 'lb1', label: 'LB' }, { id: 'lb2', label: 'LB' },
]

describe('coverage constraints — the matchups that must never happen', () => {
  it('a CB is never manned on a TE or RB, and a LB is never manned on a WR', () => {
    expect(canCover('CB', 'TE')).toBe(false)
    expect(canCover('CB', 'RB')).toBe(false)
    expect(canCover('LB', 'WR')).toBe(false)
    expect(canCover('CB', 'WR')).toBe(true)
    expect(canCover('LB', 'TE')).toBe(true)
    expect(canCover('S', 'WR')).toBe(true)
  })

  it('holds across every shell, against spread and heavy personnel alike', () => {
    for (const personnel of [SPREAD, HEAVY, FOUR_WIDE]) {
      const k = situation({ offense: personnel })
      const receivers = oppSkill(k)
      const byId = new Map(receivers.map(r => [r.id, r]))
      for (const shellId of Object.keys(SHELLS)) {
        const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers, losY: LOS, ballX: BALL_X })
        for (const a of assignments.values()) {
          if (a.type !== 'man') continue
          const d = DEFENDERS.find(x => x.id === a.playerId)
          const r = byId.get(a.targetId)
          const pair = d.label + '->' + r.label
          expect({ shellId, pair, ok: canCover(d.label, r.label) }).toEqual({ shellId, pair, ok: true })
        }
      }
    }
  })

  it('never doubles a receiver in man, and never forgets a defender', () => {
    const k = situation({ offense: SPREAD })
    const receivers = oppSkill(k)
    for (const shellId of Object.keys(SHELLS)) {
      const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers, losY: LOS, ballX: BALL_X })
      // A defender the engine has NO assignment for is treated as a pass rusher, so a forgotten
      // man is not a neutral mistake — he is an unplanned blitzer and a hole where he was standing.
      expect({ shellId, n: assignments.size }).toEqual({ shellId, n: DEFENDERS.length })
      const targets = [...assignments.values()].map(a => a.targetId).filter(Boolean)
      expect({ shellId, dupes: targets.length - new Set(targets).size }).toEqual({ shellId, dupes: 0 })
    }
  })

  it('never leaves an isolated receiver uncovered', () => {
    // One receiver alone on the left, three bunched right — the case named in the design.
    const k = situation({ offense: [['wr1', 'WR', 4], ['wr2', 'WR', 40], ['wr3', 'WR', 44], ['te1', 'TE', 34], ['rb1', 'RB', 26]] })
    const receivers = oppSkill(k)
    for (const shellId of Object.keys(SHELLS)) {
      const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers, losY: LOS, ballX: BALL_X })
      const manned = new Set([...assignments.values()].map(a => a.targetId).filter(Boolean))
      const zoned = [...assignments.values()].filter(a => a.type === 'zone')
      const near = zoned.some(z => Math.abs(z.zoneCenterX - 4) < 16)
      expect({ shellId, covered: manned.has('wr1') || near }).toEqual({ shellId, covered: true })
    }
  })

  it('only ever emits zone types the engine understands', () => {
    const legal = new Set(['flat', 'deep', 'curl', 'hook'])
    const k = situation({ offense: SPREAD })
    for (const shellId of Object.keys(SHELLS)) {
      const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers: oppSkill(k), losY: LOS, ballX: BALL_X })
      for (const a of assignments.values()) {
        if (a.type !== 'zone') continue
        expect({ shellId, z: a.zoneType, ok: legal.has(a.zoneType) }).toEqual({ shellId, z: a.zoneType, ok: true })
      }
    }
  })

  it('a man shell really is man, and a zone shell really is zone', () => {
    const k = situation({ offense: SPREAD })
    const receivers = oppSkill(k)
    const count = (shellId, type) => {
      const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers, losY: LOS, ballX: BALL_X })
      return [...assignments.values()].filter(a => a.type === type).length
    }
    expect(count('cover_1', 'man')).toBeGreaterThanOrEqual(4)
    expect(count('man_blitz_6', 'man')).toBeGreaterThanOrEqual(4)
    expect(count('cover_3', 'man')).toBe(0)
    expect(count('cover_4', 'man')).toBe(0)
  })

  it('a blitz shell actually sends extra rushers', () => {
    const k = situation({ offense: SPREAD })
    const receivers = oppSkill(k)
    const blitzers = (shellId) => {
      const { assignments } = expandShell(shellId, { defenders: DEFENDERS, receivers, losY: LOS, ballX: BALL_X })
      return [...assignments.values()].filter(a => a.type === 'blitz').length
    }
    expect(blitzers('man_blitz_5')).toBe(1)
    expect(blitzers('man_blitz_6')).toBe(2)
    expect(blitzers('zone_blitz_5')).toBe(1)
    expect(blitzers('cover_2')).toBe(0)
  })

  it('Tampa 2 puts a linebacker deep — the thing that makes it Tampa 2', () => {
    const k = situation({ offense: SPREAD })
    const { assignments } = expandShell('tampa_2', { defenders: DEFENDERS, receivers: oppSkill(k), losY: LOS, ballX: BALL_X })
    const deepLB = [...assignments.values()].some(a =>
      a.zoneType === 'deep' && DEFENDERS.find(d => d.id === a.playerId)?.label === 'LB')
    expect(deepLB).toBe(true)
  })
})

describe('personnel', () => {
  it('always fields exactly seven coverage players', () => {
    for (const offense of [SPREAD, HEAVY, FOUR_WIDE]) {
      const p = choosePersonnel(situation({ offense }), BALL_X)
      expect({ offense: offense[0][0], total: p.CB + p.S + p.LB }).toEqual({ offense: offense[0][0], total: COVERAGE_ON_FIELD })
    }
  })

  it('never leaves the box empty against two tight ends', () => {
    expect(choosePersonnel(situation({ offense: HEAVY }), BALL_X).LB).toBeGreaterThanOrEqual(2)
  })

  it('never fields fewer than two corners against four wide', () => {
    expect(choosePersonnel(situation({ offense: FOUR_WIDE }), BALL_X).CB).toBeGreaterThanOrEqual(2)
  })

  it('brings more corners against spread than against heavy', () => {
    const spread = choosePersonnel(situation({ offense: FOUR_WIDE }), BALL_X)
    const heavy = choosePersonnel(situation({ offense: HEAVY }), BALL_X)
    expect(spread.CB).toBeGreaterThan(heavy.CB)
    expect(heavy.LB).toBeGreaterThan(spread.LB)
  })
})

describe('the defensive call', () => {
  it('only ever names a shell that exists', () => {
    const rng = makeRng(3)
    for (let i = 0; i < 400; i++) {
      const k = situation({ down: 1 + (i % 4), distance: 1 + (i % 20), yardLine: 5 + (i % 90), offense: SPREAD })
      const id = chooseShell(k, rng, BALL_X)
      expect({ id, known: !!SHELLS[id] }).toEqual({ id, known: true })
    }
  })

  it('plays prevent only when leading late — not merely on third and long', () => {
    expect(isPreventSituation(situation({ down: 3, distance: 20, quarter: 1, clock: 600, score: { own: 0, opp: 7 } }))).toBe(false)
    expect(isPreventSituation(situation({ quarter: 4, clock: 25, yardLine: 30, score: { own: 21, opp: 17 } }))).toBe(true)
    expect(isPreventSituation(situation({ quarter: 4, clock: 25, yardLine: 30, score: { own: 17, opp: 21 } }))).toBe(false)
  })

  // [difficulty] Variety is a property of the FULL defense, so this asserts it at hard. A knowledge
  // object with no difficulty set defaults to 'easy' (createKnowledge), and easy is deliberately
  // held to the vanilla shells — on an obvious-run down that narrows a three-call menu to two, which
  // is the easy tier working rather than the caller breaking.
  it('varies its call at HARD, so the offense cannot sit on one', () => {
    const rng = makeRng(11)
    const k = situation({ down: 1, distance: 10, offense: SPREAD })
    k.difficulty = 'hard'
    const seen = new Set(Array.from({ length: 60 }, () => chooseShell(k, rng, BALL_X)))
    expect(seen.size).toBeGreaterThan(2)
  })

  it('is narrower at EASY than at HARD — that is what the tier buys', () => {
    const spread = (difficulty) => {
      const rng = makeRng(11)
      const k = situation({ down: 1, distance: 10, offense: SPREAD })
      k.difficulty = difficulty
      return new Set(Array.from({ length: 60 }, () => chooseShell(k, rng, BALL_X)))
    }
    const easy = spread('easy')
    const hard = spread('hard')
    expect(easy.size).toBeLessThan(hard.size)
    // …and every call easy makes is still a real shell the full defense would also run.
    for (const id of easy) expect(SHELLS[id]).toBeDefined()
  })
})

describe('offense', () => {
  const roster = [
    ...Array.from({ length: 4 }, (_, i) => ({ id: 'wr' + i, position: 'WR', ovr: 90 - i })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: 'te' + i, position: 'TE', ovr: 85 - i })),
    ...Array.from({ length: 2 }, (_, i) => ({ id: 'rb' + i, position: 'RB', ovr: 88 - i })),
  ]

  it('builds a legal, complete formation for every call it makes', () => {
    const rng = makeRng(5)
    for (let i = 0; i < 300; i++) {
      const k = situation({ role: 'offense', down: 1 + (i % 4), distance: 1 + (i % 20), yardLine: 3 + (i % 95) })
      const call = callOffense(k, rng, BALL_X)
      const players = buildFormation(call, k, { losY: k.yardLine, ballX: BALL_X, roster, rng })

      expect(players).toHaveLength(5)
      expect(new Set(players.map(p => p.id)).size).toBe(5)
      for (const p of players) {
        const legal = legalSpot(p.label, p.x, p.y, k.yardLine)
        expect({ label: p.label, xOk: legal.x === p.x, yOk: legal.y === p.y })
          .toEqual({ label: p.label, xOk: true, yOk: true })
      }
    }
  })

  it('assigns only routes the engine knows', () => {
    const rng = makeRng(6)
    for (let i = 0; i < 300; i++) {
      const k = situation({ role: 'offense', down: 1 + (i % 4), distance: 1 + (i % 18), yardLine: 5 + (i % 90) })
      const call = callOffense(k, rng, BALL_X)
      for (const p of buildFormation(call, k, { losY: k.yardLine, ballX: BALL_X, roster, rng })) {
        if (!p.route) continue
        expect({ route: p.route, known: ROUTE_TYPES.has(p.route) }).toEqual({ route: p.route, known: true })
      }
    }
  })

  it('every concept gives every receiver a route the engine knows', () => {
    const receivers = [
      { id: 'a', label: 'WR', x: 6 }, { id: 'b', label: 'WR', x: 18 },
      { id: 'c', label: 'WR', x: 46 }, { id: 'd', label: 'TE', x: 33 }, { id: 'e', label: 'RB', x: 26 },
    ]
    for (const conceptId of Object.keys(CONCEPTS)) {
      const routes = assignRoutes(conceptId, receivers, BALL_X)
      expect({ conceptId, n: routes.size }).toEqual({ conceptId, n: receivers.length })
      for (const r of routes.values()) {
        expect({ conceptId, route: r, known: ROUTE_TYPES.has(r) }).toEqual({ conceptId, route: r, known: true })
      }
    }
  })

  it('every formation asks for five skill players the roster can actually supply', () => {
    for (const id of Object.keys(FORMATIONS)) {
      const p = personnelFor(id)
      expect({ id, n: p.WR + p.TE + p.RB }).toEqual({ id, n: 5 })
      expect({ id, wr: p.WR <= 4, te: p.TE <= 3, rb: p.RB <= 2 }).toEqual({ id, wr: true, te: true, rb: true })
    }
  })

  it('never stacks a back on the quarterback', () => {
    // The QB is auto-placed at (ballX, losY - 6) and is NOT in the formation table, so a back at
    // dx 0 / depth 6 lands exactly on him and depth 7 is close enough to render as a stack and
    // collide at the snap. Three formations did this before it was caught in a real game.
    const QB_X = BALL_X, QB_Y = LOS - 6
    const MIN_GAP = 1.6   // just over two player radii
    for (const id of Object.keys(FORMATIONS)) {
      for (const mirror of [false, true]) {
        for (const spot of layout(id, { losY: LOS, ballX: BALL_X, mirror })) {
          if (spot.label !== 'RB') continue
          const gap = Math.hypot(spot.x - QB_X, spot.y - QB_Y)
          expect({ id, mirror, clear: gap >= MIN_GAP }).toEqual({ id, mirror, clear: true })
        }
      }
    }
  })

  it('never stacks two skill players on each other either', () => {
    const MIN_GAP = 1.6
    for (const id of Object.keys(FORMATIONS)) {
      const spots = layout(id, { losY: LOS, ballX: BALL_X })
      for (let i = 0; i < spots.length; i++) {
        for (let j = i + 1; j < spots.length; j++) {
          const gap = Math.hypot(spots[i].x - spots[j].x, spots[i].y - spots[j].y)
          expect({ id, pair: `${i}-${j}`, clear: gap >= MIN_GAP }).toEqual({ id, pair: `${i}-${j}`, clear: true })
        }
      }
    }
  })

  it('runs away from the crowd, not into it', () => {
    const k = situation({ role: 'offense', yardLine: LOS })
    for (const [id, x] of [['d1', 10], ['d2', 13], ['d3', 16], ['d4', 19], ['d5', 12]]) {
      applyEvent(k, 'player_placed', { id, x, y: LOS + 2, label: 'LB', team: 'd' })
    }
    expect(chooseRunAngle(k, BALL_X, makeRng(2)).angle).toBeGreaterThan(0)
  })

  it('throws on third and long rather than running into a wall', () => {
    const rng = makeRng(9)
    const k = situation({ role: 'offense', down: 3, distance: 12 })
    const calls = Array.from({ length: 30 }, () => callOffense(k, rng, BALL_X).playType)
    expect(calls.every(c => c === 'pass')).toBe(true)
  })
})

describe('the information boundary', () => {
  it('knowledge carries no route, play type or coverage field — there is nothing to leak', () => {
    const k = situation({ offense: SPREAD })
    const json = JSON.stringify(k, (_, v) => (v instanceof Map ? [...v.values()] : v))
    for (const forbidden of ['playDesign', 'route', 'playType', 'defenseCoverage', 'runAngle']) {
      expect({ forbidden, present: json.includes('"' + forbidden + '"') })
        .toEqual({ forbidden, present: false })
    }
  })

  it('an unknown event is ignored rather than throwing', () => {
    const k = situation({})
    expect(() => applyEvent(k, 'something_new_someday', { anything: true })).not.toThrow()
  })
})

describe('special teams', () => {
  it('matches the specified field-goal curve', () => {
    // ⚠️ THE BANDS THAT WERE ASKED FOR, checked at each edge so the spec is the test:
    //   inside 35 100%, inside 45 90%, inside 50 80%, inside 55 75%.
    // The argument is the KICK distance (goal line + 17).
    expect(fieldGoalChance(20)).toBeCloseTo(1.00, 2)
    expect(fieldGoalChance(35)).toBeCloseTo(1.00, 2)
    expect(fieldGoalChance(45)).toBeCloseTo(0.90, 2)
    expect(fieldGoalChance(50)).toBeCloseTo(0.80, 2)
    expect(fieldGoalChance(55)).toBeCloseTo(0.75, 2)
    // Interpolated inside a band rather than stepped — no cliff between 34 and 36 yards.
    expect(fieldGoalChance(40)).toBeGreaterThan(0.90)
    expect(fieldGoalChance(40)).toBeLessThan(1.00)
    // And it keeps falling past the last band: seventy yards is not a 75% proposition.
    expect(fieldGoalChance(70)).toBeLessThan(0.5)
    expect(fieldGoalChance(90)).toBeGreaterThan(0)

    // …and it only ever gets harder with distance.
    for (let d = 10; d < 70; d += 5) {
      expect(fieldGoalChance(d)).toBeGreaterThanOrEqual(fieldGoalChance(d + 5))
    }
  })

  it('lets it bounce inside the 10 and returns it otherwise', () => {
    expect(puntReturnChoice(5)).toBe('let_it_bounce')
    expect(puntReturnChoice(10)).toBe('let_it_bounce')
    expect(puntReturnChoice(11)).toBe('return')
    expect(puntReturnChoice(40)).toBe('return')
  })

  const fourthDown = (over) => {
    const k = situation({ role: 'offense', down: 4, ...over })
    k.decision = {
      context: 'fourth_down',
      fieldGoalDistance: over.fgDistance,
      options: [
        { id: 'go_for_it', legal: true },
        { id: 'punt', legal: over.canPunt !== false },
        { id: 'field_goal', legal: over.canKick !== false },
      ],
    }
    return fourthDownChoice(k, makeRng(1)).payload.option
  }

  it('kicks when in range with long to go', () => {
    expect(fourthDown({ distance: 8, yardLine: 70, fgDistance: 47 })).toBe('field_goal')
  })

  it('punts from its own end on fourth and long', () => {
    expect(fourthDown({ distance: 9, yardLine: 20, fgDistance: 97, canKick: false })).toBe('punt')
  })

  it('goes for it on fourth and inches in plus territory', () => {
    expect(fourthDown({ distance: 1, yardLine: 60, fgDistance: 57 })).toBe('go_for_it')
  })
})
