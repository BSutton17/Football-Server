import { describe, it, expect } from '@jest/globals'
import { createTrainingGame, destroyTrainingGame } from '../training/game.js'
import { stepUntil } from '../headless/harness.js'
import { beginSpecialTeams, serializeSpecialTeams, KICK, fgBlockRegion } from '../game/specialTeams.js'
import { broadcastSpecialTeams } from '../game/eventQueue.js'
import { specialTeamsAction, FG_BLOCK_CHANCE } from '../ai/specialTeams.js'
import { PHASE } from '../game/stateMachine.js'

// [fg block] The computer read `st.blockAvailable` to decide whether to block, and the server has never sent it.
// So it never tried: not once, in any game. These go through what the server really sends.

const stub = () => ({ onEvent() {} })

function kickAgainstTheComputer(seed, kickType, whenDone) {
  const kicker = 0
  const ctx = createTrainingGame({ seed, controllers: { [kicker]: stub() } })
  try {
    const s = ctx.state
    Object.assign(s, { possession: kicker, direction: 1, phase: PHASE.PRE_SNAP, yardLine: 70, down: 4, distance: 5, specialTeams: null })
    beginSpecialTeams(s, kickType, { kickingSlot: kicker })
    broadcastSpecialTeams(s, ctx.io)
    ctx.seats[kicker].fire('special_teams_input', { aim: 'left' })     // a human's first tap
    return whenDone(ctx, s)
  } finally {
    if (ctx.state.nextPlayTimer) clearTimeout(ctx.state.nextPlayTimer)
    destroyTrainingGame(ctx)
  }
}

const runKick = (ctx) => stepUntil(ctx.roomId, ctx.io, st => st.phase !== PHASE.PRE_SNAP, { maxTicks: 200 })

describe('[fg block] the computer', () => {
  const seen = (over) => serializeSpecialTeams({ specialTeams: { kickType: KICK.FIELD_GOAL, phase: 'setup', kickingSlot: 0, playerControlled: true, power: 1, angle: 0, started: true, kickTimer: 0.5, ...over }, ballX: 26, yardLine: 70, direction: 1, possession: 0 }, 1)

  it('aims for the green, so a block it goes for is a block', () => {
    const k = { aiKick: null, specialTeams: seen() }
    const action = specialTeamsAction(k, () => 0)
    expect(action.event).toBe('fg_block')
    expect(fgBlockRegion(action.payload.position)).toBe('green')
  })

  it('rolls once a kick: a miss on the roll is not asked again on the next meter update', () => {
    const k = { aiKick: null, specialTeams: seen() }
    const rolls = []
    const rng = () => { rolls.push(1); return 0.99 }
    for (let i = 0; i < 20; i++) expect(specialTeamsAction(k, rng)).toBeNull()
    expect(rolls).toHaveLength(1)
  })

  it('waits for the kick to go up rather than blocking the first tap', () => {
    const k = { aiKick: null, specialTeams: seen({ kickTimer: 3.4 }) }
    expect(specialTeamsAction(k, () => 0)).toBeNull()
    k.specialTeams = seen({ kickTimer: 0.9 })
    expect(specialTeamsAction(k, () => 0)?.event).toBe('fg_block')
  })

  it('does nothing before the kicker starts, or for a kick of its own', () => {
    expect(specialTeamsAction({ aiKick: null, specialTeams: seen({ started: false }) }, () => 0)).toBeNull()
    expect(specialTeamsAction({ aiKick: null, specialTeams: seen({ blockAttempted: true }) }, () => 0)).toBeNull()
  })

  // ⚠️ THE RATE IS THE POINT. Rolling per update instead of per kick would make it several times the 1% the design
  // fixed, and leaving the field unread makes it nothing. 1,500 real kicks, through the real brain and handler.
  it('blocks about 1% of real kicks against a human kicker, both kinds', () => {
    const KICKS = 1500
    let attempts = 0, blocked = 0
    for (let n = 0; n < KICKS; n++) {
      kickAgainstTheComputer(7000 + n, n % 2 ? KICK.FIELD_GOAL : KICK.EXTRA_POINT, (ctx, s) => {
        const st = s.specialTeams
        runKick(ctx)
        if (st.blockAttempted) attempts++
        if (st.blocked) blocked++
      })
    }
    expect(FG_BLOCK_CHANCE).toBe(0.01)
    expect(blocked).toBe(attempts)        // it only goes when it means it, at the green
    expect(blocked).toBeGreaterThanOrEqual(5)
    expect(blocked).toBeLessThanOrEqual(35)
  })
})
