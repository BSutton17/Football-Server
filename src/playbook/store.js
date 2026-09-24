// ── Reading and writing the authored playbook ([authored]) ──────────────────
//
// The sandbox's persistence. Formations, plays and shells live as ONE JSON file inside the repo,
// next to the hand-written tables they will eventually replace, which means the training harness
// reads them directly, they ship with the game, and they are version-controlled with everything
// else. No database, no migration, and a diff you can read.
//
// ⚠️ NOTHING INVALID EVER REACHES THE FILE. An authored formation is data the engine TRUSTS — it
// puts players on the grass without re-checking — so validation happens here, on the way in, once.
// The alternative is defending against malformed spots at every read site forever.
//
// ⚠️ WRITES ARE ATOMIC. Temp file plus rename, the same pattern the training checkpoints use. A
// half-written playbook would be worse than no playbook: it takes the whole authored library with
// it, which by then is hours of the user's drawing.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  emptyPlaybook, validateFormation, validatePlay, validateShell, autoRunPlay, PLAYBOOK_VERSION,
} from '../ai/playbook/authored.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLAYBOOK_PATH = process.env.PLAYBOOK_PATH ?? join(HERE, '..', 'ai', 'playbook', 'authored.json')

const KINDS = {
  formations: validateFormation,
  plays: validatePlay,
  shells: validateShell,
}

export function loadPlaybook(path = PLAYBOOK_PATH) {
  if (!existsSync(path)) return emptyPlaybook()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      version: raw.version ?? PLAYBOOK_VERSION,
      formations: raw.formations ?? {},
      plays: raw.plays ?? {},
      shells: raw.shells ?? {},
    }
  } catch (err) {
    // Refuse to silently start from empty — that would look like the library vanished and the next
    // save would overwrite the damaged file with nothing.
    throw new Error(`playbook at ${path} is unreadable (${err.message}) — fix or move it before saving`)
  }
}

export function savePlaybook(book, path = PLAYBOOK_PATH) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(book, null, 2))
  renameSync(tmp, path)
  return book
}

// `U Off Trips Wk` -> `u_off_trips_wk`. Ids are derived from the name so the file reads like the
// playbook it is, rather than a list of uuids.
export function slugify(name) {
  return String(name).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

function uniqueId(base, taken, keepId) {
  if (keepId) return keepId
  let id = base || 'untitled'
  let n = 2
  while (taken[id]) id = `${base}_${n++}`
  return id
}

// ── Saving one item ─────────────────────────────────────────────────────────
//
// `id` present means EDIT (keep the id, so every play built on a formation still points at it);
// absent means create.
export function upsert(kind, item, { id = null, path = PLAYBOOK_PATH, book = null } = {}) {
  const validate = KINDS[kind]
  if (!validate) throw new Error(`unknown playbook kind "${kind}"`)
  const current = book ?? loadPlaybook(path)

  const result = kind === 'plays' ? validate(item, current.formations) : validate(item)
  if (!result.ok) return { ok: false, errors: result.errors }

  const finalId = uniqueId(slugify(item.name), current[kind], id)
  const next = { ...current, [kind]: { ...current[kind], [finalId]: item } }
  savePlaybook(next, path)
  return { ok: true, id: finalId, book: next }
}

// ── Creating a formation creates its run ────────────────────────────────────
//
// ⚠️ ON CREATE ONLY, never on edit. Re-adding it every time a formation is saved would pile up
// duplicate runs every time the user nudged a receiver.
//
// The run play is an ordinary play afterwards — renameable, editable and deletable like any
// other. This only saves the clicks; it does not make it special.
export function createFormation(formation, { path = PLAYBOOK_PATH } = {}) {
  const made = upsert('formations', formation, { path })
  if (!made.ok) return made

  const run = autoRunPlay(formation, made.id)
  // No back on the field: an empty set has nobody to hand it to. The formation is still created.
  if (!run) return { ...made, runPlayId: null, runNote: 'no back in this formation, so no run play' }

  // Pass the book forward so the run is written onto the formation that was just saved, rather
  // than re-reading a file that a second save would then race.
  const play = upsert('plays', run, { path, book: made.book })
  if (!play.ok) return { ...made, runPlayId: null, runNote: play.errors.join('; ') }
  return { ok: true, id: made.id, runPlayId: play.id, book: play.book }
}

// ── Deleting ────────────────────────────────────────────────────────────────
//
// ⚠️ DELETING A FORMATION THAT HAS PLAYS IS REFUSED, not cascaded. The user's rule for EDITING is
// that plays survive; silently destroying three plays because a formation was removed is the same
// surprise in a worse form. The caller is told exactly which plays are in the way.
export function remove(kind, id, { path = PLAYBOOK_PATH, book = null, force = false } = {}) {
  const current = book ?? loadPlaybook(path)
  if (!current[kind]?.[id]) return { ok: false, errors: [`no ${kind} with id "${id}"`] }

  if (kind === 'formations' && !force) {
    const dependents = Object.entries(current.plays)
      .filter(([, p]) => p.formationId === id)
      .map(([playId, p]) => p.name ?? playId)
    if (dependents.length) {
      return {
        ok: false,
        errors: [`${dependents.length} play(s) still use this formation: ${dependents.join(', ')}`],
        dependents,
      }
    }
  }

  const rest = { ...current[kind] }
  delete rest[id]
  let next = { ...current, [kind]: rest }
  // A forced formation delete takes its plays with it, because a play pointing at a formation that
  // no longer exists cannot be put on the field.
  if (kind === 'formations' && force) {
    next.plays = Object.fromEntries(Object.entries(next.plays).filter(([, p]) => p.formationId !== id))
  }
  savePlaybook(next, path)
  return { ok: true, book: next }
}

// Everything the engine and the sandbox need to know is consistent. Run on load so a hand-edited
// file cannot quietly put a broken play on the field.
export function auditPlaybook(book) {
  const problems = []
  for (const [id, f] of Object.entries(book.formations ?? {})) {
    const r = validateFormation(f)
    if (!r.ok) problems.push(`formation ${id}: ${r.errors.join('; ')}`)
  }
  for (const [id, p] of Object.entries(book.plays ?? {})) {
    const r = validatePlay(p, book.formations ?? {})
    if (!r.ok) problems.push(`play ${id}: ${r.errors.join('; ')}`)
  }
  for (const [id, s] of Object.entries(book.shells ?? {})) {
    const r = validateShell(s)
    if (!r.ok) problems.push(`shell ${id}: ${r.errors.join('; ')}`)
  }
  return { ok: problems.length === 0, problems }
}
