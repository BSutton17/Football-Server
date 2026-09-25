import { describe, it, expect } from '@jest/globals'
import { recommendOffense, recommendDefense, classifyShell } from '../ai/playcall/recommend.js'

// [authored] The AI's own read, handed to the player as a shortlist.

// A play is only ever read for its route depths, so the fixtures carry just those.
const pass = (id, formationId, depth, name = id) => ({
  [id]: { name, formationId, playType: 'pass', assignments: { WR1: { kind: 'route', points: [{ dd: depth }] } } },
})
const run = (id, formationId) => ({ [id]: { name: id, formationId, playType: 'run', assignments: {} } })

const book = {
  formations: {
    trips: { name: 'TRIPS' }, bunch: { name: 'BUNCH' }, empty: { name: 'EMPTY' }, gun: { name: 'GUN' },
  },
  plays: {
    ...pass('quick', 'trips', 4),
    ...pass('medium', 'bunch', 9),
    ...pass('deep', 'empty', 20),
    ...pass('shot', 'gun', 30),
    ...run('inside', 'trips'),
  },
  defFormations: { base: { name: '4-3' }, nickel: { name: 'NICKEL' } },
  shells: {
    cover2:  { name: 'COVER 2',  formationId: 'base',   personnel: { CB: 2, S: 2 }, assignments: j({ rush: 4, zone: 7 }) },
    cover1:  { name: 'COVER 1',  formationId: 'nickel', personnel: { CB: 3, S: 2 }, assignments: j({ rush: 4, man: 5, zone: 2 }) },
    fire:    { name: 'FIRE X',   formationId: 'base',   personnel: { CB: 2, S: 2 }, assignments: j({ rush: 6, man: 5 }) },
  },
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
    const out = recommendOffense(book, sit(4, 1, 98))
    expect(out[0].id).toBe('quick')
    expect(out.map(o => o.id)).not.toContain('shot')
  })

  it('⚠️ RANKS THE LEAST BAD WHEN EVERY ROUTE RUNS OUT OF FIELD', () => {
    // A flat floor ties them all, and a tie falls back to playbook order — which is how the
    // deepest concept in the book stayed top of the goal-line menu.
    const deepOnly = { ...book, plays: { ...pass('a', 'trips', 18), ...pass('b', 'bunch', 30) } }
    expect(recommendOffense(deepOnly, sit(3, 1, 99))[0].id).toBe('a')
  })

  it('asks for the sticks on 3rd and long, not a checkdown', () => {
    const out = recommendOffense(book, sit(3, 18, 40))
    expect(out[0].depth).toBeGreaterThan(10)
  })

  it('asks for something short on 3rd and 1', () => {
    expect(recommendOffense(book, sit(3, 1, 50))[0].id).toBe('quick')
  })

  it('changes its answer when the situation changes — the bug that started this', () => {
    const shortYardage = recommendOffense(book, sit(3, 1, 50)).map(o => o.id).join()
    const longYardage  = recommendOffense(book, sit(3, 18, 40)).map(o => o.id).join()
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
})

describe('the defensive shortlist', () => {
  const look = { id: '3wr1te1rb', wr: 3, te: 1, rb: 1 }

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
