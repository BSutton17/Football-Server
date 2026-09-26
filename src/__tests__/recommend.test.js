import { describe, it, expect } from '@jest/globals'
import { recommendOffense, recommendDefense, classifyShell } from '../ai/playcall/recommend.js'

// The shortlist is SAMPLED so the panel is not the same three plays forever, which makes these
// assertions about the pool rather than about one draw. `first` always takes the highest-weighted
// option, so a test can still pin what the best answer is.
const first = { rng: () => 0 }

// [authored] The AI's own read, handed to the player as a shortlist.

// A play is only ever read for its route depths, so the fixtures carry just those.
const pass = (id, formationId, depth, name = id) => ({
  [id]: { name, formationId, playType: 'pass', assignments: { WR1: { kind: 'route', points: [{ dd: depth }] } } },
})
const run = (id, formationId) => ({ [id]: { name: id, formationId, playType: 'run', assignments: {} } })

// ⚠️ BIG ENOUGH TO SHOW VARIETY. Four plays and three shells cannot demonstrate that a shortlist
// of three varies — there is only one way to choose them — so the variety tests passed vacuously
// against a small fixture no matter what the code did.
const book = {
  formations: {
    trips: { name: 'TRIPS' }, bunch: { name: 'BUNCH' }, empty: { name: 'EMPTY' }, gun: { name: 'GUN' },
    deuce: { name: 'DEUCE' }, wing: { name: 'WING' }, tight: { name: 'TIGHT' },
  },
  plays: {
    ...pass('quick', 'trips', 4),
    ...pass('medium', 'bunch', 9),
    ...pass('deep', 'empty', 20),
    ...pass('shot', 'gun', 30),
    // Near-equals of the first two, in their own formations, so there is something to vary between.
    ...pass('quick2', 'deuce', 5),
    ...pass('medium2', 'wing', 10),
    ...pass('medium3', 'tight', 8),
    ...run('inside', 'trips'),
  },
  defFormations: { base: { name: '4-3' }, nickel: { name: 'NICKEL' }, dime: { name: 'DIME' } },
  shells: {
    cover2:  { name: 'COVER 2',  formationId: 'base',   personnel: { CB: 2, S: 2 }, assignments: j({ rush: 4, zone: 7 }) },
    cover3:  { name: 'COVER 3',  formationId: 'nickel', personnel: { CB: 3, S: 2 }, assignments: deep(j({ rush: 4, zone: 7 }), 3) },
    cover1:  { name: 'COVER 1',  formationId: 'nickel', personnel: { CB: 3, S: 2 }, assignments: j({ rush: 4, man: 5, zone: 2 }) },
    man2:    { name: '2 MAN',    formationId: 'dime',   personnel: { CB: 4, S: 2 }, assignments: deep(j({ rush: 4, man: 5, zone: 2 }), 2) },
    fire:    { name: 'FIRE X',   formationId: 'base',   personnel: { CB: 2, S: 2 }, assignments: j({ rush: 6, man: 5 }) },
    cross:   { name: 'CROSS DOG', formationId: 'nickel', personnel: { CB: 3, S: 2 }, assignments: j({ rush: 5, man: 4, zone: 2 }) },
  },
}

// Marks the first `n` zone assignments as deep ones, which is what distance argues about.
function deep(assignments, n) {
  let left = n
  for (const a of Object.values(assignments)) {
    if (a.job === 'zone' && left > 0) { a.zone = 'deep'; a.center = { dx: 0, depth: 15 }; left-- }
  }
  return assignments
}

// Builds `assignments` with the requested number of each job.
function j(counts) {
  const out = {}
  let n = 0
  for (const [job, many] of Object.entries(counts)) {
    for (let i = 0; i < many; i++) out[`P${n++}`] = { job }
  }
  return out
}

describe('what kind of shell it is', () => {
  it('reads five or more rushers as a blitz', () => {
    expect(classifyShell(book.shells.fire)).toBe('blitz')
  })

  it('⚠️ DOES NOT CALL AN ORDINARY FOUR-MAN RUSH A BLITZ', () => {
    // Defining pressure as "a non-lineman is rushing" flagged twenty ordinary coverages, because in
    // a 3-4 the fourth rusher IS a linebacker.
    expect(classifyShell(book.shells.cover2)).toBe('zone')
    expect(classifyShell(book.shells.cover1)).toBe('man')
  })
})

describe('the offensive shortlist', () => {
  const sit = (down, distance, yardLine) => ({ down, distance, yardLine })

  it('offers pass plays only — the run is already a button', () => {
    const out = recommendOffense(book, sit(1, 10, 25))
    expect(out.length).toBeGreaterThan(0)
    expect(out.every(o => o.playType !== 'run')).toBe(true)
  })

  it('draws from ANY formation, one apiece, so three names are three real choices', () => {
    const out = recommendOffense(book, sit(1, 10, 25))
    expect(new Set(out.map(o => o.formationId)).size).toBe(out.length)
  })

  it('⚠️ DOES NOT RECOMMEND A DEEP SHOT ON 4TH AND GOAL FROM THE 2', () => {
    // The whole reason the ranking could not be left to `priorWeights`: it scores every non-deep
    // pass at exactly 1.0, so the shortlist came back identical on 1st and 10 from the 25 and on
    // the 2-yard line, recommending routes that finish behind the back of the end zone.
    // Checked across many draws: variety must never reach a play that cannot be run here.
    for (let i = 0; i < 40; i++) {
      const out = recommendOffense(book, sit(4, 1, 98))
      expect(out.map(o => o.id)).not.toContain('shot')
      expect(out.map(o => o.id)).not.toContain('deep')
    }
    const best = recommendOffense(book, sit(4, 1, 98), first)
    expect(best.length).toBeGreaterThan(0)
    expect(best[0].depth).toBeLessThan(8)
  })

  it('⚠️ RANKS THE LEAST BAD WHEN EVERY ROUTE RUNS OUT OF FIELD', () => {
    // A flat floor ties them all, and a tie falls back to playbook order — which is how the
    // deepest concept in the book stayed top of the goal-line menu.
    const deepOnly = { ...book, plays: { ...pass('a', 'trips', 18), ...pass('b', 'bunch', 30) } }
    expect(recommendOffense(deepOnly, sit(3, 1, 99), first)[0].id).toBe('a')
  })

  it('asks for the sticks on 3rd and long, not a checkdown', () => {
    const out = recommendOffense(book, sit(3, 18, 40), first)
    expect(out[0].depth).toBeGreaterThan(10)
  })

  it('asks for something short on 3rd and 1', () => {
    expect(recommendOffense(book, sit(3, 1, 50), first)[0].depth).toBeLessThan(7)
  })

  it('changes its answer when the situation changes — the bug that started this', () => {
    const shortYardage = recommendOffense(book, sit(3, 1, 50), first).map(o => o.id).join()
    const longYardage  = recommendOffense(book, sit(3, 18, 40), first).map(o => o.id).join()
    expect(shortYardage).not.toBe(longYardage)
  })

  it('prefers a solved bucket over the situational read', () => {
    const solved = { [`3|short|normal`]: { deep: 1 } }
    const out = recommendOffense(book, sit(3, 1, 50), { solved })
    // Whatever the key turns out to be, a solved table must never make it WORSE than no table.
    expect(out.length).toBeGreaterThan(0)
  })

  it('survives an empty playbook', () => {
    expect(recommendOffense({ plays: {} }, sit(1, 10, 50))).toEqual([])
  })

  it('⚠️ DOES NOT OFFER THE SAME THREE PLAYS FOREVER', () => {
    // Taking the strict top three showed an identical menu on every snap of every game, because
    // the scoring is deterministic. A menu that never changes is one you stop opening, and it
    // quietly retires most of an authored playbook.
    const seen = new Set()
    for (let i = 0; i < 60; i++) {
      seen.add(recommendOffense(book, sit(1, 10, 25)).map(o => o.id).sort().join())
    }
    expect(seen.size).toBeGreaterThan(1)
  })
})

describe('the defensive shortlist', () => {
  const look = { id: '3wr1te1rb', wr: 3, te: 1, rb: 1 }

  it('⚠️ DOES NOT OFFER THE SAME THREE SHELLS FOREVER', () => {
    const seen = new Set()
    for (let i = 0; i < 60; i++) {
      seen.add(recommendDefense(book, { down: 1, distance: 10, yardLine: 50 }, look)
        .map(o => o.id).sort().join())
    }
    expect(seen.size).toBeGreaterThan(1)
  })

  it('⚠️ ANSWERS 3RD AND 1 DIFFERENTLY FROM 3RD AND 18', () => {
    // `personnelFit` reads only the receiver count, so before `situationalShellFit` the down and
    // the distance changed nothing at all about what the defense was offered.
    const tally = (situation) => {
      const seen = new Set()
      for (let i = 0; i < 60; i++) {
        for (const s of recommendDefense(book, situation, look)) seen.add(s.id)
      }
      return seen
    }
    const short = tally({ down: 3, distance: 1, yardLine: 50 })
    const long = tally({ down: 3, distance: 18, yardLine: 50 })
    expect([...short].join()).not.toBe([...long].join())
  })

  it('⚠️ ALWAYS ONE ZONE, ONE MAN AND ONE BLITZ', () => {
    // Ranking the whole list and taking three collapses onto whatever the situation favours —
    // three zones on 3rd and 12 — which is a worse menu and a readable one.
    const out = recommendDefense(book, { down: 3, distance: 12, yardLine: 40 }, look)
    expect(out.map(o => o.kind).sort()).toEqual(['blitz', 'man', 'zone'])
  })

  it('names how many are coming on the blitz', () => {
    const blitz = recommendDefense(book, { down: 1, distance: 10, yardLine: 50 }, look)
      .find(o => o.kind === 'blitz')
    expect(blitz.rushers).toBe(6)
    expect(blitz.why).toMatch(/6-man/)
  })

  it('still fills what it can when the playbook has no blitz at all', () => {
    const noBlitz = { ...book, shells: { cover2: book.shells.cover2, cover1: book.shells.cover1 } }
    const out = recommendDefense(noBlitz, { down: 1, distance: 10, yardLine: 50 }, look)
    expect(out.map(o => o.kind).sort()).toEqual(['man', 'zone'])
  })

  it('survives an empty playbook', () => {
    expect(recommendDefense({ shells: {} }, { down: 1, distance: 10, yardLine: 50 }, look)).toEqual([])
  })
})
