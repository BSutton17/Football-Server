// ── Everything that outlives a server restart ([seasons]) ───────────────────
//
// Accounts, login sessions, seasons, in-progress games and trophies. Two implementations of one small
// interface: MongoDB in production, and a Map-backed one the tests run on, so nothing about the rules
// of a season needs a database to be tested.
//
// ⚠️ MONGO IS OPTIONAL TO THE GAME. Everyone playing online or offline without an account must be
// unaffected if the database is down or was never configured. So connecting is lazy, a failure is
// retried on the next request rather than crashing the process, and only Seasons say they are unavailable.

import { MongoClient } from 'mongodb'

const COLLECTIONS = {
  users: 'users',
  sessions: 'authSessions',
  handoffs: 'authHandoffs',
  seasons: 'seasons',
  gameSaves: 'gameSaves',
  trophies: 'trophies',
  schedules: 'schedules',
}

export class StoreUnavailable extends Error {}

// ── MongoDB ──────────────────────────────────────────────────────────────

function mongoUri() {
  return process.env.MONGO_URI ?? process.env.MONGODB_URI ?? null
}

// Local development shares a connection string with production, so it gets its own database.
function mongoDbName() {
  return process.env.MONGO_DB ?? (process.env.NODE_ENV === 'production' ? 'efootball' : 'efootball_dev')
}

export function createMongoStore() {
  let client = null
  let connecting = null

  async function db() {
    if (client) return client.db(mongoDbName())
    const uri = mongoUri()
    if (!uri) throw new StoreUnavailable('MONGO_URI is not set')
    connecting ??= (async () => {
      const c = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, maxPoolSize: 10 })
      await c.connect()
      await ensureIndexes(c.db(mongoDbName()))
      client = c
      console.log(`[db] connected to ${mongoDbName()}`)
    })().catch((err) => {
      connecting = null
      console.error(`[db] connection failed: ${err.message}`)
      throw new StoreUnavailable('The database could not be reached')
    })
    await connecting
    return client.db(mongoDbName())
  }

  async function ensureIndexes(d) {
    await d.collection(COLLECTIONS.sessions).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    await d.collection(COLLECTIONS.handoffs).createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
    await d.collection(COLLECTIONS.seasons).createIndex({ userId: 1, slot: 1 })
    await d.collection(COLLECTIONS.trophies).createIndex({ userId: 1 })
  }

  const col = async (name) => (await db()).collection(COLLECTIONS[name])

  return {
    available: () => !!mongoUri(),

    async upsertUser(user) {
      const c = await col('users')
      const now = new Date()
      await c.updateOne(
        { _id: user.id },
        {
          $set: { email: user.email, name: user.name, picture: user.picture ?? null, lastSeenAt: now },
          $setOnInsert: { createdAt: now },
        },
        { upsert: true },
      )
    },
    async getUser(id) {
      const u = await (await col('users')).findOne({ _id: id })
      return u ? { id: u._id, email: u.email, name: u.name, picture: u.picture ?? null } : null
    },

    async putSession(hash, doc) { await (await col('sessions')).replaceOne({ _id: hash }, doc, { upsert: true }) },
    async getSession(hash) { return (await col('sessions')).findOne({ _id: hash }) },
    async deleteSession(hash) { await (await col('sessions')).deleteOne({ _id: hash }) },

    async putHandoff(id, doc) { await (await col('handoffs')).replaceOne({ _id: id }, doc, { upsert: true }) },
    async takeHandoff(id) {
      const r = await (await col('handoffs')).findOneAndDelete({ _id: id })
      return r ?? null
    },

    async getSeason(id) { return (await col('seasons')).findOne({ _id: id }) },
    async listSeasons(userId) { return (await col('seasons')).find({ userId }).toArray() },
    async putSeason(season) { await (await col('seasons')).replaceOne({ _id: season._id }, season, { upsert: true }) },
    async deleteSeason(id) { await (await col('seasons')).deleteOne({ _id: id }) },

    async putGameSave(seasonId, doc) { await (await col('gameSaves')).replaceOne({ _id: seasonId }, doc, { upsert: true }) },
    async getGameSave(seasonId) { return (await col('gameSaves')).findOne({ _id: seasonId }) },
    async deleteGameSave(seasonId) { await (await col('gameSaves')).deleteOne({ _id: seasonId }) },

    async addTrophy(trophy) { await (await col('trophies')).replaceOne({ _id: trophy._id }, trophy, { upsert: true }) },
    async listTrophies(userId) { return (await col('trophies')).find({ userId }).sort({ createdAt: -1 }).toArray() },

    async getSchedule(year) { return (await col('schedules')).findOne({ _id: year }) },
    async putSchedule(schedule) {
      const { year } = schedule
      await (await col('schedules')).replaceOne({ _id: year }, { ...schedule, _id: year }, { upsert: true })
    },
  }
}

// ── In memory, for tests ─────────────────────────────────────────────────

export function createMemoryStore() {
  const clone = (v) => (v == null ? null : structuredClone(v))
  const m = {
    users: new Map(), sessions: new Map(), handoffs: new Map(), seasons: new Map(),
    gameSaves: new Map(), trophies: new Map(), schedules: new Map(),
  }
  return {
    available: () => true,
    _maps: m,

    async upsertUser(user) { m.users.set(user.id, { ...user }) },
    async getUser(id) { return clone(m.users.get(id)) },

    async putSession(hash, doc) { m.sessions.set(hash, clone({ ...doc, _id: hash })) },
    async getSession(hash) { return clone(m.sessions.get(hash)) },
    async deleteSession(hash) { m.sessions.delete(hash) },

    async putHandoff(id, doc) { m.handoffs.set(id, clone({ ...doc, _id: id })) },
    async takeHandoff(id) {
      const d = clone(m.handoffs.get(id))
      m.handoffs.delete(id)
      return d
    },

    async getSeason(id) { return clone(m.seasons.get(id)) },
    async listSeasons(userId) { return [...m.seasons.values()].filter(s => s.userId === userId).map(clone) },
    async putSeason(season) { m.seasons.set(season._id, clone(season)) },
    async deleteSeason(id) { m.seasons.delete(id) },

    async putGameSave(seasonId, doc) { m.gameSaves.set(seasonId, clone({ ...doc, _id: seasonId })) },
    async getGameSave(seasonId) { return clone(m.gameSaves.get(seasonId)) },
    async deleteGameSave(seasonId) { m.gameSaves.delete(seasonId) },

    async addTrophy(trophy) { m.trophies.set(trophy._id, clone(trophy)) },
    async listTrophies(userId) { return [...m.trophies.values()].filter(t => t.userId === userId).map(clone) },

    async getSchedule(year) { return clone(m.schedules.get(year)) },
    async putSchedule(schedule) { m.schedules.set(schedule.year, clone({ ...schedule, _id: schedule.year })) },
  }
}

// ── The one in use ───────────────────────────────────────────────────────

let store = null

export function getStore() {
  store ??= createMongoStore()
  return store
}

export function setStore(next) {
  store = next
}
