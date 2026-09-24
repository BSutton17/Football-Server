// ── The offensive brain (heuristic) ([offline]) ──────────────────────────────
//
// Four decisions, in order, each one narrowing the next:
//
//   1. RUN OR PASS (or RPO) — from down, distance, clock and score.
//   2. FORMATION — which brings the personnel with it. Chosen to suit the call: you do not line up
//      empty to run inside, and you do not line up in goal line to throw four verticals.
//   3. WHERE — on a run, which side and at what angle, decided from where the defenders are NOT.
//      On a pass, which concept.
//   4. PROTECTION — whether the back stays in. A concept that takes time needs him; a quick game
//      concept is better off with him in the route.
//
// Like the defense, everything here is a pure function of Knowledge, so it cannot see the coverage
// call any more than the defense can see the play. It reads what a quarterback reads: where the
// defenders are standing, and how many of them are near the line.

import { CONCEPTS, assignRoutes } from './playbook/concepts.js'
import { FORMATIONS, layout, personnelFor } from './playbook/formations.js'
import { yardsToGoal, isGoalToGo, FIELD_MID } from './knowledge.js'

// ── Run or pass ───────────────────────────────────────────────────────────────

export function choosePlayType(k, rng = Math.random, ballX = FIELD_MID) {
  const toGo = k.distance
  const togoal = yardsToGoal(k)
  const box = defendersInBox(k, ballX)

  // Two-minute and behind: the clock is the opponent, so the ball has to go forward and out.
  if (isHurryUp(k)) return 'pass'

  // Short yardage. Running is the highest-percentage play in football at this distance, and it
  // stays that way until the box is genuinely stacked.
  if (toGo <= 2) return box >= 8 ? 'pass' : 'run'

  // Goal line: no field to throw into.
  if (isGoalToGo(k) && togoal <= 3) return 'run'

  // Third and long is a throwing down, and everybody knows it.
  if (k.down === 3 && toGo >= 7) return 'pass'

  // First down is where the option is worth most — the defense has the least information.
  if (k.down === 1) {
    const r = rng()
    if (box <= 6 && r < 0.45) return 'run'       // light box invites the run
    if (r < 0.25) return 'rpo'                   // make them wrong either way
    return r < 0.55 ? 'run' : 'pass'
  }

  // Second down follows from the distance left.
  if (k.down === 2) {
    if (toGo <= 4) return rng() < 0.6 ? 'run' : 'rpo'
    if (toGo >= 9) return 'pass'
    return rng() < 0.4 ? 'run' : 'pass'
  }

  // Fourth down, if it is being played at all, is a conversion attempt.
  return toGo <= 2 ? 'run' : 'pass'
}

// ── Formation ─────────────────────────────────────────────────────────────────
//
// Personnel rides along with the formation, which is the honest way round: you do not choose "two
// tight ends" in the abstract, you choose a formation that happens to need them.
export function chooseFormation(k, playType, rng = Math.random) {
  const togoal = yardsToGoal(k)
  const pick = (...ids) => ids[Math.floor(rng() * ids.length)]

  if (isGoalToGo(k) && togoal <= 5) return playType === 'run' ? 'goal_line' : pick('base', 'bunch')
  if (isHurryUp(k)) return pick('empty', 'doubles', 'trips')

  if (playType === 'run') {
    if (k.distance <= 2) return pick('heavy', 'base', 'goal_line')
    return pick('base', 'trips', 'heavy')
  }

  if (playType === 'rpo') return pick('trips', 'base', 'doubles')

  // Pass.
  if (k.down === 3 && k.distance >= 8) return pick('empty', 'doubles', 'trips')
  return pick('trips', 'doubles', 'base', 'bunch')
}

// ── Concept ───────────────────────────────────────────────────────────────────
//
// Picked from the DEPTH the situation needs, not from what looks exciting. A concept that breaks
// at six yards on third-and-twelve is a punt with extra steps.
export function chooseConcept(k, formationId, rng = Math.random, ballX = FIELD_MID) {
  const toGo = k.distance
  const box = defendersInBox(k, ballX)
  const pick = (...ids) => ids[Math.floor(rng() * ids.length)]

  // Pressure showing: get the ball out. Slants and screens are the two answers.
  if (box >= 8) return pick('slants', 'screen', 'drag', 'max_protect')

  if (isGoalToGo(k) && yardsToGoal(k) <= 5) return pick('smash', 'stick', 'slants')
  if (isHurryUp(k) && toGo >= 10) return pick('four_verts', 'flood', 'bench')

  if (toGo <= 4) return pick('stick', 'slants', 'mesh', 'drag')
  if (toGo <= 8) return pick('mesh', 'levels', 'smash', 'bench', 'flood')
  if (toGo <= 15) return pick('flood', 'bench', 'levels', 'smash', 'four_verts')
  return pick('four_verts', 'shot', 'flood')
}

// ── Where to run ──────────────────────────────────────────────────────────────
//
// The engine takes a run as an ANGLE (−60°..+60° from straight ahead), and the back commits to it
// for the first stretch of the play. So this is the one genuinely spatial decision on offense:
// point him where the defenders are not.
//
// The read is a simple one, and deliberately so — it counts defenders in three lanes near the line
// and picks the emptiest. It cannot see the coverage call, only bodies, which is exactly what a
// back sees.
export const RUN_ANGLES = { INSIDE_LEFT: -15, LEFT: -35, OUTSIDE_LEFT: -55, MIDDLE: 0, INSIDE_RIGHT: 15, RIGHT: 35, OUTSIDE_RIGHT: 55 }

const LANE_HALF_WIDTH = 6        // yards either side of a lane's centre
const RUN_READ_DEPTH = 6         // how far downfield a defender still counts as being in the way

export function chooseRunAngle(k, ballX = FIELD_MID, rng = Math.random) {
  const lanes = [
    { angle: RUN_ANGLES.OUTSIDE_LEFT, x: ballX - 14 },
    { angle: RUN_ANGLES.LEFT, x: ballX - 9 },
    { angle: RUN_ANGLES.INSIDE_LEFT, x: ballX - 4 },
    { angle: RUN_ANGLES.MIDDLE, x: ballX },
    { angle: RUN_ANGLES.INSIDE_RIGHT, x: ballX + 4 },
    { angle: RUN_ANGLES.RIGHT, x: ballX + 9 },
    { angle: RUN_ANGLES.OUTSIDE_RIGHT, x: ballX + 14 },
  ]

  const scored = lanes.map(lane => {
    let n = 0
    for (const d of k.opp.values()) {
      if (d.y > k.yardLine + RUN_READ_DEPTH) continue      // deep defenders are not the run fit
      if (Math.abs(d.x - lane.x) > LANE_HALF_WIDTH) continue
      n++
    }
    // A small random nudge breaks ties differently each time, so the AI is not a metronome that
    // runs to the same gap every single first down.
    return { ...lane, crowd: n + rng() * 0.4 }
  })

  scored.sort((a, b) => a.crowd - b.crowd)
  return { angle: scored[0].angle, crowd: Math.round(scored[0].crowd), lanes: scored }
}

// How many of the defenders this seat can see are near the line. Drives the run/pass read and the
// protection call — it is the single most informative pre-snap number on offense.
export function defendersInBox(k, ballX = FIELD_MID) {
  let n = 0
  for (const d of k.opp.values()) {
    if (d.y > k.yardLine + 6) continue
    if (Math.abs(d.x - ballX) > 10) continue
    n++
  }
  // The four down linemen are auto-placed and never broadcast as player_placed, so they are not in
  // `opp`. They are always there, so they are always counted.
  return n + 4
}

// Two minutes or less, and needing points.
export function isHurryUp(k) {
  const behind = (k.score?.own ?? 0) <= (k.score?.opp ?? 0)
  const lateHalf = k.quarter === 2 || k.quarter === 4
  return lateHalf && k.clock <= 120 && behind
}

// ── Protection ────────────────────────────────────────────────────────────────
//
// Whether the back stays in to block. A back in protection is a blocker the defense has to beat;
// a back in the route is a receiver it has to cover. The trade is worth making when the concept
// needs time, or when there are more rushers than blockers.
export function keepBackIn(k, conceptId, ballX = FIELD_MID) {
  const concept = CONCEPTS[conceptId]
  if (!concept) return false
  if (concept.routes.RB === 'block') return true       // the concept already says so
  if (concept.depth === 'deep') return true            // deep routes need the time
  return defendersInBox(k, ballX) >= 8                 // more rushers than the line can handle
}

// ── The whole decision ────────────────────────────────────────────────────────

export function callOffense(k, rng = Math.random, ballX = FIELD_MID) {
  const playType = choosePlayType(k, rng, ballX)
  const formationId = chooseFormation(k, playType, rng)
  const conceptId = playType === 'run' ? null : chooseConcept(k, formationId, rng, ballX)
  const run = chooseRunAngle(k, ballX, rng)

  return {
    playType,
    formationId,
    formationName: FORMATIONS[formationId]?.name ?? formationId,
    personnel: personnelFor(formationId),
    conceptId,
    conceptName: conceptId ? CONCEPTS[conceptId]?.name : null,
    runAngle: playType === 'run' || playType === 'rpo' ? run.angle : 0,
    keepBackIn: conceptId ? keepBackIn(k, conceptId, ballX) : false,
    why: `${k.down}&${Math.round(k.distance)} at ${Math.round(k.yardLine)} | box ${defendersInBox(k, ballX)}`,
  }
}

// Builds the actual formation and routes for a call. Returns spots with labels and routes attached
// — everything `place_player` and `set_offense` need, and nothing they do not.
export function buildFormation(call, k, { losY, ballX, roster, rng = Math.random }) {
  const mirror = rng() < 0.5
  const spots = layout(call.formationId, { losY, ballX, mirror })

  // Fill the spots from the roster, best available at each position.
  const byPos = {}
  for (const p of roster) (byPos[p.position] ??= []).push(p)
  for (const group of Object.values(byPos)) group.sort((a, b) => (b.ovr ?? 0) - (a.ovr ?? 0))

  const used = new Set()
  const players = []
  for (const spot of spots) {
    const group = byPos[spot.label] ?? []
    const pick = group.find(p => !used.has(p.id))
    if (!pick) continue
    used.add(pick.id)
    players.push({ id: pick.id, label: spot.label, x: spot.x, y: spot.y, ratings: pick.ratings, xFactor: pick.xFactor })
  }

  // Routes, if this is a passing call.
  let routes = new Map()
  if (call.conceptId) {
    const strongSide = players.filter(p => p.x >= ballX).length >= players.filter(p => p.x < ballX).length ? 1 : -1
    routes = assignRoutes(call.conceptId, players, ballX, { strongSide })
    if (call.keepBackIn) {
      for (const p of players) if (p.label === 'RB') routes.set(p.id, 'block')
    }
  } else {
    // A designed run: everyone who is not carrying it is blocking, which the engine already does
    // for skill players on a run — the explicit assignment is for the tight ends, who would
    // otherwise be handed a route they are not running.
    for (const p of players) routes.set(p.id, 'block')
  }

  return players.map(p => ({ ...p, route: routes.get(p.id) ?? null, team: 'o' }))
}
