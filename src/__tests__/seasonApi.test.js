import { TEAMS } from '../season/teams.js'
import { describe, it, expect, beforeAll, afterAll, beforeEach } from '@jest/globals'
import express from 'express'
import { createServer } from 'node:http'
import { createMemoryStore, setStore, getStore, StoreUnavailable } from '../db/store.js'
import { createAuthRouter, setCredentialVerifier, isDevLoginEnabled } from '../auth/routes.js'
import { createSession, resolveSession } from '../auth/sessions.js'
import { createSeasonRouter } from '../season/routes.js'
import { setScheduleFetcher, scheduleFor } from '../season/service.js'
import { SCREEN } from '../season/season.js'
import bundled from '../season/data/schedule2026.js'

// The HTTP surface, over a real socket on a spare port.

let server, base

beforeAll(async () => {
  const app = express()
  app.use('/auth', createAuthRouter())
  app.use('/season', createSeasonRouter())
  server = createServer(app)
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise(r => server.close(r)))

beforeEach(() => {
  setStore(createMemoryStore())
  setScheduleFetcher(async () => { throw new Error('no network in tests') })
  setCredentialVerifier(async (credential) => {
    if (credential !== 'good-google-token') throw new Error('bad signature')
    return { id: 'google:42', email: 'player@example.com', name: 'Player', picture: null }
  })
})

const call = async (method, path, { token, body } = {}) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => null) }
}

const signIn = async () => (await call('POST', '/auth/google', { body: { credential: 'good-google-token' } })).body.token
const SETTINGS = { mode: 'manual', difficulty: 'hard', quarterMinutes: 6 }

describe('[auth] signing in', () => {
  it('a good Google token gets a session and an account', async () => {
    const r = await call('POST', '/auth/google', { body: { credential: 'good-google-token' } })
    expect(r.status).toBe(200)
    expect(r.body.token.length).toBeGreaterThan(30)
    expect(r.body.user.name).toBe('Player')
    expect((await call('GET', '/auth/me', { token: r.body.token })).body.user.id).toBe('google:42')
  })

  it('⚠️ A TOKEN GOOGLE DID NOT SIGN IS REFUSED', async () => {
    const r = await call('POST', '/auth/google', { body: { credential: 'forged' } })
    expect(r.status).toBe(401)
    expect(r.body.token).toBeUndefined()
  })

  it('⚠️ ONLY A HASH OF THE TOKEN IS STORED', async () => {
    const token = await signIn()
    const stored = [...getStore()._maps.sessions.keys()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).not.toBe(token)
    expect(JSON.stringify([...getStore()._maps.sessions.values()])).not.toContain(token)
  })

  it('no token, a junk token and a signed-out token all answer 401', async () => {
    expect((await call('GET', '/auth/me')).status).toBe(401)
    expect((await call('GET', '/auth/me', { token: 'junk-junk-junk-junk-junk-junk' })).status).toBe(401)
    const token = await signIn()
    await call('POST', '/auth/logout', { token })
    expect((await call('GET', '/auth/me', { token })).status).toBe(401)
  })

  it('⚠️ THE LOGIN LASTS: a year, and using it restarts the year', async () => {
    const t0 = Date.parse('2026-11-05T00:00:00Z')
    const day = 86400000
    await getStore().upsertUser({ id: 'u1', name: 'x' })
    const token = await createSession('u1', t0)
    expect(await resolveSession(token, t0 + 300 * day)).toBe('u1')     // refreshed here
    expect(await resolveSession(token, t0 + 600 * day)).toBe('u1')     // past the first year, still in
    expect(await resolveSession(token, t0 + 1000 * day)).toBeNull()    // a year untouched: gone
  })

  it('dev login is off unless asked for, and never in production', async () => {
    expect((await call('POST', '/auth/dev-login', { body: { name: 'a' } })).status).toBe(404)
    process.env.AUTH_DEV_LOGIN = '1'
    expect(isDevLoginEnabled()).toBe(true)
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    expect(isDevLoginEnabled()).toBe(false)
    process.env.NODE_ENV = was
    delete process.env.AUTH_DEV_LOGIN
  })
})

describe('[auth] the home-screen handoff', () => {
  const id = 'abcdefghijklmnopqrstuvwxyz012345'

  it('⚠️ THE APP COLLECTS WHAT THE SIGN-IN PAGE LEFT, ONCE', async () => {
    expect((await call('GET', `/auth/handoff/${id}`)).body.status).toBe('pending')
    const signedIn = await call('POST', '/auth/google', { body: { credential: 'good-google-token', handoffId: id } })

    const first = await call('GET', `/auth/handoff/${id}`)
    expect(first.body.status).toBe('done')
    expect(first.body.token).toBe(signedIn.body.token)
    expect(first.body.user.id).toBe('google:42')

    const second = await call('GET', `/auth/handoff/${id}`)
    expect(second.body.status).toBe('pending')
    expect(second.body.token).toBeUndefined()
  })

  it('an expired handoff is worth nothing', async () => {
    await getStore().putHandoff(id, { token: 't', user: {}, expiresAt: new Date(Date.now() - 1000) })
    expect((await call('GET', `/auth/handoff/${id}`)).body.status).toBe('pending')
  })

  it('refuses a malformed id', async () => {
    expect((await call('GET', '/auth/handoff/short')).status).toBe(400)
  })
})

describe('[seasons] the API', () => {
  it('⚠️ EVERYTHING NEEDS A LOGIN', async () => {
    expect((await call('GET', '/season/home')).status).toBe(401)
    expect((await call('POST', '/season/new', { body: { slot: 0, teamId: 'KC' } })).status).toBe(401)
  })

  it('home has three empty slots and every club\'s strength of schedule', async () => {
    const r = await call('GET', '/season/home', { token: await signIn() })
    expect(r.status).toBe(200)
    expect(r.body.slots).toEqual([null, null, null])
    expect(r.body.schedule.year).toBe(2026)
    expect(r.body.schedule.numeral).toBe('LXI')
    expect(Object.keys(r.body.schedule.sos)).toHaveLength(32)
    expect(r.body.trophies).toEqual([])
  })

  it('starts a season on the real schedule with the settings it was given', async () => {
    const token = await signIn()
    const r = await call('POST', '/season/new', { token, body: { slot: 1, teamId: 'DET', settings: SETTINGS } })
    expect(r.status).toBe(200)
    const s = r.body.season
    expect(s.teamId).toBe('DET')
    expect(s.settings).toEqual(SETTINGS)
    expect(s.games).toHaveLength(272)
    expect(s.week).toBe(1)
    const home = (await call('GET', '/season/home', { token })).body
    expect(home.slots[1].teamId).toBe('DET')
    expect(home.slots[0]).toBeNull()
  })

  it('clamps nonsense settings rather than storing them', async () => {
    const r = await call('POST', '/season/new', {
      token: await signIn(),
      body: { slot: 0, teamId: 'KC', settings: { mode: 'cheat', difficulty: 'lol', quarterMinutes: 99 } },
    })
    expect(r.body.season.settings).toEqual({ mode: 'automatic', difficulty: 'easy', quarterMinutes: 6 })
  })

  it('refuses a bad team and a bad slot', async () => {
    const token = await signIn()
    expect((await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'XXX' } })).status).toBe(400)
    expect((await call('POST', '/season/new', { token, body: { slot: 3, teamId: 'KC' } })).status).toBe(400)
  })

  it('⚠️ A FULL SLOT IS NOT OVERWRITTEN WITHOUT SAYING SO', async () => {
    const token = await signIn()
    await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'KC' } })
    expect((await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'BUF' } })).status).toBe(409)
    const replaced = await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'BUF', replace: true } })
    expect(replaced.body.season.teamId).toBe('BUF')
    expect((await call('GET', '/season/home', { token })).body.slots[0].teamId).toBe('BUF')
  })

  it('⚠️ NOBODY ELSE CAN SEE OR TOUCH YOUR SEASON', async () => {
    const mine = await signIn()
    const id = (await call('POST', '/season/new', { token: mine, body: { slot: 0, teamId: 'KC' } })).body.season.id
    await getStore().upsertUser({ id: 'u2', name: 'other' })
    const theirs = await createSession('u2')
    expect((await call('GET', `/season/${id}`, { token: theirs })).status).toBe(404)
    expect((await call('POST', `/season/${id}/sim`, { token: theirs })).status).toBe(404)
    expect((await call('DELETE', `/season/${id}`, { token: theirs })).status).toBe(404)
  })

  it('sims a week at a time, all the way to the end, and an all-time winner gets a trophy', async () => {
    const token = await signIn()
    const id = (await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'KC' } })).body.season.id

    let view, guard = 0
    do {
      view = (await call('POST', `/season/${id}/sim`, { token })).body.season
    } while (view.phase !== 'complete' && guard++ < 40)
    expect(view.phase).toBe('complete')
    expect(view.playoffs.champion).toBeTruthy()

    // Once it is over there is nothing left to sim.
    expect((await call('POST', `/season/${id}/sim`, { token })).status).toBe(409)

    const home = (await call('GET', '/season/home', { token })).body
    expect(home.trophies).toHaveLength(view.finish === 'champion' ? 1 : 0)
  }, 30000)

  it('⚠️ A TROPHY OUTLIVES THE SAVE IT WAS WON IN', async () => {
    const token = await signIn()
    // ⚠️ THE BEST TEAM IN THE LEAGUE, BECAUSE SEEDS ARE RANDOM. A season's seed cannot be set from out here, so
    // this sims until somebody wins it all. It named one mid-pack favorite, and now and then sixty seasons
    // went by without a title and a test about trophies failed for no reason to do with trophies.
    const best = TEAMS.reduce((a, b) => (b.ovr > a.ovr ? b : a)).id
    let trophyAt = null
    for (let i = 0; i < 60 && trophyAt == null; i++) {
      const id = (await call('POST', '/season/new', { token, body: { slot: 0, teamId: best, replace: true } })).body.season.id
      let view, guard = 0
      do {
        view = (await call('POST', `/season/${id}/sim`, { token })).body.season
      } while (view.phase !== 'complete' && guard++ < 40)
      if (view.finish === 'champion') trophyAt = view
    }
    expect(trophyAt).toBeTruthy()
    expect(trophyAt.screens.at(-1).type).toBe(SCREEN.SUPER_BOWL_CHAMPION)

    const before = (await call('GET', '/season/home', { token })).body
    expect(before.trophies.length).toBeGreaterThanOrEqual(1)
    expect(before.trophies[0].numeral).toBe('LXI')
    expect(before.trophies[0].teamId).toBe(best)

    await call('DELETE', `/season/${trophyAt.id}`, { token })
    const after = (await call('GET', '/season/home', { token })).body
    expect(after.slots[0]).toBeNull()
    expect(after.trophies.length).toBe(before.trophies.length)
  }, 120000)

  it('a screen is acknowledged once and stays gone', async () => {
    const token = await signIn()
    const id = (await call('POST', '/season/new', { token, body: { slot: 0, teamId: 'KC' } })).body.season.id
    let view, guard = 0
    do {
      view = (await call('POST', `/season/${id}/sim`, { token })).body.season
    } while (!view.screens.length && guard++ < 25)
    expect(view.screens.length).toBeGreaterThan(0)
    const n = view.screens.length
    const after = (await call('POST', `/season/${id}/ack`, { token })).body.season
    expect(after.screens).toHaveLength(n - 1)
    expect((await call('GET', `/season/${id}`, { token })).body.season.screens).toHaveLength(n - 1)
  }, 30000)

  it('⚠️ WITH THE DATABASE DOWN IT SAYS SO, and does not take anything else with it', async () => {
    const down = createMemoryStore()
    down.getSession = async () => { throw new StoreUnavailable('down') }
    setStore(down)
    const r = await call('GET', '/season/home', { token: 'x'.repeat(40) })
    expect(r.status).toBe(503)
    expect(r.body.error).toBe('unavailable')
  })
})

describe('[seasons] where the schedule comes from', () => {
  const realisticFeed = async (url) => {
    const week = Number(/week=(\d+)/.exec(url)[1])
    const year = Number(/dates=(\d+)/.exec(url)[1])
    const events = bundled.games.filter(g => g.week === week).map(g => ({
      date: g.date,
      competitions: [{
        neutralSite: g.neutral,
        status: { type: { completed: year < 2027 } },
        competitors: [
          { homeAway: 'home', score: '20', team: { abbreviation: g.home === 'WAS' ? 'WSH' : g.home } },
          { homeAway: 'away', score: '10', team: { abbreviation: g.away === 'WAS' ? 'WSH' : g.away } },
        ],
      }],
    }))
    return { ok: true, json: async () => ({ events }) }
  }

  it('⚠️ A NEW YEAR FETCHES ITS SCHEDULE ONCE, AND STORES IT', async () => {
    let calls = 0
    const counting = async (url) => { calls++; return realisticFeed(url) }
    const first = await scheduleFor(2027, { fetcher: counting })
    expect(first.year).toBe(2027)
    expect(first.games).toHaveLength(272)
    expect(first.games.some(g => g.home === 'WAS' || g.away === 'WAS')).toBe(true)   // ESPN calls them WSH
    expect(first.sos.KC.rank).toBeGreaterThan(0)
    const n = calls
    const second = await scheduleFor(2027, { fetcher: counting })
    expect(second.year).toBe(2027)
    expect(calls).toBe(n)
  })

  it('⚠️ ESPN BEING DOWN NEVER STOPS A SEASON: the bundled schedule steps in', async () => {
    const r = await scheduleFor(2026, { fetcher: async () => { throw new Error('down') } })
    expect(r.year).toBe(2026)
    expect(r.games).toHaveLength(272)
  })
})
