// ── The stat spotlight ([spotlight]) ─────────────────────────────────────────
//
// Now and then, after somebody makes a play, the broadcast shows his line for the game — the way a
// TV graphic pops up after a big run. Requested rules, all in one place so they can be read at once:
//
//   • nothing until BOTH teams have had the ball (a box score of one drive is not a box score)
//   • a RUN of more than 5 yards:  50% chance — the runner
//   • a PASS of more than 8 yards: 60% chance — half the receiver, half the passer
//   • a SACK:                      always — the man who got it
//   • an INTERCEPTION:             always — the man who got it
//   • a TACKLE FOR LOSS:           50% — the tackler (a run, or a catch dropped behind the line)
//
// ⚠️ A DEFENDER ONLY EVER APPEARS FOR A PLAY HE WON. "Don't display defensive player stats during big
// plays. Instead show them during turnovers, sacks and TFL." The man who finally tackled a 40-yard
// gain used to get a share of that gain's graphic.
//
// In a season game, after Week 5, a quarter of the graphics show the player's numbers for the year
// instead of for the game ([season stats]). Every graphic is eligible, whoever it is for.
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
  PASS_MIN_YARDS: 8,     // more than this
  PASS_CHANCE: 0.6,
  PASS_RECEIVER_SHARE: 0.5,
  LOSS_CHANCE: 0.5,
  SEASON_AFTER_WEEK: 5,  // "after week 5": from Week 6 on, and all through the playoffs
  SEASON_CHANCE: 0.25,
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
export function chooseSpotlight({ kind, yards = 0, carrier = null, passer = null, tackler = null, sacker = null, interceptor = null }, rng = Math.random) {
  if (kind === 'sack') return sacker ? { who: sacker, role: 'sacker' } : null
  if (kind === 'interception') return interceptor ? { who: interceptor, role: 'interceptor' } : null

  // A tackle for loss is the defender's play, whatever was called. No tackler (he stepped out behind
  // the line) means nobody made it, so there is nothing to show.
  if ((kind === 'run' || kind === 'pass') && yards < 0) {
    if (!tackler) return null
    return rng() < SPOTLIGHT.LOSS_CHANCE ? { who: tackler, role: 'tackler' } : null
  }

  if (kind === 'run') {
    if (!(yards > SPOTLIGHT.RUN_MIN_YARDS)) return null
    if (!(rng() < SPOTLIGHT.RUN_CHANCE)) return null
    return carrier ? { who: carrier, role: 'rusher' } : null
  }

  if (kind === 'pass') {
    if (!(yards > SPOTLIGHT.PASS_MIN_YARDS)) return null
    if (!(rng() < SPOTLIGHT.PASS_CHANCE)) return null
    if (rng() < SPOTLIGHT.PASS_RECEIVER_SHARE) return carrier ? { who: carrier, role: 'receiver' } : null
    return passer ? { who: passer, role: 'passer' } : (carrier ? { who: carrier, role: 'receiver' } : null)
  }

  return null
}

const LINE_FIELDS = [
  'attempts', 'completions', 'passYards', 'passTD', 'interceptionsThrown',
  'carries', 'rushYards', 'rushTD',
  'receptions', 'recYards', 'recTD',
  'tackles', 'tfl', 'sacks', 'interceptions',
]

// Only the counting stats a graphic shows. The client picks which to print by role. `before` is his
// year so far, when the graphic is for the season: today's game is not in it yet.
function publicLine(line, before = null) {
  const out = {}
  for (const field of LINE_FIELDS) out[field] = (line[field] ?? 0) + (before?.[field] ?? 0)
  return out
}

// A season game after Week 5: one graphic in four is the player's year. Week is null in the playoffs.
function showsSeasonLine(state, rng) {
  const { season } = state
  if (!season?.totals) return false
  if (season.week != null && season.week <= SPOTLIGHT.SEASON_AFTER_WEEK) return false
  return rng() < SPOTLIGHT.SEASON_CHANCE
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
    const rng = spotlightRng(state)
    const pick = chooseSpotlight(play, rng)
    if (!pick?.who?.id) return null
    const line = lineOf(state.stats, pick.who.id, pick.who.slot ?? null)
    if (!line) return null
    const scope = showsSeasonLine(state, rng) ? 'season' : 'game'
    const before = scope === 'season' ? (state.season.totals[`${line.slot}:${line.id}`] ?? null) : null
    const payload = {
      id: line.id, slot: line.slot, name: line.name, label: line.label, role: pick.role, scope,
      // The new line of scrimmage, in the offense's frame — a portrait phone puts the card at the
      // end of the field the ball is not at.
      yardLine: state.yardLine,
      line: publicLine(line, before),
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
