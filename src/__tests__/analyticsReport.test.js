import { describe, it, expect, beforeAll, afterAll } from '@jest/globals'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ── The report has to be right, or it is worse than having none ──────────────
//
// ⚠️ A REAL GAME'S REPORT LOGGED AN INTERCEPTION AS A TACKLE. The outcome was read as the LAST
// terminal event in the sequence, and an interception fires THROW → INTERCEPTION → TACKLE — the tackle
// ending the RETURN, not the play. So the record said "TACKLE", and the only hint that anything had
// happened was `yards: null`. Anybody counting interceptions off that file would have counted none.
//
// This file exists because this subsystem had no tests at all, which is how that shipped. A diagnostic
// nobody has checked is a diagnostic that quietly tells you the wrong thing, and this one is being used
// to decide what to fix next.
//
// ⚠️ THE MODULE IS IMPORTED DYNAMICALLY, AFTER THE ENV IS SET. `ENABLED` and the output path are
// resolved at module load, and recording is deliberately OFF under test — the suite builds solo games,
// and it once wrote real plays into the repo's analytics-output and left a phantom play at the top of
// the next real report. So this one opts in, and writes to a temp directory it then removes.

let dir
let log

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'analytics-'))
  process.env.ANALYTICS = '1'
  process.env.ANALYTICS_DIR = dir
  log = await import('../analytics/playLog.js')
})

afterAll(() => {
  delete process.env.ANALYTICS
  delete process.env.ANALYTICS_DIR
  rmSync(dir, { recursive: true, force: true })
})

// A solo game, which is the only kind that is recorded.
function state(roomId, over = {}) {
  return {
    roomId, solo: true, quarter: 1, clock: 300, down: 1, distance: 10, yardLine: 40,
    score: [0, 0], possession: 0, mode: 'manual', difficulty: 'medium', ballX: 26,
    playDesign: { playType: 'pass' },
    offensePlayers: new Map(), defensePlayers: new Map(),
    ...over,
  }
}

function recordsFor(roomId) {
  const lines = readFileSync(join(dir, 'plays.jsonl'), 'utf8').trim().split('\n').filter(Boolean)
  return lines.map(l => JSON.parse(l)).filter(r => r.roomId === roomId || true)
}

function lastRecord() {
  const all = recordsFor()
  return all[all.length - 1]
}

describe('what the report calls the outcome of a play', () => {
  it('⚠️ names an INTERCEPTION, not the tackle that ended the return', () => {
    const s = state('an-int')
    log.beginPlay(s)
    log.noteEvent(s, 'THROW', { receiverId: 'wr1' })
    log.noteEvent(s, 'INTERCEPTION', { catcherId: 'cb1' })
    log.noteEvent(s, 'TACKLE', {})
    s.possession = 1                       // the ball changed hands
    s.yardLine = 55
    log.endPlay(s)

    const r = lastRecord()
    expect(r.result.outcome).toBe('INTERCEPTION')
    // ⚠️ AND IT SAYS SO OUTRIGHT rather than leaving it to be inferred from a null yardage.
    expect(r.result.possessionChanged).toBe(true)
    expect(r.result.yards).toBeNull()      // the frame flipped; a number here would not be real
  })

  it('names a TOUCHDOWN even though a tackle may follow it', () => {
    const s = state('an-td')
    log.beginPlay(s)
    log.noteEvent(s, 'TACKLE', {})
    log.noteEvent(s, 'TOUCHDOWN', {})
    log.endPlay(s)

    const r = lastRecord()
    expect(r.result.outcome).toBe('TOUCHDOWN')
    expect(r.result.yards).toBe(60)        // measured to the goal line from the 40
  })

  it('prefers a SACK to the tackle that is part of it', () => {
    const s = state('an-sack')
    log.beginPlay(s)
    log.noteEvent(s, 'SACK', {})
    log.noteEvent(s, 'TACKLE', {})
    s.yardLine = 32
    log.endPlay(s)
    expect(lastRecord().result.outcome).toBe('SACK')
  })

  it('still reports an ordinary tackle as a tackle, with its yardage', () => {
    const s = state('an-tackle')
    log.beginPlay(s)
    log.noteEvent(s, 'TACKLE', {})
    s.yardLine = 47.5
    log.endPlay(s)

    const r = lastRecord()
    expect(r.result.outcome).toBe('TACKLE')
    expect(r.result.possessionChanged).toBe(false)
    expect(r.result.yards).toBe(7.5)
  })

  // The case the report could not name: a safety is resolved inside onSack/onTackle without enqueuing
  // an event of its own, so all the log sees is a TACKLE and a possession change. A real game produced
  // exactly this on 1st and 10 from the offense's own 1. The flag is what makes it visible at all.
  it('flags a possession change it cannot otherwise explain', () => {
    const s = state('an-safety', { yardLine: 1 })
    log.beginPlay(s)
    log.noteEvent(s, 'TACKLE', {})
    s.possession = 1
    log.endPlay(s)

    const r = lastRecord()
    expect(r.result.outcome).toBe('TACKLE')
    expect(r.result.possessionChanged).toBe(true)
  })
})

describe('recording is opt-in', () => {
  it('writes nothing for a room that is not a solo game', () => {
    const before = recordsFor().length
    const s = state('an-online', { solo: false })
    log.beginPlay(s)
    log.noteEvent(s, 'TACKLE', {})
    log.endPlay(s)
    expect(recordsFor().length).toBe(before)
  })
})
