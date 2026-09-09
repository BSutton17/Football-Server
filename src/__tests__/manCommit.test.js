import { describe, it, expect } from '@jest/globals'
import { getManTarget } from '../game/systems/movement.js'
import { validateAssignCoverage } from '../game/validation.js'
import { initGame, deleteGame } from '../game/gameState.js'
import { PHASE } from '../game/stateMachine.js'
import { FIELD } from '../constants.js'

// ── [man commit] Selling out to take away one thing ──────────────────────────
//
// A committed man defender abandons honest leverage and fully positions himself against ONE route
// family. What matters is that each commitment is a real bet: it must move him decisively toward
// what he is taking away, and equally decisively AWAY from everything else. A commitment that
// quietly kept him in a good position against the thing he chose to ignore would be free, and
// nobody would ever play man honestly again.

const DIR = 1                 // offense advancing toward +y
const BALL_X = 26.67
const receiver = (over = {}) => ({ x: 34, y: 50, vx: 0, vy: 0, ...over })

// Positive = the defender is UNDERNEATH (between the receiver and the line); negative = over the top.
const underneathBy = (t, r) => (r.y - t.y) * DIR
// Positive = the defender is on the ball side of the receiver.
const insideBy     = (t, r) => (BALL_X - r.x > 0 ? t.x - r.x : r.x - t.x)

describe('side commitments', () => {
  it('inside puts the defender on the ball side of the receiver', () => {
    const r = receiver()
    expect(insideBy(getManTarget(r, DIR, 55, 1, 'in', BALL_X), r)).toBeGreaterThan(1)
  })

  it('outside puts him on the sideline side', () => {
    const r = receiver()
    expect(insideBy(getManTarget(r, DIR, 55, 1, 'out', BALL_X), r)).toBeLessThan(-1)
  })

  it('overrides whatever leverage he happened to line up with', () => {
    // Same commitment, opposite alignments — the commitment wins both times.
    const r = receiver()
    const fromRight = getManTarget(r, DIR, 55,  1, 'in', BALL_X)
    const fromLeft  = getManTarget(r, DIR, 55, -1, 'in', BALL_X)
    expect(fromRight.x).toBeCloseTo(fromLeft.x, 5)
  })

  it('"inside" means toward the BALL, not the middle of the field', () => {
    // Receiver to the LEFT of a ball spotted on the right hash: inside is to his right.
    const r = { x: 10, y: 50, vx: 0, vy: 0 }
    const ballRight = 40
    expect(getManTarget(r, DIR, 55, -1, 'in', ballRight).x).toBeGreaterThan(r.x)
  })

  it('commits harder than honest leverage does', () => {
    const r = receiver()
    const honest    = getManTarget(r, DIR, 55, 1)
    const committed = getManTarget(r, DIR, 55, 1, 'out', BALL_X)
    expect(Math.abs(committed.x - r.x)).toBeGreaterThan(Math.abs(honest.x - r.x))
  })
})

describe('depth commitments', () => {
  it('over the top puts the defender DEEPER than the receiver', () => {
    const r = receiver()
    expect(underneathBy(getManTarget(r, DIR, 55, 1, 'over', BALL_X), r)).toBeLessThan(0)
  })

  it('underneath puts him in FRONT of the receiver', () => {
    const r = receiver()
    expect(underneathBy(getManTarget(r, DIR, 55, 1, 'under', BALL_X), r)).toBeGreaterThan(1)
  })

  it('underneath sits further in front than honest trail depth', () => {
    const r = receiver()
    const honest = underneathBy(getManTarget(r, DIR, 55, 1), r)
    const under  = underneathBy(getManTarget(r, DIR, 55, 1, 'under', BALL_X), r)
    expect(under).toBeGreaterThan(honest)
  })

  it('the two depth commitments are genuine opposites', () => {
    const r = receiver()
    const over  = getManTarget(r, DIR, 55, 1, 'over',  BALL_X)
    const under = getManTarget(r, DIR, 55, 1, 'under', BALL_X)
    expect(underneathBy(under, r)).toBeGreaterThan(underneathBy(over, r) + 3)
  })

  it('works for an offense running the other way', () => {
    const r = receiver()
    const over = getManTarget(r, -1, 55, 1, 'over', BALL_X)
    expect((r.y - over.y) * -1).toBeLessThan(0)   // still over the top, mirrored
  })
})

describe('no commitment', () => {
  it('plays honest leverage exactly as before', () => {
    const r = receiver()
    const a = getManTarget(r, DIR, 55, 1)
    const b = getManTarget(r, DIR, 55, 1, null, BALL_X)
    expect(a).toEqual(b)
  })
})

describe('validation', () => {
  const ROOM = 'man-commit-room'
  const socket = { id: 'd', data: { roomId: ROOM, role: 'defense' } }
  const base = { playerId: 'cb1', type: 'man', targetId: 'wr1' }

  function game() {
    deleteGame(ROOM)
    const s = initGame(ROOM, 0)
    s.phase = PHASE.PRE_SNAP
    return s
  }

  it('accepts each of the four commitments', () => {
    game()
    for (const c of ['in', 'out', 'over', 'under']) {
      expect(validateAssignCoverage(socket, { ...base, manCommit: c })).toBeNull()
    }
  })

  it('accepts man with no commitment at all', () => {
    game()
    expect(validateAssignCoverage(socket, base)).toBeNull()
    expect(validateAssignCoverage(socket, { ...base, manCommit: null })).toBeNull()
  })

  it('rejects anything else rather than storing it', () => {
    game()
    expect(validateAssignCoverage(socket, { ...base, manCommit: 'sideways' })).toMatch(/man commit/)
  })
})
