import { describe, it, expect } from '@jest/globals'
import { ADJUST_WINDOW, ADJUST_WINDOW_NEW_DRIVE } from '../ai/timing.js'

// [adjust window] The defensive adjust window, and the Ready button that ends it.
//
// The countdown is emitted as a burst of setTimeouts scheduled ALL AT ONCE when the offense locks.
// That shape is why ending it early is not simply "emit a zero": the ticks already queued keep
// arriving, and the countdown visibly walks back up to 4, 3, 2, 1 after it had finished. A token
// stamped on the countdown and checked by every tick is what actually cancels them.
//
// These tests model that scheduling exactly, because the bug lives in the interaction between the
// queue and the early exit rather than in either piece alone.

// A faithful stand-in for the handler's tick loop.
function scheduleCountdown(state, emit, start) {
  const token = (state.countdownToken ?? 0) + 1
  state.countdownToken = token
  const pending = []
  Array.from({ length: start + 1 }, (_, i) => start - i).forEach((count, i) => {
    pending.push({
      at: i,
      fire: () => {
        if (state.phase !== 'countdown' || state.countdownToken !== token) return
        emit(count)
      },
    })
  })
  return pending
}

// What the online Ready press does.
function declareReady(state, emit) {
  if (state.countdownToken == null || state.countdownEnded === state.countdownToken) return false
  // Record the ended token AFTER the bump — recording it first compares the old value against the
  // new one next time, which never matches, and a second press slips through.
  state.countdownToken += 1
  state.countdownEnded = state.countdownToken
  emit(0)
  return true
}

const run = (pending, from = 0) => pending.filter(p => p.at >= from).forEach(p => p.fire())

describe('how long the defense gets', () => {
  it('is longer on the first play of a drive', () => {
    // Same reason the play clock is 40 s there and 25 s after: everything is being placed from
    // scratch, so there is more to do.
    expect(ADJUST_WINDOW_NEW_DRIVE).toBe(15)
    expect(ADJUST_WINDOW).toBe(10)
    expect(ADJUST_WINDOW_NEW_DRIVE).toBeGreaterThan(ADJUST_WINDOW)
  })
})

describe('the countdown ticks down', () => {
  it('emits every second from the start down to zero', () => {
    const state = { phase: 'countdown' }
    const seen = []
    run(scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW))
    expect(seen).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
  })

  it('stops if the phase moves on — a snapped ball ends it', () => {
    const state = { phase: 'countdown' }
    const seen = []
    const pending = scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW)
    run(pending, 0)
    seen.length = 0
    state.phase = 'live'
    run(pending)
    expect(seen).toEqual([])
  })
})

describe('⚠️ READY ENDS IT, AND THE QUEUED TICKS DO NOT COME BACK', () => {
  it('jumps straight to zero', () => {
    const state = { phase: 'countdown' }
    const seen = []
    const pending = scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW)
    run(pending.slice(0, 4))            // 10, 9, 8, 7 have gone out
    expect(declareReady(state, c => seen.push(c))).toBe(true)
    expect(seen).toEqual([10, 9, 8, 7, 0])
  })

  it('⚠️ AND THE REST OF THE COUNTDOWN STAYS CANCELLED', () => {
    // The actual bug: without the token every remaining setTimeout still fires, so after the zero
    // the player watches it count 6, 5, 4, 3, 2, 1 again.
    const state = { phase: 'countdown' }
    const seen = []
    const pending = scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW)
    run(pending.slice(0, 4))
    declareReady(state, c => seen.push(c))
    run(pending, 4)                     // everything still queued now fires
    expect(seen).toEqual([10, 9, 8, 7, 0])
  })

  it('ignores a second press — there is nothing left to end', () => {
    const state = { phase: 'countdown' }
    const seen = []
    scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW)
    expect(declareReady(state, c => seen.push(c))).toBe(true)
    expect(declareReady(state, c => seen.push(c))).toBe(false)
    expect(seen).toEqual([0])
  })

  it('arms cleanly again on the NEXT play', () => {
    // A fresh countdown takes a new token, so last play's cancellation cannot suppress this one.
    const state = { phase: 'countdown' }
    const seen = []
    scheduleCountdown(state, () => {}, ADJUST_WINDOW)
    declareReady(state, () => {})

    const next = scheduleCountdown(state, c => seen.push(c), ADJUST_WINDOW_NEW_DRIVE)
    run(next)
    expect(seen[0]).toBe(15)
    expect(seen[seen.length - 1]).toBe(0)
    expect(declareReady(state, c => seen.push(c))).toBe(true)
  })

  it('does nothing when no countdown is running', () => {
    expect(declareReady({ phase: 'pre_snap' }, () => {})).toBe(false)
  })
})
