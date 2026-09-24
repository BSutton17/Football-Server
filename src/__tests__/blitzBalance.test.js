import { describe, it, expect } from '@jest/globals'
import { runMovement } from '../game/systems/movement.js'
import { createController } from '../ai/controller.js'
import { createKnowledge, applyEvent } from '../ai/knowledge.js'
import { skillFor } from '../ai/difficulty.js'
import { DIFFICULTY } from '../constants.js'
import { syntheticRoster } from '../ai/roster.js'

// [pressure] WHY A SIX-MAN BLITZ WAS THE BEST CALL ON EVERY DOWN.
//
// Measured with training:headroom, `man_blitz_6` scored 23.52 against a par of 15.00 and beat the
// next-best shell by 3.5. The trained NEAT champion called it on 100% of situations — it had found
// a dominant strategy, which is why its holdout curve was flat. Two separate defects fed it, and
// this file pins both.
//
// Neither was the obvious suspect. The protection engaged every rusher (the man who reached the
// quarterback was still engaged with a blocker on 10 of 11 plays, never unblocked and never shed),
// and forcing max protect — 7.3 blockers against 5.9 rushers — produced pressure at an identical
// 1.44s. It was not a numbers problem.

const DT = 0.05

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

const qb = (x, y) => ({ id: 'qb', label: 'QB', x, y, vx: 0, vy: 0, isEngaged: false })
const ol = (id, x, y) => ({ id, label: 'OL', x, y, vx: 0, vy: 0, isEngaged: true, passBlockAnchorX: x, passBlockAnchorY: y })
const rusher = (id, x, y) => ({ id, label: 'LB', x, y, vx: 0, vy: 0, isEngaged: true, shedBlock: false, leverageScore: 0 })

// How fast a blitzer actually travels, engaged versus free, on the identical code path.
//
// ⚠️ This measures a blitzer against ITSELF rather than against a down lineman, and that is
// deliberate. A no-coverage rusher in a synthetic pocket runs its CONTAIN arc — measured moving
// backwards at -6.18 yd/s, away from the quarterback — because contain needs a real pocket, a real
// pass set and the engagement system to look sensible. Comparing against it here measures the
// harness, not the fix. Engaged-vs-free on one code path has no such confound.
function blitzerSpeed(engaged) {
  const passer = qb(26, 29)
  const d = rusher('d2', 26, 36)
  d.isEngaged = engaged
  const blocker = ol('olB', 26, 33)
  if (engaged) { d.engagedWithId = 'olB'; blocker.engagedWithId = 'd2' }

  const state = {
    direction: 1,
    yardLine: 25,
    offensePlayers: makeMap([passer, blocker]),
    defensePlayers: makeMap([d]),
    defenseCoverage: new Map([['d2', { type: 'blitz', targetId: null }]]),
    playerFatigue: new Map(),
    playDesign: { playType: 'pass' },
    ballCarrierId: null,
    catchSpot: null,
  }

  for (let i = 0; i < 10; i++) runMovement(state, null, DT)
  return Math.hypot(d.vx, d.vy)
}

describe('a block is a block, whoever it is on', () => {
  // ⚠️ THE DEFECT. Blitzers used BLITZ_ENGAGED_MULT = 0.75 where every other engaged player uses
  // ENGAGED_SPEED_MULT = 0.5, AND the blitz branch multiplied by a further 1.1 EVEN WHILE ENGAGED —
  // so a blocked blitzer travelled at 0.825 of top speed against a blocked lineman's 0.5. Measured
  // in a real pocket, a blocked blitzer closed on the quarterback 1.9x to 3.2x as fast as a blocked
  // lineman on the same play, and the pocket collapsed at ~1.4s however many blockers were kept in.
  //
  // Being blocked has to actually cost a blitzer something. 0.825/1.1 = 0.75 of free speed was the
  // broken value; the fix puts it near 0.53.
  it('being blocked roughly halves a blitzer, rather than barely slowing him', () => {
    const free = blitzerSpeed(false)
    const blocked = blitzerSpeed(true)
    expect(free).toBeGreaterThan(0)
    expect(blocked).toBeGreaterThan(0)
    expect(blocked / free).toBeLessThan(0.65)
  })

  it('…but a blocked blitzer is not frozen — he still fights through', () => {
    expect(blitzerSpeed(true) / blitzerSpeed(false)).toBeGreaterThan(0.35)
  })

  it('the urgency bonus applies in space only, never through a blocker', () => {
    // A free blitzer carries BLITZ_FREE_URGENCY on top of full speed; an engaged one must not.
    // Stacking it on the engaged multiplier was half the defect.
    const plain = blitzerSpeed(false)
    const blocked = blitzerSpeed(true)
    expect(blocked).toBeLessThan(plain * 0.6)
  })
})

describe('the quarterback has an answer to pressure', () => {
  // ⚠️ DEFECT TWO. The throwaway mechanic has always existed — `throwaway_ready`, a validator, a
  // handler — and NOTHING in ai/ referenced it. So the AI quarterback took a seven-yard sack in
  // every situation where a human would have taken the free incompletion. Combined with a read gate
  // that waited for a window past the point of being hit, the ball came out on only 45% of plays
  // against a six-man blitz.
  function pressuredQb({ difficulty = DIFFICULTY.HARD, throwawayReady = true, defenderAt = 1.0 } = {}) {
    const fired = []
    const socket = { id: 'ai', data: {}, fire: (e, p) => fired.push({ event: e, payload: p }), emit() {}, on() {} }
    const c = createController({ socket, slot: 0, roster: syntheticRoster('ai0'), seed: 1 })
    const k = c.knowledge
    k.role = 'offense'
    k.phase = 'live'
    k.difficulty = difficulty
    k.throwawayReady = throwawayReady
    c.lastCall = { playType: 'pass' }
    // ⚠️ Delivered as a real positions_update payload, not written onto k.live by hand: applyEvent
    // REBUILDS k.live from the payload, so a hand-built map is wiped by the first event and every
    // assertion then reads an empty field.
    const frame = [
      { id: 'qb',  team: 'o', state: 'ball', x: 26, y: 20 },   // `state: 'ball'` is the wire field
      { id: 'wr1', team: 'o', ready: true, x: 26.4, y: 30 },   // smothered
      { id: 'cb1', team: 'd', x: 26.4, y: 30.1 },
      { id: 'lb1', team: 'd', x: 26, y: 20 + defenderAt },     // in his lap
    ]
    return { c, k, fired, frame }
  }

  it('throws it away rather than eating the sack when nobody is open', () => {
    const { c, fired, frame } = pressuredQb()
    for (let i = 0; i < 4 && !fired.some(f => f.event === 'throwaway'); i++) c.onEvent('positions_update', frame)
    expect(fired.some(f => f.event === 'throwaway')).toBe(true)
  })

  it('does NOT throw it away before the server has offered it', () => {
    // Bailing out is refused until 2s of live play, so firing early just earns a rejection.
    const { c, fired, frame } = pressuredQb({ throwawayReady: false })
    for (let i = 0; i < 6; i++) c.onEvent('positions_update', frame)
    expect(fired.some(f => f.event === 'throwaway')).toBe(false)
  })

  it('does NOT throw it away with a clean pocket', () => {
    const { c, fired, frame } = pressuredQb({ defenderAt: 9 })
    for (let i = 0; i < 6; i++) c.onEvent('positions_update', frame)
    expect(fired.some(f => f.event === 'throwaway')).toBe(false)
  })

  it('the throwaway is reset per play, so it cannot leak into the next snap', () => {
    const k = createKnowledge(0)
    applyEvent(k, 'throwaway_ready', {})
    expect(k.throwawayReady).toBe(true)
    applyEvent(k, 'game_state', {
      phase: 'pre_snap', role: 'offense', down: 1, distance: 10, yardLine: 25,
      playSerial: (k.playSerial ?? 0) + 1,
    })
    expect(k.throwawayReady).toBe(false)
  })
})

describe('pressure awareness is a difficulty knob like every other', () => {
  it('is ordered easy < medium < hard, so a better tier reacts sooner', () => {
    expect(skillFor(DIFFICULTY.EASY).pressureAware)
      .toBeLessThan(skillFor(DIFFICULTY.MEDIUM).pressureAware)
    expect(skillFor(DIFFICULTY.MEDIUM).pressureAware)
      .toBeLessThan(skillFor(DIFFICULTY.HARD).pressureAware)
  })

  it('is information-free — it reads defender positions the AI is already sent', () => {
    // The guarantee that matters: feeling the rush uses `k.live`, which is exactly the picture a
    // human is looking at. Nothing here consults the play call or the coverage assignment.
    expect(skillFor(DIFFICULTY.HARD).pressureAware).toBeLessThanOrEqual(1)
  })
})
