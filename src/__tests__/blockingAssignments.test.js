import { describe, it, expect } from '@jest/globals'
import { getBlockerTarget, getStalkBlockTarget, isStalkBlocker } from '../game/systems/movement.js'
import { blitzOnSide } from '../game/systems/init.js'

// Three requests about blocking:
//   • "RBs blocking should prioritize the most active threat and whoever has the clearest path to the
//     QB. Sometimes they block a guy in the crowd in the middle and leave an edge blitzer unblocked."
//   • "When WRs are blocking during a pass or run play, they should go upfield and engage CBs and
//     defenders, not drop back."
//   • "If a TE is on a route that is blue, it's a check and release: if a player is blitzing on the
//     TE side he blocks, otherwise he runs the route."

const LOS = 40, BALL_X = 26.665
const map = ps => new Map(ps.map(p => [p.id, p]))
const ol = (i, x) => ({ id: `ol${i}`, label: 'OL', x, y: LOS - 1, vx: 0, vy: 0, blockTargetId: `dl${i}` })
const dl = (i, x) => ({ id: `dl${i}`, label: 'DL', x, y: LOS + 1, vx: 0, vy: 0 })

function protection({ crowdEngaged = false } = {}) {
  const qb = { id: 'qb', label: 'QB', x: BALL_X, y: LOS - 7, vx: 0, vy: 0 }
  const rb = { id: 'rb', label: 'RB', x: BALL_X + 2, y: LOS - 6, vx: 0, vy: 0, route: 'block' }
  const line = [-4, -2, 0, 2, 4].map((dx, i) => ol(i, BALL_X + dx))
  const front = [-3, -1, 1, 3].map((dx, i) => dl(i, BALL_X + dx))
  // A linebacker blitzing straight up the middle, into the pile.
  const crowd = { id: 'mlb', label: 'LB', x: BALL_X + 0.5, y: LOS + 3, vx: 0, vy: -3,
    isEngaged: crowdEngaged, engagedWithId: crowdEngaged ? 'ol2' : null }
  // A safety blitzing off the edge, wide, with nothing between him and the quarterback.
  const edge = { id: 'ss', label: 'S', x: BALL_X - 11, y: LOS + 4, vx: 3, vy: -6 }
  return {
    state: {
      direction: 1, ballX: BALL_X, playDesign: { playType: 'pass' },
      offensePlayers: map([qb, rb, ...line]),
      defensePlayers: map([...front, crowd, edge]),
      defenseCoverage: new Map([['mlb', { type: 'blitz' }], ['ss', { type: 'blitz' }]]),
    },
    rb,
  }
}

describe('⚠️ THE BACK PICKS UP THE REAL THREAT', () => {
  it('the edge blitzer with a clear lane, not the man in the pile', () => {
    const { state, rb } = protection()
    getBlockerTarget(rb, state, LOS, 1)
    expect(rb.blockTargetId).toBe('ss')
  })

  it('a back latched on the pile lets him go once a lineman has him, and takes the edge', () => {
    const { state, rb } = protection({ crowdEngaged: true })
    rb.blockTargetId = 'mlb'
    getBlockerTarget(rb, state, LOS, 1)
    expect(rb.blockTargetId).toBe('ss')
  })

  it('with only one free rusher, that is the one he takes', () => {
    const { state, rb } = protection()
    state.defensePlayers.delete('ss'); state.defenseCoverage.delete('ss')
    getBlockerTarget(rb, state, LOS, 1)
    expect(rb.blockTargetId).toBe('mlb')
  })
})

describe('⚠️ A BLOCKING RECEIVER GOES UPFIELD TO THE MAN OVER HIM', () => {
  const setup = (playType, route) => {
    const wr = { id: 'wr', label: 'WR', x: 5, y: LOS - 1, vx: 0, vy: 0, route }
    const rb = { id: 'rb', label: 'RB', x: BALL_X, y: LOS - 6, vx: 0, vy: 0 }
    const cb = { id: 'cb', label: 'CB', x: 6, y: LOS + 6, vx: 0, vy: 0 }
    const lb = { id: 'lb', label: 'LB', x: 22, y: LOS + 4, vx: 0, vy: 0 }
    const state = { direction: 1, ballX: BALL_X, playDesign: { playType }, catchSpot: null,
      offensePlayers: map([wr, rb]), defensePlayers: map([cb, lb]), defenseCoverage: new Map() }
    return { state, wr, rb }
  }

  it('on a run: takes the corner and meets him past the line, not back toward the carrier', () => {
    const { state, wr, rb } = setup('run')
    expect(isStalkBlocker(wr, state, 'run', false)).toBe(true)
    const t = getStalkBlockTarget(wr, state, LOS, 1, rb)
    expect(wr.stalkTargetId).toBe('cb')
    expect(t.y).toBeGreaterThan(LOS + 4)          // upfield, at the corner
    expect(Math.abs(t.x - 6)).toBeLessThan(1.5)   // out wide where the corner is, not inside
  })

  it('on a pass with a block assignment: the same, instead of pass protection by the QB', () => {
    const { state, wr } = setup('pass', 'block')
    expect(isStalkBlocker(wr, state, 'pass', false)).toBe(true)
    expect(getStalkBlockTarget(wr, state, LOS, 1, null).y).toBeGreaterThan(LOS + 4)
  })

  it('a WR running a route on a pass is not a blocker', () => {
    const { state, wr } = setup('pass', 'go')
    expect(isStalkBlocker(wr, state, 'pass', false)).toBe(false)
  })
})

describe('⚠️ A BLUE-ROUTE TE CHECKS THE BLITZ BEFORE HE RELEASES', () => {
  const te = { id: 'te', label: 'TE', x: BALL_X + 4, y: LOS - 1 }
  const state = (blitzer) => ({
    ballX: BALL_X,
    defensePlayers: map([{ id: 'dl', label: 'DL', x: BALL_X + 3, y: LOS + 1 }, blitzer]),
    defenseCoverage: new Map([['dl', { type: null }], [blitzer.id, { type: 'blitz' }]]),
  })
  it('a blitzer on his side: he stays in', () => {
    expect(blitzOnSide(state({ id: 'lb', label: 'LB', x: BALL_X + 6, y: LOS + 4 }), te)).toBe(true)
  })
  it('a blitzer on the other side: he releases', () => {
    expect(blitzOnSide(state({ id: 'lb', label: 'LB', x: BALL_X - 6, y: LOS + 4 }), te)).toBe(false)
  })
  it('the linemen rushing is not a blitz', () => {
    const s = state({ id: 'lb', label: 'LB', x: BALL_X - 6, y: LOS + 4 })
    s.defenseCoverage.set('lb', { type: 'zone' })
    expect(blitzOnSide(s, te)).toBe(false)
  })
})
