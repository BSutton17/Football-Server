// ── The test runner, because Jest's own discovery cannot be trusted here ────
//
//   npm test                 # everything
//   npm test openness kick   # only suites whose filename contains one of these
//
// ⚠️ JEST SILENTLY COLLECTS FEWER TEST FILES THAN EXIST IN THIS REPO, and the failure mode is a
// green run rather than an error.
//
// The repo lives under OneDrive, which dehydrates files that have not been touched recently.
// A dehydrated file keeps a reparse tag on its directory entry, and Node's
// `readdirSync(..., { withFileTypes: true })` reports those as SYMLINKS — even after the content is
// hydrated, and even though `lstat` on the same path correctly says "regular file". Jest's crawler
// skips anything that is not a file, so the suite quietly shrinks.
//
// ⚠️ AND IT SHRINKS PARTIALLY, WHICH IS THE DANGEROUS FORM. On 2026-10-01 `npm test` reported
// "70 suites, 1280 tests, all passed" over and over while the repo held 104 files and ~1680 tests.
// A 1-of-104 collapse is obvious; 70-of-104 reads as "the suite". It also drifts within a single
// session — 70, then 5, then 70 — with no change to the tree, and `jest --clearCache` does not help.
//
// When the full set finally ran it surfaced SIX failures that had been invisible for an unknown
// length of time: four tests asserting that the clock running out kills a live play (the rule had
// deliberately changed — a down in progress is now completed), the halftime timeout reset driven
// through the same stale path, and one interception test pinning a magic RNG roll that a deliberate
// rebalance had moved out from under it. None of them were hard to fix. Nobody knew they were there.
//
// So discovery is not used. The files are globbed here and handed to Jest explicitly, and the count
// is printed and checked — a number that is a decision rather than a number that is read.
//
// The real fix is to move the repo out of the OneDrive-synced tree. Until then, this.

import { readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { join } from 'node:path'

const TEST_DIR = join(process.cwd(), 'src', '__tests__')

// ⚠️ `statSync`, NOT the dirent type. The dirent is exactly what lies about these files.
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    let st
    try { st = statSync(full) } catch { continue }
    if (st.isDirectory()) { out.push(...collect(full)); continue }
    if (/\.(test|spec)\.[jt]sx?$/.test(entry)) out.push(full)
  }
  return out
}

const filters = process.argv.slice(2).filter(a => !a.startsWith('-'))
const flags = process.argv.slice(2).filter(a => a.startsWith('-'))

let files = collect(TEST_DIR).sort()
const total = files.length
if (filters.length) {
  files = files.filter(f => filters.some(k => f.toLowerCase().includes(k.toLowerCase())))
}

if (files.length === 0) {
  console.error(filters.length
    ? `[test] no suite matched ${filters.join(', ')} (of ${total} found)`
    : `[test] found no test files under ${TEST_DIR} — something is wrong with the checkout`)
  process.exit(1)
}

console.log(filters.length
  ? `[test] ${files.length} of ${total} suites (filtered by ${filters.join(', ')})`
  : `[test] ${total} suites`)

const res = spawnSync(process.execPath, [
  '--experimental-vm-modules',
  join('node_modules', 'jest', 'bin', 'jest.js'),
  ...flags,
  '--runTestsByPath',
  ...files,
], { stdio: 'inherit' })

// ⚠️ PROPAGATE THE CODE EXPLICITLY. `npm test --silent` has swallowed a failing exit code in this
// repo before, and a commit went out on top of a red suite because of it.
process.exit(res.status ?? 1)
