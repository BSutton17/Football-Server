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
import { solvedTable } from './playcall/table.js'
import { getGame } from '../game/gameState.js'
const forceDeps = { adjustOffense }
import { createKnowledge, applyEvent, isOffense, isDefense, oppSkill } from './knowledge.js'
import { callDefense, selectPlayers } from './defense.js'
import { callOffense, buildFormation, chooseRunAngle } from './offense.js'
import { expandShell, alignmentFor } from './assignments.js'
import { legalSpot } from './playbook/formations.js'
import { specialTeamsAction, fourthDownChoice } from './specialTeams.js'
import { makeRng } from '../game/utils/rng.js'
import { chooseSetTime, shouldSetNow } from './timing.js'
import { rankTargets } from './reads.js'
import { skillFor } from './difficulty.js'

// Defensive placement bounds, mirroring the client's getPositionYBounds. A defender placed past
// these is refused outright, so the alignment a shell asks for has to be clamped into them — a
// Tampa 2 linebacker carrying the deep middle lines up at ten yards and RUNS to sixteen.
const DEF_MAX_DEPTH = { LB: 10, CB: 20, S: 25 }
const DEF_MIN_DEPTH = 0.75      // a full player radius off the ball, or it is offside

// One simulation tick, in seconds. The AI's sense of time is positions_update arrivals, which the
// server sends once per tick — so counting them IS counting game time, and it stays correct
// through a freeze or a pause because a held tick sends nothing.
const TICK_SECONDS = 0.05

// Where the down linemen line up, by how many of them there are. Spacing is listed per count
// rather than computed, because the alignments genuinely differ: three is a nose with two ends,
// four is the base front.
//
// ⚠️ MUST MATCH `DL_SPACING` in Client/src/game/formation.ts, or the two screens draw a different
// defense. The four-man row is byte-identical to what shipped before this became variable.
const DL_SPACING = {
  3: [-3.0, 0, 3.0],
  4: [-3.25, -1.25, 1.25, 3.25],
}

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
    done: { personnel: false, formation: false, coverage: false, set: false, snapped: false },

    onEvent(event, payload) {
      applyEvent(k, event, payload)
      if (k.newPlay) { resetPlay(); k.newPlay = false }

      switch (event) {
        case 'game_state': return onSituation()
        case 'player_placed': return onOpponentMoved(payload)
        case 'offense_set': return onOffenseSet()
        case 'hike_countdown': return onCountdown(payload)
        case 'play_result': return undefined   // the whistle; knowledge.js records the phase
        case 'play_clock_update': return onSituation()
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
        case 'positions_update': return onLive()
        default: return undefined
      }
    },
  }

  function resetPlay() {
    self.done = { personnel: false, formation: false, coverage: false, set: false, snapped: false }
    self.lastCall = null
    // ⚠️ The authored shell is per PLAY. Left set, the defense would keep calling last down's
    // coverage for the rest of the drive — and because alignDefense re-runs on every opponent
    // placement, it would look like it was deciding afresh each time while never changing.
    self.authoredCall = null
    self.authoredLook = null   // …and the look it was chosen against, so a new play re-decides
    self.coverageOnField = []  // …and who the last shell had out there
    self.players = []
    self.setAt = null
    self.manualFrozen = false
    self.heldFor = 0
    self.looks = 0
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
        : callAuthoredOffense(authored, k, { ballX, rng, ...brains() }))
      : null

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
    if (self.setAt == null) self.setAt = chooseSetTime(rng)
    if (!self.forceSet && !shouldSetNow(k.playClock ?? 0, self.setAt)) return

    const losY = k.yardLine
    const ballX = k.ballX            // the line and the quarterback pivot on the hash, like the client's
    // The line and the quarterback are not dragged by anyone — they are auto-placed, and they
    // travel in the set_offense payload rather than as place_player events.
    socket.fire('set_offense', {
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

    // ⚠️ A RE-CALLED SHELL MUST TAKE THE PREVIOUS ONE'S DEFENDERS OFF. Shells field different
    // numbers behind the line — seven behind a four-man front, eight behind a three — so going
    // from the eight-man shell to the seven-man one placed seven and left the eighth standing
    // where he was. Twelve men, and the extra one still had last call's assignment.
    const wanted = new Set(rows.map(r => r.id))
    for (const id of self.coverageOnField ?? []) {
      if (wanted.has(id)) continue
      self.expectMissingRemoval = true
      socket.fire('remove_player', id)
      self.expectMissingRemoval = false
      self.placedAt.delete(id)
    }
    self.coverageOnField = [...wanted]
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
    const look = formationLookId(receivers)
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
    const wanted = new Set(front.map(d => d.id))
    for (const id of self.frontOnField ?? []) {
      // ⚠️ WHICH LINEMEN ARE OUT THERE OUTLIVES THE PLAY, so this record has to as well. The first
      // version of this guard asked `placedAt`, which is wiped at the start of every play — so by
      // the time a four-man front shrank to three, the record of the fourth was already gone and
      // the removal never fired at all. He stayed on the field, at the previous hash.
      if (!wanted.has(id)) {
        self.expectMissingRemoval = true
        socket.fire('remove_player', id)   // the handler takes the id itself, not an object
        self.expectMissingRemoval = false
        self.placedAt.delete(id)
      }
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

    if (isManualRoom()) return runManualClock()
    tryThrow()
  }

  // The server tells us outright, on ball_snapped. Better than inferring it from the room mode:
  // a manual room still runs its RUN plays the ordinary way, and only the server knows which.
  function isManualRoom() { return k.manualPlay }

  // [manual] How long the AI holds GO before releasing to look. Long enough for routes to declare
  // (the engine needs 1.3s on a route with no cut) and short enough that the rush has not arrived.
  const MANUAL_LOOK_AFTER = 1.1
  // …and how long it holds on a later press, once it has already had one look.
  const MANUAL_HOLD_AGAIN = 0.55

  function runManualClock() {
    // Time only advances while the board is moving, which is the same clock the engine uses.
    if (self.manualFrozen) return
    self.heldFor = (self.heldFor ?? 0) + TICK_SECONDS
    const limit = self.looks > 0 ? MANUAL_HOLD_AGAIN : MANUAL_LOOK_AFTER
    if (self.heldFor < limit) return
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

  function pressureUrgency() {
    const qb = [...k.live.values()].find(p => p.carrier)
    if (!qb) return 0
    let nearest = Infinity
    for (const p of k.live.values()) {
      if (p.team !== 'd') continue
      const d = Math.hypot(p.x - qb.x, p.y - qb.y)
      if (d < nearest) nearest = d
    }
    if (!Number.isFinite(nearest)) return 0
    const raw = (PRESSURE_FAR - nearest) / (PRESSURE_FAR - PRESSURE_ON)
    return Math.max(0, Math.min(1, raw)) * skill().pressureAware
  }

  function tryThrow() {
    const sk = skill()
    const targets = rankTargets(k, { noise: sk.readNoise, rng })

    self.liveFor = (self.liveFor ?? 0) + (isManualRoom() ? 0 : TICK_SECONDS)
    const elapsed = isManualRoom() ? self.looks * 0.9 : self.liveFor
    const urgency = pressureUrgency()

    // ⚠️ Bail out rather than eat the sack. A throwaway costs nothing and a sack costs seven yards
    // plus the down, so a quarterback with nobody open and a defender in his lap should always take
    // the incompletion. The AI never did this — the mechanic existed and nothing in ai/ referenced
    // it — which is a large part of why blitzing was free.
    const nothingThere = targets.length === 0 || targets[0].score < sk.throwFloor
    if (k.throwawayReady && urgency >= 0.99 && nothingThere) {
      self.done.threw = true
      socket.fire('throwaway')
      say('threw it away under pressure')
      return true
    }

    if (targets.length === 0) return false

    // The bar falls with TIME (a receiver worth waiting for at two seconds is the best you will get
    // at four) or with PRESSURE, whichever is more urgent.
    const decay = Math.max(Math.min(1, elapsed / sk.patience), urgency)
    const bar = sk.throwThreshold - (sk.throwThreshold - sk.throwFloor) * decay

    const best = targets[0]
    if (best.score < bar) return false

    self.done.threw = true
    socket.fire('throw_to_receiver', best.id)
    say(`throw → ${best.id} (${best.estimated ? 'read' : 'openness'} ${best.score.toFixed(2)} vs bar ${bar.toFixed(2)})`)
    return true
  }

  // ── Special teams ─────────────────────────────────────────────────────────
  function onSpecialTeams() {
    const action = k.decision
      ? fourthDownChoice(k, rng)
      : specialTeamsAction(k, rng)
    if (!action) return
    say('special teams:', action.event, JSON.stringify(action.payload))
    socket.fire(action.event, action.payload)
  }

  return self
}
