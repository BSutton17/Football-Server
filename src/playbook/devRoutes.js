// ── The sandbox's save button ([authored]) ──────────────────────────────────
//
//   GET    /dev/playbook                 everything, plus an audit
//   POST   /dev/playbook/:kind           create           -> { id }
//   PUT    /dev/playbook/:kind/:id       edit in place    (keeps the id, so plays keep pointing at it)
//   DELETE /dev/playbook/:kind/:id       remove           (?force=1 to take dependent plays too)
//
// `kind` is formations | plays | shells.
//
// ⚠️ THIS ROUTER WRITES FILES INTO THE REPO, so it must be impossible to reach in production. It
// is gated three ways and every one of them has to pass:
//
//   1. NODE_ENV must not be production,
//   2. ENABLE_PLAYBOOK_DEV must be explicitly set — being in dev is not, on its own, consent,
//   3. the request must come from loopback.
//
// `isDevPlaybookEnabled` is exported so the mount site reads as the guard it is, and so the test
// can prove the gate rather than trusting it.

import express from 'express'
import { loadPlaybook, upsert, remove, createFormation, auditPlaybook, PLAYBOOK_PATH } from './store.js'

const KINDS = new Set(['formations', 'plays', 'shells'])

export function isDevPlaybookEnabled(env = process.env) {
  return env.NODE_ENV !== 'production' && Boolean(env.ENABLE_PLAYBOOK_DEV)
}

// Loopback only. A dev machine on a café network should not be serving a file-writing endpoint to
// the café.
export function isLocalRequest(req) {
  const ip = req.ip ?? req.socket?.remoteAddress ?? ''
  return ip === '::1' || ip === '127.0.0.1' || ip === '::ffff:127.0.0.1'
}

export function createPlaybookDevRouter() {
  const router = express.Router()
  router.use(express.json({ limit: '2mb' }))

  router.use((req, res, next) => {
    if (!isLocalRequest(req)) return res.status(403).json({ error: 'playbook dev API is loopback only' })
    next()
  })

  router.get('/playbook', (_req, res) => {
    const book = loadPlaybook()
    res.json({ ...book, audit: auditPlaybook(book), path: PLAYBOOK_PATH })
  })

  router.post('/playbook/:kind', (req, res) => {
    const { kind } = req.params
    if (!KINDS.has(kind)) return res.status(400).json({ error: `unknown kind "${kind}"` })
    // A new formation also gets its run play — there is nothing to draw on a run, so authoring
    // one by hand for every formation is pure clicking.
    const result = kind === 'formations' ? createFormation(req.body) : upsert(kind, req.body)
    // 422, not 500: the payload is well-formed JSON that describes an illegal formation, and the
    // sandbox shows these strings to the user directly.
    if (!result.ok) return res.status(422).json({ errors: result.errors })
    res.json({
      id: result.id,
      runPlayId: result.runPlayId,
      runNote: result.runNote,
      [kind]: result.book[kind],
      plays: result.book.plays,
    })
  })

  router.put('/playbook/:kind/:id', (req, res) => {
    const { kind, id } = req.params
    if (!KINDS.has(kind)) return res.status(400).json({ error: `unknown kind "${kind}"` })
    // ⚠️ The id is KEPT. That is what makes "edit a formation without erasing its plays" work —
    // every play stores a formationId, and a new id on edit would orphan all of them.
    const result = upsert(kind, req.body, { id })
    if (!result.ok) return res.status(422).json({ errors: result.errors })
    res.json({ id: result.id, [kind]: result.book[kind] })
  })

  router.delete('/playbook/:kind/:id', (req, res) => {
    const { kind, id } = req.params
    if (!KINDS.has(kind)) return res.status(400).json({ error: `unknown kind "${kind}"` })
    const result = remove(kind, id, { force: req.query.force === '1' })
    // 409: the delete is refused because something still depends on it, and the response names
    // what, so the sandbox can offer to take them too rather than just failing.
    if (!result.ok) return res.status(409).json({ errors: result.errors, dependents: result.dependents })
    res.json({ ok: true, [kind]: result.book[kind] })
  })

  return router
}
