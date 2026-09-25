// ── The solved table, loaded ([authored]) ───────────────────────────────────
//
// `runSolve.mjs` writes a table of distributions; `select.js` has always accepted one. Nothing
// carried it between them, so every call the AI made — and every recommendation shown to a player
// — ran off the situational prior no matter how much solving had been done. The solve was real and
// entirely unused.
//
// ⚠️ A MISSING TABLE IS NORMAL, NOT AN ERROR. Before the first solve finishes there is no file, and
// the selector's prior is a complete answer on its own. Loading is therefore best-effort and silent
// about absence, and loud only when a file exists but cannot be read — which is a real problem,
// because it means the solve ran and is being ignored.
//
// ⚠️ IT IS READ WHILE THE SOLVER IS STILL WRITING. The runner checkpoints after every subgame, so
// the table on disk grows during a run. Reading a partial table is fine — the buckets it contains
// are solved, and the ones it does not fall back to the prior exactly as they did before — but it
// does mean the file can be mid-rename. The read tolerates that and keeps the last good copy.

import { readFileSync, existsSync, statSync } from 'node:fs'
import { join } from 'node:path'

export const TABLE_PATH = process.env.SOLVE_TABLE_PATH
  ?? join(process.cwd(), 'training-output', 'solve', 'table.json')

const EMPTY = { offense: {}, defense: {} }

let cached = null
let cachedMtime = 0

function readTable(path) {
  const raw = readFileSync(path, 'utf8')
  const parsed = JSON.parse(raw)
  return {
    offense: parsed?.offense ?? {},
    defense: parsed?.defense ?? {},
  }
}

// The solved distributions, or an empty table when there is nothing solved yet.
//
// Re-reads when the file's mtime changes, so a solve that finishes while the server is up is picked
// up without a restart — the whole point of checkpointing every subgame.
export function solvedTable(path = TABLE_PATH) {
  try {
    if (!existsSync(path)) return cached ?? EMPTY
    const mtime = statSync(path).mtimeMs
    if (cached && mtime === cachedMtime) return cached
    const next = readTable(path)
    cached = next
    cachedMtime = mtime
    return next
  } catch (err) {
    // A file that exists but will not parse is worth saying out loud: the solve ran and is being
    // silently discarded, which looks from the outside exactly like a solve that never helped.
    // Mid-rename is the common cause, so the last good copy is kept rather than dropped.
    if (!cached) console.warn(`[solve] table at ${path} unreadable (${err.message}); using the prior`)
    return cached ?? EMPTY
  }
}

export function reloadSolvedTable() {
  cached = null
  cachedMtime = 0
}

// How much of the playbook the table actually covers, for a startup line that says whether a solve
// is in play at all. "0 situations" and "no file" look identical from the game's side otherwise.
export function tableSummary(path = TABLE_PATH) {
  const t = solvedTable(path)
  return {
    situations: Object.keys(t.offense).length,
    pairs: Object.keys(t.defense).length,
    solved: Object.keys(t.offense).length > 0,
  }
}
