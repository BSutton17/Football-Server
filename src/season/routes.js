// ── The season API ([seasons]) ─────────────────────────────────────────────
//
// Everything between games. A game being played goes over the socket instead (season/gameRoom.js).

import express from 'express'
import { getStore } from '../db/store.js'
import { requireUser, storeErrorHandler } from '../auth/routes.js'
import { seasonSummary, seasonView } from './season.js'
import { seasonYearFor, superBowlNumeral } from './calendar.js'
import { currentSchedule, loadOwned, createNewSeason, simSeason, ackScreen, SAVE_SLOTS } from './service.js'
import { closeSeasonRoomFor } from './rooms.js'

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next)

export function createSeasonRouter() {
  const router = express.Router()
  router.use(express.json({ limit: '32kb' }))
  router.use((_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  router.use(requireUser)

  // Everything the save-slot screen needs in one request, which is what a phone on bad signal wants.
  router.get('/home', wrap(async (req, res) => {
    const store = getStore()
    const [seasons, trophies, schedule] = await Promise.all([
      store.listSeasons(req.user.id),
      store.listTrophies(req.user.id),
      currentSchedule(),
    ])
    const slots = Array.from({ length: SAVE_SLOTS }, (_, i) => {
      const s = seasons.find(x => x.slot === i)
      return s ? seasonSummary(s) : null
    })
    res.json({
      user: req.user,
      slots,
      trophies,
      schedule: {
        year: schedule.year,
        numeral: superBowlNumeral(schedule.year),
        sosYear: schedule.sosYear,
        sos: schedule.sos ?? {},
        lastYear: schedule.lastYear ?? {},
        // What the calendar says it should be, so a stale fallback can be told apart from the real thing.
        currentYear: seasonYearFor(),
      },
    })
  }))

  router.post('/new', wrap(async (req, res) => {
    const { slot, teamId, settings, replace } = req.body ?? {}
    const { season, error } = await createNewSeason(req.user.id, { slot, teamId, settings, replace: replace === true })
    if (error) return res.status(error === 'slot_taken' ? 409 : 400).json({ error })
    res.json({ season: seasonView(season) })
  }))

  router.get('/:id', wrap(async (req, res) => {
    const season = await loadOwned(req.user.id, req.params.id)
    if (!season) return res.status(404).json({ error: 'not_found' })
    res.json({ season: seasonView(season) })
  }))

  // Simulate the player's game this week, or a bye, and everybody else's with it.
  router.post('/:id/sim', wrap(async (req, res) => {
    const season = await loadOwned(req.user.id, req.params.id)
    if (!season) return res.status(404).json({ error: 'not_found' })
    const result = await simSeason(season)
    if (result.error) return res.status(409).json({ error: result.error })
    res.json({ season: seasonView(season) })
  }))

  router.post('/:id/ack', wrap(async (req, res) => {
    const season = await loadOwned(req.user.id, req.params.id)
    if (!season) return res.status(404).json({ error: 'not_found' })
    await ackScreen(season)
    res.json({ season: seasonView(season) })
  }))

  router.delete('/:id', wrap(async (req, res) => {
    const season = await loadOwned(req.user.id, req.params.id)
    if (!season) return res.status(404).json({ error: 'not_found' })
    closeSeasonRoomFor(season._id)
    const store = getStore()
    await store.deleteGameSave(season._id)
    await store.deleteSeason(season._id)
    res.json({ ok: true })
  }))

  router.use(storeErrorHandler)
  return router
}
