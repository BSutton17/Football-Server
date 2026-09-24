// ── What the network's outputs mean ([training]) ────────────────────────────
//
// The defensive decision, as numbers a network can produce. Three parts:
//
//   THE SHELL — one output per coverage. Highest wins. This is why the playbook was built as named
//     shells rather than raw per-player assignments: the network picks from a vocabulary a human
//     can read, and `expandShell` turns the choice into eleven legal assignments.
//
//   PERSONNEL — how many corners, safeties and linebackers. Three outputs, resolved into counts
//     that sum to seven.
//
//   ADJUSTMENTS — a few dials the shell does not fix: how aggressively to press, how deep to set
//     the zones, whether to bring extra pressure.
//
// ⚠️ MASK, DO NOT PENALIZE. An illegal choice is removed from consideration BEFORE the argmax, not
// scored badly afterwards. Penalizing teaches the network to avoid illegal actions, which costs
// generations of learning to do something the rules could simply have forbidden — and it makes the
// fitness landscape lumpy for no benefit. The mask here covers ENGINE legality only: a shell that
// needs more of a position than this seat has. It never encodes strategy; "Cover 0 is unwise on
// third and long" is something the network is supposed to learn, not something it is told.

import { SHELLS, SHELL_IDS } from '../ai/playbook/coverages.js'
import { COVERAGE_ON_FIELD } from '../ai/defense.js'

export const ACTION_VERSION = 'v1'

// One output per shell, then three for personnel, then the dials.
export const ACTION_FIELDS = [
  ...SHELL_IDS.map(id => `shell:${id}`),
  'personnelCB', 'personnelS', 'personnelLB',
  'pressAggression',      // how tight the man defenders play
  'zoneDepth',            // shallower or deeper than the shell's default
  'extraPressure',        // bias toward sending more
]

export const ACTION_SIZE = ACTION_FIELDS.length
export const SHELL_COUNT = SHELL_IDS.length

// What this seat can actually field. A shell asking for four safeties when the roster has three is
// not a strategic mistake, it is impossible — so it is masked off.
export function legalShells(available = { CB: 4, S: 3, LB: 4 }) {
  return SHELL_IDS.filter(id => {
    const shell = SHELLS[id]
    // The minimum this shell needs at each position: count the jobs that ONLY that position can do.
    const need = { CB: 0, S: 0, LB: 0 }
    for (const job of shell.jobs) {
      if (job.positions.length !== 1) continue
      const pos = job.positions[0]
      if (pos in need) need[pos] += (job.count ?? 1)
    }
    return need.CB <= (available.CB ?? 0)
        && need.S <= (available.S ?? 0)
        && need.LB <= (available.LB ?? 0)
  })
}

// Turns the raw outputs into a call.
//
// `available` is what the seat has on its roster; anything it cannot field is masked off. The mask
// can never be empty — every roster can field at least the base zone — but it is asserted anyway,
// because an empty mask silently becomes "the first shell in the list" and that is the kind of bug
// that trains a thousand generations of nonsense.
export function decode(outputs, { available = { CB: 4, S: 3, LB: 4 } } = {}) {
  if (outputs.length !== ACTION_SIZE) {
    throw new Error(`expected ${ACTION_SIZE} outputs, got ${outputs.length}`)
  }

  const legal = legalShells(available)
  if (legal.length === 0) throw new Error('no legal shell for this roster — the mask is empty')

  let bestId = legal[0]
  let bestScore = -Infinity
  for (const id of legal) {
    const score = outputs[SHELL_IDS.indexOf(id)]
    if (score > bestScore) { bestScore = score; bestId = id }
  }

  return {
    shellId: bestId,
    personnel: decodePersonnel(outputs, available),
    press: outputs[SHELL_COUNT + 3],
    zoneDepth: (outputs[SHELL_COUNT + 4] - 0.5) * 2,     // −1 shallower … +1 deeper
    extraPressure: outputs[SHELL_COUNT + 5],
    confidence: bestScore,
  }
}

// Three outputs into three counts summing to exactly seven, respecting what the roster holds and
// the floors the design set (never fewer than two corners; never an empty box).
export function decodePersonnel(outputs, available = { CB: 4, S: 3, LB: 4 }) {
  const raw = {
    CB: outputs[SHELL_COUNT + 0],
    S: outputs[SHELL_COUNT + 1],
    LB: outputs[SHELL_COUNT + 2],
  }
  const cap = { CB: Math.min(4, available.CB ?? 4), S: Math.min(3, available.S ?? 3), LB: Math.min(4, available.LB ?? 4) }
  const floor = { CB: 2, S: 1, LB: 1 }

  const out = { ...floor }
  let left = COVERAGE_ON_FIELD - (out.CB + out.S + out.LB)

  // Hand out the remaining places one at a time to whoever currently wants it most. Proportional
  // rounding is the obvious alternative and it routinely produces totals of six or eight.
  while (left > 0) {
    let bestPos = null, best = -Infinity
    for (const pos of ['CB', 'S', 'LB']) {
      if (out[pos] >= cap[pos]) continue
      // Scaled by how much of its allowance is already spent, so one huge output cannot take
      // every remaining place.
      const want = raw[pos] * (1 - out[pos] / (cap[pos] + 1))
      if (want > best) { best = want; bestPos = pos }
    }
    if (!bestPos) break
    out[bestPos]++
    left--
  }

  return out
}

// A fingerprint of the action layout, pinned in a checkpoint alongside the observation's.
export function actionSpecHash() {
  let h = 2166136261
  const s = `${ACTION_VERSION}:${ACTION_FIELDS.join(',')}`
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) }
  return (h >>> 0).toString(16).padStart(8, '0')
}
