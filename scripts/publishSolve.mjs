// Copy a finished solve over the SHIPPED table.
//
//   npm run solve:publish
//
// The runner writes into `training-output/`, which is gitignored, so a solve that stays there can
// never reach a deployed server. This is the step that makes it real.
import { copyFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

const from = process.argv[2] ?? join('training-output', 'solve', 'table.json')
const to = join('src', 'ai', 'playcall', 'solved.json')

if (!existsSync(from)) {
  console.error(`no solve at ${from} — run \`npm run solve\` first`)
  process.exit(1)
}

// Refuse to publish something that is not a table, rather than shipping a broken file that the
// loader will then warn about on every boot.
const parsed = JSON.parse(readFileSync(from, 'utf8'))
const situations = Object.keys(parsed?.offense ?? {}).length
const pairs = Object.keys(parsed?.defense ?? {}).length
if (!situations || !pairs) {
  console.error(`${from} has ${situations} situations and ${pairs} pairs — refusing to publish an empty table`)
  process.exit(1)
}

copyFileSync(from, to)
console.log(`published ${situations} situations and ${pairs} situation+formation pairs -> ${to}`)
console.log('commit it to deploy the solve.')
