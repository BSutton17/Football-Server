// ── Sign in with Google ([auth]) ────────────────────────────────────────────
//
// The browser gets a signed ID token from Google and sends it here. We check Google's signature and
// that it was issued for THIS app, and from then on the app holds a session of our own.
//
// ⚠️ THE HANDOFF EXISTS BECAUSE OF THE IPHONE HOME SCREEN. An app saved to the home screen is a sandbox:
// it cannot show Google's sign-in itself, and whatever opens to do it (Safari, or a sheet over the app)
// has separate storage and no reliable way to message back. So the app makes up a one-time id, opens
// the sign-in page with it, and asks the server for the result. The sign-in page drops the session here
// under that id, and the next poll collects it. It works whichever browser iOS chose, and on anything
// else that can open a link.

import express from 'express'
import { OAuth2Client } from 'google-auth-library'
import { getStore, StoreUnavailable } from '../db/store.js'
import { createSession, resolveSession, deleteSession } from './sessions.js'

// A web client id is public by design: it is in every page that shows the sign-in button.
export const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID
  ?? '133838464157-itoa8ptipuc4pbnkmu9tm2otnuubdm23.apps.googleusercontent.com'

const HANDOFF_LIFETIME_MS = 10 * 60 * 1000
const HANDOFF_ID = /^[A-Za-z0-9_-]{20,100}$/

const google = new OAuth2Client(GOOGLE_CLIENT_ID)

// Replaced in tests. Returns { id, email, name, picture }, or throws.
let verifyCredential = async (credential) => {
  const ticket = await google.verifyIdToken({ idToken: credential, audience: GOOGLE_CLIENT_ID })
  const p = ticket.getPayload()
  if (!p?.sub) throw new Error('no subject in the Google token')
  return { id: `google:${p.sub}`, email: p.email ?? null, name: p.name ?? p.email ?? 'Player', picture: p.picture ?? null }
}

export function setCredentialVerifier(fn) { verifyCredential = fn }

export function bearerToken(req) {
  const h = req.get('authorization') ?? ''
  return h.startsWith('Bearer ') ? h.slice(7) : null
}

// Attaches req.user, or answers 401. Exported for the season routes.
export async function requireUser(req, res, next) {
  try {
    const userId = await resolveSession(bearerToken(req))
    if (!userId) return res.status(401).json({ error: 'signed_out' })
    const user = await getStore().getUser(userId)
    if (!user) return res.status(401).json({ error: 'signed_out' })
    req.user = user
    next()
  } catch (err) {
    next(err)
  }
}

// [dev login] Lets a local test browser sign in without Google. ⚠️ Refused outright in production and
// off by default everywhere else, the same double gate the dev reveal uses.
export function isDevLoginEnabled() {
  return process.env.NODE_ENV !== 'production' && process.env.AUTH_DEV_LOGIN === '1'
}

// Every database failure on these routes is the same answer: the accounts are down, the game is not.
export function storeErrorHandler(err, _req, res, next) {
  if (res.headersSent) return next(err)
  if (err instanceof StoreUnavailable) return res.status(503).json({ error: 'unavailable' })
  console.error(`[api] ${err.stack ?? err.message}`)
  res.status(500).json({ error: 'server_error' })
}

export function createAuthRouter() {
  const router = express.Router()
  router.use(express.json({ limit: '32kb' }))
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })

  async function finishLogin(profile, handoffId) {
    const store = getStore()
    await store.upsertUser(profile)
    const token = await createSession(profile.id)
    const user = { id: profile.id, email: profile.email, name: profile.name, picture: profile.picture ?? null }
    if (typeof handoffId === 'string' && HANDOFF_ID.test(handoffId)) {
      await store.putHandoff(handoffId, { token, user, expiresAt: new Date(Date.now() + HANDOFF_LIFETIME_MS) })
    }
    return { token, user }
  }

  router.post('/google', async (req, res, next) => {
    try {
      const { credential, handoffId } = req.body ?? {}
      if (typeof credential !== 'string' || credential.length > 8192) return res.status(400).json({ error: 'bad_request' })
      let profile
      try {
        profile = await verifyCredential(credential)
      } catch (err) {
        console.warn(`[auth] rejected a Google token: ${err.message}`)
        return res.status(401).json({ error: 'google_rejected' })
      }
      res.json(await finishLogin(profile, handoffId))
    } catch (err) {
      next(err)
    }
  })

  // One collection only: reading it deletes it, so an old link in a browser history is worth nothing.
  router.get('/handoff/:id', async (req, res, next) => {
    try {
      if (!HANDOFF_ID.test(req.params.id)) return res.status(400).json({ error: 'bad_request' })
      const found = await getStore().takeHandoff(req.params.id)
      if (!found || new Date(found.expiresAt).getTime() <= Date.now()) return res.json({ status: 'pending' })
      res.json({ status: 'done', token: found.token, user: found.user })
    } catch (err) {
      next(err)
    }
  })

  router.get('/me', requireUser, (req, res) => res.json({ user: req.user }))

  router.post('/logout', async (req, res, next) => {
    try {
      await deleteSession(bearerToken(req))
      res.json({ ok: true })
    } catch (err) {
      next(err)
    }
  })

  router.post('/dev-login', async (req, res, next) => {
    if (!isDevLoginEnabled()) return res.status(404).end()
    try {
      const name = String(req.body?.name ?? 'Dev Player').slice(0, 40)
      res.json(await finishLogin({ id: `dev:${name}`, email: `${name}@dev.local`, name }, req.body?.handoffId))
    } catch (err) {
      next(err)
    }
  })

  router.use(storeErrorHandler)
  return router
}
