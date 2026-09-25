// ── Playbook safety net ([authored]) ────────────────────────────────────────
//
//   npm run playbook              what is in the playbook right now
//   npm run playbook:backups      every automatic backup, newest first
//   npm run playbook:restore <file>   put one back
//
// ⚠️ WHY THIS EXISTS. A smoke test once wrote an empty playbook over the live file and every
// formation and play the user had authored was gone — not in git, because the commits that
// followed had already staged the emptied file. `savePlaybook` now takes a backup before every
// write and refuses to replace a populated playbook with an empty one; this is how you get at
// those backups without needing me.

import { loadPlaybook, listBackups, restoreBackup, PLAYBOOK_PATH } from '../src/playbook/store.js'

const [, , cmd = 'show', arg] = process.argv

const counts = (b) => ['formations', 'plays', 'defFormations', 'shells']
  .map(k => `${Object.keys(b[k] ?? {}).length} ${k}`).join(' · ')

if (cmd === 'show') {
  const book = loadPlaybook()
  console.log(`\n  ${PLAYBOOK_PATH}\n  ${counts(book)}\n`)
  for (const [kind, label] of [['formations', 'OFFENSE'], ['defFormations', 'DEFENSE']]) {
    const entries = Object.entries(book[kind] ?? {})
    if (!entries.length) continue
    console.log(`  ${label}`)
    for (const [id, f] of entries) {
      const built = kind === 'formations' ? 'plays' : 'shells'
      const on = Object.values(book[built] ?? {}).filter(x => x.formationId === id).length
      console.log(`    ${f.name.padEnd(22)} ${String(on).padStart(2)} ${built}`)
    }
    console.log('')
  }
} else if (cmd === 'backups') {
  const all = listBackups()
  if (!all.length) {
    console.log('\n  No backups yet — one is written before every save.\n')
  } else {
    console.log(`\n  ${all.length} backup(s), newest first:\n`)
    for (const b of all) console.log(`    ${b.file}   ${String(b.items).padStart(3)} items`)
    console.log('\n  Restore one with:  npm run playbook:restore <file>\n')
  }
} else if (cmd === 'restore') {
  if (!arg) {
    console.error('  Which one? Run `npm run playbook:backups` to list them.')
    process.exit(1)
  }
  const r = restoreBackup(arg)
  if (!r.ok) { console.error(`  ${r.errors.join('; ')}`); process.exit(1) }
  // The current file was itself backed up first, so this is undoable.
  console.log(`\n  Restored ${r.items} item(s) from ${arg}.`)
  console.log('  The playbook that was there is now a backup of its own, if this was a mistake.\n')
} else {
  console.error(`  Unknown command "${cmd}". Try: show | backups | restore <file>`)
  process.exit(1)
}
