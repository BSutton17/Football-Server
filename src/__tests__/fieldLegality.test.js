import { describe, it, expect } from '@jest/globals'
import { enforceFieldLegality, verifyLoadedGame, saveIsPlayable, MAX_PER_SIDE } from '../game/fieldLegality.js'
import { initLivePhase } from '../game/systems/init.js'
import { initGame, deleteGame, getLosY } from '../game/gameState.js'
import { snapshotGame, hydrateGame } from '../game/snapshot.js'
import { PHASE } from '../game/stateMachine.js'
import { FRONT_DEPTH } from '../ai/playbook/front.js'
import { createTrainingGame, destroyTrainingGame, playDown } from '../training/game.js'
import { startNextPlay } from '../game/eventQueue.js'

// [field check] "When loading in a save, or before each play the game should verify whether the field is in a
// legal position. No more than 11 on each side and the sides are on the correct sides."

let nextRoom = 0
function game({ possession = 0, yardLine = 40, ballX = 26.665 } = {}) {
  const state = initGame(`field-${nextRoom++}`, possession)
  state.headless = true
  state.yardLine = yardLine
  state.ballX = ballX
  state.phase = PHASE.PRE_SNAP
  return state
}

// In the frame the server keeps: depth past the line, toward the end zone the offense attacks.
const abs = (state, depth) => getLosY(state) + state.direction * depth

function dl(state, depth = FRONT_DEPTH) {
  for (let i = 1; i <= 4; i++) {
    state.defensePlayers.set(`auto_dl${i}`, { id: `auto_dl${i}`, x: 24 + i, y: abs(state, depth), label: 'DL' })
  }
}
function defenders(state, n, depth = 6) {
  for (let i = 0; i < n; i++) {
    state.defensePlayers.set(`db${i}`, { id: `db${i}`, x: 10 + i, y: abs(state, depth), label: 'CB' })
  }
}
// The set_offense payload: relative to the offense's own goal, the line and the quarterback in it.
function design(state, { receivers = 5, past = 0 } = {}) {
  const players = []
  for (let i = 0; i < 5; i++) players.push({ id: `ol${i}`, team: 'o', label: 'OL', x: 24 + i, y: state.yardLine - 1 })
  players.push({ id: 'qb', team: 'o', label: 'QB', x: 26, y: state.yardLine - 6 })
  for (let i = 0; i < receivers; i++) players.push({ id: `wr${i}`, team: 'o', label: 'WR', x: 5 + i * 4, y: state.yardLine - 1 + past })
  state.playDesign = { playType: 'pass', runAngle: 0, players }
  return players
}
const finish = (state) => deleteGame(state.roomId)

describe('[field check] the reported bug: a row left at another yard line', () => {
  for (const possession of [0, 1]) {
    it(`puts the linemen back on the line, on the ball (attacking ${possession === 0 ? 'up' : 'down'} the field)`, () => {
      const state = game({ possession, yardLine: 56.8, ballX: 32.7 })
      design(state)
      // Exactly what the client sent: the opening kickoff's row, thirty yards the wrong way.
      dl(state, 26 - 56.8)
      initLivePhase(state)
      for (const p of ['auto_dl1', 'auto_dl2', 'auto_dl3', 'auto_dl4'].map(id => state.defensePlayers.get(id))) {
        expect((p.y - getLosY(state)) * state.direction).toBeCloseTo(FRONT_DEPTH)
      }
      const xs = [...state.defensePlayers.values()].map(p => p.x)
      expect(xs.reduce((a, b) => a + b, 0) / xs.length).toBeCloseTo(32.7)
      finish(state)
    })
  }

  it('also when the row stands on the legal side but nowhere near the ball', () => {
    const state = game({ yardLine: 10 })
    design(state)
    dl(state, 16)   // backed up on the 10, the row at 26 is fifteen yards off the ball
    initLivePhase(state)
    expect((state.defensePlayers.get('auto_dl1').y - getLosY(state)) * state.direction).toBeCloseTo(FRONT_DEPTH)
    finish(state)
  })

  it('leaves a lineman moved sideways by hand alone', () => {
    const state = game()
    design(state)
    dl(state)
    state.defensePlayers.get('auto_dl1').x = 12
    initLivePhase(state)
    expect(state.defensePlayers.get('auto_dl1').x).toBe(12)
    finish(state)
  })
})

describe('[field check] sides', () => {
  it('moves a defender on the wrong side of the line back onside', () => {
    const state = game()
    design(state)
    dl(state)
    defenders(state, 1, -3)
    const fixed = enforceFieldLegality(state)
    expect(fixed.length).toBe(1)
    expect((state.defensePlayers.get('db0').y - getLosY(state)) * state.direction).toBeGreaterThan(0)
    expect(state.defensePlayers.get('db0').x).toBe(10)
    finish(state)
  })

  it('moves a placed receiver past the line back behind it', () => {
    const state = game({ possession: 1 })
    design(state)
    state.offensePlayers.set('wr0', { id: 'wr0', x: 5, y: abs(state, 4), label: 'WR' })
    enforceFieldLegality(state)
    expect((state.offensePlayers.get('wr0').y - getLosY(state)) * state.direction).toBeLessThan(0)
    finish(state)
  })

  it('moves a receiver who only exists in the play call, before his route is built from where he stands', () => {
    const state = game()
    const players = design(state, { past: 5 })
    players.find(p => p.id === 'wr0').route = 'go'
    initLivePhase(state)
    const wr = state.offensePlayers.get('wr0')
    expect((wr.y - getLosY(state)) * state.direction).toBeLessThan(0)
    expect(wr.routeStart.y).toBe(wr.y)
    finish(state)
  })

  it('does not touch a formation right on the limits a player can really set', () => {
    const state = game()
    design(state)
    dl(state)
    defenders(state, 3, 0.75)
    state.offensePlayers.set('wr0', { id: 'wr0', x: 5, y: abs(state, 0), label: 'WR' })
    const before = JSON.stringify([...state.defensePlayers.values(), ...state.offensePlayers.values()])
    expect(enforceFieldLegality(state)).toEqual([])
    expect(JSON.stringify([...state.defensePlayers.values(), ...state.offensePlayers.values()])).toBe(before)
    finish(state)
  })

  it('does not mistake a substituted lineman set deeper for the auto-placed row', () => {
    const state = game()
    design(state)
    state.defensePlayers.set('det_dl5', { id: 'det_dl5', x: 20, y: abs(state, 5), label: 'DL' })
    expect(enforceFieldLegality(state)).toEqual([])
    finish(state)
  })
})

describe('[field check] no more than eleven', () => {
  it('takes the last defender placed off, along with his coverage', () => {
    const state = game()
    design(state)
    dl(state)
    defenders(state, 8)
    state.defenseCoverage.set('db7', { type: 'man', targetId: 'wr0' })
    enforceFieldLegality(state)
    expect(state.defensePlayers.size).toBe(MAX_PER_SIDE)
    expect(state.defensePlayers.has('db7')).toBe(false)
    expect(state.defenseCoverage.has('db7')).toBe(false)
    expect(state.defensePlayers.has('auto_dl4')).toBe(true)
    finish(state)
  })

  it('takes someone who is not in the play off the offense first', () => {
    const state = game()
    design(state)
    state.offensePlayers.set('ghost', { id: 'ghost', x: 1, y: abs(state, -2), label: 'WR' })
    initLivePhase(state)
    expect(state.offensePlayers.has('ghost')).toBe(false)
    expect(state.offensePlayers.size).toBe(MAX_PER_SIDE)
    finish(state)
  })

  it('never takes off the line or the quarterback, and takes him out of the play as well', () => {
    const state = game()
    design(state, { receivers: 7 })
    initLivePhase(state)
    expect(state.offensePlayers.size).toBe(MAX_PER_SIDE)
    expect(state.offensePlayers.has('qb')).toBe(true)
    for (let i = 0; i < 5; i++) expect(state.offensePlayers.has(`ol${i}`)).toBe(true)
    expect(state.playDesign.players.length).toBe(MAX_PER_SIDE)
    expect(state.offensePlayers.has('wr6')).toBe(false)
    finish(state)
  })

  it('counts a receiver in both the map and the play call once', () => {
    const state = game()
    const players = design(state)
    const wr = players.find(p => p.id === 'wr0')
    state.offensePlayers.set('wr0', { id: 'wr0', x: wr.x, y: abs(state, -1), label: 'WR' })
    expect(enforceFieldLegality(state)).toEqual([])
    finish(state)
  })
})

describe('[field check] loading a save', () => {
  it('turns the teams around if they face the wrong way for who has the ball', () => {
    const state = game({ possession: 1 })
    state.direction = 1
    expect(verifyLoadedGame(state).length).toBe(1)
    expect(state.direction).toBe(-1)
    finish(state)
  })

  it('says nothing about a healthy save, at either end', () => {
    for (const possession of [0, 1]) {
      const state = game({ possession })
      expect(verifyLoadedGame(state, { prePlay: true })).toEqual([])
      finish(state)
    }
  })

  it('checks a line-up it finds in the save', () => {
    const saved = game()
    saved.phase = PHASE.DEAD   // a dead ball keeps its players, which is how one gets into a save at all
    defenders(saved, 12)
    const parsed = JSON.parse(snapshotGame(saved))
    parsed.state.phase = PHASE.PRE_SNAP
    const fresh = game()
    expect(hydrateGame(fresh, JSON.stringify(parsed))).toBe(true)
    expect(fresh.defensePlayers.size).toBe(MAX_PER_SIDE)
    finish(saved); finish(fresh)
  })

  it('leaves a dead ball alone: the last play ends with players on any side of anything', () => {
    const saved = game()
    saved.phase = PHASE.DEAD
    defenders(saved, 3, -20)
    const fresh = game()
    expect(hydrateGame(fresh, snapshotGame(saved))).toBe(true)
    expect(fresh.phase).toBe(PHASE.DEAD)
    expect((fresh.defensePlayers.get('db0').y - getLosY(fresh)) * fresh.direction).toBeCloseTo(-20)
    finish(saved); finish(fresh)
  })

  it('will not resume a save with no ball or nobody holding it', () => {
    expect(saveIsPlayable({ possession: 0, yardLine: 40 })).toBe(true)
    expect(saveIsPlayable({ possession: 2, yardLine: 40 })).toBe(false)
    expect(saveIsPlayable({ possession: 0 })).toBe(false)
    const saved = game()
    const parsed = JSON.parse(snapshotGame(saved))
    delete parsed.state.yardLine
    const fresh = game({ yardLine: 33 })
    expect(hydrateGame(fresh, JSON.stringify(parsed))).toBe(false)
    expect(fresh.yardLine).toBe(33)
    finish(saved); finish(fresh)
  })
})

describe('[field check] real games', () => {
  it('never changes anything the computer lines up, on either side', () => {
    const warn = console.warn
    const seen = []
    const ctx = createTrainingGame({ seed: 4242, difficulty: 'hard' })
    ctx.state.headless = false   // so a repair reaches the log rather than passing silently
    console.warn = (...a) => { if (String(a[0]).startsWith('[field]')) seen.push(a.join(' ')) }
    try {
      let snaps = 0
      for (let i = 0; i < 60 && snaps < 12; i++) {
        if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
        if (ctx.state.phase === PHASE.GAME_OVER) break
        if (playDown(ctx, {}).ok) snaps++
      }
      expect(snaps).toBeGreaterThan(0)
      expect(seen).toEqual([])
    } finally {
      console.warn = warn
      destroyTrainingGame(ctx)
    }
  })
})
