import { describe, it, expect } from '@jest/globals'
import {
  XF,
  recordPassOutcome, recordScramble, recordPassingTouchdown,
  recordReceiverOutcome, recordTouchdownScorer,
  recordRun, recordTackleBroken, tackleBreakBonus, keepsSpeedOnBreak,
  recordDefenderOutcome, findGuardingDB, applyDefenderOpenness, defenderThrowMods,
  throwCompletionBonus, adjustOpennessForReceiver, receiverThrowMods,
  shakeOffSack, onSnapXFactors,
  applyXFactorFlags, resetXFactors, resetDriveProgress, findOffenseQB,
} from '../game/systems/xFactors.js'
import { runSackDetection } from '../game/systems/sackDetection.js'
import { ratingOf } from '../data/ratings.js'

// ── Test harness ────────────────────────────────────────────────────────────────
//
// X-Factor progress lives in state.xFactors (created lazily). A QB entity carries its potential
// ability on `xFactor`; the active flag mirrors onto the entity as `xFactorActive` (the star).

function makeQB(ability) {
  return { id: 'qb', label: 'QB', x: 26, y: 30, xFactor: ability }
}

function makeState(qb, { fatigue = [] } = {}) {
  const playerFatigue = new Map()
  for (const f of fatigue) playerFatigue.set(f.id, { stamina: f.stamina, label: f.label ?? '' })
  return {
    roomId:         'XF_TEST',
    direction:      1,
    yardLine:       25,
    offensePlayers: new Map(qb ? [[qb.id, qb]] : []),
    defensePlayers: new Map(),
    playerFatigue,
    prevPlayIncompletePass: false,
  }
}

const noIo = null

// ── Universal earn: 2 passing TDs ────────────────────────────────────────────────

describe('universal earn — 2 passing touchdowns', () => {
  it('earns any ability after the 2nd passing TD', () => {
    const qb = makeQB(XF.CANNON)        // an ability whose own condition we never meet here
    const state = makeState(qb)

    recordPassingTouchdown(state, qb, noIo)
    expect(qb.xFactorActive).toBeFalsy()

    recordPassingTouchdown(state, qb, noIo)
    expect(qb.xFactorActive).toBe(true)
  })
})

// ── Shake It Off ─────────────────────────────────────────────────────────────────

describe('Shake It Off', () => {
  it('earns on a single scramble of ≥10 yards (not on 9)', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = makeState(qb)

    recordScramble(state, qb, 9, noIo)
    expect(qb.xFactorActive).toBeFalsy()
 
    recordScramble(state, qb, 10, noIo)
    expect(qb.xFactorActive).toBe(true)
  })

  it('shakeOffSack only fires for the active ability, gated by the RNG', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = makeState(qb)

    // Not yet active → never shakes
    expect(shakeOffSack(state, qb, () => 0)).toBe(false)

    recordScramble(state, qb, 12, noIo)    // activate
    expect(shakeOffSack(state, qb, () => 0.0)).toBe(true)   // low roll → shake
    expect(shakeOffSack(state, qb, () => 0.9)).toBe(false)  // high roll → no shake
  })

  it('a different active ability never shakes a sack', () => {
    const qb = makeQB(XF.CANNON)
    const state = makeState(qb)
    recordPassingTouchdown(state, qb, noIo)
    recordPassingTouchdown(state, qb, noIo)   // active via TDs
    expect(qb.xFactorActive).toBe(true)
    expect(shakeOffSack(state, qb, () => 0)).toBe(false)
  })
})

// ── sackDetection integration ────────────────────────────────────────────────────

describe('sackDetection — Shake It Off escape', () => {
  function sackState(qb) {
    const d = { id: 'd1', label: 'DL', x: 26, y: 30.5 }   // 0.5 yds from QB → within SACK_RADIUS
    return {
      ...makeState(qb),
      defensePlayers: new Map([[d.id, d]]),
      sackEnqueued:   false,
      ballCarrierId:  null,
      qbSackImmunity: 0,
      _def: d,
    }
  }

  it('an active QB shrugs off the sack on a low roll: no sack, rusher shoved off, immunity set', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = sackState(qb)
    recordScramble(state, qb, 15, noIo)   // activate

    runSackDetection(state, null, 0.05, () => 0)   // low roll → shake

    expect(state.sackEnqueued).toBe(false)
    expect(state.qbSackImmunity).toBeGreaterThan(0)
    // rusher pushed beyond contact range
    expect(Math.hypot(state._def.x - qb.x, state._def.y - qb.y)).toBeGreaterThan(1.5)
  })

  it('a high roll still gets sacked', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = sackState(qb)
    recordScramble(state, qb, 15, noIo)

    runSackDetection(state, null, 0.05, () => 0.99)   // high roll → no shake

    expect(state.sackEnqueued).toBe(true)
  })

  it('during the immunity window no sack lands', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = sackState(qb)
    state.qbSackImmunity = 0.6

    runSackDetection(state, null, 0.05, () => 0.99)

    expect(state.sackEnqueued).toBe(false)
    expect(state.qbSackImmunity).toBeCloseTo(0.55)   // decremented by dt
  })
})

// ── Short Term Memory ────────────────────────────────────────────────────────────

describe('Short Term Memory', () => {
  const complete = { outcome: 'complete', tier: 'open', deep: false, receiverId: 'wr1' }

  it('earns after 5 completions in a row', () => {
    const qb = makeQB(XF.SHORT_TERM_MEMORY)
    const state = makeState(qb)
    for (let i = 0; i < 4; i++) recordPassOutcome(state, qb, { ...complete, receiverId: 'wr' + i }, noIo)
    expect(qb.xFactorActive).toBeFalsy()
    recordPassOutcome(state, qb, complete, noIo)
    expect(qb.xFactorActive).toBe(true)
  })

  it('an incompletion breaks the streak', () => {
    const qb = makeQB(XF.SHORT_TERM_MEMORY)
    const state = makeState(qb)
    for (let i = 0; i < 4; i++) recordPassOutcome(state, qb, complete, noIo)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)   // streak → 0
    recordPassOutcome(state, qb, complete, noIo)                     // back to 1
    expect(qb.xFactorActive).toBeFalsy()
  })

  it('grants the bonus only when the previous play was an incomplete pass', () => {
    const qb = makeQB(XF.SHORT_TERM_MEMORY)
    const state = makeState(qb)
    recordPassingTouchdown(state, qb, noIo)
    recordPassingTouchdown(state, qb, noIo)   // active

    state.prevPlayIncompletePass = false
    expect(throwCompletionBonus(state, qb, { tier: 'open', deep: false })).toBe(0)

    state.prevPlayIncompletePass = true
    expect(throwCompletionBonus(state, qb, { tier: 'open', deep: false })).toBeCloseTo(0.10)
  })
})

// ── Tight Window ─────────────────────────────────────────────────────────────────

describe('Tight Window', () => {
  it('earns from 2 contested (covered) completions', () => {
    const qb = makeQB(XF.TIGHT_WINDOW)
    const state = makeState(qb)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'covered', deep: false, receiverId: 'a' }, noIo)
    expect(qb.xFactorActive).toBeFalsy()
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'covered', deep: false, receiverId: 'b' }, noIo)
    expect(qb.xFactorActive).toBe(true)
  })

  it('earns instantly from one heavily-contested (smothered) completion', () => {
    const qb = makeQB(XF.TIGHT_WINDOW)
    const state = makeState(qb)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'smothered', deep: false, receiverId: 'a' }, noIo)
    expect(qb.xFactorActive).toBe(true)
  })

  it('bonus applies only on contested/heavily-contested throws', () => {
    const qb = makeQB(XF.TIGHT_WINDOW)
    const state = makeState(qb)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'smothered', deep: false, receiverId: 'a' }, noIo)
    expect(throwCompletionBonus(state, qb, { tier: 'open' })).toBe(0)
    expect(throwCompletionBonus(state, qb, { tier: 'covered' })).toBeCloseTo(0.10)
    expect(throwCompletionBonus(state, qb, { tier: 'smothered' })).toBeCloseTo(0.10)
  })
})

// ── Cannon ───────────────────────────────────────────────────────────────────────

describe('Cannon', () => {
  it('earns from 2 deep completions and boosts deep throws', () => {
    const qb = makeQB(XF.CANNON)
    const state = makeState(qb)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: true, receiverId: 'a' }, noIo)
    expect(qb.xFactorActive).toBeFalsy()
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: true, receiverId: 'b' }, noIo)
    expect(qb.xFactorActive).toBe(true)

    expect(throwCompletionBonus(state, qb, { deep: false })).toBe(0)
    expect(throwCompletionBonus(state, qb, { deep: true })).toBeCloseTo(0.10)
  })
})

// ── Team Chemistry ───────────────────────────────────────────────────────────────

describe('Team Chemistry', () => {
  it('earns from completions to 4 different receivers', () => {
    const qb = makeQB(XF.TEAM_CHEMISTRY)
    const state = makeState(qb)
    for (const r of ['a', 'b', 'c']) {
      recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: r }, noIo)
    }
    expect(qb.xFactorActive).toBeFalsy()
    // a 4th completion to a REPEAT receiver does not earn it
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: 'a' }, noIo)
    expect(qb.xFactorActive).toBeFalsy()
    // the 4th DIFFERENT receiver earns it
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: 'd' }, noIo)
    expect(qb.xFactorActive).toBe(true)
  })

  it('ramps +1% completion per snap and caps at +15%', () => {
    const qb = makeQB(XF.TEAM_CHEMISTRY)
    const state = makeState(qb)
    for (const r of ['a', 'b', 'c', 'd']) {
      recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: r }, noIo)
    }
    expect(qb.xFactorActive).toBe(true)

    expect(throwCompletionBonus(state, qb, {})).toBe(0)   // no snaps yet
    onSnapXFactors(state)
    expect(throwCompletionBonus(state, qb, {})).toBeCloseTo(0.01)
    for (let i = 0; i < 30; i++) onSnapXFactors(state)
    expect(throwCompletionBonus(state, qb, {})).toBeCloseTo(0.15)   // capped
  })
})

// ── Loss triggers ────────────────────────────────────────────────────────────────

describe('loss triggers', () => {
  function activeQB(ability = XF.SHAKE_IT_OFF) {
    const qb = makeQB(ability)
    const state = makeState(qb)
    recordPassingTouchdown(state, qb, noIo)
    recordPassingTouchdown(state, qb, noIo)
    expect(qb.xFactorActive).toBe(true)
    return { qb, state }
  }

  it('lost after 3 incompletions in a row', () => {
    const { qb, state } = activeQB()
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    expect(qb.xFactorActive).toBe(true)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    expect(qb.xFactorActive).toBe(false)
  })

  it('a completion resets the incompletion streak', () => {
    const { qb, state } = activeQB()
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: 'x' }, noIo)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    recordPassOutcome(state, qb, { outcome: 'incomplete' }, noIo)
    expect(qb.xFactorActive).toBe(true)   // only 2 in a row since the completion
  })

  it('lost immediately on an interception', () => {
    const { qb, state } = activeQB()
    recordPassOutcome(state, qb, { outcome: 'intercepted' }, noIo)
    expect(qb.xFactorActive).toBe(false)
  })

  it('an early loss is sticky — banked progress does not re-earn it in the same half', () => {
    const { qb, state } = activeQB()   // earned via 2 passing TDs (banked)
    recordPassOutcome(state, qb, { outcome: 'intercepted' }, noIo)
    expect(qb.xFactorActive).toBe(false)
    // Another passing TD / completion must NOT bring it back this half.
    recordPassingTouchdown(state, qb, noIo)
    recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, receiverId: 'z' }, noIo)
    expect(qb.xFactorActive).toBe(false)
  })
})

// ── Stamina on activation ────────────────────────────────────────────────────────

describe('activation stamina bonus', () => {
  it('grants +25 stamina (capped at 100) to the offense on activation', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = makeState(qb, { fatigue: [
      { id: 'qb', stamina: 50, label: 'QB' },
      { id: 'wr', stamina: 90, label: 'WR' },
    ] })
    state.offensePlayers.set('wr', { id: 'wr', label: 'WR', x: 0, y: 0 })

    recordScramble(state, qb, 12, noIo)   // activate

    expect(state.playerFatigue.get('qb').stamina).toBe(75)    // 50 + 25
    expect(state.playerFatigue.get('wr').stamina).toBe(100)   // 90 + 25, capped
  })
})

// ── Reset at the half ────────────────────────────────────────────────────────────

describe('resetXFactors', () => {
  it('wipes active state and all progress', () => {
    const qb = makeQB(XF.CANNON)
    const state = makeState(qb)
    recordPassingTouchdown(state, qb, noIo)
    recordPassingTouchdown(state, qb, noIo)
    expect(qb.xFactorActive).toBe(true)

    resetXFactors(state, noIo)
    applyXFactorFlags(state)

    expect(qb.xFactorActive).toBe(false)
    expect(state.xFactors.size).toBe(0)
    // progress is gone: a single TD no longer re-activates (would need 2 fresh ones)
    recordPassingTouchdown(state, qb, noIo)
    expect(qb.xFactorActive).toBe(false)
  })
})

// ── Misc helpers ─────────────────────────────────────────────────────────────────

describe('findOffenseQB', () => {
  it('finds the QB entity in offensePlayers', () => {
    const qb = makeQB(XF.CANNON)
    const state = makeState(qb)
    state.offensePlayers.set('wr', { id: 'wr', label: 'WR' })
    expect(findOffenseQB(state)).toBe(qb)
  })
})

// ── Wide Receivers ───────────────────────────────────────────────────────────────

function makeWR(ability) {
  return { id: 'wr', label: 'WR', x: 20, y: 50, xFactor: ability }
}

function caught(tier, deep) { return { outcome: 'complete', reason: 'caught', tier, deep } }
function missed(reason)     { return { outcome: 'incomplete', reason } }   // 'drop' (open) | 'broken_up'

describe('WR — universal earn (scored a touchdown)', () => {
  it('earns any WR ability on a single touchdown', () => {
    const wr = makeWR(XF.MOSSED)
    const state = makeState(null)
    state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)
    expect(wr.xFactorActive).toBe(true)
  })

  it('ignores a QB scorer (a QB rushing TD is not a universal earn — that path is 2 passing TDs)', () => {
    const qb = makeQB(XF.SHAKE_IT_OFF)
    const state = makeState(qb)
    recordTouchdownScorer(state, qb, noIo)
    expect(qb.xFactorActive).toBeFalsy()
  })
})

describe('High Point', () => {
  it('earns from one heavily-contested DEEP catch', () => {
    const wr = makeWR(XF.HIGH_POINT)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordReceiverOutcome(state, wr, caught('smothered', true), noIo)
    expect(wr.xFactorActive).toBe(true)
  })

  it('a shallow heavily-contested catch does NOT earn it; 2 contested deep catches do', () => {
    const wr = makeWR(XF.HIGH_POINT)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordReceiverOutcome(state, wr, caught('smothered', false), noIo)   // not deep
    recordReceiverOutcome(state, wr, caught('covered', true), noIo)      // 1 contested deep
    expect(wr.xFactorActive).toBeFalsy()
    recordReceiverOutcome(state, wr, caught('covered', true), noIo)      // 2 contested deep
    expect(wr.xFactorActive).toBe(true)
  })

  it('un-smothers a deep ball (smothered → contested), but not a shallow one', () => {
    const wr = makeWR(XF.HIGH_POINT)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)   // activate

    expect(adjustOpennessForReceiver(state, wr, 0.1, true)).toBeCloseTo(0.33)   // deep → upgraded
    expect(adjustOpennessForReceiver(state, wr, 0.1, false)).toBeCloseTo(0.1)    // shallow → unchanged
  })

  it('grants +4 acceleration (can exceed 99) via ratingBonus, reflected by ratingOf', () => {
    const wr = makeWR(XF.HIGH_POINT)
    wr.ratings = { acceleration: 97 }
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)   // activate → applies buff
    expect(ratingOf(wr, 'acceleration')).toBe(101)   // 97 + 4, not clamped at 99

    // The buff is restored each snap, and cleared when the ability is lost.
    applyXFactorFlags(state)
    expect(ratingOf(wr, 'acceleration')).toBe(101)
  })
})

describe('Mossed', () => {
  it('+10% catch on contested/heavily-contested, nothing on open', () => {
    const wr = makeWR(XF.MOSSED)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordReceiverOutcome(state, wr, caught('smothered', false), noIo)   // earn (1 heavy)
    expect(wr.xFactorActive).toBe(true)

    expect(receiverThrowMods(state, wr, { tier: 'open' }).catchBonus).toBe(0)
    expect(receiverThrowMods(state, wr, { tier: 'covered' }).catchBonus).toBeCloseTo(0.10)
    expect(receiverThrowMods(state, wr, { tier: 'smothered' }).catchBonus).toBeCloseTo(0.10)
  })
})

describe('Fast Thinking', () => {
  it('+5% catch and −10% INT on contested/heavily-contested', () => {
    const wr = makeWR(XF.FAST_THINKING)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordReceiverOutcome(state, wr, caught('covered', false), noIo)
    recordReceiverOutcome(state, wr, caught('covered', false), noIo)   // earn (2 contested)
    expect(wr.xFactorActive).toBe(true)

    expect(receiverThrowMods(state, wr, { tier: 'open' })).toEqual({ catchBonus: 0, intDelta: 0 })
    const m = receiverThrowMods(state, wr, { tier: 'smothered' })
    expect(m.catchBonus).toBeCloseTo(0.05)
    expect(m.intDelta).toBeCloseTo(-0.10)
  })
})

describe("I'm Always F*cking Open", () => {
  it('earns from 3 catches in a row', () => {
    const wr = makeWR(XF.IM_ALWAYS_OPEN)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordReceiverOutcome(state, wr, caught('open', false), noIo)
    recordReceiverOutcome(state, wr, caught('covered', false), noIo)
    expect(wr.xFactorActive).toBeFalsy()
    recordReceiverOutcome(state, wr, caught('open', false), noIo)
    expect(wr.xFactorActive).toBe(true)
  })

  it('widens the open window and guarantees a catch on open', () => {
    const wr = makeWR(XF.IM_ALWAYS_OPEN)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)   // activate

    // A 0.55 openness (normally "contested") reads as open for this WR.
    expect(adjustOpennessForReceiver(state, wr, 0.55, false)).toBeCloseTo(0.66)
    // …and an open throw is a guaranteed catch (+1.0 clamps completion to 100%).
    expect(receiverThrowMods(state, wr, { tier: 'open' }).catchBonus).toBe(1.0)
    expect(receiverThrowMods(state, wr, { tier: 'covered' }).catchBonus).toBe(0)
  })
})

describe('WR loss triggers', () => {
  function activeWR() {
    const wr = makeWR(XF.MOSSED)
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)
    expect(wr.xFactorActive).toBe(true)
    return { wr, state }
  }

  it('lost instantly on a wide-open drop', () => {
    const { wr, state } = activeWR()
    recordReceiverOutcome(state, wr, missed('drop'), noIo)
    expect(wr.xFactorActive).toBe(false)
  })

  it('lost after 2 contested drops in a row', () => {
    const { wr, state } = activeWR()
    recordReceiverOutcome(state, wr, missed('broken_up'), noIo)
    expect(wr.xFactorActive).toBe(true)
    recordReceiverOutcome(state, wr, missed('broken_up'), noIo)
    expect(wr.xFactorActive).toBe(false)
  })

  it('lost after 3 total drops even if interspersed with catches', () => {
    const { wr, state } = activeWR()
    recordReceiverOutcome(state, wr, missed('broken_up'), noIo)
    recordReceiverOutcome(state, wr, caught('open', false), noIo)   // resets the in-a-row count
    recordReceiverOutcome(state, wr, missed('broken_up'), noIo)
    recordReceiverOutcome(state, wr, caught('open', false), noIo)
    expect(wr.xFactorActive).toBe(true)
    recordReceiverOutcome(state, wr, missed('broken_up'), noIo)     // 3rd total drop
    expect(wr.xFactorActive).toBe(false)
  })

  it('the accel buff is cleared on loss', () => {
    const wr = makeWR(XF.HIGH_POINT)
    wr.ratings = { acceleration: 90 }
    const state = makeState(null); state.offensePlayers.set(wr.id, wr)
    recordTouchdownScorer(state, wr, noIo)
    expect(ratingOf(wr, 'acceleration')).toBe(94)
    recordReceiverOutcome(state, wr, missed('drop'), noIo)   // wide-open drop → lost
    expect(ratingOf(wr, 'acceleration')).toBe(90)
  })
})

// ── Running Backs ────────────────────────────────────────────────────────────────

function makeRB(ability) {
  return { id: 'rb', label: 'RB', x: 26, y: 50, xFactor: ability }
}
function rbState(rb, { yardLine = 25, distance = 10 } = {}) {
  const state = makeState(null)
  state.yardLine = yardLine
  state.distance = distance
  state.offensePlayers.set(rb.id, rb)
  return state
}

describe('Trucked', () => {
  it('earns by breaking 2 tackles within the same run', () => {
    const rb = makeRB(XF.TRUCKED)
    const state = rbState(rb)
    recordTackleBroken(state, rb, 1, noIo)
    expect(rb.xFactorActive).toBeFalsy()
    recordTackleBroken(state, rb, 2, noIo)
    expect(rb.xFactorActive).toBe(true)
  })

  it('keepsSpeedOnBreak only for an active Trucked carrier', () => {
    const rb = makeRB(XF.TRUCKED)
    const state = rbState(rb)
    expect(keepsSpeedOnBreak(state, rb)).toBe(false)
    recordTackleBroken(state, rb, 2, noIo)   // activate
    expect(keepsSpeedOnBreak(state, rb)).toBe(true)
  })
})

describe('Shifty', () => {
  it('earns on a 20+ yard run and adds +10% to the first three break attempts', () => {
    const rb = makeRB(XF.SHIFTY)
    const state = rbState(rb)
    recordRun(state, rb, { yards: 19, firstDown: false }, noIo)
    expect(rb.xFactorActive).toBeFalsy()
    recordRun(state, rb, { yards: 20, firstDown: true }, noIo)
    expect(rb.xFactorActive).toBe(true)

    expect(tackleBreakBonus(state, rb, 0)).toBeCloseTo(0.10)
    expect(tackleBreakBonus(state, rb, 2)).toBeCloseTo(0.10)
    expect(tackleBreakBonus(state, rb, 3)).toBe(0)   // 4th tackle: no bonus
  })
})

describe('Serious Dedication', () => {
  it('earns after 3 first downs in one drive', () => {
    const rb = makeRB(XF.SERIOUS_DEDICATION)
    const state = rbState(rb)
    recordRun(state, rb, { yards: 12, firstDown: true }, noIo)
    recordRun(state, rb, { yards: 12, firstDown: true }, noIo)
    expect(rb.xFactorActive).toBeFalsy()
    recordRun(state, rb, { yards: 12, firstDown: true }, noIo)
    expect(rb.xFactorActive).toBe(true)
  })

  it('a drive change resets the per-drive count; 7 first downs across drives still earns it', () => {
    const rb = makeRB(XF.SERIOUS_DEDICATION)
    const state = rbState(rb)
    // 2 first downs, then the drive ends (possession change) — per-drive count resets, total persists
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    resetDriveProgress(state)
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    resetDriveProgress(state)
    expect(rb.xFactorActive).toBeFalsy()   // never 3 in a single drive
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    expect(rb.xFactorActive).toBeFalsy()   // 6 total
    recordRun(state, rb, { yards: 11, firstDown: true }, noIo)
    expect(rb.xFactorActive).toBe(true)    // 7th total → earned
  })

  it('+20% on the first tackle only when the LOS is within 2 yds of the marker or end zone', () => {
    const rb = makeRB(XF.SERIOUS_DEDICATION)
    const state = rbState(rb, { yardLine: 25, distance: 10 })
    // earn via a TD so we can isolate the effect
    recordTouchdownScorer(state, rb, noIo)
    expect(rb.xFactorActive).toBe(true)

    // Far from both markers → no bonus
    expect(tackleBreakBonus(state, rb, 0)).toBe(0)
    // Short-yardage (distance ≤ 2) → +20% on the first tackle only
    state.distance = 2
    expect(tackleBreakBonus(state, rb, 0)).toBeCloseTo(0.20)
    expect(tackleBreakBonus(state, rb, 1)).toBe(0)   // not the first tackle
    // Goal line (within 2 of the end zone) → +20%
    state.distance = 10; state.yardLine = 98
    expect(tackleBreakBonus(state, rb, 0)).toBeCloseTo(0.20)
  })
})

describe('RB loss — 3 consecutive non-positive runs', () => {
  it('lost after 3 non-positive runs, reset by a positive run', () => {
    const rb = makeRB(XF.SHIFTY)
    const state = rbState(rb)
    recordTouchdownScorer(state, rb, noIo)   // activate
    expect(rb.xFactorActive).toBe(true)

    recordRun(state, rb, { yards: 0, firstDown: false }, noIo)
    recordRun(state, rb, { yards: -2, firstDown: false }, noIo)
    recordRun(state, rb, { yards: 5, firstDown: false }, noIo)   // positive → resets
    expect(rb.xFactorActive).toBe(true)

    recordRun(state, rb, { yards: 0, firstDown: false }, noIo)
    recordRun(state, rb, { yards: 0, firstDown: false }, noIo)
    expect(rb.xFactorActive).toBe(true)
    recordRun(state, rb, { yards: -1, firstDown: false }, noIo)  // 3rd in a row
    expect(rb.xFactorActive).toBe(false)
  })
})

// ── Defensive Backs (CB/S) ───────────────────────────────────────────────────────

function makeDB(ability, { id = 'cb', label = 'CB', x = 20, y = 50 } = {}) {
  return { id, label, x, y, xFactor: ability }
}
function makeWRTarget({ id = 'wr', x = 20, y = 50 } = {}) {
  return { id, label: 'WR', x, y }
}
// State with a receiver and a guarding DB; coverage is man on the receiver unless `zone` is set.
function dbState(db, receiver, { zone = false } = {}) {
  const state = makeState(null)
  state.defensePlayers = new Map([[db.id, db]])
  state.offensePlayers.set(receiver.id, receiver)
  state.defenseCoverage = new Map([[db.id, zone
    ? { type: 'zone', targetId: null }
    : { type: 'man', targetId: receiver.id }]])
  return state
}

const intercepted = { outcome: 'intercepted', reason: 'intercepted' }
const brokenUp    = { outcome: 'incomplete', reason: 'broken_up' }

describe('findGuardingDB', () => {
  it('returns the man defender assigned to the receiver', () => {
    const db = makeDB(XF.BALL_HAWK)
    const wr = makeWRTarget()
    const far = { id: 'cb2', label: 'CB', x: 0, y: 0 }
    const state = dbState(db, wr)
    state.defensePlayers.set(far.id, far)
    expect(findGuardingDB(state, wr)).toBe(db)
  })

  it('in zone, returns the nearest CB/S to the receiver', () => {
    const near = { id: 'cb', label: 'CB', x: 21, y: 51 }
    const far  = { id: 's',  label: 'S',  x: 0,  y: 0 }
    const wr   = makeWRTarget({ x: 20, y: 50 })
    const state = dbState(makeDB(XF.BALL_HAWK, { id: 'cb', x: 21, y: 51 }), wr, { zone: true })
    state.defensePlayers.set(far.id, far)
    expect(findGuardingDB(state, wr).id).toBe('cb')
  })
})

describe('DB earn — INT or 3 pass break-ups', () => {
  it('earns on an interception credited to the guarding DB', () => {
    const db = makeDB(XF.INTIMIDATOR)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)
    expect(db.xFactorActive).toBe(true)
  })

  it('earns on the 3rd pass break-up', () => {
    const db = makeDB(XF.SLANT_SLAYER)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...brokenUp, tier: 'covered' }, noIo)
    recordDefenderOutcome(state, db, { ...brokenUp, tier: 'covered' }, noIo)
    expect(db.xFactorActive).toBeFalsy()
    recordDefenderOutcome(state, db, { ...brokenUp, tier: 'covered' }, noIo)
    expect(db.xFactorActive).toBe(true)
  })

  it('a wide-open drop is not a break-up (no credit)', () => {
    const db = makeDB(XF.SLANT_SLAYER)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    for (let i = 0; i < 3; i++) recordDefenderOutcome(state, db, { outcome: 'incomplete', reason: 'drop', tier: 'open' }, noIo)
    expect(db.xFactorActive).toBeFalsy()
  })
})

describe('DB loss', () => {
  function activeDB(ability = XF.BALL_HAWK) {
    const db = makeDB(ability)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)   // earn via INT
    expect(db.xFactorActive).toBe(true)
    return { db, state }
  }

  it('lost instantly when a contested/heavily-contested pass is caught on them', () => {
    const { db, state } = activeDB()
    recordDefenderOutcome(state, db, { outcome: 'complete', reason: 'caught', tier: 'covered' }, noIo)
    expect(db.xFactorActive).toBe(false)
  })

  it('lost after allowing 2 (open) catches', () => {
    const { db, state } = activeDB()
    recordDefenderOutcome(state, db, { outcome: 'complete', reason: 'caught', tier: 'open' }, noIo)
    expect(db.xFactorActive).toBe(true)
    recordDefenderOutcome(state, db, { outcome: 'complete', reason: 'caught', tier: 'open' }, noIo)
    expect(db.xFactorActive).toBe(false)
  })
})

describe('Slant Slayer / Deep Pass Demon', () => {
  it('Slant Slayer: −10% catch on contested SHORT throws only', () => {
    const db = makeDB(XF.SLANT_SLAYER)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)   // activate

    expect(defenderThrowMods(state, db, { tier: 'covered', deep: false }).catchBonus).toBeCloseTo(-0.10)
    expect(defenderThrowMods(state, db, { tier: 'covered', deep: true }).catchBonus).toBe(0)   // deep → no
    expect(defenderThrowMods(state, db, { tier: 'open',    deep: false }).catchBonus).toBe(0)  // open → no
  })

  it('Deep Pass Demon: −10% catch on contested DEEP throws only', () => {
    const db = makeDB(XF.DEEP_PASS_DEMON)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)

    expect(defenderThrowMods(state, db, { tier: 'smothered', deep: true }).catchBonus).toBeCloseTo(-0.10)
    expect(defenderThrowMods(state, db, { tier: 'smothered', deep: false }).catchBonus).toBe(0)
  })
})

describe('Ball Hawk', () => {
  it('+5% INT on contested/heavily-contested throws', () => {
    const db = makeDB(XF.BALL_HAWK)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)

    expect(defenderThrowMods(state, db, { tier: 'open' }).intDelta).toBe(0)
    expect(defenderThrowMods(state, db, { tier: 'covered' }).intDelta).toBeCloseTo(0.05)
    expect(defenderThrowMods(state, db, { tier: 'smothered' }).intDelta).toBeCloseTo(0.05)
  })
})

describe('Intimidator', () => {
  it('shrinks the open window: a marginally-open throw drops to contested, a wide-open one does not', () => {
    const db = makeDB(XF.INTIMIDATOR)
    const wr = makeWRTarget()
    const state = dbState(db, wr)
    recordDefenderOutcome(state, db, { ...intercepted, tier: 'covered' }, noIo)   // activate

    // 0.70 would normally be open (≥ 0.66) but is below the Intimidator bar (0.85) → knocked to covered.
    expect(applyDefenderOpenness(state, db, 0.70)).toBeLessThan(0.66)
    // 0.90 is open enough to beat the Intimidator → stays open.
    expect(applyDefenderOpenness(state, db, 0.90)).toBe(0.90)
    // An already-contested throw is untouched.
    expect(applyDefenderOpenness(state, db, 0.50)).toBe(0.50)
  })
})
