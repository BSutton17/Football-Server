import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { serializeDevReveal } from '../game/devReveal.js'
import { serializeGameState } from '../game/serialization.js'

// [dev reveal] The screenshot tool: the computer's own call, drawn over the field, so a bad alignment
// can be photographed next to what it should have been.
//
// ⚠️ THIS IS TESTED BECAUSE OF WHAT IT GUARDS. "The defense never sees the play call" is the oldest
// rule in this codebase, and this is the one code path that deliberately breaks it. Three gates hold
// it shut; a test per gate means none of them can be quietly removed, and the payload actually
// arriving means the tool works before anyone spends an evening taking screenshots for it.

const ORIGINAL = { node: process.env.NODE_ENV, flag: process.env.ENABLE_DEV_REVEAL }

beforeEach(() => {
  process.env.NODE_ENV = 'development'
  process.env.ENABLE_DEV_REVEAL = '1'
})
afterEach(() => {
  process.env.NODE_ENV = ORIGINAL.node
  if (ORIGINAL.flag === undefined) delete process.env.ENABLE_DEV_REVEAL
  else process.env.ENABLE_DEV_REVEAL = ORIGINAL.flag
})

// A solo room mid-play: the human is slot 0, the computer slot 1.
function soloState({ aiHasBall = false } = {}) {
  const cov = new Map([
    ['d_cb1', { type: 'man', targetId: 'o_wr1', manCommit: 'in' }],
    ['d_s1',  { type: 'zone', zoneType: 'deep_middle', zoneCenterX: 26, zoneCenterY: 62 }],
    ['d_lb1', { type: 'rush' }],
  ])
  return {
    roomId: 'reveal', solo: { defenseSet: false, countdown: null },
    possession: aiHasBall ? 1 : 0,
    aiCallName: aiHasBall ? 'Gun Trips Flood' : 'Nickel Cover 1 Robber',
    playDesign: {
      playType: 'pass',
      players: [
        { id: 'o_wr1', label: 'WR', x: 6, y: 40, drawnRoute: [{ dx: 0, dd: 12 }], route: 'out' },
        { id: 'o_te1', label: 'TE', x: 20, y: 40, route: 'block' },
      ],
    },
    defensePlayers: new Map([
      ['d_cb1', { id: 'd_cb1', label: 'CB', x: 7, y: 45 }],
      ['d_s1',  { id: 'd_s1',  label: 'S',  x: 26, y: 58 }],
      ['d_lb1', { id: 'd_lb1', label: 'LB', x: 24, y: 44 }],
    ]),
    defenseCoverage: cov,
  }
}

describe('⚠️ THE THREE GATES', () => {
  it('reveals nothing in production, flag or no flag', () => {
    process.env.NODE_ENV = 'production'
    expect(serializeDevReveal(soloState(), 0)).toBeNull()
  })

  it('reveals nothing without the opt-in flag', () => {
    delete process.env.ENABLE_DEV_REVEAL
    expect(serializeDevReveal(soloState(), 0)).toBeNull()
    process.env.ENABLE_DEV_REVEAL = '0'
    expect(serializeDevReveal(soloState(), 0)).toBeNull()
  })

  it('⚠️ REVEALS NOTHING IN A TWO-HUMAN ROOM — that would hand one player the other’s call', () => {
    const online = { ...soloState(), solo: null }
    expect(serializeDevReveal(online, 0)).toBeNull()
    expect(serializeDevReveal(online, 1)).toBeNull()
  })

  it('reveals nothing to a viewer with no seat', () => {
    expect(serializeDevReveal(soloState(), null)).toBeNull()
    expect(serializeDevReveal(soloState(), undefined)).toBeNull()
  })
})

describe('⚠️ IT ACTUALLY ARRIVES — and carries what a screenshot needs', () => {
  it('gives the human the computer’s DEFENSIVE call, with every assignment', () => {
    const r = serializeDevReveal(soloState({ aiHasBall: false }), 0)
    expect(r).not.toBeNull()
    expect(r.aiRole).toBe('defense')
    expect(r.play).toBeNull()
    expect(r.shell.name).toBe('Nickel Cover 1 Robber')

    // The whole point: who is doing what, to whom, and where the zone actually sits.
    const byId = Object.fromEntries(r.shell.players.map(p => [p.id, p]))
    expect(byId.d_cb1).toMatchObject({ label: 'CB', job: 'man', covers: 'o_wr1', shade: 'in' })
    expect(byId.d_s1).toMatchObject({ job: 'zone', zone: 'deep_middle', zoneCenterX: 26, zoneCenterY: 62 })
    expect(byId.d_lb1.job).toBe('rush')
    // Positions come through, or the overlay cannot be drawn on the field at all.
    expect(byId.d_cb1.x).toBe(7)
    expect(byId.d_cb1.y).toBe(45)
  })

  it('a defender with NO assignment reads as a rusher, which is what the engine does with him', () => {
    const s = soloState()
    s.defenseCoverage.delete('d_lb1')
    const r = serializeDevReveal(s, 0)
    expect(r.shell.players.find(p => p.id === 'd_lb1').job).toBe('rush')
  })

  it('gives the computer’s OFFENSIVE call when it has the ball, routes and all', () => {
    const r = serializeDevReveal(soloState({ aiHasBall: true }), 0)
    expect(r.aiRole).toBe('offense')
    expect(r.shell).toBeNull()
    expect(r.play.name).toBe('Gun Trips Flood')
    expect(r.play.playType).toBe('pass')
    const wr = r.play.players.find(p => p.id === 'o_wr1')
    expect(wr.route).toEqual([{ dx: 0, dd: 12 }])
    expect(wr.blocking).toBe(false)
    expect(r.play.players.find(p => p.id === 'o_te1').blocking).toBe(true)
  })

  it('⚠️ IS ONE-WAY — the viewer is never shown their own call back', () => {
    // Slot 1 is the computer. Asking as slot 1 describes slot 0, so nothing here can ever be used to
    // see your OWN hidden call; the direction is what keeps this from being a cheat.
    const onDefense = serializeDevReveal(soloState({ aiHasBall: false }), 1)
    expect(onDefense.aiRole).toBe('offense')
  })

  it('survives a half-built state instead of throwing mid-play', () => {
    const bare = { solo: {}, possession: 0, defensePlayers: new Map(), defenseCoverage: new Map() }
    expect(serializeDevReveal(bare, 0).shell.players).toEqual([])
    const noDesign = { solo: {}, possession: 1 }
    expect(serializeDevReveal(noDesign, 0).play).toBeNull()
  })
})

describe('⚠️ IT IS REACHABLE FROM THE GAME STATE THE CLIENT RECEIVES', () => {
  // The bug this project keeps having is a finished feature nothing calls. The overlay reads
  // `game_state.devReveal`, so that is what gets asserted — not just the serializer in isolation.
  it('rides along on game_state', () => {
    const s = {
      ...soloState(), phase: 'pre_snap', quarter: 1, clock: 600, down: 1, distance: 10,
      yardLine: 30, ballX: 26, playClock: 25, score: [0, 0], timeouts: [3, 3],
      offensePlayers: new Map(), direction: 1,
    }
    expect(serializeGameState(s, 0).devReveal).not.toBeNull()
  })

  it('…and is null there in an ordinary game', () => {
    delete process.env.ENABLE_DEV_REVEAL
    const s = {
      ...soloState(), phase: 'pre_snap', quarter: 1, clock: 600, down: 1, distance: 10,
      yardLine: 30, ballX: 26, playClock: 25, score: [0, 0], timeouts: [3, 3],
      offensePlayers: new Map(), direction: 1,
    }
    expect(serializeGameState(s, 0).devReveal).toBeNull()
  })
})
