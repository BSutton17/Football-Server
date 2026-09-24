// ── Solo games: seating a computer opponent ([offline]) ──────────────────────
//
// A solo room is an ORDINARY room whose second seat happens to be a virtual socket instead of a
// phone. Everything downstream — team selection, the tick loop, validation, serialization — runs
// unchanged and unaware. That is deliberate: the moment offline mode needs its own copy of any of
// that, the two copies start to disagree, and the AI stops being a test of the real game.
//
// The one thing that genuinely differs is the SEED. A solo game is created seeded, so it is
// replayable: the same call in the same situation produces the same play. That is what makes an
// AI's score mean something rather than measuring luck, and it is also how a reported bug in an
// offline game can be reproduced exactly.
//
// This module imports the socket handler registrars, so nothing in src/socket/ may import IT —
// the entry point is src/socket/index.js, which is imported by nobody. Keeps the graph acyclic.

import { createRoom, joinRoom, getRoom } from '../game/roomManager.js'
import { updatePlayer } from '../game/playerRegistry.js'
import { createSession } from '../game/sessionManager.js'
import { beginTeamSelect, getTeamSelect } from '../game/teamSelect.js'
import { TEAMS } from '../data/teams.js'
import { makeRng } from '../game/utils/rng.js'
import { createVirtualSocket } from './virtualSocket.js'
import { registerAiSeat, clearAiSeats, bridgeIo } from './seats.js'
import { createController } from './controller.js'
import { createDeepDefenseBrain } from '../training/deepBrainDefense.js'
import { trainedDefenseGenome, useTrainedDefense } from './trainedDefense.js'
import { normalizeRoster } from './roster.js'
import { markSoloRoom } from './timing.js'

import { registerRoomHandlers } from '../socket/roomHandlers.js'
import { registerTeamSelectHandlers } from '../socket/teamSelectHandlers.js'
import { registerGameHandlers } from '../socket/gameHandlers.js'

const TEAM_IDS = TEAMS.map(t => t.id)

// Seeds are visible in logs and replayable by hand, so an unseeded solo game gets a fresh random
// one rather than a fixed default — otherwise every offline game would play out identically.
function freshSeed() {
  return (Math.random() * 0xffffffff) >>> 0
}

// Stands up a solo room: the human in slot 0, a computer opponent in slot 1.
//
// `controller` is optional and is the AI's brain — an object with `onEvent(event, payload)`. Left
// out, the seat is a silent placeholder that occupies slot 1 and locks a team but never plays,
// which is exactly what Phase 0 needs to prove the plumbing before there is anything to think with.
export function createSoloRoom(io, humanSocket, { roomId, mode, difficulty, seed = null, controller = null, aiRoster = null, aiTeamId = null } = {}) {
  const gameSeed = seed ?? freshSeed()
  const rng      = makeRng(gameSeed)

  // `solo: true` is what lets an offline AUTOMATIC room keep the difficulty it was created with —
  // see the note in createRoom. Without it, picking Hard in the offline panel silently produced the
  // easy computer.
  const created = createRoom(roomId, humanSocket.id, { mode, difficulty, seed: gameSeed, solo: true })
  if (created.error) return { error: created.error }

  // ── Slot 0: the human, exactly as create_room would seat them ─────────────
  humanSocket.join(roomId)
  humanSocket.data.roomId = roomId
  updatePlayer(humanSocket.id, { roomId })

  // ── Slot 1: the computer ──────────────────────────────────────────────────
  // The brain is attached AFTER the socket exists (it needs to fire events through it), so the
  // inbox is routed through a mutable holder rather than captured at construction.
  const brain = { current: controller }
  const ai = createVirtualSocket(roomId, {
    slot: 1,
    role: 'defense',                       // provisional; the join below settles it
    onEvent: (e, p) => brain.current?.onEvent(e, p),
  })
  registerAiSeat(ai)

  // The AI plays through the SAME handlers a phone does. Registering them here is what makes
  // `ai.fire('place_player', …)` go through `validatePlacePlayer` like everyone else.
  const bridged = bridgeIo(io)
  registerRoomHandlers(bridged, ai)
  registerTeamSelectHandlers(bridged, ai)
  registerGameHandlers(bridged, ai)

  const joined = joinRoom(roomId, ai.id, { mode, rng })
  if (joined.error) {
    clearAiSeats(roomId)
    return { error: joined.error }
  }

  ai.data.roomId = roomId
  updatePlayer(ai.id, { roomId })

  // ── Roles + team selection ────────────────────────────────────────────────
  beginTeamSelect(roomId)

  const room        = getRoom(roomId)
  const offenseSlot = room?.offenseSlot ?? 0
  const humanRole   = offenseSlot === 0 ? 'offense' : 'defense'
  const aiRole      = offenseSlot === 1 ? 'offense' : 'defense'

  humanSocket.data.role = humanRole
  ai.data.role          = aiRole
  updatePlayer(humanSocket.id, { role: humanRole })
  updatePlayer(ai.id,          { role: aiRole })

  // Only the human gets a session token. A virtual seat cannot lose its connection, so it has
  // nothing to reconnect with — and a token for it would linger in the room's token list and be
  // swept as if a real player had walked away.
  const token = createSession(humanSocket.id, roomId, 0, humanRole)

  humanSocket.emit('room_joined', { slot: 0, mode: created.mode, difficulty: created.difficulty })
  humanSocket.emit('roles_assigned', { role: humanRole })
  humanSocket.emit('session_token', token)
  humanSocket.emit('team_select_start', {
    slot: 0,
    teamIds: TEAM_IDS,
    quarterMinutes: getTeamSelect(roomId)?.quarterMinutes,
    defenseSeesOpenness: getTeamSelect(roomId)?.defenseSeesOpenness,
  })

  // The computer picks first and locks straight away, so the human sees a settled opponent rather
  // than an empty slot. Locking first also means the existing duplicate-team rule does the work of
  // keeping the two apart — the human simply cannot pick a team that is already taken.
  //
  // The player may name the opponent, or leave it to the seed. An unknown id is treated as "random"
  // rather than refused: a stale client should still get a game, not an error screen.
  const chosen = TEAM_IDS.includes(aiTeamId) ? aiTeamId : TEAM_IDS[Math.floor(rng() * TEAM_IDS.length)]
  ai.fire('lock_team', { teamId: chosen })

  // Now the brain, with the roster it just locked. Built after the lock so it has real players to
  // pick from rather than a placeholder it would have to be told about later.
  if (!brain.current) {
    // [deep] HARD mode fields the TRAINED coordinator; easy and medium keep the heuristic with
    // their handicaps. The trained brain is a drop-in — same socket, same slot, same roster — and
    // falls back to the heuristic on its own if the genome will not load.
    const trained = useTrainedDefense(created.difficulty) ? trainedDefenseGenome() : null
    const build = trained ? createDeepDefenseBrain : createController
    brain.current = build({
      socket: ai,
      slot: 1,
      ...(trained ? { genome: trained } : {}),
      // The server has no player data — rosters live on the client (see ai/roster.js). A solo room
      // may hand the computer's roster over at creation; without one it fields a synthetic team of
      // average players, which plays correctly and is what the headless harness uses.
      roster: normalizeRoster(aiRoster, chosen),
      seed: gameSeed ^ 0x5bf03635,   // its own stream, so AI decisions do not consume the game's
      log: process.env.AI_LOG === '1',
    })
  }

  // Flagged on the ROOM, because the game state does not exist yet — it is created when both
  // teams lock. startGameFromSelection copies the flag across.
  const room2 = getRoom(roomId)
  if (room2) room2.solo = true

  console.log(`[solo] ${roomId} seeded ${gameSeed} — human ${humanRole} slot 0, AI ${aiRole} slot 1 (${chosen}${aiTeamId ? '' : ', random'})`)

  return { roomId, slot: 0, seed: gameSeed, aiSocketId: ai.id, aiTeamId: chosen, role: humanRole, mode: created.mode, difficulty: created.difficulty }
}

// Tear the computer seat down with the room.
export function endSoloRoom(roomId) {
  clearAiSeats(roomId)
}
