// ── Seasons, as the rest of the server sees them ([seasons]) ───────────────
//
// season.js holds the rules and knows nothing about storage. This loads, applies and saves.

import { randomBytes } from 'node:crypto'
import { getStore } from '../db/store.js'
import { GAME_MODE, DIFFICULTY, clampQuarterMinutes } from '../constants.js'
import { isTeam } from './teams.js'
import { seasonYearFor, superBowlNumeral } from './calendar.js'
import { fetchSchedule } from './schedule.js'
import { createSeason, recordOf, playoffRecordOf, simCurrent, acknowledgeScreen, recordUserGame, findGame, upgradeSeason } from './season.js'
import bundled2026 from './data/schedule2026.js'

export const SAVE_SLOTS = 3

// The newest schedule shipped in the repository: the floor if ESPN and the database are both no help.
const BUNDLED = bundled2026

let lastFetchFailureAt = 0
const FETCH_RETRY_MS = 10 * 60 * 1000
let defaultFetcher = undefined   // the real network, unless a test has said otherwise

export function setScheduleFetcher(fn) { defaultFetcher = fn; lastFetchFailureAt = 0 }

// ⚠️ NEVER SHOWS A PLAYER AN ERROR FOR ESPN HAVING A BAD DAY. In order: what we already stored for the
// year, a fresh fetch (stored for next time), and otherwise the newest schedule we have. In early
// September the feed may not have the new year's full slate yet, and a failed fetch is only retried
// every ten minutes so that a season starting does not wait on it.
export async function scheduleFor(year, { fetcher = defaultFetcher } = {}) {
  const store = getStore()
  const stored = await store.getSchedule(year)
  if (stored) return stored

  if (Date.now() - lastFetchFailureAt > FETCH_RETRY_MS) {
    try {
      const fresh = await fetchSchedule(year, fetcher)
      await store.putSchedule(fresh)
      console.log(`[season] stored the ${year} schedule`)
      return fresh
    } catch (err) {
      lastFetchFailureAt = Date.now()
      console.warn(`[season] could not fetch the ${year} schedule: ${err.message}`)
    }
  }
  return year === BUNDLED.year ? BUNDLED : (await store.getSchedule(year - 1)) ?? BUNDLED
}

export function currentSchedule(now = new Date(), opts) {
  return scheduleFor(seasonYearFor(now), opts)
}

function normalizeSettings(raw) {
  return {
    mode: raw?.mode === GAME_MODE.MANUAL ? GAME_MODE.MANUAL : GAME_MODE.AUTOMATIC,
    difficulty: Object.values(DIFFICULTY).includes(raw?.difficulty) ? raw.difficulty : DIFFICULTY.EASY,
    quarterMinutes: clampQuarterMinutes(raw?.quarterMinutes),
  }
}

export async function loadOwned(userId, seasonId) {
  if (typeof seasonId !== 'string') return null
  const season = await getStore().getSeason(seasonId)
  if (!season || season.userId !== userId) return null
  if (upgradeSeason(season)) await saveSeason(season)
  return season
}

export async function saveSeason(season, now = new Date()) {
  season.updatedAt = now.toISOString()
  await getStore().putSeason(season)
}

// The Lombardi goes on the account, not the save: it survives the slot being overwritten.
async function awardTrophyIfWon(season) {
  if (season.finish !== 'champion') return
  const final = season.playoffs.games.find(g => g.round === 4)
  await getStore().addTrophy({
    _id: `${season.userId}:${season._id}`,
    userId: season.userId,
    seasonId: season._id,
    year: season.year,
    numeral: superBowlNumeral(season.year),
    teamId: season.teamId,
    record: recordOf(season),
    playoffRecord: playoffRecordOf(season),
    final: final ? { home: final.home, away: final.away, hs: final.hs, as: final.as, ot: !!final.ot } : null,
    createdAt: new Date().toISOString(),
  })
}

export async function createNewSeason(userId, { slot, teamId, settings, replace = false }, now = new Date()) {
  if (!Number.isInteger(slot) || slot < 0 || slot >= SAVE_SLOTS) return { error: 'bad_slot' }
  if (!isTeam(teamId)) return { error: 'bad_team' }

  const store = getStore()
  const existing = (await store.listSeasons(userId)).filter(s => s.slot === slot)
  if (existing.length && !replace) return { error: 'slot_taken' }
  for (const old of existing) {
    await store.deleteGameSave(old._id)
    await store.deleteSeason(old._id)
  }

  const schedule = await currentSchedule(now)
  const season = createSeason({
    id: randomBytes(12).toString('hex'),
    userId, slot, teamId,
    settings: normalizeSettings(settings),
    schedule,
    seed: randomBytes(4).readUInt32LE(0),
    now,
  })
  await saveSeason(season, now)
  return { season }
}

export async function simSeason(season) {
  const result = simCurrent(season)
  if (result.error) return result
  await awardTrophyIfWon(season)
  await saveSeason(season)
  return result
}

export async function ackScreen(season) {
  acknowledgeScreen(season)
  await saveSeason(season)
}

// A played game has finished. The result is what the engine says, and nothing from the client.
export async function recordPlayedGame(seasonId, userId, gameId, result) {
  const store = getStore()
  const season = await loadOwned(userId, seasonId)
  if (!season) return { error: 'no_season' }
  if (!findGame(season, gameId)) return { error: 'no_game' }
  const outcome = recordUserGame(season, gameId, result)
  if (outcome.error) return outcome
  await awardTrophyIfWon(season)
  await saveSeason(season)
  await store.deleteGameSave(seasonId)
  return { season }
}
