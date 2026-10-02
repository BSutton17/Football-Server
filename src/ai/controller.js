// ── The controller ([offline]) ───────────────────────────────────────────────
//
// The only module in ai/ that ACTS. Everything else decides; this fires the events.
//
// Together with knowledge.js it forms the boundary: knowledge.js is the only reader, this is the
// only writer, and every layer between them is a pure function. That split is what makes the
// fairness guarantee checkable rather than aspirational — a test can scan the imports and prove no
// other file touches the game.
//
// The controller is a state machine over the pre-snap phase, because that is where the AI actually
// plays. Once the ball is snapped the engine takes over and the AI's only remaining job on offense
// is deciding when to throw.

import { loadPlaybook } from '../playbook/store.js'
import {
  hasAuthoredOffense, hasAuthoredDefense, callAuthoredOffense, buildAuthoredOffense,
  callAuthoredDefense, buildAuthoredDefense, formationLookId,
} from './playbook/runAuthored.js'
import { adjustOffense } from './playbook/adjustOffense.js'
import { REPEAT_DELAY } from './playcall/select.js'
import { solvedTable } from './playcall/table.js'
import { noteDecision } from '../analytics/playLog.js'
import { getGame } from '../game/gameState.js'
const forceDeps = { adjustOffense }
import { createKnowledge, applyEvent, isOffense, isDefense, oppSkill } from './knowledge.js'
import { callDefense, selectPlayers } from './defense.js'
import { callOffense, buildFormation, chooseRunAngle } from './offense.js'
import { expandShell, alignmentFor } from './assignments.js'
import { legalSpot } from './playbook/formations.js'
import { specialTeamsAction, fourthDownChoice } from './specialTeams.js'
import { shouldCallTimeout } from './clockManagement.js'
import { makeRng } from '../game/utils/rng.js'
import { shouldSetNow } from './timing.js'
import { chooseTempo, setTimeFor, tempoRunLean, TEMPO } from './tempo.js'

// [run adjust] How late the offense takes its one look at the front, in seconds of hike countdown.
// One beat before the snap: late enough that the defense has finished moving, early enough to be a
// decision rather than a reaction.
const RUN_ADJUST_AT = 1
import { rankTargets, orderKey, developedFraction } from './reads.js'
import { OPENNESS_OPEN } from '../constants.js'
import { skillFor } from './difficulty.js'

// Defensive placement bounds, mirroring the client's getPositionYBounds. A defender placed past
// these is refused outright, so the alignment a shell asks for has to be clamped into them — a
// Tampa 2 linebacker carrying the deep middle lines up at ten yards and RUNS to sixteen.
const DEF_MAX_DEPTH = { LB: 10, CB: 20, S: 25 }
const DEF_MIN_DEPTH = 0.75      // a full player radius off the ball, or it is offside

// One simulation tick, in seconds. The AI's sense of time is positions_update arrivals, which the
// server sends once per tick — so counting them IS counting game time, and it stays correct
// through a freeze or a pause because a held tick sends nothing.
import { DL_SPACING } from './playbook/front.js'

const TICK_SECONDS = 0.05

// ⚠️ READ ONCE, NOT EVERY SNAP. The playbook is a file on disk and placeOffense runs on every
// play; re-reading and re-parsing 126 plays each time would be pure waste. It is reloaded only
// when the sandbox has written to it, which a dev session does and a game never does.
let cachedBook = null
function authoredBook() {
  if (cachedBook === null) {
    try { cachedBook = loadPlaybook() } catch { cachedBook = { formations: {}, plays: {}, defFormations: {}, shells: {} } }
  }
  return cachedBook
}

export function reloadAuthoredPlaybook() { cachedBook = null }

// [solve] Build the call for one named play, going through the same adjustment the chooser does.
function forceOnePlay(book, playId, k, ballX) {
  const play = book.plays?.[playId]
  if (!play) return null
  const formation = { ...book.formations[play.formationId], id: play.formationId }
  if (!formation?.spots) return null
  const { adjustOffense } = forceDeps
  const { play: adjusted, mirror, keptIn } = adjustOffense({ ...play, id: playId }, formation, { ballX, rushers: 4 })
  return { play: adjusted, formation, mirror, keptIn, playType: play.playType }
}

function forceOneShell(book, shellId) {
  const shell = book.shells?.[shellId]
  if (!shell) return null
  const formation = { ...book.defFormations[shell.formationId], id: shell.formationId }
  if (!formation?.spots) return null
  return { shell: { ...shell, id: shellId }, formation, look: { id: 'forced' } }
}


// ── What the caller knows beyond the situation ──────────────────────────────
//
// ⚠️ BOTH OF THESE WERE BUILT AND NEITHER WAS CONNECTED. `select.js` has always taken a solved
// table and a half-time read; nothing ever passed one, so every call the AI made ran off the
// situational prior no matter how much solving had been done, and the half-time analysis lived
// only in a log line. This is the wire.
//
// Read fresh each call rather than captured: the table grows while the solver runs, and the read
// does not exist until half-time.
function callInputs(socket, slot) {
  const solved = solvedTable()
  let adjust = null
  try {
    adjust = getGame(socket?.data?.roomId)?.halftimeRead?.[slot] ?? null
  } catch { /* no room yet, or a room without a game: the prior is a complete answer */ }
  return { solved, adjust }
}

export function createController({ socket, slot, roster, seed = 1, log = false }) {
  const brains = () => callInputs(socket, slot)
  const k = createKnowledge(slot)
  const rng = makeRng(seed)

  const self = {
    knowledge: k,
    // [training] Set by createNetworkBrain to hand the coverage call to a network. Null means the
    // heuristic decides, which is the shipping behaviour.
    overrideDefensiveCall: null,
    // [training] The same hook for the offense's play call. Nothing in the shipping path sets it.
    overrideOffensiveCall: null,
    // [deep] Per-player adjustment of the expanded shell. Null means the shell stands as written,
    // which is the shipping behaviour and what every heuristic call does.
    adjustAssignments: null,
    // [deep] …and the same for the offensive formation: placement and route stem length.
    adjustFormation: null,
    // What the AI decided this play, kept for logs, tests and (later) training telemetry.
    lastCall: null,
    // Guards so a decision is made once per play rather than on every event that arrives.
    done: { personnel: false, formation: false, coverage: false, set: false, snapped: false, timeout: false, runAdjust: false },

    onEvent(event, payload) {
      applyEvent(k, event, payload)
      if (k.newPlay) { resetPlay(); k.newPlay = false }

      // ⚠️ NOTHING MAY BE DONE DURING A STOPPAGE, AND THE AI COULD NOT TELL. It called a timeout and
      // then kept acting inside its own freeze — setting the offense, placing defenders, assigning
      // coverage — every one refused ("Play is paused for a timeout"), over and over for as long as
      // it lasted. Guarded at the event boundary rather than in one handler, because it was every
      // handler: placement comes in on `player_placed` and has nothing to do with `onSituation`.
      //
      // Found by scripts/tempoCheck.mjs the first time it ran after timeouts were added.
      if (self.stopped && event !== 'timeout_ended' && event !== 'game_state') return undefined

      switch (event) {
        case 'game_state': return onSituation()
        case 'player_placed': return onOpponentMoved(payload)
        case 'offense_set': return onOffenseSet()
        case 'hike_countdown': return onCountdown(payload)
        case 'play_result': return undefined   // the whistle; knowledge.js records the phase
        case 'play_clock_update': return onSituation()
        // [kick] The meter is draining. This is the AI's ONLY heartbeat during a kick — without it
        // it taps once and the ball is kicked at whatever power is left, which was none.
        case 'special_teams_update': return onSpecialTeams()
        // [kick] The meter is draining. This is the AI's ONLY heartbeat during a kick — without it
        // it taps once and the ball is kicked at whatever power is left, which was none.
        case 'special_teams_update': return onSpecialTeams()
        // [manual] The board froze / started moving again. In a manual room a throw is legal ONLY
        // while frozen, so these two are the AI's entire passing window.
        // ⚠️ A REFUSED ACTION IS ALWAYS A BUG, and always a silent one. A rejected
        // `assign_coverage` leaves a defender with no job, and the engine rushes anyone it has no
        // assignment for — so the AI loses a defender to the pass rush and opens a hole where he
        // was standing, with nothing on screen to say so. Logged unconditionally, not behind the
        // debug flag, because there is no situation in which this is expected.
        case 'room_error': {
          // …with ONE exception, and it is narrow on purpose: pulling a lineman who has already
          // left the field. The engine rebuilds the defense at every snap, so the front this
          // controller remembers may simply not be there any more. That miss is the expected
          // outcome, not a bug, and letting it shout here would train the eye to ignore the very
          // line that catches a refused coverage assignment.
          const expected = self.expectMissingRemoval && /Player not found/i.test(payload?.message ?? '')
          if (!expected) console.warn(`[ai:${slot}] ACTION REFUSED: ${payload?.message ?? '(no reason)'}`)
          return undefined
        }

        // The snap. Nothing else announces it — see the note in knowledge.js.
        case 'ball_snapped': return undefined
        // [rpo] The read window closed and the back has the ball — there is nothing left to throw.
        // Without this the AI keeps trying and the server refuses it: "Too late to throw".
        case 'rpo_handoff':
          self.done.threw = true
          return undefined
        case 'manual_frozen': return onManualFrozen()
        case 'manual_resumed': return onManualResumed()
        // [offline] The human defense declared itself ready. There is nothing left to wait for, so
        // the computer stops sitting on the play clock and sets now.
        case 'defense_set': return onDefenseSet()
        // ⚠️ NOTHING MAY BE DONE DURING A STOPPAGE, AND THE AI COULD NOT TELL. It called a timeout
        // and then tried to set the offense inside its own stoppage — refused, over and over
        // ("Play is paused for a timeout"), for as long as the freeze lasted. A real game recovers
        // when the timeout expires; a harness driving downs directly just spins. Found by
        // scripts/tempoCheck.mjs on the first run after timeouts were added.
        case 'timeout_started': self.stopped = true; return undefined
        case 'timeout_ended': self.stopped = false; return onSituation()
        case 'positions_update': return onLive()
        default: return undefined
      }
    },
  }

  function resetPlay() {
    self.done = { personnel: false, formation: false, coverage: false, set: false, snapped: false, timeout: false, runAdjust: false }
    self.lastCall = null
    // ⚠️ The authored shell is per PLAY. Left set, the defense would keep calling last down's
    // coverage for the rest of the drive — and because alignDefense re-runs on every opponent
    // placement, it would look like it was deciding afresh each time while never changing.
    self.authoredCall = null
    self.authoredLook = null   // …and the look it was chosen against, so a new play re-decides
    self.coverageOnField = []  // …and who the last shell had out there
    self.players = []
    self.setAt = null
    self.tempo = null
    self.hurriedSeconds = 0
    self.stopped = false
    self.manualFrozen = false
    self.heldFor = 0
    self.looks = 0
    self.boardTime = 0
    self.reads = new Map()
    self.liveFor = 0     // a fresh moment to set, chosen next time the offense thinks
    self.forceSet = false
    self.alignedAgainst = null   // [twitch] the opponent formation this defense last answered
    self.placedAt = new Map()    // …and where each defender was actually put
    // ⚠️ `frontOnField` IS DELIBERATELY NOT CLEARED HERE. It is the only record of which linemen
    // are standing on the field, and the engine does not always rebuild the defense alongside this
    // reset — clearing it strands the fourth lineman of a shrinking front all over again.
  }

  function say(...args) { if (log) console.log(`[ai:${slot}]`, ...args) }

  // ── The situation changed: a new play is up ────────────────────────────────
  function onSituation() {
    // Special teams owns the whole play when it is running — a kick is not a formation.
    if (k.specialTeams || k.decision) return onSpecialTeams()
    if (k.phase !== 'pre_snap' && k.phase !== 'countdown') return

    // [clock] Spend a timeout before lining up, not after — the seconds being saved are the ones
    // about to bleed away while the formation is placed. Once per play: `done.timeout` is cleared
    // by resetPlay like every other one-shot decision.
    if (!self.done.timeout && shouldCallTimeout(k)) {
      self.done.timeout = true
      say(`timeout — Q${k.quarter} ${Math.ceil(k.clock)}s left, ${k.timeouts?.own} in hand`)
      socket.fire('call_timeout')
      return
    }

    if (isOffense(k)) return playOffense()
    if (isDefense(k)) return playDefense()
  }

  // ── Offense ───────────────────────────────────────────────────────────────
  // Two steps, deliberately separated in TIME.
  //
  // A human offense drags its players out one at a time and then locks the formation when it is
  // happy — so the defense watches the picture form and has the whole play clock to answer it.
  // An AI that did both in one breath would show the defense nothing until the instant it set,
  // leaving five seconds to react to a formation that appeared out of nowhere. So: line up at
  // once, lock later.
  function playOffense() {
    placeOffense()
    lockOffense()
  }

  // Decide the play and put the receivers on the grass. Happens as soon as the AI has a situation.
  function placeOffense() {
    if (self.done.formation) return

    const losY = k.yardLine
    const ballX = k.ballX            // the hash the ball is on — NOT the middle of the field
    // [training] The offensive mirror of overrideDefensiveCall. Same contract: it replaces the CALL
    // and inherits the formation build, the legality clamps and the hash, so an overridden call is
    // as legal as a heuristic one. Used to hold a concept fixed while measuring what it is worth.
    // ⚠️ AN AUTHORED PLAY IS PREFERRED WHEN THERE IS ONE, and the hand-written concepts remain the
    // fallback. They are not dead code: a fresh install has an empty playbook, and an AI that
    // could not line up until somebody had drawn a hundred plays would be unusable. An override
    // still wins over both — that is how a play is held fixed while it is being measured.
    const authored = self.overrideOffensiveCall ? null : authoredBook()
    // [solve] Hold ONE play fixed while it is measured. Same contract as overrideOffensiveCall:
    // it replaces the choice and inherits the formation build, the flip and the protection call,
    // so a forced play is as legal as a chosen one.
    const authoredCall = authored && hasAuthoredOffense(authored)
      ? (self.forceAuthoredPlay
        ? forceOnePlay(authored, self.forceAuthoredPlay, k, ballX)
        : callAuthoredOffense(authored, k, {
          ballX, rng, recent: self.recentPlays,
          // [tempo] The clock's lean on the run/pass mix. Decided here rather than inside the
          // play-caller because the SITUATION buckets the solve is keyed on carry no score and no
          // clock — adding them would multiply the buckets and thin every one of them out. So the
          // solved equilibrium stands and the clock bends it.
          runLeanMult: tempoRunLean(chooseTempo(k)),
          ...brains(),
        }))
      : null

    // ⚠️ KEPT ACROSS PLAYS, DELIBERATELY. This is the one piece of offensive memory that must NOT
    // be in `resetPlay` — the whole point is that it outlives the play. Bounded to the delay length
    // so it cannot grow for a whole game.
    if (authoredCall?.play?.id) {
      self.recentPlays = [authoredCall.play.id, ...(self.recentPlays ?? [])].slice(0, REPEAT_DELAY)
    }

    if (authoredCall?.play?.name) {
      const g = getGame(socket?.data?.roomId)
      if (g) {
        g.aiCallName = `${authoredCall.play.name} / ${authoredCall.formation?.name ?? ''}`
        // [analytics] The same call as structured data. `aiCallName` is a label for a screenshot;
        // a report needs the ids.
        g.aiCall = {
          ...(g.aiCall ?? {}),
          offense: {
            playId: authoredCall.play.id ?? null,
            playName: authoredCall.play.name ?? null,
            formationId: authoredCall.formation?.id ?? authoredCall.play.formationId ?? null,
            playType: authoredCall.play.playType ?? null,
          },
        }
      }
    }

    let call
    if (authoredCall) {
      call = {
        playType: authoredCall.playType,
        formationName: authoredCall.formation.name,
        conceptName: authoredCall.play.name,
        why: 'authored',
        // ⚠️ ALWAYS A NUMBER, even on a pass. `set_offense` validates runAngle unconditionally, so
        // the hand-written path has always supplied one; a null here is refused outright and the
        // offense simply never sets. An authored RUN stores no angle by design — the lane is read
        // off the defensive front right here, which is what a real back is reading.
        runAngle: chooseRunAngle(k, ballX, rng).angle,
        authored: authoredCall,
      }
      self.players = buildAuthoredOffense(authoredCall, { losY, ballX, roster })
    } else {
      call = self.overrideOffensiveCall
        ? self.overrideOffensiveCall(k, rng, ballX)
        : callOffense(k, rng, ballX)
      self.players = buildFormation(call, k, { losY, ballX, roster, rng })
    }
    self.lastCall = call

    // [deep] The offensive mirror of adjustAssignments. The concept has already handed every
    // receiver a route from the list; this lets a brain move him and lengthen or shorten his stem
    // (`routeDepthScale`, which the route engine already applies). Routes stay from the LIST — the
    // AI picks and stretches them, it does not draw new ones.
    if (self.adjustFormation) {
      const adjusted = self.adjustFormation(self.players, { k, call, losY, ballX })
      if (Array.isArray(adjusted)) self.players = adjusted
    }
    say(`${call.playType} — ${call.formationName}${call.conceptName ? ' / ' + call.conceptName : ''} (${call.why})`)

    for (const p of self.players) {
      socket.fire('place_player', {
        id: p.id, x: p.x, y: p.y, label: p.label, team: 'o',
        ratings: p.ratings, xFactor: p.xFactor,
        // An authored play carries the shape somebody drew rather than a route name.
        ...(p.drawnRoute ? { drawnRoute: p.drawnRoute } : {}),
      })
    }
    self.done.formation = true
  }

  // Lock it in. Held back until a moment between 20 and 5 seconds left on the play clock, chosen
  // at random per play so a human cannot learn the rhythm and pre-empt the snap.
  function lockOffense() {
    if (self.done.set || !self.done.formation) return
    // [tempo] When to snap is a clock decision, not a coin toss — see ai/tempo.js. Fixed once per
    // play so the offense does not change its mind mid-walk-up.
    if (self.setAt == null) {
      self.tempo = chooseTempo(k)
      self.setAt = setTimeFor(self.tempo, rng)
      if (self.tempo !== TEMPO.NORMAL) say(`tempo: ${self.tempo} (set at :${self.setAt.toFixed(0)})`)
    }
    if (!self.forceSet && !shouldSetNow(k.playClock ?? 0, self.setAt)) return

    // ⚠️ BEING HURRIED MUST NOT SAVE THE OFFENSE TIME ON THE GAME CLOCK.
    //
    // The computer picks a moment to snap — somewhere between 20 and 5 seconds left — and the game
    // clock runs while it waits. A human defense pressing Set Defense short-circuits that wait, so
    // the snap came sooner in real time and the seconds the offense had every intention of burning
    // simply never happened. Declaring ready was therefore a free way to stop the clock, which is
    // the opposite of what it should cost.
    //
    // So the skipped play clock is reported with the set, and the server takes it off the game
    // clock at the snap. The defense still gets to play sooner; it just does not get the time back.
    const skipped = self.forceSet ? Math.max(0, (k.playClock ?? 0) - self.setAt) : 0
    self.hurriedSeconds = skipped

    const losY = k.yardLine
    const ballX = k.ballX            // the line and the quarterback pivot on the hash, like the client's
    // The line and the quarterback are not dragged by anyone — they are auto-placed, and they
    // travel in the set_offense payload rather than as place_player events.
    socket.fire('set_offense', {
        hurriedSeconds: self.hurriedSeconds ?? 0,
      playSerial: k.playSerial,
      playType: self.lastCall.playType,
      runAngle: self.lastCall.runAngle,
      players: [
        ...self.players.map(p => ({
          id: p.id, x: p.x, y: p.y, label: p.label, team: 'o',
          route: p.route, routeDepthScale: p.routeDepthScale ?? 1,
          ratings: p.ratings, xFactor: p.xFactor,
          ...(p.drawnRoute ? { drawnRoute: p.drawnRoute } : {}),
        })),
        ...autoOffense(losY, ballX),
      ],
    })
    self.done.set = true
  }

  // The five linemen and the quarterback, at the spots the client generates for them. These must
  // match Client/src/game/formation.ts — both sides draw the same formation, and a mismatch is a
  // line that renders in one place and blocks from another.
  function autoOffense(losY, centerX) {
    return [
      { id: 'auto_ol_lt', x: centerX - 3.5, y: losY - 1, team: 'o', label: 'OL' },
      { id: 'auto_ol_lg', x: centerX - 1.75, y: losY - 1, team: 'o', label: 'OL' },
      { id: 'auto_ol_c', x: centerX, y: losY - 1, team: 'o', label: 'OL' },
      { id: 'auto_ol_rg', x: centerX + 1.75, y: losY - 1, team: 'o', label: 'OL' },
      { id: 'auto_ol_rt', x: centerX + 3.5, y: losY - 1, team: 'o', label: 'OL' },
      { id: 'auto_qb', x: centerX, y: losY - 6, team: 'o', label: 'QB' },
    ]
  }

  // ── Defense ───────────────────────────────────────────────────────────────
  //
  // The defense cannot line up until it has seen the offense, so this runs on every opponent
  // placement rather than once. It is cheap and idempotent: the same picture produces the same
  // call, and only a CHANGED picture re-aligns anybody.
  // ⚠️ Re-entrancy guard. `place_player` broadcasts to the WHOLE room, so every placement the AI
  // makes comes straight back to it as a player_placed event. Without this, aligning the defense
  // re-triggers aligning the defense, seven times over, forever — the first run of the end-to-end
  // test hung the suite exactly this way.
  let aligning = false

  function playDefense() {
    if (aligning) return
    // A placement can arrive after the whistle (the other side re-registering, a late echo). Acting
    // on it is refused outright — "Action not available in current phase (dead)" — so don't.
    if (k.phase !== 'pre_snap' && k.phase !== 'countdown') return
    const receivers = oppSkill(k)
    if (receivers.length === 0) return        // nothing to line up against yet
    aligning = true
    try { alignDefense(receivers) } finally { aligning = false }
  }

  // Put an authored shell on the grass. Deliberately the same two events the heuristic path
  // fires — place_player and assign_coverage — so nothing downstream can tell them apart.
  function placeAuthoredDefense(call, { losY, ballX, receivers }) {
    const rows = buildAuthoredDefense(call, { losY, ballX, receivers, roster })

    // ⚠️ ANYONE NOT IN THIS CALL COMES OFF, AND THE FIELD IS THE SOURCE OF TRUTH. Shells field
    // different numbers behind the line — seven behind a four-man front, eight behind a three —
    // and personnel substitution can change WHICH player fills a spot between two alignments of
    // the same play. Either one leaves somebody standing there holding last call's assignment:
    // twelve men on the field.
    //
    // This used to track what it had placed and remove the difference, which is bookkeeping that
    // has to stay in step with reality — and did not. Reading `defensePlayers` needs no
    // bookkeeping and cannot drift: whoever is out there and is not in this call is removed,
    // whatever put him there, including the heuristic path this call replaced.
    const keep = new Set([...rows.map(r => r.id), ...(self.frontOnField ?? [])])
    const onField = getGame(socket?.data?.roomId)?.defensePlayers
    for (const id of [...(onField?.keys() ?? [])]) {
      if (keep.has(id)) continue
      socket.fire('remove_player', id)
      self.placedAt.delete(id)
    }
    for (const d of rows) {
      // ⚠️ Only a placement that actually MOVES him. Re-sending the same spot is what a player
      // sees as the defense twitching: every re-align rebroadcast eleven positions and the client
      // redrew them all even when nothing had changed.
      const was = self.placedAt.get(d.id)
      if (!was || Math.abs(was.x - d.x) > 0.05 || Math.abs(was.y - d.y) > 0.05) {
        self.placedAt.set(d.id, { x: d.x, y: d.y })
        socket.fire('place_player', {
          id: d.id, x: d.x, y: d.y, label: d.label, team: 'd',
          ratings: d.ratings, xFactor: d.xFactor,
        })
      }
      socket.fire('assign_coverage', {
        playerId: d.id,
        type: d.coverage.type,
        targetId: d.coverage.targetId ?? null,
        zoneType: d.coverage.zoneType ?? null,
        zoneCenterX: d.coverage.zoneCenterX ?? null,
        zoneCenterY: d.coverage.zoneCenterY ?? null,
        manCommit: d.coverage.manCommit ?? null,
      })
    }
    self.done.coverage = true
  }

  function alignDefense(receivers) {
    const losY = k.yardLine
    const ballX = k.ballX            // the front lines up on the hash, across from the offense

    // ⚠️ THE FRONT MUST MATCH THE SHELL, or the defense fields twelve. An authored 3-4 or 3-3-5
    // places EIGHT behind the line rather than seven, so four linemen on top of it is one man too
    // many and every snap is refused with "defense has 12 players, not 11". The play still ran and
    // the down still advanced, which is why it read as a working defense right up until the
    // validator was actually listened to.
    //
    // The linemen themselves are NOT optional: they are generated client-side and re-sent by the
    // defending client every pre-snap, so a defense that does not send them has no pass rush at
    // all — the quarterback stands untouched and the play never ends.
    const authoredD = self.overrideDefensiveCall ? null : authoredBook()
    const runningAuthored = authoredD && hasAuthoredDefense(authoredD)
    // ⚠️ A NEW OFFENSIVE LOOK IS A NEW QUESTION. The shell was chosen once per play and never
    // revisited, so an offense that changed its whole personnel grouping — three receivers out,
    // an empty set in — was answered by the call made against the formation it had abandoned. The
    // defense realigned its bodies and kept the wrong coverage, which is exactly what "switching
    // plays does not switch the defense" looks like from the other side of the ball.
    //
    // Keyed on the LOOK and not on position, which is the distinction that matters here: the whole
    // information structure is that the defense answers the formation it can see. Re-rolling on
    // every twitch would let a human shuffle a receiver back and forth until they liked the
    // coverage, and would also put the twitching back that `placedAt` exists to stop. Personnel
    // changing is a real event; a man moving two yards is not.
    const look = formationLookId(receivers, { ballX, losY })
    if (runningAuthored && self.authoredCall && self.authoredLook !== look) {
      self.authoredCall = null
      say(`offense changed to ${look} — re-calling the defense`)
    }
    if (runningAuthored && !self.authoredCall) {
      self.authoredLook = look
      self.authoredCall = self.forceAuthoredShell
        ? forceOneShell(authoredD, self.forceAuthoredShell)
        : callAuthoredDefense(authoredD, k, { ballX, receivers, rng, ...brains() })
      if (self.authoredCall) {
        say(`${self.authoredCall.shell.name} — ${self.authoredCall.formation.name} vs ${self.authoredCall.look.id}`)
        // [dev reveal] Named on the state so a screenshot can say WHICH shell this is, not just
        // where eleven dots ended up. Harmless when the reveal is off: nothing reads it.
        const g = getGame(socket?.data?.roomId)
        if (g) {
          g.aiCallName = `${self.authoredCall.shell.name} / ${self.authoredCall.formation.name}`
          g.aiCall = {
            ...(g.aiCall ?? {}),
            defense: {
              shellId: self.authoredCall.shell.id ?? null,
              shellName: self.authoredCall.shell.name ?? null,
              defFormationId: self.authoredCall.formation.id ?? null,
              look: self.authoredCall.look?.id ?? null,
            },
          }
        }
      }
    }
    const frontSize = self.authoredCall
      ? (self.authoredCall.formation.spots ?? []).filter(sp => String(sp.slot).startsWith('DL')).length
      : 4
    const front = autoDefense(losY, ballX, frontSize)
    for (const dl of front) socket.fire('place_player', dl)

    // ⚠️ A SHRINKING FRONT LEAVES A LINEMAN BEHIND. Going from a four-man front to a three-man one
    // places DL1-3 and says nothing about DL4 — who is still standing where the last shell put
    // him, still counts toward the eleven, and still rushes. On a new hash he is visibly in the
    // wrong place: the front's centre came out four yards off the ball.
    // ⚠️ A SHRINKING FRONT LEAVES A LINEMAN BEHIND, so the surplus comes off — asked of the
    // FIELD rather than of a record this code keeps. An earlier version consulted `placedAt`,
    // which is wiped at the start of every play, so by the time a four-man front shrank to three
    // the record of the fourth was already gone and the removal never fired at all.
    const wanted = new Set(front.map(d => d.id))
    const live = getGame(socket?.data?.roomId)?.defensePlayers
    for (const id of ['auto_dl1', 'auto_dl2', 'auto_dl3', 'auto_dl4']) {
      if (wanted.has(id) || !live?.has(id)) continue
      socket.fire('remove_player', id)   // the handler takes the id itself, not an object
      self.placedAt.delete(id)
    }
    self.frontOnField = [...wanted]

    // ⚠️ AN AUTHORED SHELL IS CHOSEN AFTER SEEING THE OFFENSE, which is why this sits inside
    // alignDefense rather than beside the offensive call: `receivers` is the whole input. The
    // hand-written shells remain the fallback for an empty playbook, and an override still wins
    // over both so a shell can be held fixed while it is measured.
    if (self.authoredCall) {
      placeAuthoredDefense(self.authoredCall, { losY, ballX, receivers })
      return
    }

    if (!self.done.personnel) {
      // [training] A NEAT genome plugs in HERE and nowhere else. It replaces the CALL — which
      // shell, which personnel — and inherits everything around it: the legality mask, the
      // alignment, motion, the hash. So a network's call is as legal as the heuristic's by
      // construction, and the network is never asked to rediscover that a corner cannot cover a
      // tight end.
      self.lastCall = self.overrideDefensiveCall
        ? self.overrideDefensiveCall(k)
        : callDefense(k, rng, ballX)
      say(`${self.lastCall.shellName} — ${JSON.stringify(self.lastCall.personnel)} (${self.lastCall.why})`)
      self.done.personnel = true
    }
    const call = self.lastCall
    const onField = selectPlayers(roster, call.personnel)
    const defenders = onField.map(p => ({ id: p.id, label: p.position }))

    let { assignments, warnings } = expandShell(call.shellId, { defenders, receivers, losY, ballX })

    // [deep] The second integration point for a network, and the one that widens the action space
    // past "pick a shell". The shell has already produced eleven LEGAL assignments; this lets a
    // brain adjust them per player — send a coverage man, move a zone's centre, shade a matchup,
    // line somebody up somewhere else. Nothing downstream changes: the same place_player and
    // assign_coverage calls go out, through the same validation a phone's would.
    if (self.adjustAssignments) {
      const adjusted = self.adjustAssignments(assignments, { k, defenders, receivers, losY, ballX, onField })
      if (adjusted?.assignments) {
        assignments = adjusted.assignments
        warnings = [...warnings, ...(adjusted.warnings ?? [])]
      }
    }
    if (warnings.length && log) say('warnings:', warnings.join('; '))

    // What this alignment answered, so a later drag can tell whether anything really moved.
    self.alignedAgainst = new Map(receivers.map(r => [r.id, { x: r.x, y: r.y }]))
    self.placedAt ??= new Map()

    const byId = new Map(receivers.map(r => [r.id, r]))
    for (const [id, a] of assignments) {
      const player = onField.find(p => p.id === id)
      // [deep] An alignment delta rides on the assignment. It is applied BEFORE clampDefender, so a
      // brain can ask to line up anywhere and still cannot produce an offside or illegally deep
      // defender — the clamp remains the authority.
      const base = alignmentFor(a, { losY, receivers: byId })
      const nudged = { x: base.x + (a.alignDx ?? 0), y: base.y + (a.alignDy ?? 0) }
      const spot = slop(nudged)
      const placed = clampDefender(player.position, spot, losY)

      // ⚠️ Only send a placement that actually MOVES him. Re-sending the same spot is what the
      // player sees as the defense twitching: every re-align rebroadcast eleven positions, and the
      // client redrew them all even when nothing had changed.
      const was = self.placedAt.get(id)
      if (!was || Math.abs(was.x - placed.x) > 0.05 || Math.abs(was.y - placed.y) > 0.05) {
        self.placedAt.set(id, { x: placed.x, y: placed.y })
        socket.fire('place_player', {
          id, x: placed.x, y: placed.y, label: player.position, team: 'd',
          ratings: player.ratings, xFactor: player.xFactor,
        })
      }

      // blitz and spy are coverage TYPES in this engine, not placements — they still go through
      // assign_coverage, just without a target or a landmark.
      socket.fire('assign_coverage', {
        playerId: id,
        type: a.type,
        targetId: a.targetId ?? null,
        zoneType: a.zoneType ?? null,
        zoneCenterX: a.zoneCenterX ?? null,
        zoneCenterY: a.zoneCenterY ?? null,
        manCommit: a.manCommit ?? null,
      })
    }
    self.done.coverage = true
  }

  // [difficulty] Sloppy alignment, which is the easy tier's main handicap on defense. The shell
  // still asks for the right spot; this defender just does not get there exactly. Drawn from the
  // controller's own seeded stream so a replay stays a replay, and clamped afterwards by
  // clampDefender so a slopped spot can never be an ILLEGAL one (offside, or past the legal depth).
  // Note what this is not: it degrades where a defender STANDS, not what the AI was told.
  function slop(spot) {
    const yards = skill().alignSlop
    if (!yards) return spot
    return {
      x: spot.x + (rng() * 2 - 1) * yards,
      y: spot.y + (rng() * 2 - 1) * yards,
    }
  }

  // This room's tier. Read through a function rather than captured once, because `difficulty`
  // arrives on the first game_state — a value captured at construction time would always be the
  // 'easy' default in createKnowledge.
  function skill() { return skillFor(k.difficulty) }

  // A defender's legal box is shallower than a zone landmark can be — a deep safety may be placed
  // 25 yards off, a linebacker only 10. Clamping here rather than in the shell keeps the LANDMARK
  // honest (that is where he is going) while the ALIGNMENT stays legal (that is where he starts).
  function clampDefender(label, spot, losY) {
    const maxDepth = DEF_MAX_DEPTH[label] ?? 15
    const { x } = legalSpot('DEF', spot.x, spot.y, losY)
    // ⚠️ THE FIELD ENDS. Clamping only to `losY + maxDepth` puts a deep safety past the back of the
    // end zone whenever the ball is inside the 25 — the server refuses that outright ("y must be a
    // number between -10 and 110"), the placement is dropped, and the defense silently takes the
    // field with nine men. Invisible until an alignment delta made it common; the same class of bug
    // as a deep zone landmark being refused and quietly turning a safety into a pass rusher.
    const wanted = Number.isFinite(spot.y) ? spot.y : losY + DEF_MIN_DEPTH
    const byRole = Math.max(losY + DEF_MIN_DEPTH, Math.min(losY + maxDepth, wanted))
    return {
      x,
      y: Math.max(-10, Math.min(110, byRole)),
    }
  }

  // The down linemen, at the spots the client generates. Must match the DL_SPACING table in
  // Client/src/game/formation.ts — both sides draw the same front.
  //
  // ⚠️ THE COUNT IS VARIABLE BUT DEFAULTS TO FOUR, so nothing about the live game moves. An
  // authored 3-4 or 3-3-5 front asks for fewer; a 5-2 does NOT ask for five, because every roster
  // carries exactly four linemen — its fifth man on the ball is a linebacker walked down.
  function autoDefense(losY, centerX, count = 4) {
    return DL_SPACING[count].map((dx, i) => (
      { id: `auto_dl${i + 1}`, x: centerX + dx, y: losY + 1, team: 'd', label: 'DL' }
    ))
  }

  // ── Motion ────────────────────────────────────────────────────────────────
  //
  // "When a player on offense moves they should move." Re-running the whole decision on every drag
  // would be both expensive and twitchy, so the CALL is fixed and only the alignment follows: man
  // defenders travel with their receiver, zone defenders hold their landmark. That is also what a
  // real defense does — motion does not change the coverage, it changes who is standing where.
  // How far a receiver must actually move before the defense bothers to re-align.
  //
  // ⚠️ NOT a timer. Dragging a receiver fires a `place_player` on every pointer move, and the AI
  // re-aligned all eleven defenders on each one — which on screen is the whole defense twitching
  // continuously while you drag. The obvious fix is to debounce, and it would be WRONG: the
  // training harness drives plays synchronously, so a deferred realignment would land after the
  // snap and the defense would line up against nothing. This stays synchronous and simply ignores
  // movement too small to change anybody's job.
  const MOTION_THRESHOLD = 1.5    // yards

  function onOpponentMoved(payload) {
    // Our own placements echo back through the room broadcast. Ignore them: reacting to yourself
    // is how the alignment loop became infinite.
    const mine = isOffense(k) ? 'o' : 'd'
    if (payload?.team === mine) return
    if (!isDefense(k)) return

    const last = self.alignedAgainst
    if (last) {
      const receivers = oppSkill(k)
      const changed = receivers.length !== last.size || receivers.some(r => {
        const was = last.get(r.id)
        return !was || Math.hypot(r.x - was.x, r.y - was.y) > MOTION_THRESHOLD
      })
      if (!changed) return
    }
    playDefense()
  }

  // ── The snap ──────────────────────────────────────────────────────────────
  function onDefenseSet() {
    self.forceSet = true
    if (isOffense(k)) playOffense()   // places if it somehow has not yet, then locks immediately
  }

  function onOffenseSet() {
    // The offense has locked. As the defense this is the last chance to adjust, which playDefense
    // has already taken; nothing further to do until the countdown runs out.
    if (isDefense(k)) playDefense()
  }

  function onCountdown(payload) {
    if (!isOffense(k)) return

    // [run adjust] The last beat before the snap: look at where the front actually lined up and take
    // the lane it left. `chooseRunAngle` already scores every gap by how crowded it is — it was just
    // being asked before the defense had shown anything.
    if ((payload?.count ?? 99) <= RUN_ADJUST_AT && !self.done.runAdjust && self.lastCall?.playType === 'run') {
      self.done.runAdjust = true
      const lane = chooseRunAngle(k, k.ballX, rng)
      if (lane && Number.isFinite(lane.angle)) {
        say(`run adjust → ${lane.angle}°`)
        socket.fire('adjust_run_angle', { runAngle: lane.angle })
      }
    }
    // The hike unlocks at zero. Snapping is the offense's own decision, so it is made here rather
    // than reacting to a server prompt.
    if ((payload?.count ?? 1) <= 0 && !self.done.snapped) {
      self.done.snapped = true
      socket.fire('snap_ball')
    }
  }

  // ── Live play ─────────────────────────────────────────────────────────────
  //
  // Post-snap the engine runs everything except the throw. The offense watches for an open receiver
  // and lets it go; the defense has nothing left to decide.
  //
  // Two modes, and they are genuinely different problems:
  //
  //   AUTOMATIC — the play runs itself. Watch each tick, throw when somebody comes open.
  //   MANUAL    — nothing moves unless GO is held, and a throw is legal ONLY while the board is
  //               frozen. So the loop is: hold GO to let the routes develop, release to freeze,
  //               look, then either throw or hold again. An AI that never releases can never throw
  //               — which is exactly what happened in the first real game: two plays, two sacks,
  //               the quarterback holding the ball the whole way.
  function onLive() {
    if (!isOffense(k) || k.phase !== 'live') return
    if (self.lastCall?.playType === 'run') return
    if (self.done.threw) return

    if (isManualRoom()) {
      // ⚠️ HE DECIDES EVERY TICK IN MANUAL TOO, exactly as in automatic. The board still runs on
      // the manual clock underneath, so the mode keeps its rhythm; this changes only WHEN he is
      // allowed to pull the trigger. See mayThrowWhileMoving in validation.js for why.
      if (tryThrow()) return
      return runManualClock()
    }
    tryThrow()
  }

  // The server tells us outright, on ball_snapped. Better than inferring it from the room mode:
  // a manual room still runs its RUN plays the ordinary way, and only the server knows which.
  function isManualRoom() { return k.manualPlay }

  // [manual] How long the AI holds GO before releasing to look. Long enough for routes to declare
  // (the engine needs 1.3s on a route with no cut) and short enough that the rush has not arrived.
  // ⚠️ AFTER the routes declare, not before. The engine needs 1.3s on a route with no cut, so a
  // first look at 1.1s is spent on a field where nobody has broken yet — measured, zero receivers
  // were above the throw FLOOR at that look, so it could never produce a throw and he only ever got
  // one more before the rush arrived.
  const MANUAL_LOOK_AFTER = 1.45
  // …and how long it holds on a later press, once it has already had one look.
  // How often he gets to decide at all: throws are legal only while frozen, so this is his entire
  // decision rate in manual — two or three looks in a play, against roughly forty-seven chances to
  // act in automatic. Shortening it to 0.3 was tried and measured WORSE (34% against 30%), so the
  // cadence is not what is costing the sacks; leaving it where it was.
  const MANUAL_HOLD_AGAIN = 0.55

  // ⚠️ HE LETS GO OF GO WHEN HE FEELS THE RUSH. Throws are only legal while the board is FROZEN,
  // so in manual the quarterback does not decide every tick the way he does in automatic — he gets
  // one look per press, 0.55s of board time apart. Measured, he was being sacked at ~2.3s having had
  // TWO decision points in the whole play, because a rusher that arrives mid-press cannot be
  // answered until the next release. A human holding the button would simply let go. So does he.
  const MANUAL_PEEK_PRESSURE = 0.55

  // [manual anticipation] How far ahead a trend is projected when he finally gets to look. Roughly
  // the gap between looks: he is guessing where a receiver will be by the time the ball could get
  // there, not where he was.
  const ANTICIPATE_AHEAD = 0.4
  // How much history the trend is measured over. Too short and it is noise; too long and it is
  // still describing the receiver's release.
  const READ_MEMORY = 10

  // ⚠️ HE MAY ONLY THROW WHILE FROZEN. HE MAY ALWAYS LOOK. Reading is free and continuous; it
  // is the THROW that the manual rule restricts. Without this he saw the field exactly twice in a
  // play, and an intermittent window sampled twice is usually missed.
  function readField() {
    const seen = rankTargets(k, { noise: 0, rng })
    const at = self.boardTime ?? 0
    self.reads ??= new Map()
    for (const t of seen) {
      const arr = self.reads.get(t.id) ?? []
      arr.push({ at, o: t.trueScore })
      if (arr.length > READ_MEMORY) arr.shift()
      self.reads.set(t.id, arr)
    }
  }

  // Where a receiver's openness is HEADING, from the history above. Falls back to what he can see
  // right now whenever there is not enough history to have an opinion.
  function anticipate(id, current) {
    const arr = self.reads?.get(id)
    if (!arr || arr.length < 3) return current
    const first = arr[0], last = arr[arr.length - 1]
    const dt = last.at - first.at
    if (dt <= 0.05) return current
    const slope = (last.o - first.o) / dt
    return Math.max(0, Math.min(1, current + slope * ANTICIPATE_AHEAD))
  }

  function runManualClock() {
    // Time only advances while the board is moving, which is the same clock the engine uses.
    if (self.manualFrozen) return
    self.heldFor = (self.heldFor ?? 0) + TICK_SECONDS
    // Still read every tick: the trend feeds `anticipate` below, which ranks on where a receiver is
    // HEADING rather than where he is. The early release that used to sit here existed only to buy
    // him a LOOK, and he no longer needs the board stopped in order to throw.
    readField()
    // ⚠️ AND THE PLAY'S REAL AGE, which `looks * 0.9` only pretended to be: after two looks it
    // claimed 1.8s when 2.35s of board time had actually gone by, so the throw bar decayed slower
    // than the rush arrived. This is the same quantity `liveFor` is in automatic.
    self.boardTime = (self.boardTime ?? 0) + TICK_SECONDS
    const limit = self.looks > 0 ? MANUAL_HOLD_AGAIN : MANUAL_LOOK_AFTER
    if (self.heldFor < limit && pressureUrgency() < MANUAL_PEEK_PRESSURE) return
    self.heldFor = 0
    socket.fire('go_release')
  }

  function onManualFrozen() {
    self.manualFrozen = true
    self.looks = (self.looks ?? 0) + 1
    if (!isOffense(k) || self.done.threw || self.lastCall?.playType === 'run') return

    // The one window in which a throw is legal. Take it if anybody is open; otherwise start the
    // board again and look once more.
    if (tryThrow()) return
    socket.fire('go_press')
  }

  function onManualResumed() {
    self.manualFrozen = false
  }

  // The throw itself. Returns true if the ball went.
  //
  // The threshold falls the longer the play goes on: a receiver who is a 0.7 at two seconds is
  // worth waiting for, and the same receiver at four seconds is the best you are going to get
  // before the rush arrives. Without this the AI holds out for a window that never opens.
  // [difficulty] The three numbers live in difficulty.js now. An easy quarterback holds out for a
  // window better than he needs (high threshold), takes too long to give up on it (long patience)
  // and then forces it into a worse one than a good passer would (low floor) — indecision, then
  // panic. Hard keeps the tuned values these constants used to hold.

  // ── Pressure ([pressure]) ─────────────────────────────────────────────────
  //
  // How close the nearest defender is to the man holding the ball, as 0 (clean pocket) to 1 (about
  // to be hit). Computed from `k.live`, which is the same picture a human is looking at — this is
  // reading the rush, not seeing through the defense.
  //
  // Why it exists: against a six-man blitz the AI quarterback used to hold the ball for a window
  // that never opened, throwing at 1.79s with the best receiver at 0.27 openness, or not at all.
  // Peak openness on those same plays was 1.00 — somebody DID come open, exactly as football says
  // they should against an all-out blitz — but the read gate waited past the point of being hit.
  // A real passer speeds up when the rush arrives and takes the best thing available.
  const PRESSURE_ON  = 2.5   // yd — he is about to be hit
  const PRESSURE_FAR = 6.0   // yd — the pocket is still clean

  // ⚠️ `pressureAware` SHIFTS WHEN HE NOTICES, IT DOES NOT CAP WHAT HE CAN NOTICE.
  //
  // It used to multiply the result, which is a different and much worse thing: at 0.45 on easy and
  // 0.8 on medium, urgency could never reach 1 on either tier no matter how close the rush got. Two
  // consequences, both of which read as "the quarterback won't throw":
  //
  //   - the bail-out gate (0.99) was arithmetically unreachable off hard — dead code for most
  //     players. Measured: zero throwaways across all three tiers over hundreds of pass plays.
  //   - the throw bar decays with `max(elapsed/patience, urgency)`, so a capped urgency also capped
  //     the decay. With a receiver between the floor and the bar he would neither throw to him nor
  //     throw it away; he stood in the pocket until somebody arrived. On medium the sacks land at
  //     2.3s against a patience of 3.2s, so running out of time never rescued him either.
  //
  // Now a less aware passer simply starts reacting later — 4.1 yards out on easy against 6.0 on
  // hard — and still reaches full urgency when a defender is on top of him, which is the one thing
  // every quarterback does.
  function pressureUrgency() {
    const qb = [...k.live.values()].find(p => p.qb || p.carrier)
    if (!qb) return 0
    let nearest = Infinity
    for (const p of k.live.values()) {
      if (p.team !== 'd') continue
      const d = Math.hypot(p.x - qb.x, p.y - qb.y)
      if (d < nearest) nearest = d
    }
    if (!Number.isFinite(nearest)) return 0
    const aware = skill().pressureAware
    const far = PRESSURE_FAR * aware + PRESSURE_ON * (1 - aware)
    if (far <= PRESSURE_ON) return nearest <= PRESSURE_ON ? 1 : 0
    return Math.max(0, Math.min(1, (far - nearest) / (far - PRESSURE_ON)))
  }

  // ⚠️ HOW CLOSE IS CLOSE ENOUGH TO BAIL OUT. The gate used to be 0.99 against the HANDICAPPED
  // urgency, which made the throwaway unreachable in two separate ways:
  //
  //   - `pressureAware` is 0.45 on easy and 0.8 on medium, so urgency could not arithmetically
  //     reach 0.99 on either tier. The bail-out was dead code for every player not on hard.
  //   - even on hard, 0.99 means a defender within 2.5 yards — the moment of the sack, not a beat
  //     before it. Measured across all three tiers over hundreds of pass plays: zero throwaways.
  //
  // Reported as "the quarterback is constantly getting sacked and I'm only rushing 4 ... it might
  // be because the qb won't throw", and the measurement agreed with the second half: sacks go UP as
  // rushers go DOWN (0% against four in zone, 9% against four in man, 20% against three), which is
  // backwards for a protection failure and exactly right for a passer with nowhere to go.
  // How far BELOW the throw floor the best man has to be before giving up on the play entirely.
  // 1.0 means "bail whenever nobody clears the floor"; lower means he will sling a contested one.
  //
  // ⚠️ AT 1.0 HE THREW IT AWAY ON 23% OF PASS PLAYS. Measured over 405: no throw at all on 27% of
  // them, for nought yards each, which is most of why the offense managed 3.1 yards an attempt. It
  // got worse as coverage got tighter -- fewer open men means more giving up -- so the fix belongs
  // on the offense rather than by loosening the defense back.
  //
  // At 0.5, paired over 582 plays: +0.538 ± 0.259 yds/play, which is REAL. No throw falls from 27%
  // to 10% and touchdowns went from 4 to 12. It is not free: interceptions go 2 -> 6 and sacks
  // 12 -> 20 over the same sample. Pricing a turnover at the engine's own possession value (~38
  // yds) that is about 0.48 yds a pass play against a gain near 0.98, so it is still ahead -- and a
  // quarterback who slings a contested ball is better to watch than one who gives up.
  const BAIL_FLOOR_SCALE = 0.5

  const BAIL_PRESSURE = 0.72

  // The openness he currently requires, which falls with time and with pressure. Lifted out of
  // tryThrow because in manual the decision to STOP THE BOARD is made against the same number.
  // How far through the play he is, 0 at the snap and 1 once his patience is spent or the rush is on
  // top of him. One definition, two users: the openness he requires falls with it, and so does how
  // much he insists on a throw that converts (reads.js, shortReach).
  function readDecay(sk, elapsed, urgency) {
    const t = Math.min(1, elapsed / sk.patience)

    // ⚠️ TIME ONLY BUYS PATIENCE BACK AS FAST AS THE PLAY ACTUALLY DEVELOPS.
    //
    // Reported as "the QB is still throwing very fast and not letting plays develop", and the report
    // bore it out: a median release at 1.05s of board time, where an average of 1.3 receivers had
    // declared. The first short route breaks at 0.7-0.9s, reads wide open -- a back in the flat with
    // nobody within five yards -- and by then the bar has already decayed from 0.66 to about 0.57,
    // so even a discounted checkdown clears it. The ball was gone before the play existed.
    //
    // So the TIME half of the decay is scaled by how much of the route distribution is live. Pressure
    // is deliberately left alone: a rush closing on him is a real reason to get rid of it, and that is
    // what keeps this from turning into sacks.
    //
    // ⚠️ AND `t` IS ITS OWN FLOOR, which is what stops it being a deadlock. Early, the decay has to
    // be earned by receivers declaring; by the time his patience is spent, t is 1 and time counts in
    // full whether anybody got open or not. A play where the routes are jammed must still end in a
    // throwaway rather than a quarterback standing still for ever.
    //
    // At full development this is exactly the old expression, so it is inert on a developed play.
    // ⚠️ THE FLOOR'S SHAPE WAS SWEPT AND IS INERT. Weakening it early (t squared, t cubed) was tried
    // on the theory that `t` neuters the gate exactly when development is lowest. It changed nothing
    // measurable -- release 1.19s and 42% of throws with two or fewer declared, at every exponent --
    // because the development term is already the larger of the two nearly all the time. So the simple
    // form stays rather than a knob that does not move anything.
    const gate = process.env.QB_DEVELOP_GATE === '0' ? 1 : Math.max(developedFraction(k), t)
    return Math.max(t * gate, urgency)
  }

  function currentBar(sk, elapsed, urgency) {
    return sk.throwThreshold - (sk.throwThreshold - sk.throwFloor) * readDecay(sk, elapsed, urgency)
  }

  // The beat he has to hold the ball before a throw is legal at all, in seconds of live play
  // (board time in manual). Short enough that a screen still goes early, long enough that the ball
  // is never gone on the snap.
  // How far into the play the "he must actually be open" requirement holds before it lets go. Past it
  // the bar alone decides, so a dying play still ends in a throw rather than a sack.
  const OPEN_REQUIRED_UNTIL = Number(process.env.QB_OPEN_UNTIL ?? 0.5)

  const MIN_TIME_BEFORE_THROW = 0.65

  // ⚠️ AND LONGER WHEN THERE IS NO SUCH THING AS A QUICK THROW THAT HELPS. On 3rd and 8 a ball out
  // at 0.75s cannot convert whatever happens to it, so the floor above is the only thing he is really
  // waiting for. A screen still has to go early, which is why this is conditioned on the down needing
  // real yards rather than applied to everything.
  const CONVERT_MIN_TIME = Number(process.env.QB_CONVERT_MIN_TIME ?? 1.2)
  const CONVERT_MIN_DISTANCE = 4

  function minHold() {
    const mustConvert = (k.down ?? 1) >= 3 && (k.distance ?? 10) >= CONVERT_MIN_DISTANCE
    return mustConvert ? Math.max(MIN_TIME_BEFORE_THROW, CONVERT_MIN_TIME) : MIN_TIME_BEFORE_THROW
  }

  // [analytics] Forwards a decision to the report for this socket's room. A no-op off a solo game
  // and wrapped besides: a missing report must never cost a throw.
  function noteAiDecision(sock, decision) {
    try {
      const g = getGame(sock?.data?.roomId)
      if (g) noteDecision(g, decision)
    } catch { /* ignore */ }
  }

  function tryThrow() {
    const sk = skill()

    self.liveFor = (self.liveFor ?? 0) + (isManualRoom() ? 0 : TICK_SECONDS)
    const elapsed = isManualRoom() ? (self.boardTime ?? 0) : self.liveFor
    const urgency = pressureUrgency()

    // ⚠️ THE CLOCK IS READ BEFORE THE FIELD IS, and that is load-bearing now. On a down that must
    // convert, how badly a throw short of the sticks is discounted depends on how much play he has
    // left -- early he wants the first down, late he wants the completion. Ranking first and timing
    // afterwards would have ranked against a snap-time picture on every tick.
    const targets = rankTargets(k, {
      noise: sk.readNoise, rng, decay: readDecay(sk, elapsed, urgency),
    })

    // ⚠️ Bail out rather than eat the sack. A throwaway costs nothing and a sack costs seven yards
    // plus the down, so a quarterback with nobody open and a defender in his lap should always take
    // the incompletion. The AI never did this — the mechanic existed and nothing in ai/ referenced
    // it — which is a large part of why blitzing was free.
    // ⚠️ WHAT COUNTS AS "NOTHING THERE" DECIDES HOW OFTEN HE GIVES UP. At the throw floor he
    // bailed on 23% of pass plays for nought yards each, which is most of why the offense averages
    // 3.1 yards an attempt. A contested ball is worth more than a throwaway: interceptions are 0.5%
    // of attempts in this engine, so the downside is close to free.
    const bailFloor = sk.throwFloor * BAIL_FLOOR_SCALE
    const nothingThere = targets.length === 0 || targets[0].score < bailFloor
    // ⚠️ OR HE HAS SIMPLY RUN OUT OF PLAY. Past his patience the bar has already decayed to the
    // floor, so if nothing is above the floor by then, nothing is coming — waiting longer only
    // chooses between a throwaway and a sack, and the throwaway is free.
    const outOfTime = elapsed >= sk.patience
    if (k.throwawayReady && nothingThere && (urgency >= BAIL_PRESSURE || outOfTime)) {
      noteAiDecision(socket, {
        kind: 'throwaway', urgency: +urgency.toFixed(3), elapsed: +elapsed.toFixed(2), outOfTime,
        best: targets[0] ? +targets[0].score.toFixed(3) : null, floor: sk.throwFloor,
      })
      self.done.threw = true
      socket.fire('throwaway')
      say('threw it away under pressure')
      return true
    }

    if (targets.length === 0) return false

    // ⚠️ HE CANNOT LET IT GO THE INSTANT THE BALL IS SNAPPED. Reported as a glitch: the ball
    // occasionally left his hand immediately. The read gate alone does not prevent it, because a
    // receiver can already score well at the snap -- a back in the flat with nobody within five
    // yards reads as WIDE OPEN before he has gone anywhere -- so the throw was legal on tick one.
    //
    // A flat floor rather than a change to the read: nothing about the openness is wrong at that
    // moment, it is simply too early for the ball to be gone. Applied in BOTH modes, since manual
    // now decides every tick on the same code path and would show the same thing.
    //
    // ⚠️ BELOW THE BAIL-OUT ON PURPOSE. Throwing it away is not "letting it go early" -- it is
    // already gated far harder, at 2s of live play by the server's throwaway window, and putting
    // this above it stopped a quarterback with a defender in his lap from saving the down.
    if (elapsed < minHold()) return false

    // The bar falls with TIME (a receiver worth waiting for at two seconds is the best you will get
    // at four) or with PRESSURE, whichever is more urgent.
    const bar = currentBar(sk, elapsed, urgency)

    // [manual anticipation] Re-rank on where each receiver is HEADING rather than where he is, then
    // judge that against the same bar. Only in manual, and only when he has had ticks to watch.
    //
    // ⚠️ SORTED THROUGH `orderKey`, NOT ON THE SCORE. This re-sorted on the score alone, which
    // threw away the tiering reads.js had just done -- so "prefer the first down over the checkdown"
    // was live everywhere EXCEPT a manual room, which is the mode the game is played in. The
    // anticipation belongs on the openness; the preference between a conversion and a checkdown is
    // not something projecting a receiver forward has anything to say about.
    let best = targets[0]
    if (isManualRoom() && targets.length) {
      const projected = targets
        .map(t => ({ ...t, score: anticipate(t.id, t.score) }))
        .sort((a, b) => orderKey(b) - orderKey(a))
      best = projected[0]
    }
    // ⚠️ EARLY ON, THE MAN HE THROWS TO HAS TO ACTUALLY BE OPEN, AND "OPEN" IS A STEP.
    //
    // The completion odds are not a ramp: at OPENNESS_OPEN and above a throw is caught 95% of the time,
    // and anywhere from 0.33 to 0.66 it is 45% -- so an 0.55 window and an 0.64 window are THE SAME
    // THROW, and the gap between 0.64 and 0.66 is fifty points of completion. Everything above scores on
    // continuous openness, which means the quarterback was optimising a number the engine cannot see.
    //
    // Measured over a real game: on 38% of his throws an open man was available and he found him, but
    // only 35% of his throws went to one AT ALL. He was not missing open men. He was releasing when
    // there were none, into a 45% window, because 0.60 looked good enough against a continuous bar.
    //
    // ⚠️ IT IS JUDGED ON THE RAW READ, NOT ON `score`. `score` is openness DISCOUNTED by how far short
    // of the sticks the catch would be, so the two live in different units -- a 0.70 receiver short of
    // the marker scores 0.35 and a 0.66 one past it scores 0.66. Raising the BAR was tried first and was
    // inert for exactly that reason: it moved a threshold in the wrong units.
    //
    // Relaxed by the same `decay` everything else uses, so late in the play a 45% throw is available
    // again -- which is right, because by then the alternative is a sack.
    const rawOpen = best.trueScore ?? best.score
    if (readDecay(sk, elapsed, urgency) < OPEN_REQUIRED_UNTIL && rawOpen < OPENNESS_OPEN) return false

    if (best.score < bar) {
      // [analytics] Holding on is a decision as much as throwing is, and it is the one that ends
      // in sacks. Sampled rather than logged every tick: 20 Hz of "still waiting" would drown it.
      if ((self._heldLog = (self._heldLog ?? 0) + 1) % 10 === 0) {
        noteAiDecision(socket, {
          kind: 'held', elapsed: +elapsed.toFixed(2), urgency: +urgency.toFixed(3),
          best: +best.score.toFixed(3), bar: +bar.toFixed(3),
        })
      }
      return false
    }

    // [analytics] WHY he threw, not just that he did: the bar he had to clear, what everybody else
    // was worth, and how much pressure was on him. The record that makes a bad decision arguable.
    // ⚠️ `score` AND `ranked` WERE ON DIFFERENT SCALES IN MANUAL. In manual the chosen man is
    // re-ranked on where he is HEADING, so the logged score was a projection while `ranked` held
    // the raw reads -- one play showed a throw at score 0.639 to a receiver listed at 0.404, which
    // looks like a contradiction and is not. Both are recorded now, and which one decided it.
    const raw = targets.find(t => t.id === best.id)
    noteAiDecision(socket, {
      kind: 'throw', target: best.id,
      score: +best.score.toFixed(3),
      rawScore: raw ? +raw.score.toFixed(3) : null,
      projected: isManualRoom(),
      bar: +bar.toFixed(3), urgency: +urgency.toFixed(3), elapsed: +elapsed.toFixed(2),
      ranked: targets.slice(0, 5).map(t => ({ id: t.id, score: +t.score.toFixed(3), estimated: !!t.estimated })),
    })
    self.done.threw = true
    socket.fire('throw_to_receiver', best.id)
    say(`throw → ${best.id} (${best.estimated ? 'read' : 'openness'} ${best.score.toFixed(2)} vs bar ${bar.toFixed(2)})`)
    return true
  }

  // ── Special teams ─────────────────────────────────────────────────────────
  // ⚠️ RE-ENTRANT. A tap is echoed back as a `special_teams_update`, which wakes this, which taps
  // again — "Maximum call stack size exceeded" on the first kick after the meter started being
  // broadcast. One action per update is also simply correct: the meter drains on a clock, so there
  // is nothing to gain from answering the echo of your own input.
  let kicking = false
  function onSpecialTeams() {
    if (kicking) return
    kicking = true
    try { doSpecialTeams() } finally { kicking = false }
  }

  // ⚠️ THE COMPUTER COULD NOT KICK AT ALL, AND TWICE THE REASON LOOKED LIKE THE POWER METER.
  //
  // Reported as "the AI punts 22 yards", then as "still punting at the minimum" after a fix aimed
  // at the meter. The second report is the useful one: a fix that does not move the number was not
  // the fault. scripts/kickLab.mjs measured the whole path and added the column that found it --
  // the power the ball was struck at. It was full-meter-minus-one-complete-drain, on every kick.
  // The AI was not kicking badly. It was firing NOTHING, and 21.4 yards is what a punt travels at
  // no power. Field goals went 0 for 20 from 37 and 49 yards for the same reason.
  //
  // The cause was in neither the meter nor the policy: `k.decision` is cleared only by a
  // `game_state`, and resolving the menu into a punt or a field goal does not send one. So the
  // answered menu stayed open in the AI's knowledge and every wake-up for the rest of the kick
  // re-answered it instead of kicking. Fixed in knowledge.js, where the view is what was wrong.
  //
  // Two things remain true here. A KICK OUTRANKS A MENU: if both are somehow present, the ball on
  // the field is the live question. And the kick that this call just put on the field is acted on
  // IN THIS CALL -- its broadcast woke this function re-entrantly and the guard below swallowed it,
  // which is right for a tap loop and wrong for a one-shot strike. Without it the computer sits
  // silent until the five-second inactivity timer starts the meter for it, so every AI kick took
  // eight and a half seconds of real time.
  function doSpecialTeams() {
    if (k.specialTeams) return fireAction(specialTeamsAction(k, rng))
    if (!k.decision) return
    fireAction(fourthDownChoice(k, rng))
    if (k.specialTeams) fireAction(specialTeamsAction(k, rng))
  }

  function fireAction(action) {
    if (!action) return
    say('special teams:', action.event, JSON.stringify(action.payload))
    socket.fire(action.event, action.payload)
  }

  return self
}
