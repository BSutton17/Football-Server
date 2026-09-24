// ── The coverage playbook ([offline]) ────────────────────────────────────────
//
// The engine has no idea what "Cover 3" is. Its vocabulary is eleven independent per-player
// assignments — `man` (with a target and an optional shade), `zone` (one of flat/deep/curl/hook
// with a draggable landmark), `blitz`, `spy`. A named coverage is therefore not a thing you SELECT,
// it is a shape you EXPAND INTO those eleven assignments.
//
// This file is the vocabulary that makes a call nameable. Each shell says, in the abstract:
//   • how many defenders it wants at each job (deep, underneath, rushing),
//   • where each of those jobs lives on the field, in landmarks rather than coordinates,
//   • what kind of player is allowed to do it.
//
// `expandShell` in assignments.js turns that into real players in real spots. Keeping the shape
// separate from the assignment is what lets the same Cover 3 line up correctly against two tight
// ends and against four wide, and it is what will later let NEAT pick a shell without also having
// to re-derive where a curl zone belongs.
//
// LANDMARKS. Positions are offense-relative: y counts up toward the offense's goal, and x is
// absolute across the field with the ball's hash as the pivot. A landmark is written as an offset
// from the LINE OF SCRIMMAGE and from the BALL, so a shell is field-position independent.

import { FIELD } from '../../constants.js'

export const FIELD_WIDTH = FIELD.WIDTH
export const HASH_LEFT = FIELD_WIDTH * 0.25
export const HASH_RIGHT = FIELD_WIDTH * 0.75

// Zone kinds the engine understands. Anything else is a bug, not a new idea.
export const ZONE = { FLAT: 'flat', CURL: 'curl', HOOK: 'hook', DEEP: 'deep' }

// A man defender may sell out to take away exactly one thing. These are the engine's four.
export const SHADE = { IN: 'in', OUT: 'out', OVER: 'over', UNDER: 'under' }

// Job kinds a shell can ask for.
export const JOB = {
  DEEP: 'deep',         // a zone defender with a deep landmark
  UNDER: 'under',       // a zone defender underneath
  MAN: 'man',           // locked to a receiver
  RUSH: 'rush',         // blitzing
  SPY: 'spy',           // shadowing the quarterback
}

// Which positions may hold each job. This is the first half of the constraint the design calls for
// — the second half (who is manned with whom) lives in assignments.js, because it needs to see the
// actual receivers.
const ANY_DB = ['S', 'CB']
const ANY_BACK7 = ['CB', 'S', 'LB']

// ── Shell definitions ─────────────────────────────────────────────────────────
//
// `jobs` is an ORDERED list. Order is priority: when a shell wants more jobs than there are
// defenders, the tail is dropped, so the most important responsibilities are written first. A deep
// safety in a Cover 3 is not optional; the fourth underneath defender is.
//
// depth  — yards past the line of scrimmage for the landmark (negative = behind it).
// spot   — how the landmark sits across the field:
//            'middle'      on the ball
//            'left'/'right' toward that sideline by `width` yards
//            'quarter'     one of the four quarters of the field, chosen by index
//            'half'        one of the two halves
//            'strong'/'weak' toward the side with more / fewer receivers

export const SHELLS = {
  // ── Single-high man. One safety over the top, everyone else locked on. ────
  cover_1: {
    name: 'Cover 1',
    kind: 'man',
    blurb: 'Man across the board with one safety over the top and a spy underneath.',
    jobs: [
      { job: JOB.DEEP, positions: ['S'], depth: 14, spot: 'middle' },
      { job: JOB.MAN, positions: ANY_BACK7, count: 4 },
      { job: JOB.SPY, positions: ['LB'] },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.HOOK, depth: 5, spot: 'middle' },
    ],
  },

  // ── Two deep, man underneath. ─────────────────────────────────────────────
  cover_2_man: {
    name: 'Cover 2 Man',
    kind: 'man',
    blurb: 'Two deep safeties, man underneath. Takes away the deep ball without giving up the run.',
    jobs: [
      { job: JOB.DEEP, positions: ['S'], depth: 13, spot: 'half', index: 0 },
      { job: JOB.DEEP, positions: ['S'], depth: 13, spot: 'half', index: 1 },
      { job: JOB.MAN, positions: ANY_BACK7, count: 4 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 5, spot: 'middle' },
    ],
  },

  // ── Two deep, five under. The base zone. ──────────────────────────────────
  cover_2: {
    name: 'Cover 2',
    kind: 'zone',
    blurb: 'Two deep halves, five underneath. Sound everywhere, soft in the deep middle.',
    jobs: [
      { job: JOB.DEEP, positions: ANY_DB, depth: 13, spot: 'half', index: 0 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 13, spot: 'half', index: 1 },
      { job: JOB.UNDER, positions: ['CB'], zone: ZONE.FLAT, depth: 4, spot: 'left', width: 15 },
      { job: JOB.UNDER, positions: ['CB'], zone: ZONE.FLAT, depth: 4, spot: 'right', width: 15 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 8, spot: 'middle' },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.CURL, depth: 7, spot: 'left', width: 8 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.CURL, depth: 7, spot: 'right', width: 8 },
    ],
  },

  // ── Tampa 2: Cover 2 with the middle linebacker running the seam. ─────────
  tampa_2: {
    name: 'Tampa 2',
    kind: 'zone',
    blurb: 'Cover 2 with the middle linebacker carrying the deep middle — closes the hole a Cover 2 leaves.',
    jobs: [
      { job: JOB.DEEP, positions: ANY_DB, depth: 13, spot: 'half', index: 0 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 13, spot: 'half', index: 1 },
      // The whole point of the shell: a linebacker with a DEEP landmark up the middle.
      { job: JOB.DEEP, positions: ['LB'], depth: 16, spot: 'middle' },
      { job: JOB.UNDER, positions: ['CB'], zone: ZONE.FLAT, depth: 4, spot: 'left', width: 15 },
      { job: JOB.UNDER, positions: ['CB'], zone: ZONE.FLAT, depth: 4, spot: 'right', width: 15 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.CURL, depth: 7, spot: 'left', width: 9 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.CURL, depth: 7, spot: 'right', width: 9 },
    ],
  },

  // ── Three deep, four under. ───────────────────────────────────────────────
  cover_3: {
    name: 'Cover 3',
    kind: 'zone',
    blurb: 'Three deep thirds, four underneath. Hard to throw over, soft in the flats.',
    jobs: [
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'third', index: 0 },
      { job: JOB.DEEP, positions: ['S'], depth: 16, spot: 'third', index: 1 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'third', index: 2 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.FLAT, depth: 4, spot: 'left', width: 14 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.FLAT, depth: 4, spot: 'right', width: 14 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 8, spot: 'middle' },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.CURL, depth: 7, spot: 'strong', width: 8 },
    ],
  },

  // ── Four deep quarters. ───────────────────────────────────────────────────
  cover_4: {
    name: 'Cover 4',
    kind: 'zone',
    blurb: 'Four deep quarters, three underneath. Built to erase everything over the top.',
    jobs: [
      { job: JOB.DEEP, positions: ANY_DB, depth: 14, spot: 'quarter', index: 0 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'quarter', index: 1 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'quarter', index: 2 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 14, spot: 'quarter', index: 3 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 7, spot: 'middle' },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.CURL, depth: 6, spot: 'left', width: 10 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.CURL, depth: 6, spot: 'right', width: 10 },
    ],
  },

  // ── Prevent: everybody deep, give up whatever is underneath. ──────────────
  prevent: {
    name: 'Prevent',
    kind: 'zone',
    blurb: 'Everyone deep. Concedes the short throw to make sure nothing gets behind you.',
    jobs: [
      { job: JOB.DEEP, positions: ANY_DB, depth: 22, spot: 'quarter', index: 0 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 24, spot: 'quarter', index: 1 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 24, spot: 'quarter', index: 2 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 22, spot: 'quarter', index: 3 },
      { job: JOB.DEEP, positions: ANY_BACK7, depth: 18, spot: 'middle' },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 12, spot: 'left', width: 9 },
      { job: JOB.UNDER, positions: ['LB'], zone: ZONE.HOOK, depth: 12, spot: 'right', width: 9 },
    ],
  },

  // ── Man pressure: five rushers (four linemen plus one). ───────────────────
  man_blitz_5: {
    name: 'Man Blitz 5',
    kind: 'man',
    blurb: 'Five rushers, man behind it, one safety over the top.',
    rushers: 1,
    jobs: [
      { job: JOB.RUSH, positions: ['LB'], count: 1 },
      { job: JOB.DEEP, positions: ['S'], depth: 13, spot: 'middle' },
      { job: JOB.MAN, positions: ANY_BACK7, count: 5 },
    ],
  },

  // ── Man pressure: six rushers. No help anywhere. ──────────────────────────
  man_blitz_6: {
    name: 'Man Blitz 6',
    kind: 'man',
    blurb: 'Six rushers, pure man behind it. Gets there fast or gives up everything.',
    rushers: 2,
    jobs: [
      { job: JOB.RUSH, positions: ['LB'], count: 2 },
      { job: JOB.MAN, positions: ANY_BACK7, count: 5 },
    ],
  },

  // ── Zone pressure: five rushers, zone behind it. ──────────────────────────
  zone_blitz_5: {
    name: 'Zone Blitz 5',
    kind: 'zone',
    blurb: 'Five rushers with three deep behind — pressure without the man-coverage risk.',
    rushers: 1,
    jobs: [
      { job: JOB.RUSH, positions: ['LB', 'S'], count: 1 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'third', index: 0 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 16, spot: 'third', index: 1 },
      { job: JOB.DEEP, positions: ANY_DB, depth: 15, spot: 'third', index: 2 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.CURL, depth: 6, spot: 'left', width: 10 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.CURL, depth: 6, spot: 'right', width: 10 },
      { job: JOB.UNDER, positions: ANY_BACK7, zone: ZONE.HOOK, depth: 7, spot: 'middle' },
    ],
  },
}

export const SHELL_IDS = Object.keys(SHELLS)

// How many extra rushers a shell sends beyond the four down linemen. Used by the offense-side
// heuristic and, later, as a network input.
export function extraRushers(shellId) {
  return SHELLS[shellId]?.rushers ?? 0
}

export function isManShell(shellId) {
  return SHELLS[shellId]?.kind === 'man'
}

// ── Landmarks ─────────────────────────────────────────────────────────────────
//
// Turns a job's abstract spot into a real point on the field. `ballX` is the hash the ball is on,
// which is the pivot everything mirrors around — a Cover 3 played from the left hash is not the
// same three thirds as one played from the middle.
// ⚠️ THE LANDMARK MUST BE ON THE FIELD. Zone centres are offense-relative yards, where the end
// zones are −10 and 110, and `assign_coverage` REFUSES anything outside that. A deep zone 15 yards
// past a line of scrimmage on the 97 lands at 112 and is rejected — and a refused assignment is
// not a no-op: the engine treats a defender it has no assignment for as a PASS RUSHER, so the
// safety silently blitzes and the deep middle is wide open. Found on the goal line by the
// AI-vs-AI soak, never by playing.
const FIELD_BACK = 110
const FIELD_FRONT = -10

export function landmark(job, { losY, ballX, strongSide = 1 }) {
  const y = clampY(losY + (job.depth ?? 0))
  const w = job.width ?? 10

  switch (job.spot) {
    case 'middle': return { x: ballX, y }
    case 'left': return { x: clampX(ballX - w), y }
    case 'right': return { x: clampX(ballX + w), y }
    case 'strong': return { x: clampX(ballX + strongSide * w), y }
    case 'weak': return { x: clampX(ballX - strongSide * w), y }

    // Even splits of the FIELD, not of the ball — deep zones divide the whole width, which is why
    // a deep safety does not slide with the hash the way an underneath defender does.
    case 'half': return { x: FIELD_WIDTH * (job.index === 0 ? 0.25 : 0.75), y }
    case 'third': return { x: FIELD_WIDTH * [0.17, 0.5, 0.83][job.index ?? 1], y }
    case 'quarter': return { x: FIELD_WIDTH * [0.12, 0.38, 0.62, 0.88][job.index ?? 0], y }

    default: return { x: ballX, y }
  }
}

function clampX(x) {
  return Math.max(1.5, Math.min(FIELD_WIDTH - 1.5, x))
}

function clampY(y) {
  return Math.max(FIELD_FRONT, Math.min(FIELD_BACK, y))
}
