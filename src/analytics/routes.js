// ── Getting the report off the box ([analytics]) ────────────────────────────
//
// The report is written on the SERVER, and on Heroku that disk is ephemeral and unreachable. So
// there has to be a way to pull it down: play a game, hit the link, save the file.
//
// ⚠️ IT IS READ-ONLY AND IT HOLDS NOTHING PRIVATE. Player ids, positions and play calls from
// offline games against the computer — no accounts, no opponents, nothing a viewer of the game
// could not already see. Mounted unconditionally for that reason; if that ever stops being true,
// gate it the way the playbook dev routes are gated.

import { Router } from 'express'
import { createReadStream, existsSync } from 'node:fs'
import { analyticsPaths, analyticsSummary } from './playLog.js'

export function createAnalyticsRouter() {
  const router = Router()
  const { file, meta } = analyticsPaths()

  // What is on disk right now, so it can be checked without downloading it.
  router.get('/', (_req, res) => {
    const s = analyticsSummary()
    res.json({
      ...s,
      mb: s.bytes ? Math.round((s.bytes / 1048576) * 100) / 100 : 0,
      download: '/analytics/plays.jsonl',
      note: 'One JSON object per play. Offline games only. Resets on every deploy.',
    })
  })

  // The report itself. `Content-Disposition` so a browser saves it instead of trying to render
  // tens of megabytes of JSON, and a stream so it is never held in memory twice.
  router.get('/plays.jsonl', (_req, res) => {
    if (!existsSync(file)) return res.status(404).json({ error: 'no report yet — play an offline game first' })
    res.setHeader('Content-Type', 'application/x-ndjson')
    res.setHeader('Content-Disposition', 'attachment; filename="plays.jsonl"')
    createReadStream(file).pipe(res)
  })

  router.get('/meta.json', (_req, res) => {
    if (!existsSync(meta)) return res.status(404).json({ error: 'no report yet' })
    res.setHeader('Content-Type', 'application/json')
    createReadStream(meta).pipe(res)
  })

  return router
}
