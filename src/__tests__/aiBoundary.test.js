import { describe, it, expect } from '@jest/globals'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

// [offline] The information boundary, enforced by reading the source rather than by trusting it.
//
// The standing rule of this codebase is that the defense never sees the play call. For a human
// that is guaranteed by the network: the server simply never sends it. For an AI running INSIDE
// the server, nothing physical stops it reaching into the game state — so the guarantee has to be
// structural, and this is where that structure is checked.
//
// The shape: `knowledge.js` is the only module allowed to turn received events into a picture, and
// `controller.js` is the only one allowed to act. Everything between them is a pure function over
// a Knowledge object, and a pure function cannot cheat no matter who writes it later.
//
// If this test fails, do not widen the allowlist to make it pass. Ask instead whether a human
// player would be told the same thing — and if so, emit it to both sides.

const AI_DIR = join(process.cwd(), 'src', 'ai')

// Modules permitted to import the game itself. Deliberately tiny, and asserted to STAY tiny.
const MAY_TOUCH_THE_GAME = new Set([
  'solo.js',        // stands the room up: creates it, seats the AI, starts team selection
  'seats.js',       // the emit bridge — needs nothing from the game, but may resolve rooms
  'timing.js',      // solo pre-snap timing, stored on the game state
  'controller.js',  // the one writer
  'roster.js',      // the computer's players
])

// Imports that would give a module a way to read the live game directly.
const GAME_IMPORTS = /from\s+'\.\.\/(game|data)\//

function listAi(dir = AI_DIR, prefix = '') {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) { out.push(...listAi(full, prefix + entry + '/')); continue }
    if (entry.endsWith('.js')) out.push({ name: prefix + entry, path: full, src: readFileSync(full, 'utf8') })
  }
  return out
}

const FILES = listAi()

describe('the AI information boundary', () => {
  it('finds the ai/ modules at all (a passing test over an empty list proves nothing)', () => {
    expect(FILES.length).toBeGreaterThanOrEqual(8)
    expect(FILES.map(f => f.name)).toEqual(expect.arrayContaining(['knowledge.js', 'controller.js', 'defense.js', 'offense.js']))
  })

  it('only the named modules may import the game', () => {
    for (const f of FILES) {
      const touches = GAME_IMPORTS.test(f.src)
      const allowed = MAY_TOUCH_THE_GAME.has(f.name)
      expect({ file: f.name, touchesGame: touches && !allowed })
        .toEqual({ file: f.name, touchesGame: false })
    }
  })

  it('the allowlist stays small — widening it is the thing to notice', () => {
    expect(MAY_TOUCH_THE_GAME.size).toBe(5)
  })

  it('no decision module can reach the live game state', () => {
    // These are the files that actually CHOOSE things. None of them may read a game object, so
    // none of them can see a route, a play call or a coverage assignment.
    const deciders = ['knowledge.js', 'defense.js', 'offense.js', 'assignments.js', 'specialTeams.js',
      'playbook/coverages.js', 'playbook/concepts.js', 'playbook/formations.js']
    for (const name of deciders) {
      const f = FILES.find(x => x.name === name)
      expect({ name, found: !!f }).toEqual({ name, found: true })
      for (const forbidden of ['getGame', 'playDesign', 'defenseCoverage', 'offensePlayers', 'defensePlayers']) {
        expect({ name, forbidden, present: f.src.includes(forbidden) })
          .toEqual({ name, forbidden, present: false })
      }
    }
  })

  it('nothing in ai/ calls Math.random — a seeded game must stay reproducible', () => {
    // solo.js is the one exception, and it is the right one: picking a FRESH SEED for a game that
    // was not given one is the single place randomness must NOT be seeded. Seeding the seed
    // generator would make every offline game play out identically.
    const SEED_PICKER = 'solo.js'
    for (const f of FILES) {
      if (f.name === SEED_PICKER) continue
      // A `rng = Math.random` DEFAULT is fine: it only fires when no stream was supplied, the same
      // contract the sim's own systems use. A bare call is not.
      const bare = f.src.replace(/rng\s*=\s*Math\.random/g, '').includes('Math.random')
      expect({ file: f.name, bareRandom: bare }).toEqual({ file: f.name, bareRandom: false })
    }
    // …and the exception is exactly one call, in the function that names itself.
    const solo = FILES.find(f => f.name === SEED_PICKER)
    const bareCalls = (solo.src.replace(/rng\s*=\s*Math\.random/g, '').match(/Math\.random/g) ?? []).length
    expect(bareCalls).toBe(1)
    expect(solo.src).toMatch(/function freshSeed/)
  })

  it('the knowledge object carries no field a human would not be sent', () => {
    const k = FILES.find(f => f.name === 'knowledge.js')
    // The shape is the guarantee: if there is no field for it, there is nothing to leak.
    for (const forbidden of ['route', 'playType', 'coverage', 'runAngle', 'concept']) {
      const declared = new RegExp('^\\s*' + forbidden + ':', 'mi').test(k.src)
      expect({ forbidden, declared }).toEqual({ forbidden, declared: false })
    }
  })
})
