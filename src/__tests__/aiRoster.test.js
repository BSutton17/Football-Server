import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals'
import { normalizeRoster, syntheticRoster } from '../ai/roster.js'

// ── The computer's roster, and the handicap nobody could see ─────────────────
//
// ⚠️ A WHOLE GAME WAS PLAYED WITH THE COMPUTER ON A SYNTHETIC ROSTER AND NOTHING SAID SO.
//
// Picking "surprise me" for the opponent's team made the client send `aiRoster: []`, this fell back to
// `syntheticRoster`, and that is ids and positions with NO ratings and NO X-FACTORS. The computer then
// played every snap on generic position baselines — speed, awareness, catching, route running, tackling
// — against a human using their real roster, with the entire X-Factor mechanic missing on its side.
//
// It is invisible in play, which is the part that matters: the generated ids are `sea_wr1`, `sea_cb1`,
// identical to the real ones, so the opponent still shows as Seattle with Seattle's logo. The way it
// surfaced was a gameplay complaint — "the CBs were getting burned deep and the offense just could not
// do much" — which is exactly what an invisible handicap looks like from the player's chair.
//
// For scale: Seattle's actual corner is 95 speed / 97 acceleration / 97 awareness with the Intimidator
// X-Factor, and the second is 97 speed with DEEP PASS DEMON. The computer ran at the CB baseline, 90
// speed and 85 awareness, with no X-Factor at all.
//
// Fixed at the source (the client now resolves the random pick and always sends a real team). These are
// the server's half: it refuses to degrade QUIETLY.

const POOL = [
  ...Array.from({ length: 4 }, (_, i) => ({ id: `sea_wr${i + 1}`, position: 'WR', ovr: 85, ratings: { speed: 92 } })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `sea_te${i + 1}`, position: 'TE', ovr: 80, ratings: { speed: 78 } })),
  ...Array.from({ length: 2 }, (_, i) => ({ id: `sea_rb${i + 1}`, position: 'RB', ovr: 84, ratings: { speed: 95 } })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `sea_cb${i + 1}`, position: 'CB', ovr: 90, ratings: { speed: 95, awareness: 97 } })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `sea_s${i + 1}`, position: 'S', ovr: 85, ratings: { speed: 93 } })),
  ...Array.from({ length: 4 }, (_, i) => ({ id: `sea_lb${i + 1}`, position: 'LB', ovr: 82, ratings: { speed: 80 } })),
]

let warn
beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}) })
afterEach(() => warn.mockRestore())

const warnings = () => warn.mock.calls.map(c => c.join(' ')).join('\n')

describe('a real roster is used as sent', () => {
  it('keeps every player and their ratings', () => {
    const r = normalizeRoster(POOL, 'SEA')
    expect(r).toHaveLength(POOL.length)
    expect(r.filter(p => p.ratings)).toHaveLength(POOL.length)
    expect(r.find(p => p.id === 'sea_cb1').ratings).toMatchObject({ speed: 95, awareness: 97 })
  })

  it('says nothing, because there is nothing wrong', () => {
    normalizeRoster(POOL, 'SEA')
    expect(warnings()).toBe('')
  })
})

describe('⚠️ a degraded roster is never silent', () => {
  it('warns when none was sent at all — the "surprise me" path', () => {
    const r = normalizeRoster([], 'SEA')
    expect(r.filter(p => p.ratings)).toHaveLength(0)     // synthetic, as before
    expect(warnings()).toMatch(/SYNTHETIC/i)
    expect(warnings()).toMatch(/SEA/)
  })

  it('warns when it cannot field a legal eleven', () => {
    normalizeRoster(POOL.slice(0, 3), 'SEA')
    expect(warnings()).toMatch(/SYNTHETIC/i)
    expect(warnings()).toMatch(/pass catchers/)
  })

  // ⚠️ A ROSTER WITH NO RATINGS IS NOT A ROSTER, however many names are in it. It passes the count test
  // and fields eleven position baselines — the same degradation as synthetic, through the front door.
  it('warns when a full roster arrives carrying no ratings', () => {
    const unrated = POOL.map(({ ratings, ...p }) => p)
    const r = normalizeRoster(unrated, 'SEA')
    expect(r).toHaveLength(POOL.length)                  // it is still used; it is just called out
    expect(warnings()).toMatch(/NOT ONE/)
  })

  it('and the warning names the mechanic, not just the fact', () => {
    normalizeRoster([], 'SEA')
    expect(warnings()).toMatch(/X-Factor/i)
  })
})

describe('what a synthetic roster is', () => {
  // Pinned because this is the thing that masqueraded as a real team: the ids are indistinguishable.
  it('has the same id shape as the real roster, which is why the fallback was invisible', () => {
    const synth = syntheticRoster('SEA')
    expect(synth.some(p => p.id === 'sea_wr1')).toBe(true)
    expect(POOL.some(p => p.id === 'sea_wr1')).toBe(true)
  })

  it('carries no ratings and no X-Factors', () => {
    for (const p of syntheticRoster('SEA')) {
      expect(p.ratings).toBeUndefined()
      expect(p.xFactor).toBeUndefined()
    }
  })
})
