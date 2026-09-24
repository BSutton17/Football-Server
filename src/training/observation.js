// ── What the network sees ([training]) ──────────────────────────────────────
//
// Turns a Knowledge object into a fixed-length vector of numbers. This is the whole world as far
// as a genome is concerned, and three rules govern it:
//
//   EVERY VALUE IS IN [0, 1] OR [-1, 1]. A sigmoid network cannot make sense of a yard line in the
//     range 0..100 sitting next to a down in the range 1..4 — the large input swamps the small one
//     and the small one is effectively ignored. Unbounded quantities go through tanh rather than
//     being divided by a guessed maximum.
//
//   IT IS BUILT FROM KNOWLEDGE, NOT FROM GAME STATE. Knowledge is assembled only from events the
//     seat actually receives, so an observation physically cannot contain the opponent's play call.
//     The fairness guarantee is inherited rather than re-argued.
//
//   THE LENGTH IS PINNED. Changing it changes what every saved genome means, so `OBSERVATION_SIZE`
//     and `OBSERVATION_VERSION` travel with a checkpoint and a mismatch REFUSES to load rather
//     than quietly producing nonsense.

import { FIELD } from '../constants.js'
import { oppPersonnel, oppSkill, oppInBox, yardsToGoal, isGoalToGo } from '../ai/knowledge.js'

export const OBSERVATION_VERSION = 'v1'

// The layout, in order. Kept as a table so the count cannot drift from the builder and so a
// debugging session can name input 23 instead of counting.
export const OBSERVATION_FIELDS = [
  // ── Situation ──
  'down1', 'down2', 'down3', 'down4',        // one-hot: which down
  'distanceShort',                            // 1 at inches, 0 at 15+
  'distanceLong',                             // the other end of the same scale
  'fieldPosition',                            // 0 own goal line → 1 opponent's
  'inRedZone',
  'goalToGo',
  'backedUp',                                 // inside our own 10

  // ── Clock and score ──
  'quarterLate',                              // 2nd or 4th quarter
  'clockUrgent',                              // under two minutes
  'scoreMargin',                              // −1 well behind → +1 well ahead
  'leading',
  'timeoutsOwn',

  // ── The opponent's personnel ──
  'oppWR', 'oppTE', 'oppRB',                  // counts, normalized
  'oppSkillTotal',
  'inBox',                                    // how many of them are tight to the formation
  'heavyPersonnel',                           // 2+ TE
  'spreadPersonnel',                          // 4+ WR

  // ── The formation in front of us ──
  'widestLeft', 'widestRight',                // how far out the outside men are, from the ball
  'receiversLeft', 'receiversRight',
  'imbalance',                                // −1 all left → +1 all right
  'isolatedReceiver',                         // somebody alone on a side
  'bunched',                                  // three within a few yards of each other
  'backfieldDepth',                           // how deep the deepest back is
  'emptyBackfield',

  // ── Our own hand ──
  'ownCB', 'ownS', 'ownLB',                   // what this seat has available
  'ballOnHash',                               // −1 left hash → +1 right hash
]

export const OBSERVATION_SIZE = OBSERVATION_FIELDS.length

// Squashes an unbounded value into [0, 1] without needing a guessed maximum.
const squash = (x, scale = 1) => (Math.tanh(x / scale) + 1) / 2
const clamp01 = (x) => Math.max(0, Math.min(1, x))

export function observe(k, { roster = null } = {}) {
  const ballX = k.ballX ?? FIELD.WIDTH / 2
  const opp = oppPersonnel(k)
  const skill = oppSkill(k)
  const toGoal = yardsToGoal(k)

  const left = skill.filter(p => p.x < ballX)
  const right = skill.filter(p => p.x >= ballX)
  const widest = (side, sign) => side.length
    ? Math.max(...side.map(p => Math.abs(p.x - ballX))) / (FIELD.WIDTH / 2)
    : 0

  // A receiver with nobody within this many yards on his own side is isolated — the case the
  // design calls out as never-leave-uncovered.
  const ISOLATION = 8
  const isolated = skill.some(r => {
    const sameSide = skill.filter(o => o.id !== r.id && (o.x < ballX) === (r.x < ballX))
    return sameSide.length === 0 || sameSide.every(o => Math.abs(o.x - r.x) > ISOLATION)
  })

  const bunched = skill.some(r => {
    const near = skill.filter(o => o.id !== r.id && Math.abs(o.x - r.x) < 4)
    return near.length >= 2
  })

  const backs = skill.filter(p => p.label === 'RB')
  const deepest = backs.length ? Math.max(...backs.map(p => k.yardLine - p.y)) : 0

  const own = roster ?? []
  const count = (pos) => own.filter(p => p.position === pos).length

  const margin = (k.score?.own ?? 0) - (k.score?.opp ?? 0)

  const v = [
    // Situation
    k.down === 1 ? 1 : 0,
    k.down === 2 ? 1 : 0,
    k.down === 3 ? 1 : 0,
    k.down >= 4 ? 1 : 0,
    clamp01(1 - (k.distance - 1) / 14),
    clamp01((k.distance - 1) / 14),
    clamp01(k.yardLine / 100),
    toGoal <= 20 ? 1 : 0,
    isGoalToGo(k) ? 1 : 0,
    k.yardLine <= 10 ? 1 : 0,

    // Clock and score
    (k.quarter === 2 || k.quarter === 4) ? 1 : 0,
    clamp01(1 - (k.clock ?? 600) / 120),
    Math.tanh(margin / 14),
    margin > 0 ? 1 : 0,
    clamp01((k.timeouts?.own ?? 3) / 3),

    // Opponent personnel
    clamp01(opp.WR / 4),
    clamp01(opp.TE / 3),
    clamp01(opp.RB / 2),
    clamp01(skill.length / 5),
    clamp01(oppInBox(k, ballX) / 5),
    opp.TE >= 2 ? 1 : 0,
    opp.WR >= 4 ? 1 : 0,

    // Formation
    widest(left, -1),
    widest(right, 1),
    clamp01(left.length / 4),
    clamp01(right.length / 4),
    skill.length ? (right.length - left.length) / skill.length : 0,
    isolated ? 1 : 0,
    bunched ? 1 : 0,
    squash(deepest, 8),
    backs.length === 0 ? 1 : 0,

    // Our hand
    clamp01(count('CB') / 4),
    clamp01(count('S') / 3),
    clamp01(count('LB') / 4),
    (ballX - FIELD.WIDTH / 2) / (FIELD.WIDTH / 2),
  ]

  // A length mismatch means the table and the builder have drifted, which would silently shift
  // every input by one and make a saved genome meaningless.
  if (v.length !== OBSERVATION_SIZE) {
    throw new Error(`observation is ${v.length} long, expected ${OBSERVATION_SIZE} — the field table and the builder have drifted`)
  }
  return v
}

// A fingerprint of the LAYOUT. Pinned in a checkpoint: change the inputs and every saved genome
// stops meaning what it meant, so loading one must refuse rather than silently misread it.
export function observationSpecHash() {
  let h = 2166136261
  const s = `${OBSERVATION_VERSION}:${OBSERVATION_FIELDS.join(',')}`
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
