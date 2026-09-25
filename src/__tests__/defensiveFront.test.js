import { describe, it, expect } from '@jest/globals'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// [authored] ⚠️ THE DEFENSIVE FRONT IS DEFINED TWICE, ON PURPOSE AND DANGEROUSLY.
//
// `autoDefense` in ai/controller.js places the down linemen for the simulation, and `DL_SPACING`
// in Client/src/game/formation.ts places them for the picture. The comment in both files says
// they must match. Nothing enforced it until this test: when they drift, the server simulates a
// front the client never draws, and the two screens show a different defense with no error
// anywhere.

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'ai', 'controller.js')
const CLIENT = join(HERE, '..', '..', '..', 'Client', 'src', 'game', 'formation.ts')

const table = (file) => {
  const m = readFileSync(file, 'utf8').match(/DL_SPACING[^=]*= \{([\s\S]*?)\}/)
  return m ? m[1].replace(/\s|as const/g, '') : null
}

describe('the two defensive front tables', () => {
  it('exists on the server', () => {
    expect(table(SERVER)).toBeTruthy()
  })

  it('MATCHES the client, exactly', () => {
    // Skipped rather than failed when the sibling repo is not checked out — CI for the server
    // alone should not go red for a file it does not have.
    if (!existsSync(CLIENT)) {
      console.warn('[defensiveFront] Client repo not present; parity not checked')
      return
    }
    expect(table(SERVER)).toBe(table(CLIENT))
  })

  it('still puts four linemen out by default, so the live game is unmoved', () => {
    const t = table(SERVER)
    expect(t).toContain('4:[-3.25,-1.25,1.25,3.25]')
  })
})
