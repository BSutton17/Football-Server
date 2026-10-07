// ── The stat spotlight ([spotlight]) ─────────────────────────────────────────
//
// Now and then, after somebody makes a play, the broadcast shows his line for the game — the way a
// TV graphic pops up after a big run. Requested rules, all in one place so they can be read at once:
//
//   • nothing until BOTH teams have had the ball (a box score of one drive is not a box score)
//   • a RUN of more than 5 yards:  50% chance — then 75% the runner, 25% the tackler
//   • a PASS of more than 8 yards: 60% chance — then 45% the receiver, 45% the passer, 10% the tackler
//   • a SACK:                      always — the man who got it
//   • a TACKLE FOR LOSS:           50% — the tackler (a run, or a catch dropped behind the line)
//
// The server decides and sends the line itself, so both screens show the same player with the same
// numbers. Where it appears and how long it stays (four seconds) are the client's business (StatSpotlight.tsx).
//
// ⚠️ ITS OWN RANDOM STREAM. A seeded game is replayable tick for tick, and every engine roll is drawn
// from `state.rng`; drawing the spotlight's coin flips from that same stream would shift every roll
// after the first big run, changing the football to decide a graphic. So it has a stream of its own.

import { makeRng } from './utils/rng.js'
import { lineOf } from './stats.js'

export const SPOTLIGHT = {
  RUN_MIN_YARDS: 5,      // more than this
  RUN_CHANCE: 0.5,
  RUN_RUNNER_SHARE: 0.75,
  PASS_MIN_YARDS: 8,     // more than this
  PASS_CHANCE: 0.6,
  PASS_RECEIVER_SHARE: 0.45,
  PASS_PASSER_SHARE: 0.45,
  LOSS_CHANCE: 0.5,
}

// Called at every snap: this team has now had the ball.
export function noteHadBall(state) {
  if (!state) return
  if (!Array.isArray(state.hadBall)) state.hadBall = [false, false]
  if (state.possession === 0 || state.possession === 1) state.hadBall[state.possession] = true
}

export function bothTeamsHaveHadBall(state) {
  return !!(state?.hadBall?.[0] && state?.hadBall?.[1])
}

function spotlightRng(state) {
  if (!state.spotlightRng) {
    state.spotlightRng = state.seed == null ? Math.random : makeRng(((state.seed >>> 0) ^ 0x5f0711) >>> 0)
  }
  return state.spotlightRng
}

// Who, if anyone, a play puts in the spotlight. Pure: the rolls come from `rng`.
//
// A tackler is not always there to show — a man who stepped out of bounds was not tackled — so the
// tackler's share falls back to the ball carrier rather than to nothing; the roll already said this
// play earned a graphic.
export function chooseSpotlight({ kind, yards = 0, carrier = null, passer = null, tackler = null, sacker = null }, rng = Math.random) {
  if (kind === 'sack') return sacker ? { who: sacker, role: 'sacker' } : null

  // A tackle for loss is the defender's play, whatever was called. No tackler (he stepped out behind
  // the line) means nobody made it, so there is nothing to show.
  if ((kind === 'run' || kind === 'pass') && yards < 0) {
    if (!tackler) return null
    return rng() < SPOTLIGHT.LOSS_CHANCE ? { who: tackler, role: 'tackler' } : null
  }

  if (kind === 'run') {
    if (!(yards > SPOTLIGHT.RUN_MIN_YARDS)) return null
    if (!(rng() < SPOTLIGHT.RUN_CHANCE)) return null
    const r = rng()
    if (r < SPOTLIGHT.RUN_RUNNER_SHARE || !tackler) return carrier ? { who: carrier, role: 'rusher' } : null
    return { who: tackler, role: 'tackler' }
  }

  if (kind === 'pass') {
    if (!(yards > SPOTLIGHT.PASS_MIN_YARDS)) return null
    if (!(rng() < SPOTLIGHT.PASS_CHANCE)) return null
    const r = rng()
    if (r < SPOTLIGHT.PASS_RECEIVER_SHARE) return carrier ? { who: carrier, role: 'receiver' } : null
    if (r < SPOTLIGHT.PASS_RECEIVER_SHARE + SPOTLIGHT.PASS_PASSER_SHARE) {
      return passer ? { who: passer, role: 'passer' } : (carrier ? { who: carrier, role: 'receiver' } : null)
    }
    if (tackler) return { who: tackler, role: 'tackler' }
    return carrier ? { who: carrier, role: 'receiver' } : null
  }

  return null
}

// Only the counting stats a graphic shows. The client picks which to print by role.
function publicLine(line) {
  return {
    attempts: line.attempts, completions: line.completions, passYards: line.passYards,
    passTD: line.passTD, interceptionsThrown: line.interceptionsThrown,
    carries: line.carries, rushYards: line.rushYards, rushTD: line.rushTD,
    receptions: line.receptions, recYards: line.recYards, recTD: line.recTD,
    tackles: line.tackles, sacks: line.sacks, interceptions: line.interceptions,
  }
}

// Decide at the whistle, SHOW at the next line-up. Requested: "the stats shouldn't happen until the
// ball is set for the next play, not immediately." So the decision is made here — while the play that
// earned it, and its numbers, are known — and parked on the state; `releaseSpotlight` sends it once
// the next play has been set up (startNextPlay). Call AFTER the play's numbers are recorded, so the
// line includes the play that earned it. Never throws: a graphic must not be able to stop a play.
export function maybeSpotlight(state, io, play) {
  try {
    if (!state?.stats || !io) return null
    if (!bothTeamsHaveHadBall(state)) return null
    const pick = chooseSpotlight(play, spotlightRng(state))
    if (!pick?.who?.id) return null
    const line = lineOf(state.stats, pick.who.id, pick.who.slot ?? null)
    if (!line) return null
    const payload = {
      id: line.id, slot: line.slot, name: line.name, label: line.label, role: pick.role,
      // The new line of scrimmage, in the offense's frame — a portrait phone puts the card at the
      // end of the field the ball is not at.
      yardLine: state.yardLine,
      line: publicLine(line),
    }
    state.pendingSpotlight = payload
    return payload
  } catch (err) {
    console.warn(`[spotlight] ${state?.roomId} skipped: ${err?.message ?? err}`)
    return null
  }
}

// Sends the parked graphic, if there is one, now that the ball is spotted for the next play. The
// yard line is refreshed to the line the ball now sits on, because that — not where the last play
// ended — is what a portrait phone places the card against.
export function releaseSpotlight(state, io) {
  const payload = state?.pendingSpotlight
  if (!payload) return null
  state.pendingSpotlight = null
  try {
    const out = { ...payload, yardLine: state.yardLine }
    io?.to(state.roomId).emit('stat_spotlight', out)
    return out
  } catch (err) {
    console.warn(`[spotlight] ${state?.roomId} not sent: ${err?.message ?? err}`)
    return null
  }
}
