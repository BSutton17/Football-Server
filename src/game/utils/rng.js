// ── Seeded randomness ([determinism]) ────────────────────────────────────────
//
// Production play uses Math.random and always has. This module exists for the two things that
// cannot: replaying a game exactly, and training an AI, where the same genome facing the same
// situation must produce the same play or a fitness score means nothing.
//
// The whole generator state is ONE uint32, so a run can be checkpointed and resumed mid-stream by
// writing down a single number. That is the same property the Kingdoms trainer relied on, and it is
// worth more than a statistically fancier generator here: every consumer of this is a coin flip or
// a percentile lookup, not a Monte Carlo integration.
//
// mulberry32 — small, fast, passes gjrand's basic suite, period 2^32.

// A game's randomness is reached through `rngOf(state)` rather than by calling Math.random
// directly. Every site that used to call Math.random now goes through it, so seeding a game is a
// single assignment at creation and nothing downstream has to know.

const UINT32 = 0x100000000

export function makeRng(seed = 1) {
  // Keep the seed away from 0: mulberry32 starting at 0 spends its first few outputs near zero,
  // which is exactly the range most of the callers here compare against.
  let s = (seed >>> 0) || 0x9e3779b9

  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / UINT32
  }

  // The generator's entire state, for checkpoint + resume. Reading it never advances the stream.
  next.getState = () => s
  next.setState = (v) => { s = (v >>> 0) || 0x9e3779b9 }
  next.seed     = seed >>> 0
  next.seeded   = true

  return next
}

// The randomness a game should use. Precedence: an explicit override (tests inject a stub and must
// keep winning), then the game's own seeded generator, then Math.random for ordinary play.
//
// Written as a helper rather than a `rng = Math.random` default parameter because the default only
// fires when the caller passes nothing — and the callers are systems invoked as (state, io, dt),
// which pass nothing and would therefore never see the game's seed.
export function rngOf(state, override) {
  return override ?? state?.rng ?? Math.random
}

// True when this game is running on a seeded stream — i.e. it is replayable. Training asserts this.
export function isSeeded(state) {
  return !!state?.rng?.seeded
}
