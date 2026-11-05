// ── Playing a season game ([seasons]) ──────────────────────────────────────
//
// A season game IS a solo game: the same room, the same computer seat, the same engine. What this file
// adds is everything around it: which game it is, who is home, an autosave on every play, resuming
// from that save, and carrying the final score back into the season.
//
// Imported only by src/socket/index.js. See the note at the top of ai/solo.js for why that matters.

import { randomBytes } from 'node:crypto'
import { getStore } from '../db/store.js'
import { resolveSession } from '../auth/sessions.js'
import { createSoloRoom } from '../ai/solo.js'
import { getRoom } from '../game/roomManager.js'
import { getGame } from '../game/gameState.js'
import { PHASE } from '../game/stateMachine.js'
import { snapshotGame, SNAPSHOT_VERSION } from '../game/snapshot.js'
import { setSeasonHooks } from '../game/seasonHooks.js'
import { getTokensByRoomId } from '../game/sessionManager.js'
import { lockPick, bothLocked, setQuarterLength } from '../game/teamSelect.js'
import { startGameFromSelection } from '../socket/teamSelectHandlers.js'
import { rejoinRoom } from '../socket/roomHandlers.js'
import { TEAM } from './teams.js'
import { beginGame, currentUserGame, seasonView } from './season.js'
import { loadOwned, saveSeason, recordPlayedGame } from './service.js'
import { setSeasonRoom, seasonRoomOf, forgetSeasonRoom, closeRoom, closeSeasonRoomFor } from './rooms.js'

// How long a finished game's room stays up for a player who has not tapped Continue. The season has
// long since been updated, so this only keeps the final-score screen working through a reconnect.
const FINISHED_ROOM_MS = 10 * 60 * 1000

// ── Autosave ─────────────────────────────────────────────────────────────
//
// One write in flight per season, and only the newest waits behind it. A slow database must never queue
// up a backlog of plays, and an old snapshot landing after a newer one would rewind the game.

const saves = new Map()   // seasonId → { inFlight: Promise|null, next: doc|null }

function writeSave(seasonId, doc) {
  let q = saves.get(seasonId)
  if (!q) { q = { inFlight: null, next: null }; saves.set(seasonId, q) }
  q.next = doc
  if (!q.inFlight) pumpSaves(seasonId, q)
  return q
}

function pumpSaves(seasonId, q) {
  const doc = q.next
  q.next = null
  q.inFlight = getStore().putGameSave(seasonId, doc)
    .catch(err => console.error(`[season] autosave failed for ${seasonId}: ${err.message}`))
    .then(() => {
      q.inFlight = null
      if (q.next) pumpSaves(seasonId, q)
      else saves.delete(seasonId)
    })
}

async function savesSettled(seasonId) {
  for (;;) {
    const q = saves.get(seasonId)
    if (!q?.inFlight) return
    await q.inFlight
  }
}

function saveDoc(state, snapshot) {
  return {
    gameId: state.season.gameId,
    version: SNAPSHOT_VERSION,
    snapshot,
    quarter: state.quarter,
    clock: state.clock,
    score: state.score,
    savedAt: new Date().toISOString(),
  }
}

// ── The engine's three signals ───────────────────────────────────────────

const isRoomOver = (state) => state?.phase === PHASE.GAME_OVER

async function finishGame(state, io, roomId) {
  const { seasonId, userId, gameId } = state.season
  const result = {
    us: state.score[0],
    them: state.score[1],
    usTds: state.touchdowns?.[0] ?? 0,
    themTds: state.touchdowns?.[1] ?? 0,
    overtime: !!state.overtime,
  }
  saves.delete(seasonId)   // anything still queued describes a game that is over

  // ⚠️ THE RESULT IS RETRIED. This is the one write in the feature that cannot simply happen again on
  // the next play. If it never lands, the save still holds the last dead ball and the game can be resumed
  // from there, which is the honest fallback, so the retries are about not needing it.
  let recorded = null
  for (let attempt = 0; attempt < 5 && !recorded; attempt++) {
    try {
      await savesSettled(seasonId)
      recorded = await recordPlayedGame(seasonId, userId, gameId, result)
    } catch (err) {
      console.error(`[season] could not record ${gameId} (attempt ${attempt + 1}): ${err.message}`)
      await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
  }
  if (!recorded?.season) {
    console.error(`[season] ${gameId} was not recorded: ${recorded?.error ?? 'database unreachable'}`)
  }

  const socketId = getRoom(roomId)?.players[0]
  if (socketId) {
    io.to(socketId).emit('season_game_final', {
      seasonId,
      gameId,
      recorded: !!recorded?.season,
      season: recorded?.season ? seasonView(recorded.season) : null,
    })
  }

  const timer = setTimeout(() => {
    if (seasonRoomOf(seasonId) === roomId) { closeRoom(roomId); forgetSeasonRoom(seasonId) }
  }, FINISHED_ROOM_MS)
  timer.unref?.()
}

export function installSeasonHooks() {
  setSeasonHooks({
    onCheckpoint(state) {
      if (isRoomOver(state)) return
      try {
        writeSave(state.season.seasonId, saveDoc(state, snapshotGame(state)))
      } catch (err) {
        console.error(`[season] could not snapshot ${state.season.gameId}: ${err.message}`)
      }
    },
    onGameOver(state, io) {
      finishGame(state, io, state.roomId).catch(err => console.error(`[season] finish failed: ${err.stack}`))
    },
    onRoomExpired(state, roomId) {
      console.log(`[season] ${roomId} expired — ${state.season.gameId} stays resumable from its save`)
      forgetSeasonRoom(state.season.seasonId)
    },
  })
}

// ── Sockets ──────────────────────────────────────────────────────────────

function fail(socket, code, message) {
  socket.emit('season_error', { code, message })
}

const starting = new Set()   // seasons being opened right now: a double tap must not open two rooms

async function playSeasonGame(io, socket, payload) {
  const userId = await resolveSession(payload?.token)
  if (!userId) return fail(socket, 'signed_out', 'Please sign in again.')

  const season = await loadOwned(userId, payload?.seasonId)
  if (!season) return fail(socket, 'not_found', 'That season could not be found.')

  // Already running: this is the same player on a new connection, or a second device taking over.
  const runningId = seasonRoomOf(season._id)
  if (runningId) {
    const running = getGame(runningId)
    const token = getTokensByRoomId(runningId)[0]
    if (running && token && !isRoomOver(running)) {
      socket.emit('session_token', token)
      rejoinRoom(io, socket, token)
      return
    }
    closeRoom(runningId)
    forgetSeasonRoom(season._id)
  }

  const game = currentUserGame(season)
  if (!game) return fail(socket, 'no_game', 'You have no game to play right now.')
  const begun = beginGame(season, game.id)
  if (begun.error) return fail(socket, 'no_game', begun.error)

  const opponent = game.home === season.teamId ? game.away : game.home
  if (payload?.aiTeamId !== opponent || !Array.isArray(payload?.aiRoster)) {
    return fail(socket, 'bad_request', 'The opponent roster did not match. Please try again.')
  }

  // A save belongs to the game it was made in. One left over from anything else is ignored.
  const save = await getStore().getGameSave(season._id)
  const snapshot = save?.gameId === game.id && save.version === SNAPSHOT_VERSION ? save.snapshot : null

  await saveSeason(season)

  const roomId = `S${randomBytes(6).toString('hex')}`
  const created = createSoloRoom(io, socket, {
    roomId,
    mode: season.settings.mode,
    difficulty: season.settings.difficulty,
    aiRoster: payload.aiRoster,
    aiTeamId: opponent,
    season: {
      seasonId: season._id,
      gameId: game.id,
      userId,
      year: season.year,
      homeSlot: game.home === season.teamId ? 0 : 1,
      neutral: !!game.neutral,
      playoff: game.round != null,
      superBowl: game.round === 4,
      week: game.week ?? null,
      roundName: game.round != null ? { 1: 'Wild Card', 2: 'Divisional', 3: 'Conference Championship', 4: 'Super Bowl' }[game.round] : null,
    },
    seasonSnapshot: snapshot,
  })
  if (created.error) return fail(socket, 'server_error', 'The game could not be started. Please try again.')

  setSeasonRoom(season._id, roomId)
  socket.data.seasonId = season._id

  // The computer has locked its team. Lock the player's and the game begins through the ordinary path.
  setQuarterLength(roomId, season.settings.quarterMinutes)
  lockPick(roomId, 0, season.teamId)
  io.to(roomId).emit('team_selected', { slot: 0, teamId: season.teamId, locked: true })
  if (bothLocked(roomId)) startGameFromSelection(io, roomId)
  console.log(`[season] ${roomId} ${snapshot ? 'resumed' : 'started'} ${game.id} — ${TEAM[season.teamId].abbr} vs ${TEAM[opponent].abbr}`)
}

// When it is safe to walk away: the ball is dead and no kick is mid-flight. During a live play the
// answer is "after this play", because quitting mid-down would be a way to undo it.
export function canSaveAndQuit(state) {
  if (!state?.season || state.phase === PHASE.GAME_OVER || state.phase === PHASE.LIVE) return false
  if (state.specialTeams) return false
  return true
}

export function registerSeasonHandlers(io, socket) {
  socket.on('season_play', async (payload) => {
    const key = String(payload?.seasonId ?? '')
    if (starting.has(key)) return
    starting.add(key)
    try {
      await playSeasonGame(io, socket, payload)
    } catch (err) {
      console.error(`[season] could not start a game: ${err.stack ?? err.message}`)
      fail(socket, 'unavailable', 'Seasons are unavailable right now. Please try again.')
    } finally {
      starting.delete(key)
    }
  })

  socket.on('season_save_quit', async () => {
    const roomId = socket.data.roomId
    const state = roomId ? getGame(roomId) : null
    if (!state?.season) return
    if (!canSaveAndQuit(state)) return fail(socket, 'not_now', 'You can save once this play is over.')
    const { seasonId } = state.season
    try {
      writeSave(seasonId, saveDoc(state, snapshotGame(state)))
      await savesSettled(seasonId)
      socket.data.roomId = null
      closeSeasonRoomFor(seasonId)
      socket.emit('season_saved', { seasonId })
    } catch (err) {
      console.error(`[season] save and quit failed: ${err.message}`)
      fail(socket, 'unavailable', 'The game could not be saved. Please try again.')
    }
  })

  // Done with the final-score screen.
  socket.on('season_leave', () => {
    const roomId = socket.data.roomId
    const state = roomId ? getGame(roomId) : null
    if (!state?.season || !isRoomOver(state)) return
    const { seasonId } = state.season
    socket.data.roomId = null
    closeSeasonRoomFor(seasonId)
  })
}
