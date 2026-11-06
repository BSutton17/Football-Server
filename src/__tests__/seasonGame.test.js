import { describe, it, expect, beforeEach, afterEach } from '@jest/globals'
import { createMemoryStore, setStore, getStore } from '../db/store.js'
import { createSession } from '../auth/sessions.js'
import { createFakeIo } from '../headless/harness.js'
import { createTrainingGame, destroyTrainingGame, playDown } from '../training/game.js'
import { getGame } from '../game/gameState.js'
import { PHASE, transition } from '../game/stateMachine.js'
import { startNextPlay, resolveDecision, resolveConversion, resolveOnsideChoice, enqueue, processQueue, EVENT } from '../game/eventQueue.js'
import { snapshotGame, hydrateGame } from '../game/snapshot.js'
import { endStoppage } from '../game/pause.js'
import { setSeasonHooks } from '../game/seasonHooks.js'
import { getSlotByToken, getTokensByRoomId } from '../game/sessionManager.js'
import {
  recordPassOutcome, recordRun, recordScramble, activeXFactorIds, applyXFactorFlags, HOME_EDGE, XF,
} from '../game/systems/xFactors.js'
import { serializeGameState } from '../game/serialization.js'
import { installSeasonHooks, registerSeasonHandlers, canSaveAndQuit } from '../season/gameRoom.js'
import { seasonRoomOf, closeSeasonRoomFor, forgetSeasonRoom } from '../season/rooms.js'
import { createNewSeason, recordPlayedGame, setScheduleFetcher } from '../season/service.js'
import { currentUserGame } from '../season/season.js'
import { ROSTER as LEAGUE } from '../season/rosters.js'
import { recordRush } from '../game/stats.js'

// ── The whole path: sign in, start a game, autosave, lose the server, resume, finish ──

const USER = 'google:123'
const ROSTER = [
  ...['wr1', 'wr2', 'wr3', 'wr4', 'te1', 'te2', 'te3', 'rb1', 'rb2'].map((p, i) => ({
    id: `x_${p}`, position: p.slice(0, 2).toUpperCase(), ovr: 80 + i, name: p, ratings: { speed: 88 },
  })),
  ...['cb1', 'cb2', 'cb3', 'cb4', 's1', 's2', 's3', 'lb1', 'lb2', 'lb3', 'lb4'].map((p, i) => ({
    id: `x_${p}`, position: p.replace(/\d/, '').toUpperCase(), ovr: 80 + i, name: p, ratings: { speed: 88 },
  })),
]

function humanSocket(id = 'phone-1') {
  const handlers = new Map()
  const emits = []
  return {
    id,
    data: {},
    emits,
    on: (e, fn) => handlers.set(e, fn),
    emit: (e, p) => emits.push({ event: e, payload: p }),
    join: () => {},
    leave: () => {},
    disconnect: () => {},
    to: () => ({ emit: () => {} }),
    fire: (e, p) => handlers.get(e)?.(p),
    sent: (e) => emits.filter(x => x.event === e),
  }
}

const settle = async (ms = 0) => { await new Promise(r => setTimeout(r, ms)); await new Promise(r => setImmediate(r)) }

async function waitFor(cond, ms = 2000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await cond()
    if (v) return v
    await settle(5)
  }
  throw new Error('timed out waiting')
}

describe('[seasons] a game, end to end', () => {
  let io, sock, token, season, opened = []

  beforeEach(async () => {
    setStore(createMemoryStore())
    setScheduleFetcher(async () => { throw new Error('no network in tests') })   // the bundled schedule
    installSeasonHooks()
    io = createFakeIo()
    sock = humanSocket()
    registerSeasonHandlers(io, sock)
    token = await createSession(USER)
    const made = await createNewSeason(USER, {
      slot: 0, teamId: 'KC', settings: { mode: 'automatic', difficulty: 'medium', quarterMinutes: 4 },
    })
    season = made.season
    opened = [season._id]
  })

  afterEach(() => {
    for (const id of opened) closeSeasonRoomFor(id)
    setSeasonHooks({ onCheckpoint: () => {}, onGameOver: () => {}, onRoomExpired: () => {} })
  })

  const opponentOf = (s) => {
    const g = currentUserGame(s)
    return g.home === s.teamId ? g.away : g.home
  }

  async function startGame(socket = sock, s = season) {
    socket.fire('season_play', { token, seasonId: s._id, aiTeamId: opponentOf(s), aiRoster: ROSTER })
    return waitFor(() => {
      const roomId = seasonRoomOf(s._id)
      return roomId && getGame(roomId)
    })
  }

  it('⚠️ REFUSES WITHOUT A VALID LOGIN', async () => {
    sock.fire('season_play', { token: 'nope-nope-nope-nope-nope-nope', seasonId: season._id })
    await waitFor(() => sock.sent('season_error').length)
    expect(sock.sent('season_error')[0].payload.code).toBe('signed_out')
    expect(seasonRoomOf(season._id)).toBeNull()
  })

  it('⚠️ REFUSES SOMEBODY ELSE\'S SEASON', async () => {
    const other = await createSession('google:someone-else')
    sock.fire('season_play', { token: other, seasonId: season._id })
    await waitFor(() => sock.sent('season_error').length)
    expect(sock.sent('season_error')[0].payload.code).toBe('not_found')
  })

  it('starts with the season\'s settings, the real matchup and the right home side', async () => {
    const state = await startGame()
    const game = currentUserGame(season)
    expect(state.mode).toBe('automatic')
    expect(state.difficulty).toBe('medium')
    expect(state.quarterSeconds).toBe(240)
    expect(state.season.gameId).toBe(game.id)
    expect(state.season.homeSlot).toBe(game.home === 'KC' ? 0 : 1)
    expect(state.teams[0]).toBe('KC')
    expect(state.teams[1]).toBe(opponentOf(season))
    // No team select screen: the schedule has already decided.
    expect(sock.sent('team_select_start')).toHaveLength(0)
    expect(sock.sent('season_game_start')[0].payload.resuming).toBe(false)
    expect(io.of('team_select_complete')).toHaveLength(1)
    // The client hears who is home.
    expect(serializeGameState(state, 0).season.homeSlot).toBe(state.season.homeSlot)
  })

  it('marks the game as begun, so it can no longer be simulated instead', async () => {
    await startGame()
    const stored = await getStore().getSeason(season._id)
    expect(stored.activeGameId).toBe(currentUserGame(season).id)
  })

  it('⚠️ AUTOSAVES ON EVERY PLAY', async () => {
    const state = await startGame()
    transition(state, PHASE.COUNTDOWN); transition(state, PHASE.DEAD)
    state.score = [7, 3]
    startNextPlay(state.roomId, io)
    const save = await waitFor(() => getStore().getGameSave(season._id))
    expect(save.gameId).toBe(state.season.gameId)
    expect(save.score).toEqual([7, 3])
  })

  it('⚠️ A SERVER RESTART LOSES NOTHING: score, clock, ball and fatigue all come back from the save', async () => {
    const state = await startGame()
    transition(state, PHASE.COUNTDOWN); transition(state, PHASE.DEAD)
    Object.assign(state, { score: [21, 17], quarter: 3, clock: 77, possession: 1, direction: -1, yardLine: 41, down: 3, distance: 6 })
    state.playerFatigue.set('kc_wr1', { stamina: 44, label: 'WR', slot: 0 })
    startNextPlay(state.roomId, io)
    await waitFor(async () => (await getStore().getGameSave(season._id))?.score?.[0] === 21)

    // The process dies: every room is gone, and only the database remains.
    closeSeasonRoomFor(season._id)
    forgetSeasonRoom(season._id)

    const back = humanSocket('phone-after-restart')
    registerSeasonHandlers(io, back)
    const stored = await getStore().getSeason(season._id)
    const resumed = await startGame(back, stored)

    expect(resumed.score).toEqual([21, 17])
    expect(resumed.quarter).toBe(3)
    expect(resumed.clock).toBe(77)
    expect(resumed.possession).toBe(1)
    expect(resumed.down).toBe(3)
    expect(resumed.yardLine).toBe(41)
    // A little back for sitting out the play that went in between, and nothing like a fresh pair of legs.
    expect(resumed.playerFatigue.get('kc_wr1').stamina).toBeGreaterThanOrEqual(44)
    expect(resumed.playerFatigue.get('kc_wr1').stamina).toBeLessThan(50)
    // Straight back into it, on the side of the ball the save says.
    expect(back.sent('season_game_start')[0].payload.resuming).toBe(true)
    const success = io.of('reconnect_success').at(-1).payload
    expect(success.role).toBe('defense')
    // ⚠️ AND FROM THE VERY FIRST MESSAGE. The room's own coin toss must never be announced on the way:
    // in that window the client took the computer's offense for its own players and re-placed them on
    // defense, and a Denver tight end sacked Denver's quarterback.
    expect(back.sent('roles_assigned').map(m => m.payload.role)).toEqual(['defense'])
    expect(back.data.role).toBe('defense')
  })

  it('a second device takes the running game over rather than opening another', async () => {
    const state = await startGame()
    const roomId = state.roomId
    const other = humanSocket('phone-2')
    registerSeasonHandlers(io, other)
    other.fire('season_play', { token, seasonId: season._id, aiTeamId: opponentOf(season), aiRoster: ROSTER })
    await waitFor(() => other.sent('reconnect_success').length)
    expect(seasonRoomOf(season._id)).toBe(roomId)
    expect(getSlotByToken(getTokensByRoomId(roomId)[0])).toBe(0)
  })

  async function finishGameAt(state, score) {
    transition(state, PHASE.COUNTDOWN); transition(state, PHASE.DEAD)
    state.score = score
    state.quarter = 4
    state.clock = 0
    startNextPlay(state.roomId, io)
  }

  it('⚠️ THE FINAL IS RECORDED, THE WEEK MOVES ON, AND THE SAVE IS GONE', async () => {
    const state = await startGame()
    const gameId = state.season.gameId
    await finishGameAt(state, [31, 10])
    await waitFor(() => io.of('season_game_final').length)
    const final = io.of('season_game_final')[0].payload
    expect(final.recorded).toBe(true)
    expect(final.season.week).toBe(2)
    expect(final.season.record.w).toBe(1)

    const stored = await getStore().getSeason(season._id)
    const played = stored.games.find(g => g.id === gameId)
    expect(played.status).toBe('final')
    expect(played.by).toBe('user')
    expect(stored.activeGameId).toBeNull()
    expect(await getStore().getGameSave(season._id)).toBeNull()
  })

  it('⚠️ WHAT HAPPENED IN THE GAME GOES ON THE PLAYERS\' YEARS, for both clubs', async () => {
    const state = await startGame()
    const [mine, theirs] = state.season.teams
    const myBack = LEAGUE[mine].rb[0]
    const theirQb = LEAGUE[theirs].qb
    recordRush(state.stats, { runner: { id: myBack.id, slot: 0, label: 'RB' }, yards: 61 })
    recordRush(state.stats, { runner: { id: 'auto_qb', slot: 1, label: 'QB' }, yards: 14 })
    await finishGameAt(state, [31, 10])
    await waitFor(() => io.of('season_game_final').length)
    const stored = await getStore().getSeason(season._id)
    expect(stored.stats.regular[myBack.id].rushYards).toBe(61)
    expect(stored.stats.regular[theirQb.id].rushYards).toBe(14)
  })

  it('⚠️ A PLAYER\'S YEAR NEVER REACHES THE CLIENT IN THE GAME STATE', async () => {
    const state = await startGame()
    expect(state.season.totals).toBeTruthy()
    expect(serializeGameState(state, 0).season.totals).toBeUndefined()
  })

  it('⚠️ A FINISHED GAME CANNOT BE PLAYED AGAIN, and cannot be rematched', async () => {
    const state = await startGame()
    const gameId = state.season.gameId
    await finishGameAt(state, [31, 10])
    await waitFor(() => io.of('season_game_final').length)
    const again = await recordPlayedGame(season._id, USER, gameId, { us: 0, them: 99 })
    expect(again.error).toBeTruthy()
    const stored = await getStore().getSeason(season._id)
    expect(stored.games.find(g => g.id === gameId).hs + stored.games.find(g => g.id === gameId).as).toBe(41)
  })

  it('a regular-season game level after four goes to overtime rather than ending', async () => {
    const state = await startGame()
    await finishGameAt(state, [14, 14])
    expect(state.phase).not.toBe(PHASE.GAME_OVER)
    expect(state.quarter).toBe(5)
    expect(state.overtime).toBeTruthy()
    expect(state.clock).toBe(160)     // two thirds of a four-minute quarter
    expect(state.timeouts).toEqual([2, 2])
    expect(io.of('period_transition').at(-1).payload.kind).toBe('overtime')
  })

  describe('[seasons] save and quit', () => {
    it('is not offered mid-play: quitting a down would undo it', async () => {
      const state = await startGame()
      expect(canSaveAndQuit(state)).toBe(true)
      state.phase = PHASE.LIVE
      expect(canSaveAndQuit(state)).toBe(false)
      sock.fire('season_save_quit')
      await waitFor(() => sock.sent('season_error').length)
      expect(sock.sent('season_error')[0].payload.code).toBe('not_now')
      state.phase = PHASE.PRE_SNAP
    })

    it('⚠️ SAVES THE EXACT MOMENT, closes the room, and resumes from it', async () => {
      const state = await startGame()
      Object.assign(state, { score: [10, 0], quarter: 2, clock: 123.5 })
      sock.data.roomId = state.roomId
      sock.fire('season_save_quit')
      await waitFor(() => sock.sent('season_saved').length)
      expect(seasonRoomOf(season._id)).toBeNull()
      const save = await getStore().getGameSave(season._id)
      expect(save.clock).toBe(123.5)

      const back = humanSocket('phone-next-day')
      registerSeasonHandlers(io, back)
      const resumed = await startGame(back, await getStore().getSeason(season._id))
      expect(resumed.score).toEqual([10, 0])
      expect(resumed.clock).toBe(123.5)
    })
  })
})

// ── Overtime rules, on the engine directly ───────────────────────────────

describe('[overtime] the league\'s rules', () => {
  let ctx
  const fresh = (playoff = false) => {
    ctx = createTrainingGame({ seed: 4242 })
    const s = ctx.state
    s.season = { seasonId: 'x', gameId: 'g', homeSlot: 0, playoff, neutral: false }
    s.quarterSeconds = 300
    s.score = [10, 10]
    s.quarter = 4
    s.clock = 0
    s.phase = PHASE.DEAD
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })   // into overtime
    if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })   // and the first snap
    return s
  }
  afterEach(() => { if (ctx) destroyTrainingGame(ctx); ctx = null })

  const score = (slot, carrierId = null) => {
    enqueue(ctx.roomId, EVENT.TOUCHDOWN, { scoringSlot: slot, carrierId })
    ctx.state.phase = PHASE.LIVE
    processQueue(ctx.roomId, ctx.state, ctx.io)
  }
  const nextPlay = () => {
    const s = ctx.state
    if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }
    if (s.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
  }

  it('an ordinary game has no overtime: level is a tie', () => {
    ctx = createTrainingGame({ seed: 1 })
    const s = ctx.state
    s.score = [10, 10]; s.quarter = 4; s.clock = 0; s.phase = PHASE.DEAD
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).toBe(PHASE.GAME_OVER)
    expect(s.quarter).toBe(4)
  })

  it('⚠️ A TOUCHDOWN ON THE FIRST DRIVE DOES NOT END IT: the other team gets the ball', () => {
    const s = fresh()
    const first = s.possession
    score(first)
    expect(s.phase).not.toBe(PHASE.GAME_OVER)
    expect(s.conversionPending).toBe(true)
  })

  it('…and when they fail to answer, that is the game', () => {
    const s = fresh()
    const first = s.possession
    s.score[first] += 7
    // First team's drive ends in that score: the ball goes over.
    s.possession = 1 - first
    s.phase = PHASE.DEAD
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).toBe(PHASE.PRE_SNAP)     // still their chance
    // They turn it over.
    s.phase = PHASE.DEAD
    s.possession = first
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).toBe(PHASE.GAME_OVER)
  })

  it('⚠️ ONCE BOTH HAVE HAD IT, THE NEXT TOUCHDOWN WINS AT ONCE, with no try', () => {
    const s = fresh()
    const first = s.possession
    s.overtime.firstDriveDone = [true, true]
    score(first)
    expect(s.phase).toBe(PHASE.GAME_OVER)
    expect(s.conversionPending).toBe(false)
    expect(s.score[first]).toBe(16)
  })

  it('a defensive touchdown ends it, whoever has had the ball', () => {
    const s = fresh()
    const def = 1 - s.possession
    score(def)
    expect(s.phase).toBe(PHASE.GAME_OVER)
    expect(s.score[def]).toBe(16)
  })

  it('a safety ends it', () => {
    const s = fresh()
    enqueue(ctx.roomId, EVENT.SAFETY, { safetySlot: s.possession })
    s.phase = PHASE.LIVE
    processQueue(ctx.roomId, s, ctx.io)
    expect(s.phase).toBe(PHASE.GAME_OVER)
  })

  it('⚠️ REGULAR SEASON: an overtime that runs out level is a tie', () => {
    const s = fresh(false)
    s.clock = 0; s.phase = PHASE.DEAD
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).toBe(PHASE.GAME_OVER)
    expect(s.score[0]).toBe(s.score[1])
  })

  it('⚠️ PLAYOFFS: it does not. Another period, until somebody wins', () => {
    const s = fresh(true)
    s.clock = 0; s.phase = PHASE.DEAD
    startNextPlay(ctx.roomId, ctx.io, { quiet: true })
    expect(s.phase).not.toBe(PHASE.GAME_OVER)
    expect(s.quarter).toBe(6)
    expect(s.overtime.periods).toBe(2)
  })
})

// ── The computer plays a whole overtime game through the save and back ───

// Drives the real engine the way scripts/fullGameLab.mjs does. Kicks are not driven by playDown, so
// fourth downs go for it and touchdowns go for two.
function drive(ctx, { until = () => false, maxSteps = 4000, onPlay = null } = {}) {
  let plays = 0
  for (let i = 0; i < maxSteps; i++) {
    const st = ctx.state
    if (st.phase === PHASE.GAME_OVER || until(st)) break
    if (st.stoppage) {
      const reason = st.stoppage.reason
      endStoppage(st)
      if (reason === 'timeout') for (const b of ctx.brains) b.onEvent('timeout_ended')
      continue
    }
    if (st.awaitingTransitionTap) { st.awaitingTransitionTap = false; startNextPlay(ctx.roomId, ctx.io, { quiet: true }); continue }
    if (st.decisionPending) { resolveDecision(st, ctx.io, 'go_for_it', { quiet: true }); continue }
    if (st.conversionPending) {
      resolveConversion(st, ctx.io, 'two_point')
      if (st.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      continue
    }
    if (st.onsideChoicePending) { resolveOnsideChoice(st, ctx.io, 'kickoff'); continue }
    if (st.phase === PHASE.DEAD) { startNextPlay(ctx.roomId, ctx.io, { quiet: true }); continue }
    const r = playDown(ctx, {})
    if (!r.ok) {
      if (ctx.state.phase === PHASE.PRE_SNAP) ctx.brains[ctx.state.possession].onEvent('play_clock_update', { playClock: 0 })
      if (ctx.state.phase === PHASE.DEAD) startNextPlay(ctx.roomId, ctx.io, { quiet: true })
      continue
    }
    if (!ctx.state.clockStopped && ctx.state.phase === PHASE.DEAD) ctx.state.clock = Math.max(1, ctx.state.clock - 18)
    plays++
    onPlay?.(ctx.state)
  }
  return plays
}

describe('[seasons] a real game through the save', () => {
  afterEach(() => setSeasonHooks({ onCheckpoint: () => {}, onGameOver: () => {}, onRoomExpired: () => {} }))

  it('⚠️ EVERY CHECKPOINT OF A WHOLE GAME SURVIVES THE ROUND TRIP', () => {
    const ctx = createTrainingGame({ seed: 91 })
    ctx.state.season = { seasonId: 'lab', gameId: 'g', homeSlot: 0, playoff: false, neutral: false }
    const saved = []
    setSeasonHooks({ onCheckpoint: (st) => saved.push(snapshotGame(st)) })
    try {
      drive(ctx)
      expect(ctx.state.phase).toBe(PHASE.GAME_OVER)
      expect(saved.length).toBeGreaterThan(40)
      for (const json of saved) {
        const target = { roomId: 'z', season: { a: 1 } }
        expect(hydrateGame(target, json)).toBe(true)
        expect(target.roomId).toBe('z')
        expect(target.score).toHaveLength(2)
        expect(target.playerFatigue).toBeInstanceOf(Map)
        expect(target.offensePlayers).toBeInstanceOf(Map)
        expect(typeof target.rng).toBe('function')
      }
    } finally { destroyTrainingGame(ctx) }
  })

  it('⚠️ A GAME RESUMED FROM A MID-GAME SAVE PLAYS ON TO THE END', () => {
    const ctx = createTrainingGame({ seed: 92 })
    ctx.state.season = { seasonId: 'lab', gameId: 'g', homeSlot: 0, playoff: false, neutral: false }
    let saved = null
    setSeasonHooks({ onCheckpoint: (st) => { if (st.quarter === 3 && !saved && st.phase === PHASE.PRE_SNAP) saved = snapshotGame(st) } })
    try {
      drive(ctx, { until: (st) => !!saved && st.quarter === 3 })
    } finally { destroyTrainingGame(ctx) }
    expect(saved).toBeTruthy()

    const next = createTrainingGame({ seed: 93 })
    try {
      next.state.season = { seasonId: 'lab', gameId: 'g', homeSlot: 0, playoff: false, neutral: false }
      hydrateGame(next.state, saved)
      expect(next.state.quarter).toBe(3)
      const plays = drive(next)
      expect(plays).toBeGreaterThan(10)
      expect(next.state.phase).toBe(PHASE.GAME_OVER)
    } finally { destroyTrainingGame(next) }
  })

  it('⚠️ THE COMPUTER PLAYS OVERTIME THROUGH TO A WINNER IN THE PLAYOFFS', () => {
    for (const seed of [201, 202, 203]) {
      const ctx = createTrainingGame({ seed })
      const s = ctx.state
      s.season = { seasonId: 'lab', gameId: 'g', homeSlot: 0, playoff: true, neutral: false }
      s.score = [17, 17]; s.quarter = 4; s.clock = 0; s.phase = PHASE.DEAD
      try {
        startNextPlay(ctx.roomId, ctx.io, { quiet: true })
        if (s.nextPlayTimer) { clearTimeout(s.nextPlayTimer); s.nextPlayTimer = null }
        expect(s.overtime).toBeTruthy()
        drive(ctx)
        expect(s.phase).toBe(PHASE.GAME_OVER)
        expect(s.score[0]).not.toBe(s.score[1])
      } finally { destroyTrainingGame(ctx) }
    }
  }, 120000)
})

// ── The star, and home field ─────────────────────────────────────────────

describe('[X-Factors] the shared quarterback id', () => {
  function twoQbs() {
    const mine = { id: 'auto_qb', label: 'QB', x: 26, y: 40, xFactor: XF.CANNON }
    const theirs = { id: 'auto_qb', label: 'QB', x: 26, y: 80 }             // the computer's: no X-Factor
    return {
      mine, theirs,
      state: {
        roomId: 'r', possession: 0, xFactors: new Map(),
        offensePlayers: new Map([[mine.id, mine]]),
        defensePlayers: new Map(),
        playerFatigue: new Map(),
      },
    }
  }

  it('⚠️ ONE QUARTERBACK EARNING HIS DOES NOT STAR THE OTHER', () => {
    const { mine, state } = twoQbs()
    for (let i = 0; i < 2; i++) recordPassOutcome(state, mine, { outcome: 'complete', tier: 'open', deep: true }, null)
    expect(mine.xFactorActive).toBe(true)
    expect(activeXFactorIds(state, 0)).toEqual(['auto_qb'])
    expect(activeXFactorIds(state, 1)).toEqual([])     // what the other team's star is drawn from
  })

  it('⚠️ TWO QUARTERBACKS WITH ABILITIES KEEP SEPARATE PROGRESS', () => {
    const { mine, state } = twoQbs()
    recordPassOutcome(state, mine, { outcome: 'complete', tier: 'open', deep: true }, null)

    // Possession flips, and the other team's quarterback (a different ability) throws.
    const other = { id: 'auto_qb', label: 'QB', x: 26, y: 80, xFactor: XF.SHORT_TERM_MEMORY }
    state.possession = 1
    state.offensePlayers = new Map([[other.id, other]])
    recordPassOutcome(state, other, { outcome: 'complete', tier: 'open', deep: true }, null)

    expect(state.xFactors.size).toBe(2)
    expect(state.xFactors.get('0:auto_qb').ability).toBe(XF.CANNON)
    expect(state.xFactors.get('1:auto_qb').ability).toBe(XF.SHORT_TERM_MEMORY)
    expect(state.xFactors.get('0:auto_qb').deepCompletions).toBe(1)
    expect(state.xFactors.get('1:auto_qb').deepCompletions).toBe(1)
  })

  it('the star comes back on a new play for the right man', () => {
    const { mine, state } = twoQbs()
    for (let i = 0; i < 2; i++) recordPassOutcome(state, mine, { outcome: 'complete', tier: 'open', deep: true }, null)
    const nextPlay = { id: 'auto_qb', label: 'QB', xFactor: XF.CANNON }
    state.offensePlayers = new Map([[nextPlay.id, nextPlay]])
    applyXFactorFlags(state)
    expect(nextPlay.xFactorActive).toBe(true)
  })
})

describe('[seasons] home field makes an X-Factor about 5% easier', () => {
  function rb(season, possession = 0) {
    const p = { id: 'kc_rb1', label: 'RB', xFactor: XF.SHIFTY }
    return {
      p,
      state: {
        roomId: 'r', possession, season, rng: () => 0.5, xFactors: new Map(),
        offensePlayers: new Map([[p.id, p]]), defensePlayers: new Map(), playerFatigue: new Map(),
      },
    }
  }

  it('it is 5%', () => expect(HOME_EDGE).toBe(0.05))

  it('⚠️ A 19-YARD RUN EARNS SHIFTY AT HOME, NOT ON THE ROAD', () => {
    const home = rb({ homeSlot: 0 })
    recordRun(home.state, home.p, { yards: 19, firstDown: false }, null)
    expect(home.p.xFactorActive).toBe(true)

    const away = rb({ homeSlot: 1 })
    recordRun(away.state, away.p, { yards: 19, firstDown: false }, null)
    expect(away.p.xFactorActive).toBeFalsy()
  })

  it('⚠️ NOT AT A NEUTRAL SITE, WHICH IS EVERY SUPER BOWL', () => {
    const sb = rb({ homeSlot: 0, neutral: true })
    recordRun(sb.state, sb.p, { yards: 19, firstDown: false }, null)
    expect(sb.p.xFactorActive).toBeFalsy()
  })

  it('⚠️ NOT OUTSIDE A SEASON: ordinary games are untouched', () => {
    const plain = rb(undefined)
    recordRun(plain.state, plain.p, { yards: 19, firstDown: false }, null)
    expect(plain.p.xFactorActive).toBeFalsy()
    recordRun(plain.state, plain.p, { yards: 20, firstDown: false }, null)
    expect(plain.p.xFactorActive).toBe(true)
  })

  it('the computer gets it too when IT is at home', () => {
    const home = rb({ homeSlot: 1 }, 1)     // the computer has the ball, and is home
    recordRun(home.state, home.p, { yards: 19, firstDown: false }, null)
    expect(home.p.xFactorActive).toBe(true)
  })

  it('a scramble needs 9.5 yards at home instead of 10', () => {
    const qb = { id: 'auto_qb', label: 'QB', xFactor: XF.SHAKE_IT_OFF }
    const state = {
      roomId: 'r', possession: 0, season: { homeSlot: 0 }, rng: () => 0.5, xFactors: new Map(),
      offensePlayers: new Map([[qb.id, qb]]), defensePlayers: new Map(), playerFatigue: new Map(),
    }
    recordScramble(state, qb, 9.5, null)
    expect(qb.xFactorActive).toBe(true)
  })

  it('a counted play occasionally counts double at home, and about one time in twenty', () => {
    const qb = { id: 'auto_qb', label: 'QB', xFactor: XF.CANNON }
    let rolls = 0, doubles = 0
    const state = {
      roomId: 'r', possession: 0, season: { homeSlot: 0 }, xFactors: new Map(),
      offensePlayers: new Map([[qb.id, qb]]), defensePlayers: new Map(), playerFatigue: new Map(),
      rng: () => { rolls++; return Math.random() },
    }
    for (let i = 0; i < 4000; i++) {
      state.xFactors.clear()
      recordPassOutcome(state, qb, { outcome: 'complete', tier: 'open', deep: false, airYards: 25 }, null)
      if (state.xFactors.get('0:auto_qb')?.deepCompletions === 2) doubles++
      qb.xFactorActive = false
    }
    expect(rolls).toBeGreaterThan(0)
    expect(doubles / 4000).toBeGreaterThan(0.03)
    expect(doubles / 4000).toBeLessThan(0.07)
  })
})
