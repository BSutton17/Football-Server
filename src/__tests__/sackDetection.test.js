import { describe, it, expect } from '@jest/globals'
import { runSackDetection }        from '../game/systems/sackDetection.js'

// getLosY: dir=+1, yardLine=25 → losY = 10 + 25 = 35
// QB behind LOS: qb.y < 35. Place QB at y=30 → yardsBehind = (35-30)*1 = 5 ≥ 0 ✓
// QB past  LOS:  qb.y > 35. Place QB at y=40 → yardsBehind = (35-40)*1 = -5 < 0 ✓

function makeMap(players) {
  const m = new Map()
  for (const p of players) m.set(p.id, p)
  return m
}

function makeState({ offense = [], defense = [], dir = 1, yardLine = 25, sackEnqueued = false } = {}) {
  return {
    direction:      dir,
    yardLine,
    offensePlayers: makeMap(offense),
    defensePlayers: makeMap(defense),
    sackEnqueued,
    roomId:         'TEST_ROOM',
  }
}

function qb(y = 30, x = 26) {
  return { id: 'qb', label: 'QB', x, y }
}

// Place a defender at exactly `dist` yards north of the QB
function defAt(dist, id = 'd1') {
  return { id, label: 'DL', x: 26, y: 30 + dist }
}

// ── Guard: sackEnqueued already set ──────────────────────────────────────────

describe('sackEnqueued guard', () => {
  it('does nothing when sackEnqueued is already true', () => {
    const state = makeState({
      offense:      [qb()],
      defense:      [defAt(0.5)],   // close enough to sack
      sackEnqueued: true,
    })

    runSackDetection(state, null, 0.05)

    // sackEnqueued should remain true — no double-fire
    expect(state.sackEnqueued).toBe(true)
  })
})

// ── Early exits ───────────────────────────────────────────────────────────────

describe('early exits without a sack', () => {
  it('no QB on field → sackEnqueued stays false', () => {
    const state = makeState({ defense: [defAt(0.5)] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(false)
  })

  it('QB past the LOS → no sack possible', () => {
    // dir=+1, losY=35. QB at y=40 → yardsBehind = (35-40) < 0
    const q  = qb(40)
    const d  = { id: 'd1', label: 'DL', x: 26, y: 40.5 }   // 0.5 yards away
    const state = makeState({ offense: [q], defense: [d] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(false)
  })

  it('QB at LOS (not behind) → no sack (yardsBehind = 0, allowed)', () => {
    // yardsBehind = 0 is >= 0 so the check passes — sack CAN happen at LOS
    const q = qb(35)  // QB exactly at losY
    const d = defAt(0.5)
    // manually place defender next to qb
    d.y = 35.5
    const state = makeState({ offense: [q], defense: [d] })

    runSackDetection(state, null, 0.05)

    // yardsBehind = (35-35)*1 = 0, not < 0 → sack detection runs → defender is close
    expect(state.sackEnqueued).toBe(true)
  })
})

// ── Sack radius detection ─────────────────────────────────────────────────────

describe('sack radius detection (touching = CONTACT_RADIUS 1.5 yd)', () => {
  it('defender beyond contact range → sackEnqueued stays false', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(1.6)] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(false)
  })

  it('defender at the contact distance → sack triggered', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(1.5)] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(true)
  })

  it('defender inside 1 yard → sack triggered', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(0.5)] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(true)
  })

  it('defender directly on top of QB → sack triggered', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(0.0)] })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(true)
  })
})

// ── Second call with sackEnqueued = true doesn't re-fire ─────────────────────

describe('one sack per play', () => {
  it('a second call after sack fires does not reset or re-enqueue', () => {
    const state = makeState({ offense: [qb()], defense: [defAt(0.5)] })

    runSackDetection(state, null, 0.05)
    expect(state.sackEnqueued).toBe(true)

    // Simulate another tick
    runSackDetection(state, null, 0.05)
    expect(state.sackEnqueued).toBe(true)  // unchanged
  })
})

// ── Direction = -1 (offense going south) ─────────────────────────────────────

describe('direction = -1 (offense advancing southward)', () => {
  // dir=-1, yardLine=25 → losY = 110 - 25 = 85
  // QB behind LOS: qb.y > 85. QB at y=90 → yardsBehind = (85-90)*(-1) = 5 ≥ 0 ✓

  it('triggers sack when QB is behind the southward LOS', () => {
    const q = { id: 'qb', label: 'QB', x: 26, y: 90 }
    const d = { id: 'd1', label: 'DL', x: 26, y: 90.5 }   // 0.5 yards away
    const state = makeState({ offense: [q], defense: [d], dir: -1 })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(true)
  })

  it('no sack when QB is past the southward LOS', () => {
    // dir=-1, losY=85. QB at y=80 → yardsBehind = (85-80)*(-1) = -5 < 0
    const q = { id: 'qb', label: 'QB', x: 26, y: 80 }
    const d = { id: 'd1', label: 'DL', x: 26, y: 80.5 }
    const state = makeState({ offense: [q], defense: [d], dir: -1 })

    runSackDetection(state, null, 0.05)

    expect(state.sackEnqueued).toBe(false)
  })
})
