// ── Start the server with the play sandbox API on ([authored]) ──────────────
//
//   npm run dev:sandbox
//
// ⚠️ THIS EXISTS BECAUSE `ENABLE_PLAYBOOK_DEV=1 npm run dev` IS BASH SYNTAX. On PowerShell — the
// default shell on Windows — that line is not a command with an environment variable in front of
// it, it is a command called `ENABLE_PLAYBOOK_DEV=1`, and it fails with "is not recognized as the
// name of a cmdlet". Setting the variable here means the instructions are the same on every shell.
//
// It does NOT weaken the gate. `isDevPlaybookEnabled` still refuses to mount the router when
// NODE_ENV is production, and the router is still loopback-only. This only supplies the explicit
// opt-in that being in dev deliberately does not imply on its own — running THIS script is the
// consent.

process.env.ENABLE_PLAYBOOK_DEV = '1'
process.env.NODE_ENV ??= 'development'

if (process.env.NODE_ENV === 'production') {
  console.error('[dev:sandbox] refusing to run with NODE_ENV=production — this is a dev-only tool')
  process.exit(1)
}

await import('../src/index.js')
