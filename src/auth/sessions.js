// ── Staying logged in ([auth]) ──────────────────────────────────────────────
//
// "Make sure login persists across closing the app."
//
// Google proves who somebody is once. After that the app holds a token of ours. It lasts a year and
// the year restarts every time it is used, so anyone still playing never gets signed out; the client
// keeps it in the app's own long-lived storage (see Client/src/season/authStore.ts).
//
// Only a HASH is stored. A leaked database holds nothing that can be replayed as a login.

import { createHash, randomBytes } from 'node:crypto'
import { getStore } from '../db/store.js'

const SESSION_LIFETIME_MS = 365 * 24 * 60 * 60 * 1000
// Don't write to the database on every request just to move an expiry a few seconds on.
const REFRESH_AFTER_MS = 24 * 60 * 60 * 1000

const hashOf = (token) => createHash('sha256').update(token).digest('hex')

export async function createSession(userId, now = Date.now()) {
  const token = randomBytes(32).toString('base64url')
  await getStore().putSession(hashOf(token), {
    userId,
    createdAt: new Date(now),
    refreshedAt: new Date(now),
    expiresAt: new Date(now + SESSION_LIFETIME_MS),
  })
  return token
}

// The user id behind a token, or null. An expired session counts as none even if the database has
// not swept it yet.
export async function resolveSession(token, now = Date.now()) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null
  const hash = hashOf(token)
  const store = getStore()
  const session = await store.getSession(hash)
  if (!session) return null
  if (new Date(session.expiresAt).getTime() <= now) {
    await store.deleteSession(hash)
    return null
  }
  if (now - new Date(session.refreshedAt).getTime() > REFRESH_AFTER_MS) {
    await store.putSession(hash, {
      ...session,
      refreshedAt: new Date(now),
      expiresAt: new Date(now + SESSION_LIFETIME_MS),
    })
  }
  return session.userId
}

export async function deleteSession(token) {
  if (typeof token === 'string') await getStore().deleteSession(hashOf(token))
}
