import { describe, it, expect } from '@jest/globals'
import { opennessBreakdown, computeReceiverOpenness, manShade } from '../game/utils/openness.js'
import { opennessTier, OPENNESS_OPEN, OPENNESS_RED } from '../game/utils/passOutcome.js'
import { adjustOpennessForReceiver, receiverThrowMods, XF } from '../game/systems/xFactors.js'
import { laneContext } from '../game/serialization.js'

// [man shade] "We have to respect man coverage shading. Too many times a player is playing underneath,
// TOUCHING a wr on a curl route and the wr catches the ball basically through the db body, the same is true
// with some go routes and the db is playing perfect defense over the top, both of those situations should be
// a heavily contested ball (unless something like an X-Factor is on)."
//
// The offense goes up the field here: y grows downfield, the QB is at y=0.

const QB = { x: 26, y: 0 }
const CURL = { breaksBack: true, settles: true, deepVertical: false, maxDepth: 12, givesUpDepth: true }
const GO = { breaksBack: false, settles: false, deepVertical: true, maxDepth: 40 }
const SHORT_GO = { breaksBack: false, settles: false, deepVertical: false, maxDepth: 10 }
const RUNNING_UP = { vx: 0, vy: 9 }
const COMING_BACK = { vx: 0, vy: -5 }
const SET = { vx: 0, vy: 0 }

const wr = (y, routeTraits, motion, x = 26) => ({ id: 'wr', x, y, ...motion, routeTraits })
const db = (x, y, id = 'db') => ({ id, label: 'CB', x, y, vx: 0, vy: 0, ratings: { awareness: 80, speed: 88 } })
const MAN = { losY: 0, direction: 1, zoneIds: new Set(), manIds: new Set(['db']) }
const ZONE = { losY: 0, direction: 1, zoneIds: new Set(['db']), manIds: new Set() }
const read = (r, d, ctx = MAN) => opennessBreakdown(r, [d], QB, ctx)
const tierOf = (r, d, ctx = MAN) => opennessTier(read(r, d, ctx).openness)

describe('[man shade] underneath on a curl', () => {
  it('⚠️ TOUCHING HIM AS HE COMES BACK IS HEAVILY CONTESTED (it read green, a 95% catch)', () => {
    const r = read(wr(12, CURL, COMING_BACK), db(26, 10))
    expect(r.shade).toBe('under')
    expect(opennessTier(r.openness)).toBe('smothered')
  })

  it('…when he has settled', () => {
    expect(tierOf(wr(12, CURL, SET), db(26.5, 10.2))).toBe('smothered')
  })

  it('…and on the stem, because the route is coming back to the man sitting there', () => {
    const r = read(wr(9, CURL, RUNNING_UP), db(26.5, 6.7))
    expect(r.shade).toBe('under')
    expect(opennessTier(r.openness)).toBe('smothered')
  })

  it('the exact spot a committed `under` sits at: two yards under, three quarters to his side', () => {
    expect(tierOf(wr(12, CURL, COMING_BACK), db(26.75, 10))).toBe('smothered')
  })

  it('a curl with room underneath is still throwable: the shade is not a force field', () => {
    expect(tierOf(wr(12, CURL, COMING_BACK), db(30, 8))).not.toBe('smothered')
  })

  it('⚠️ A CURL STILL BEATS A DEFENDER WHO IS WELL OVER THE TOP. That is the route working.', () => {
    expect(tierOf(wr(10, CURL, RUNNING_UP), db(26, 15.5))).toBe('open')
  })

  it('but not one two yards over him: there is no room there yet', () => {
    expect(tierOf(wr(9, CURL, RUNNING_UP), db(26.3, 11))).not.toBe('open')
  })
})

describe('[man shade] over the top on a go', () => {
  it('⚠️ A DEEP GO WITH THE MAN ON TOP OF HIM IS HEAVILY CONTESTED', () => {
    expect(tierOf(wr(25, GO, RUNNING_UP), db(26.5, 27.5))).toBe('smothered')
  })

  it('⚠️ SO IS A GO TOO SHORT TO COUNT AS DEEP, which could read open with him right there', () => {
    const r = read(wr(7, SHORT_GO, RUNNING_UP), db(26.5, 10.5))
    expect(r.shade).toBe('over')
    expect(opennessTier(r.openness)).toBe('smothered')
  })

  it('and a go early in its stem', () => {
    expect(tierOf(wr(6, GO, RUNNING_UP), db(26, 8.5))).toBe('smothered')
  })

  it('⚠️ A GO THAT HAS GOT PAST A MAN SITTING UNDERNEATH HAS BEATEN HIM. That is the risk of `under`.', () => {
    const r = read(wr(14, GO, RUNNING_UP), db(26.8, 10.8))
    expect(r.shade).toBeNull()
    expect(opennessTier(r.openness)).not.toBe('smothered')
  })

  it('a receiver who has run past his man at bodies-touching range is still in coverage, as before', () => {
    expect(tierOf(wr(14, GO, RUNNING_UP), db(26.3, 12.8))).toBe('smothered')
  })

  it('a route breaking away across his face is not running into him', () => {
    const dig = wr(10, { breaksBack: false, deepVertical: false, maxDepth: 10 }, { vx: 8, vy: 0 })
    expect(read(dig, db(26, 13)).shade).toBeNull()
  })
})

describe('[man shade] only what was asked for', () => {
  it('a separated receiver is left alone', () => {
    expect(manShade(wr(12, GO, RUNNING_UP), [db(20, 10)], QB, MAN)).toBeNull()
    expect(tierOf(wr(12, SHORT_GO, { vx: 8, vy: 0 }), db(20, 9))).toBe('open')
  })

  it('it is for man coverage: a zone defender is not capped by it', () => {
    expect(read(wr(12, SHORT_GO, RUNNING_UP), db(26, 15), ZONE).shade).toBeNull()
  })

  it('a defender rushing the passer covers nobody, even standing next to the back', () => {
    const blitz = { ...MAN, manIds: new Set() }
    expect(read(wr(1, SHORT_GO, SET), db(26, -1), blitz).shade).toBeNull()
  })

  it('without the coverage context, the read is the pure one it always was', () => {
    expect(manShade(wr(12, CURL, COMING_BACK), [db(26, 10)], QB)).toBeNull()
    expect(computeReceiverOpenness(wr(40, GO, SET), [db(10, 10)], QB)).toBeGreaterThan(OPENNESS_OPEN)
  })

  it('⚠️ THE GEOMETRY FIX IS FOR EVERYBODY: a zone defender underneath does not open a curl either', () => {
    expect(tierOf(wr(12, CURL, COMING_BACK), db(26, 10), ZONE)).toBe('smothered')
  })

  it('the real coverage assignments reach it', () => {
    const state = {
      yardLine: 25, direction: 1,
      defenseCoverage: new Map([['a', { type: 'man', targetId: 'wr' }], ['b', { type: 'zone' }], ['c', { type: 'blitz' }]]),
    }
    const ctx = laneContext(state)
    expect([...ctx.manIds]).toEqual(['a'])
    expect([...ctx.zoneIds]).toEqual(['b'])
  })
})

describe('[man shade] unless an X-Factor is on', () => {
  const stateWith = (ability) => ({ xFactors: new Map(ability ? [['wr', { active: true, ability }]] : []), possession: 0 })
  const player = { id: 'wr', label: 'WR' }
  const has = (xFactor) => ({ ...player, xFactor })
  const shadedGo = read(wr(25, GO, RUNNING_UP), db(26.5, 27.5))

  it('with nothing active, heavily contested is what it stays', () => {
    const after = adjustOpennessForReceiver(stateWith(null), player, shadedGo.openness, true, shadedGo.beforeShade)
    expect(opennessTier(after)).toBe('smothered')
  })

  it('⚠️ HIGH POINT LIFTS A SHADED DEEP BALL to merely contested', () => {
    const after = adjustOpennessForReceiver(stateWith(XF.HIGH_POINT), has(XF.HIGH_POINT), shadedGo.openness, true, shadedGo.beforeShade)
    expect(after).toBe(OPENNESS_RED)
    expect(opennessTier(after)).toBe('covered')
  })

  it('⚠️ MOSSED STILL WINS MORE OF THEM', () => {
    expect(receiverThrowMods(stateWith(XF.MOSSED), has(XF.MOSSED), { tier: 'smothered' }).catchBonus).toBeGreaterThan(0)
  })

  it('⚠️ "I\'M ALWAYS OPEN" JUDGES THE READ BEFORE THE CAP, or the cap would switch the ability off', () => {
    const before = 0.55, capped = 0.25
    expect(adjustOpennessForReceiver(stateWith(XF.IM_ALWAYS_OPEN), has(XF.IM_ALWAYS_OPEN), capped, false, before)).toBe(OPENNESS_OPEN)
    // Blanketed even before the cap: the ability has never turned that into an open window.
    expect(adjustOpennessForReceiver(stateWith(XF.IM_ALWAYS_OPEN), has(XF.IM_ALWAYS_OPEN), capped, false, 0.3)).toBe(capped)
  })

  it('the read before the cap travels with the capped one', () => {
    const r = read(wr(7, SHORT_GO, RUNNING_UP), db(26.5, 10.5))
    expect(r.shade).toBe('over')
    expect(r.beforeShade).toBeGreaterThanOrEqual(r.openness)
  })
})
