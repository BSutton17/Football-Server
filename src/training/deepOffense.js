// ── The offensive action space ([deep]) ─────────────────────────────────────
//
// The mirror of deepDefense.js. The network picks a play the way a coordinator does — run, pass or
// RPO; a formation; a route concept; which way the run goes — and then adjusts each skill player
// individually: where he lines up, and how far he pushes his stem.
//
// ⚠️ ROUTES COME FROM THE LIST. The engine will accept an arbitrary drawn path (`drawnRoute`), and
// the AI deliberately does not use it. Stretching a named route is a small, readable change with a
// search space a hundred generations can actually cover; inventing polylines is an enormous space
// whose failures are unreadable. The AI picks from the playbook and stretches — it does not draw.
//
// `routeDepthScale` is already plumbed end to end (init.js -> buildWaypoints), so a stem adjustment
// needs no engine work at all.

import { observe, OBSERVATION_SIZE } from './observation.js'
import { FIELD } from '../constants.js'
import { FORMATIONS } from '../ai/playbook/formations.js'
import { CONCEPTS } from '../ai/playbook/concepts.js'
import { RUN_ANGLES } from '../ai/offense.js'

export const DEEP_OFFENSE_VERSION = 'v1'

export const FORMATION_IDS = Object.keys(FORMATIONS)
export const CONCEPT_IDS = Object.keys(CONCEPTS)
// The seven lanes chooseRunAngle offers, in the same order, so a network output maps onto a real
// running lane rather than an arbitrary angle.
export const RUN_LANES = [
  RUN_ANGLES.OUTSIDE_LEFT, RUN_ANGLES.LEFT, RUN_ANGLES.INSIDE_LEFT,
  RUN_ANGLES.MIDDLE,
  RUN_ANGLES.INSIDE_RIGHT, RUN_ANGLES.RIGHT, RUN_ANGLES.OUTSIDE_RIGHT,
]

export const OFFENSE_PLAYER_FIELDS = [
  'isPlayerQuery',
  'posWR', 'posTE', 'posRB',
  'ownX', 'ownDepth',
]

export const DEEP_OFF_OBSERVATION_SIZE = OBSERVATION_SIZE + OFFENSE_PLAYER_FIELDS.length

export const OFFENSE_ACTION_FIELDS = [
  'typeRun', 'typePass', 'typeRpo',
  ...FORMATION_IDS.map(id => `form:${id}`),
  ...CONCEPT_IDS.map(id => `concept:${id}`),
  ...RUN_LANES.map((_, i) => `lane${i}`),
  'keepBackIn',
  // Per-player, read on a player query.
  'alignDx', 'alignDy', 'stem',
]

export const DEEP_OFF_ACTION_SIZE = OFFENSE_ACTION_FIELDS.length

const CALL_SIZE = DEEP_OFF_ACTION_SIZE - 3    // everything except the three per-player outputs

// How far a receiver may be moved off his formation spot, and how far his stem may stretch.
const ALIGN_SHIFT = 5        // yards
const STEM_MIN = 0.6         // a route run three-fifths as deep
const STEM_MAX = 1.6         // …or half again as deep

const signed = (v) => Math.max(-1, Math.min(1, (v ?? 0.5) * 2 - 1))
const argmax = (arr, from, n) => {
  let best = from, bestV = -Infinity
  for (let i = from; i < from + n; i++) if ((arr[i] ?? 0) > bestV) { bestV = arr[i]; best = i }
  return best - from
}

export function observeOffenseDeep(k, { roster, player = null, ballX = FIELD.WIDTH / 2 } = {}) {
  const base = observe(k, { roster })
  const ctx = new Array(OFFENSE_PLAYER_FIELDS.length).fill(0)
  if (player) {
    ctx[0] = 1
    ctx[1] = player.label === 'WR' ? 1 : 0
    ctx[2] = player.label === 'TE' ? 1 : 0
    ctx[3] = player.label === 'RB' ? 1 : 0
    ctx[4] = Math.max(-1, Math.min(1, ((player.x ?? ballX) - ballX) / (FIELD.WIDTH / 2)))
    ctx[5] = Math.max(-1, Math.min(1, ((player.y ?? k.yardLine) - k.yardLine) / 10))
  }
  return [...base, ...ctx]
}

// The play call. Concept is only read on a pass or an RPO; the run lane only on a run or an RPO.
// Irrelevant outputs are ignored rather than masked — there is nothing illegal about them, they
// simply do not apply.
export function decodeOffenseCall(outputs) {
  let i = 0
  const playType = ['run', 'pass', 'rpo'][argmax(outputs, i, 3)]; i += 3
  const formationId = FORMATION_IDS[argmax(outputs, i, FORMATION_IDS.length)]; i += FORMATION_IDS.length
  const conceptId = CONCEPT_IDS[argmax(outputs, i, CONCEPT_IDS.length)]; i += CONCEPT_IDS.length
  const lane = argmax(outputs, i, RUN_LANES.length); i += RUN_LANES.length
  const keepBackIn = (outputs[i] ?? 0) > 0.5

  return {
    playType,
    formationId,
    formationName: FORMATIONS[formationId]?.name ?? formationId,
    personnel: FORMATIONS[formationId]?.personnel ?? { WR: 3, TE: 1, RB: 1 },
    conceptId: playType === 'run' ? null : conceptId,
    conceptName: playType === 'run' ? null : (CONCEPTS[conceptId]?.name ?? conceptId),
    runAngle: playType === 'run' || playType === 'rpo' ? RUN_LANES[lane] : 0,
    keepBackIn,
    why: 'deep network',
  }
}

// Per-receiver adjustment: where he lines up, and how long his stem runs.
export function decodeOffenseDelta(outputs) {
  const [alignDx, alignDy, stem] = outputs.slice(CALL_SIZE)
  const stemScale = STEM_MIN + Math.max(0, Math.min(1, stem ?? 0.5)) * (STEM_MAX - STEM_MIN)
  return {
    alignDx: signed(alignDx) * ALIGN_SHIFT,
    alignDy: signed(alignDy) * ALIGN_SHIFT,
    stemScale,
  }
}
