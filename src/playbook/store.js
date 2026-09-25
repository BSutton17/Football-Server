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

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, readdirSync, unlinkSync, copyFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  emptyPlaybook, validateFormation, validatePlay, validateDefFormation, validateShell, autoRunPlay,
  PLAYBOOK_VERSION,
} from '../ai/playbook/authored.js'

const HERE = dirname(fileURLToPath(import.meta.url))
export const PLAYBOOK_PATH = process.env.PLAYBOOK_PATH ?? join(HERE, '..', 'ai', 'playbook', 'authored.json')

// Each kind validates against the whole book, because a play is only legal with respect to the
// offensive formation it names and a shell with respect to its defensive one.
const KINDS = {
  formations: (item) => validateFormation(item),
  plays: (item, book) => validatePlay(item, book.formations),
  defFormations: (item) => validateDefFormation(item),
  shells: (item, book) => validateShell(item, book.defFormations),
}

// Which collection holds the things built ON a given kind, for the delete guard below.
const DEPENDENTS = {
  formations: { kind: 'plays', key: 'formationId' },
  defFormations: { kind: 'shells', key: 'formationId' },
}

export function loadPlaybook(path = PLAYBOOK_PATH) {
  if (!existsSync(path)) return emptyPlaybook()
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8'))
    return {
      version: raw.version ?? PLAYBOOK_VERSION,
      formations: raw.formations ?? {},
      plays: raw.plays ?? {},
      defFormations: raw.defFormations ?? {},
      shells: raw.shells ?? {},
    }
  } catch (err) {
    // Refuse to silently start from empty — that would look like the library vanished and the next
    // save would overwrite the damaged file with nothing.
    throw new Error(`playbook at ${path} is unreadable (${err.message}) — fix or move it before saving`)
  }
}

// ── Not losing hours of somebody's drawing ──────────────────────────────────
//
// ⚠️ THIS EXISTS BECAUSE I DESTROYED THE USER'S WORK. A smoke test wrote an empty playbook over
// the live file and every formation and play they had authored was gone — not in git, because the
// same commits that followed had already staged the emptied file. Atomic writes protected against
// a HALF-written file and did nothing about a fully-written wrong one.
//
// Two guards, and they are deliberately different:
//
//   1. A BACKUP BEFORE EVERY WRITE. Cheap, and the only thing that helps once a bad write has
//      already landed.
//   2. A REFUSAL TO WIPE. A save that would drop everything is almost never what anyone meant, so
//      it has to say so explicitly. This is the one that would have stopped it happening at all.
export const BACKUP_DIR = 'backups'
const KEEP_BACKUPS = 40

const countItems = (book) =>
  ['formations', 'plays', 'defFormations', 'shells']
    .reduce((n, k) => n + Object.keys(book?.[k] ?? {}).length, 0)

function backup(path) {
  if (!existsSync(path)) return null
  const dir = join(dirname(path), BACKUP_DIR)
  mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = join(dir, `authored-${stamp}.json`)
  copyFileSync(path, dest)

  // Keep the most recent few. Names sort chronologically because the stamp is ISO.
  const all = readdirSync(dir).filter(f => f.startsWith('authored-') && f.endsWith('.json')).sort()
  for (const old of all.slice(0, Math.max(0, all.length - KEEP_BACKUPS))) {
    try { unlinkSync(join(dir, old)) } catch { /* a stale backup is not worth failing a save over */ }
  }
  return dest
}

export function listBackups(path = PLAYBOOK_PATH) {
  const dir = join(dirname(path), BACKUP_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter(f => f.startsWith('authored-') && f.endsWith('.json'))
    .sort().reverse()
    .map(f => {
      const full = join(dir, f)
      let items = 0
      try { items = countItems(JSON.parse(readFileSync(full, 'utf8'))) } catch { /* unreadable */ }
      return { file: f, path: full, items }
    })
}

// Put a backup back. Takes a backup of the CURRENT file first, so an accidental restore is itself
// undoable.
export function restoreBackup(file, path = PLAYBOOK_PATH) {
  const full = join(dirname(path), BACKUP_DIR, file)
  if (!existsSync(full)) return { ok: false, errors: [`no backup named "${file}"`] }
  const book = JSON.parse(readFileSync(full, 'utf8'))
  savePlaybook(book, path, { allowWipe: true })
  return { ok: true, items: countItems(book), book }
}

export function savePlaybook(book, path = PLAYBOOK_PATH, { allowWipe = false } = {}) {
  mkdirSync(dirname(path), { recursive: true })

  // ⚠️ REFUSE TO WIPE. Every legitimate caller either adds something or removes ONE thing, so a
  // write that empties a playbook holding work is a mistake by definition — a stray reset, a
  // fixture leaking into the real file, a bad merge. It has to be asked for explicitly.
  if (!allowWipe && existsSync(path)) {
    let before = 0
    try { before = countItems(JSON.parse(readFileSync(path, 'utf8'))) } catch { before = 0 }
    const after = countItems(book)
    if (before > 0 && after === 0) {
      throw new Error(
        `refusing to overwrite a playbook holding ${before} item(s) with an empty one. ` +
        `If that is really the intent, pass { allowWipe: true }. Backups: ${join(dirname(path), BACKUP_DIR)}`,
      )
    }
  }

  backup(path)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(book, null, 2))
  renameSync(tmp, path)          // atomic: a truncated file would break the resume it exists for
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

  const result = validate(item, current)
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

  const dep = DEPENDENTS[kind]
  if (dep && !force) {
    const dependents = Object.entries(current[dep.kind] ?? {})
      .filter(([, x]) => x[dep.key] === id)
      .map(([xid, x]) => x.name ?? xid)
    if (dependents.length) {
      const what = dep.kind === 'plays' ? 'play' : 'shell'
      return {
        ok: false,
        errors: [`${dependents.length} ${what}(s) still use this formation: ${dependents.join(', ')}`],
        dependents,
      }
    }
  }

  const rest = { ...current[kind] }
  delete rest[id]
  let next = { ...current, [kind]: rest }
  // A forced delete takes its dependents with it, because a play or shell pointing at a formation
  // that no longer exists cannot be put on the field.
  if (dep && force) {
    next[dep.kind] = Object.fromEntries(
      Object.entries(next[dep.kind] ?? {}).filter(([, x]) => x[dep.key] !== id),
    )
  }
  savePlaybook(next, path, { allowWipe: true })
  return { ok: true, book: next }
}

// Everything the engine and the sandbox need to know is consistent. Run on load so a hand-edited
// file cannot quietly put a broken play on the field.
export function auditPlaybook(book) {
  const problems = []
  for (const [kind, validate] of Object.entries(KINDS)) {
    for (const [id, item] of Object.entries(book[kind] ?? {})) {
      const r = validate(item, book)
      if (!r.ok) problems.push(`${kind} ${id}: ${r.errors.join('; ')}`)
    }
  }
  return { ok: problems.length === 0, problems }
}
