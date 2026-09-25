import { describe, it, expect, beforeEach, afterAll } from '@jest/globals'
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadPlaybook, savePlaybook, upsert, remove, createFormation, auditPlaybook, slugify,
  listBackups, restoreBackup,
} from '../playbook/store.js'
import { isDevPlaybookEnabled, isLocalRequest, createPlaybookDevRouter } from '../playbook/devRoutes.js'
import { emptyPlaybook } from '../ai/playbook/authored.js'

// [authored] Persistence for the play sandbox. The file lives in the repo, so training reads it
// directly and it ships with the game.

const dir = mkdtempSync(join(tmpdir(), 'playbook-'))
const PATH = join(dir, 'authored.json')
afterAll(() => rmSync(dir, { recursive: true, force: true }))

const deuce = {
  name: 'Deuce',
  category: 'gun',
  spots: [
    { slot: 'WR1', dx: -14, depth: 0 }, { slot: 'WR2', dx: -6, depth: 1 },
    { slot: 'WR3', dx: 14, depth: 0 }, { slot: 'TE1', dx: 6, depth: 0 },
    { slot: 'RB1', dx: -3, depth: 6 },
  ],
}
const mesh = {
  name: 'Mesh Right', formationId: 'deuce', playType: 'pass',
  assignments: { WR1: { kind: 'route', points: [{ dx: 0, dd: 5 }] } },
}

beforeEach(() => savePlaybook(emptyPlaybook(), PATH, { allowWipe: true }))

describe('saving and loading', () => {
  it('starts empty rather than exploding when there is no file yet', () => {
    expect(loadPlaybook(join(dir, 'nope.json'))).toEqual(emptyPlaybook())
  })

  it('names ids after the play, so the file reads like a playbook', () => {
    expect(slugify('U Off Trips Wk')).toBe('u_off_trips_wk')
    const r = upsert('formations', deuce, { path: PATH })
    expect(r).toMatchObject({ ok: true, id: 'deuce' })
  })

  it('does not let two things collide on one id', () => {
    upsert('formations', deuce, { path: PATH })
    const second = upsert('formations', { ...deuce, spots: [...deuce.spots] }, { path: PATH })
    expect(second.id).toBe('deuce_2')
    expect(Object.keys(loadPlaybook(PATH).formations)).toEqual(['deuce', 'deuce_2'])
  })

  it('⚠️ KEEPS THE ID ON EDIT, which is what stops an edit orphaning its plays', () => {
    upsert('formations', deuce, { path: PATH })
    upsert('plays', mesh, { path: PATH })
    // Rename it and move a receiver — the id must not follow the new name.
    const edited = { ...deuce, name: 'Deuce Wide', spots: deuce.spots.map(s => (s.slot === 'WR1' ? { ...s, dx: -18 } : s)) }
    const r = upsert('formations', edited, { id: 'deuce', path: PATH })
    expect(r.id).toBe('deuce')
    const book = loadPlaybook(PATH)
    expect(book.formations.deuce.name).toBe('Deuce Wide')
    expect(book.plays.mesh_right.formationId).toBe('deuce')
    expect(auditPlaybook(book).ok).toBe(true)
  })

  it('refuses to write something invalid', () => {
    const r = upsert('formations', { ...deuce, category: 'wildcat' }, { path: PATH })
    expect(r.ok).toBe(false)
    expect(r.errors.join(' ')).toMatch(/category must be/)
    // And nothing was written.
    expect(loadPlaybook(PATH).formations).toEqual({})
  })

  it('refuses a play whose formation does not exist', () => {
    expect(upsert('plays', mesh, { path: PATH }).ok).toBe(false)
  })

  it('writes atomically and leaves no temp file behind', () => {
    upsert('formations', deuce, { path: PATH })
    expect(existsSync(`${PATH}.tmp`)).toBe(false)
    expect(JSON.parse(readFileSync(PATH, 'utf8')).formations.deuce.name).toBe('Deuce')
  })

  it('refuses to start from empty when the file is damaged', () => {
    // Silently starting fresh would look like the library vanished, and the next save would
    // overwrite the damaged file with nothing — taking hours of drawing with it.
    writeFileSync(PATH, '{ this is not json')
    expect(() => loadPlaybook(PATH)).toThrow(/unreadable/)
  })
})

describe('deleting', () => {
  it('⚠️ REFUSES to delete a formation that still has plays, and says which', () => {
    upsert('formations', deuce, { path: PATH })
    upsert('plays', mesh, { path: PATH })
    const r = remove('formations', 'deuce', { path: PATH })
    expect(r.ok).toBe(false)
    expect(r.dependents).toEqual(['Mesh Right'])
    expect(loadPlaybook(PATH).formations.deuce).toBeTruthy()
  })

  it('takes the plays with it when forced, because an orphan cannot be lined up', () => {
    upsert('formations', deuce, { path: PATH })
    upsert('plays', mesh, { path: PATH })
    expect(remove('formations', 'deuce', { path: PATH, force: true }).ok).toBe(true)
    const book = loadPlaybook(PATH)
    expect(book.formations).toEqual({})
    expect(book.plays).toEqual({})
  })

  it('deletes a play without touching its formation', () => {
    upsert('formations', deuce, { path: PATH })
    upsert('plays', mesh, { path: PATH })
    expect(remove('plays', 'mesh_right', { path: PATH }).ok).toBe(true)
    expect(loadPlaybook(PATH).formations.deuce).toBeTruthy()
  })

  it('says so when there is nothing to delete', () => {
    expect(remove('plays', 'ghost', { path: PATH }).ok).toBe(false)
  })
})

describe('⚠️ the dev API writes files into the repo, so the gate has to hold', () => {
  it('is off in production even when explicitly enabled', () => {
    expect(isDevPlaybookEnabled({ NODE_ENV: 'production', ENABLE_PLAYBOOK_DEV: '1' })).toBe(false)
  })

  it('is off by default — being in dev is not, on its own, consent', () => {
    expect(isDevPlaybookEnabled({ NODE_ENV: 'development' })).toBe(false)
    expect(isDevPlaybookEnabled({})).toBe(false)
  })

  it('is on only when dev AND explicitly asked for', () => {
    expect(isDevPlaybookEnabled({ NODE_ENV: 'development', ENABLE_PLAYBOOK_DEV: '1' })).toBe(true)
  })

  it('serves loopback only — a dev laptop on a café network is not a file server', () => {
    expect(isLocalRequest({ ip: '127.0.0.1' })).toBe(true)
    expect(isLocalRequest({ ip: '::1' })).toBe(true)
    expect(isLocalRequest({ ip: '::ffff:127.0.0.1' })).toBe(true)
    expect(isLocalRequest({ ip: '192.168.1.40' })).toBe(false)
    expect(isLocalRequest({ ip: '203.0.113.9' })).toBe(false)
    expect(isLocalRequest({})).toBe(false)
  })
})

describe('auditing a hand-edited file', () => {
  it('names every problem rather than failing on the first', () => {
    const book = {
      ...emptyPlaybook(),
      formations: { bad: { ...deuce, category: 'wildcat' } },
      shells: { worse: { name: 'Orphan', kind: 'man', formationId: 'gone', assignments: {} } },
    }
    const audit = auditPlaybook(book)
    expect(audit.ok).toBe(false)
    expect(audit.problems).toHaveLength(2)
    expect(audit.problems.join(' ')).toMatch(/formations bad/)
    expect(audit.problems.join(' ')).toMatch(/shells worse/)
  })
})

describe('⚠️ creating a formation creates its RUN play', () => {
  // There is nothing to draw on a run — no routes, and no lane, because the lane is read off the
  // defensive front at the line. Making a person author one by hand per formation is fifteen
  // identical clicks that can only be got wrong.
  it('comes with a run, named after the formation', () => {
    const r = createFormation(deuce, { path: PATH })
    expect(r.ok).toBe(true)
    expect(r.runPlayId).toBe('deuce_run')
    const book = loadPlaybook(PATH)
    expect(book.plays.deuce_run).toMatchObject({ playType: 'run', formationId: 'deuce' })
    expect(book.plays.deuce_run.name).toBe('Deuce Run')
    expect(auditPlaybook(book).ok).toBe(true)
  })

  it('stores no lane on it', () => {
    createFormation(deuce, { path: PATH })
    expect(loadPlaybook(PATH).plays.deuce_run.runAngle).toBeUndefined()
  })

  it('leaves the carrier implied with one back, and names one with two', () => {
    createFormation(deuce, { path: PATH })
    expect(loadPlaybook(PATH).plays.deuce_run.assignments).toEqual({})

    const twoBacks = {
      ...deuce, name: 'Split',
      spots: [...deuce.spots.slice(0, 3), { slot: 'RB1', dx: -3, depth: 6 }, { slot: 'RB2', dx: 3, depth: 6 }],
    }
    createFormation(twoBacks, { path: PATH })
    expect(loadPlaybook(PATH).plays.split_run.assignments).toEqual({ RB1: { kind: 'carry' } })
  })

  it('still creates a formation with no back, and says why there is no run', () => {
    // An empty set has nobody to hand it to. The formation is not rejected for it.
    const empty = {
      name: 'Empty', category: 'gun',
      spots: ['WR1', 'WR2', 'WR3', 'WR4', 'TE1'].map((slot, i) => ({ slot, dx: i * 5 - 12, depth: 0 })),
    }
    const r = createFormation(empty, { path: PATH })
    expect(r.ok).toBe(true)
    expect(r.runPlayId).toBeNull()
    expect(r.runNote).toMatch(/no back/)
    expect(loadPlaybook(PATH).formations.empty).toBeTruthy()
  })

  it('⚠️ does NOT pile up duplicate runs when a formation is EDITED', () => {
    // Editing goes through upsert, not createFormation — otherwise every nudge of a receiver
    // would add another run play.
    createFormation(deuce, { path: PATH })
    upsert('formations', { ...deuce, name: 'Deuce Wide' }, { id: 'deuce', path: PATH })
    upsert('formations', { ...deuce, name: 'Deuce Wider' }, { id: 'deuce', path: PATH })
    expect(Object.keys(loadPlaybook(PATH).plays)).toEqual(['deuce_run'])
  })

  it('does not create the formation at all when it is invalid', () => {
    const r = createFormation({ ...deuce, category: 'wildcat' }, { path: PATH })
    expect(r.ok).toBe(false)
    const book = loadPlaybook(PATH)
    expect(book.formations).toEqual({})
    expect(book.plays).toEqual({})
  })

  it('leaves the run play ordinary — it can be deleted like any other', () => {
    createFormation(deuce, { path: PATH })
    expect(remove('plays', 'deuce_run', { path: PATH }).ok).toBe(true)
    expect(loadPlaybook(PATH).formations.deuce).toBeTruthy()
  })
})

describe('⚠️ the router has to answer a BROWSER, not just curl', () => {
  // The bug this catches: CORS is configured on the Socket.io server and nowhere else, so the
  // HTTP routes returned no Access-Control-Allow-Origin. Every curl test passed -- curl ignores
  // CORS -- while the sandbox page could not reach the API at all. A test that only exercises the
  // handler will never see this; the middleware stack has to be in it.
  const stack = () => {
    const router = createPlaybookDevRouter()
    // express Router keeps its middleware in .stack; the CORS layer must be FIRST, or a rejected
    // preflight never gets the headers that would have let it through.
    return router.stack.map(l => l.name)
  }

  it('mounts CORS, and mounts it before anything can reject the request', () => {
    const names = stack()
    expect(names.length).toBeGreaterThan(2)
    expect(names[0]).toBe('corsMiddleware')
  })

  it('still parses JSON bodies after it', () => {
    expect(stack()).toContain('jsonParser')
  })
})

describe('⚠️ NOT LOSING HOURS OF AUTHORED WORK', () => {
  // This suite exists because a smoke test wrote an empty playbook over the live file and every
  // formation and play the user had authored was gone — not in git, because the commits that
  // followed had already staged the emptied file. Atomic writes protected against a HALF-written
  // file and did nothing whatever about a fully-written wrong one.
  it('REFUSES to replace a populated playbook with an empty one', () => {
    createFormation(deuce, { path: PATH })
    expect(() => savePlaybook(emptyPlaybook(), PATH)).toThrow(/refusing to overwrite/)
    // And the work is still there afterwards.
    expect(Object.keys(loadPlaybook(PATH).formations)).toEqual(['deuce'])
  })

  it('says how to do it on purpose, and lets you', () => {
    createFormation(deuce, { path: PATH })
    expect(() => savePlaybook(emptyPlaybook(), PATH)).toThrow(/allowWipe: true/)
    savePlaybook(emptyPlaybook(), PATH, { allowWipe: true })
    expect(Object.keys(loadPlaybook(PATH).formations)).toEqual([])
  })

  it('backs up before EVERY write, so a bad one is recoverable', () => {
    createFormation(deuce, { path: PATH })
    upsert('formations', { ...deuce, name: 'Trips' }, { path: PATH })
    const saved = listBackups(PATH)
    expect(saved.length).toBeGreaterThan(1)
    // Newest first.
    expect(saved[0].file > saved[1].file).toBe(true)
  })

  it('brings the work back', () => {
    createFormation(deuce, { path: PATH })
    createFormation({ ...deuce, name: 'Trips' }, { path: PATH })
    expect(Object.keys(loadPlaybook(PATH).formations)).toHaveLength(2)

    savePlaybook(emptyPlaybook(), PATH, { allowWipe: true })
    expect(Object.keys(loadPlaybook(PATH).formations)).toHaveLength(0)

    const best = listBackups(PATH).find(b => b.items >= 2)
    expect(best).toBeTruthy()
    const r = restoreBackup(best.file, PATH)
    expect(r.ok).toBe(true)
    expect(Object.keys(loadPlaybook(PATH).formations).sort()).toEqual(['deuce', 'trips'])
  })

  it('makes a RESTORE undoable too, by backing up what it replaces', () => {
    createFormation(deuce, { path: PATH })
    // Counting is no good once the rolling cap is reached, so check a NEW backup appeared.
    const newestBefore = listBackups(PATH)[0].file
    restoreBackup(listBackups(PATH)[0].file, PATH)
    expect(listBackups(PATH)[0].file).not.toBe(newestBefore)
  })

  it('still lets a normal delete empty the playbook', () => {
    // Removing the last thing you made is legitimate; the guard is about wholesale overwrites.
    createFormation(deuce, { path: PATH })
    expect(remove('formations', 'deuce', { path: PATH, force: true }).ok).toBe(true)
    expect(Object.keys(loadPlaybook(PATH).formations)).toEqual([])
  })
})
