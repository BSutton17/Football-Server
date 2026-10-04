import { describe, it, expect } from '@jest/globals'
import { beginPlayerPause, resumePlayerPause, isPlayerPaused, isAutoPaused, STOPPAGE, beginStoppage } from '../game/pause.js'

// ── ⚠️ A PAUSE THE SERVER CALLED, THAT NOTHING EVER LIFTED ──────────────────
//
// Reported as the game freezing, and narrowed by the player to "I think the issue is after unpausing"
// and "the game itself is freezing".
//
// The disconnect handler pauses a SOLO game when the human's socket drops — a phone sleeping in a
// pocket, backgrounding the tab, a network blip — so the computer does not play on to an empty stadium.
// Its comment has always promised "Reconnecting resumes it". ⚠️ NOTHING EVER DID: `resumePlayerPause`
// was not called anywhere in roomHandlers. The player came back to a game frozen on a stoppage they
// never asked for, with every button phase-gated into a silent refusal and no clock running to get out
// of it.
//
// The distinction below is the whole fix. A pause the PLAYER asked for has to survive their phone
// dropping — stepping away would otherwise cost them the thing they stepped away for. A pause the
// SERVER called on their behalf must not.

const game = () => ({ roomId: 'ap', stoppage: null })

describe('an automatic pause', () => {
  it('is marked as automatic, and a deliberate one is not', () => {
    const a = game(); beginPlayerPause(a, 0, { automatic: true })
    const b = game(); beginPlayerPause(b, 0)
    expect(isAutoPaused(a)).toBe(true)
    expect(isAutoPaused(b)).toBe(false)
    expect(isPlayerPaused(b)).toBe(true)   // …but it IS a pause
  })

  it('stops being automatic once it is lifted', () => {
    const s = game()
    beginPlayerPause(s, 0, { automatic: true })
    resumePlayerPause(s)
    expect(isAutoPaused(s)).toBe(false)
    expect(isPlayerPaused(s)).toBe(false)
  })

  // ⚠️ AND IT STILL PUTS BACK WHATEVER IT INTERRUPTED. A disconnect during a manual freeze must not
  // quietly un-freeze the board when the player returns — the play would resume with nobody holding GO.
  it('restores the stoppage it interrupted', () => {
    const s = game()
    beginStoppage(s, STOPPAGE.MANUAL_HOLD, null)
    beginPlayerPause(s, 0, { automatic: true })
    expect(isPlayerPaused(s)).toBe(true)
    resumePlayerPause(s)
    expect(s.stoppage?.reason).toBe(STOPPAGE.MANUAL_HOLD)
  })

  it('does not stack — a second pause over a pause changes nothing', () => {
    const s = game()
    beginPlayerPause(s, 0, { automatic: true })
    expect(beginPlayerPause(s, 1)).toBe(false)
    expect(isAutoPaused(s)).toBe(true)     // still the automatic one, not replaced
  })
})
