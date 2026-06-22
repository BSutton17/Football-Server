import { describe, it, expect, beforeEach } from '@jest/globals'
import { detectEngagements, isBlocker, ENGAGEMENT_RADIUS } from '../game/utils/engagementZone.js'
import { runEngagement, ENGAGED_SPEED_MULT } from '../game/systems/engagement.js'

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [] } = {}) {
  return {
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
  }
}

// Place a blocker and a defender at a given center-to-center separation.
function atSep(sep) {
  const blocker  = { id: 'b1', label: 'OL', x: 26,       y: 60, vx: 0, vy: 0 }
  const defender = { id: 'd1', label: 'DL', x: 26 + sep, y: 60, vx: 0, vy: 0 }
  return { blocker, defender }
}

// ── isBlocker ─────────────────────────────────────────────────────────────────

describe('isBlocker', () => {
  it('returns true for linemen labels', () => {
    for (const label of ['OL', 'C', 'G', 'T']) {
      expect(isBlocker({ label })).toBe(true)
    }
  })

  it('returns true for TE/RB assigned the block route', () => {
    expect(isBlocker({ label: 'TE', route: 'block' })).toBe(true)
    expect(isBlocker({ label: 'RB', route: 'block' })).toBe(true)
  })

  it('returns false for route runners not blocking', () => {
    expect(isBlocker({ label: 'WR', route: 'go' })).toBe(false)
    expect(isBlocker({ label: 'TE', route: 'seam' })).toBe(false)
  })

  it('returns false for skill positions with no route', () => {
    expect(isBlocker({ label: 'QB' })).toBe(false)
    expect(isBlocker({ label: 'WR' })).toBe(false)
  })

  it('returns false for defensive labels', () => {
    expect(isBlocker({ label: 'DL' })).toBe(false)
    expect(isBlocker({ label: 'CB' })).toBe(false)
  })

  it('WR and TE become blockers on a run play ([priority 4])', () => {
    expect(isBlocker({ label: 'WR', route: 'go' }, 'run')).toBe(true)
    expect(isBlocker({ label: 'TE', route: 'seam' }, 'run')).toBe(true)
  })

  it('WR and TE are NOT auto-blockers on a pass play', () => {
    expect(isBlocker({ label: 'WR', route: 'go' }, 'pass')).toBe(false)
    expect(isBlocker({ label: 'TE', route: 'seam' }, 'pass')).toBe(false)
  })
})

describe('detectEngagements — run-play perimeter blocking ([priority 4])', () => {
  it('a WR within range of a defender engages on a run, but not on a pass', () => {
    const wr  = { id: 'wr', label: 'WR', route: 'go', x: 26, y: 50 }
    const def = { id: 'cb', label: 'CB', x: 26, y: 51 }   // ~1 yd away, inside ENGAGEMENT_RADIUS
    expect(detectEngagements(makeMap([wr]), makeMap([def]), 'run')).toHaveLength(1)
    expect(detectEngagements(makeMap([wr]), makeMap([def]), 'pass')).toHaveLength(0)
  })
})

// ── detectEngagements ─────────────────────────────────────────────────────────

describe('detectEngagements', () => {
  it('returns empty when there are no players', () => {
    expect(detectEngagements(new Map(), new Map())).toHaveLength(0)
  })

  it('returns empty when no blockers are present', () => {
    const off = makeMap([{ id: 'wr1', label: 'WR', route: 'go', x: 26, y: 60 }])
    const def = makeMap([{ id: 'd1',  label: 'CB',               x: 26.5, y: 60 }])
    expect(detectEngagements(off, def)).toHaveLength(0)
  })

  it('detects a blocker within the engagement radius', () => {
    const { blocker, defender } = atSep(ENGAGEMENT_RADIUS - 0.1)
    const result = detectEngagements(makeMap([blocker]), makeMap([defender]))
    expect(result).toHaveLength(1)
  })

  it('does not detect a pair beyond the engagement radius', () => {
    const { blocker, defender } = atSep(ENGAGEMENT_RADIUS + 0.1)
    const result = detectEngagements(makeMap([blocker]), makeMap([defender]))
    expect(result).toHaveLength(0)
  })

  it('does not detect at exactly the engagement radius boundary', () => {
    // d2 <= r2 is the check — strictly equal is still "in zone"
    const { blocker, defender } = atSep(ENGAGEMENT_RADIUS)
    const result = detectEngagements(makeMap([blocker]), makeMap([defender]))
    expect(result).toHaveLength(1)  // equal distance is counted as engaged
  })

  it('returns the offense and defense player references', () => {
    const { blocker, defender } = atSep(1.0)
    const [entry] = detectEngagements(makeMap([blocker]), makeMap([defender]))
    expect(entry.offense).toBe(blocker)
    expect(entry.defense).toBe(defender)
  })

  it('includes dist in the result', () => {
    const { blocker, defender } = atSep(1.5)
    const [entry] = detectEngagements(makeMap([blocker]), makeMap([defender]))
    expect(entry.dist).toBeCloseTo(1.5, 5)
  })

  it('detects multiple engagements when several pairs are in range', () => {
    const ol1 = { id: 'ol1', label: 'OL', x: 22, y: 60 }
    const ol2 = { id: 'ol2', label: 'OL', x: 30, y: 60 }
    const dl1 = { id: 'dl1', label: 'DL', x: 22.5, y: 60 }  // near ol1
    const dl2 = { id: 'dl2', label: 'DL', x: 30.5, y: 60 }  // near ol2
    const result = detectEngagements(makeMap([ol1, ol2]), makeMap([dl1, dl2]))
    expect(result).toHaveLength(2)
  })

  it('detects one-to-many: one blocker engaging two close defenders', () => {
    const blocker = { id: 'ol1', label: 'OL', x: 26, y: 60 }
    const dl1     = { id: 'dl1', label: 'DL', x: 26.5, y: 60 }
    const dl2     = { id: 'dl2', label: 'DL', x: 26, y: 60.5 }
    const result = detectEngagements(makeMap([blocker]), makeMap([dl1, dl2]))
    expect(result).toHaveLength(2)
  })

  it('TE assigned block route is counted as a blocker', () => {
    const te  = { id: 'te1', label: 'TE', route: 'block', x: 26, y: 60 }
    const def = { id: 'd1',  label: 'LB',                 x: 26.5, y: 60 }
    const result = detectEngagements(makeMap([te]), makeMap([def]))
    expect(result).toHaveLength(1)
  })

  it('TE NOT assigned block route is not counted as a blocker', () => {
    const te  = { id: 'te1', label: 'TE', route: 'seam', x: 26, y: 60 }
    const def = { id: 'd1',  label: 'LB',                x: 26.5, y: 60 }
    const result = detectEngagements(makeMap([te]), makeMap([def]))
    expect(result).toHaveLength(0)
  })
})

// ── runEngagement ─────────────────────────────────────────────────────────────

describe('runEngagement', () => {
  it('sets isEngaged=true and engagedWithId on both players when in zone', () => {
    const { blocker, defender } = atSep(1.0)
    const state = makeState({ offense: [blocker], defense: [defender] })

    runEngagement(state, null, 0.05)

    expect(blocker.isEngaged).toBe(true)
    expect(blocker.engagedWithId).toBe('d1')
    expect(defender.isEngaged).toBe(true)
    expect(defender.engagedWithId).toBe('b1')
  })

  it('leaves isEngaged=false for players outside the zone', () => {
    const { blocker, defender } = atSep(ENGAGEMENT_RADIUS + 1)
    const state = makeState({ offense: [blocker], defense: [defender] })

    runEngagement(state, null, 0.05)

    expect(blocker.isEngaged).toBe(false)
    expect(defender.isEngaged).toBe(false)
  })

  it('clears stale engagement when players move out of range', () => {
    const { blocker, defender } = atSep(1.0)
    blocker.isEngaged     = true
    blocker.engagedWithId = 'd1'
    defender.isEngaged    = true
    defender.engagedWithId = 'b1'

    // Now move them apart before the tick
    defender.x = blocker.x + ENGAGEMENT_RADIUS + 1
    const state = makeState({ offense: [blocker], defense: [defender] })

    runEngagement(state, null, 0.05)

    expect(blocker.isEngaged).toBe(false)
    expect(defender.isEngaged).toBe(false)
  })

  it('leaves route runners unengaged even when near a defender', () => {
    const wr  = { id: 'wr1', label: 'WR', route: 'go', x: 26, y: 60 }
    const def = { id: 'd1',  label: 'CB',               x: 26.5, y: 60 }
    const state = makeState({ offense: [wr], defense: [def] })

    runEngagement(state, null, 0.05)

    expect(wr.isEngaged).toBe(false)
    expect(def.isEngaged).toBe(false)
  })

  it('ENGAGED_SPEED_MULT is less than 1 (slows engaged players)', () => {
    expect(ENGAGED_SPEED_MULT).toBeGreaterThan(0)
    expect(ENGAGED_SPEED_MULT).toBeLessThan(1)
  })

  it('preserves engagedWithId as the first engaging opponent when double-teamed', () => {
    // One defender engaged by two blockers — defender's engagedWithId stays as first blocker
    const ol1 = { id: 'ol1', label: 'OL', x: 25.8, y: 60 }
    const ol2 = { id: 'ol2', label: 'OL', x: 26.2, y: 60 }
    const def = { id: 'd1',  label: 'DL', x: 26, y: 60 }
    const state = makeState({ offense: [ol1, ol2], defense: [def] })

    runEngagement(state, null, 0.05)

    expect(def.isEngaged).toBe(true)
    // The first match is recorded; subsequent ones don't overwrite
    expect(['ol1', 'ol2']).toContain(def.engagedWithId)
  })
})
