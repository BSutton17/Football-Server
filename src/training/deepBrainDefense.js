// ── A genome as a defensive brain, with the widened action space ([deep]) ───
//
// Same contract as networkBrain.js — the controller does everything except CHOOSE — but the
// network is now asked two kinds of question rather than one:
//
//   1. "What shell?"            once per play, with the player block zeroed.
//   2. "What about THIS man?"   once per defender, with his context and the job the shell gave him.
//
// One genome answers both; a flag input says which is being asked. See the note at the top of
// deepDefense.js for why it is done this way rather than with one wide output layer.
//
// The result is then PROJECTED back onto legality before anything is fired, so a network can wish
// for an illegal defense and simply get the nearest legal one. Mask, do not penalize.

import { createController } from '../ai/controller.js'
import { buildNetwork } from '../neat/neat.js'
import { SHELLS } from '../ai/playbook/coverages.js'
import {
  observeDeep, decodeDelta, decodeShell, projectAssignments,
  DEEP_OBSERVATION_SIZE, DEEP_ACTION_SIZE, DEEP_DEFENSE_VERSION,
} from './deepDefense.js'
import { ACTION_SIZE } from './action.js'
import { oppPersonnel } from '../ai/knowledge.js'

export { DEEP_OBSERVATION_SIZE, DEEP_ACTION_SIZE }

export function createDeepDefenseBrain({ socket, slot, roster, genome, seed = 1, log = false }) {
  const net = buildNetwork(genome)

  const available = {
    CB: roster.filter(p => p.position === 'CB').length,
    S: roster.filter(p => p.position === 'S').length,
    LB: roster.filter(p => p.position === 'LB').length,
  }

  const controller = createController({ socket, slot, roster, seed, log })
  const decisions = []
  // Every adjustment the network asked for, so a test can prove it is actually using the width of
  // the action space rather than leaving every delta at zero.
  const adjustments = []

  controller.overrideDefensiveCall = (k) => {
    const outputs = net(observeDeep(k, { roster, ballX: k.ballX }))
    const action = decodeShell(outputs.slice(0, ACTION_SIZE), { available })
    const call = {
      shellId: action.shellId,
      shellName: SHELLS[action.shellId]?.name ?? action.shellId,
      personnel: action.personnel,
      extraRushers: SHELLS[action.shellId]?.rushers ?? 0,
      why: `deep network (${action.confidence.toFixed(2)})`,
      network: action,
    }
    decisions.push(call)
    return call
  }

  controller.adjustAssignments = (assignments, { k, receivers, losY, ballX, onField }) => {
    const byId = new Map(receivers.map(r => [r.id, r]))
    const posOf = new Map((onField ?? []).map(p => [p.id, p.position]))
    const out = new Map()
    const warnings = []

    for (const [id, a] of assignments) {
      const player = { id, label: posOf.get(id) ?? 'LB', x: a.alignX, y: a.alignY }
      const target = a.targetId ? byId.get(a.targetId) : null
      const outputs = net(observeDeep(k, { roster, player, assignment: { ...a, target }, ballX }))
      const d = decodeDelta(outputs)
      adjustments.push({ id, ...d })

      // `orig` is what the projection restores if it has to undo a change — see the note on
      // `revert` in deepDefense.js. Restoring a type alone leaves an assignment covering nobody.
      let next = { ...a, orig: a, alignDx: d.alignDx, alignDy: d.alignDy }

      // Send him, or drop him into coverage. `convertedBy` is what the projection reads when it has
      // to undo one of these — reverting the wrong defender would be worse than not allowing it.
      if (d.change === 'send' && a.type !== 'blitz') {
        next = { ...next, type: 'blitz', targetId: null, zoneType: null, zoneCenterX: null, zoneCenterY: null, convertedBy: 'send' }
      } else if (d.change === 'drop' && a.type === 'blitz') {
        next = { ...next, type: 'zone', zoneType: 'hook', zoneCenterX: ballX, zoneCenterY: losY + 8, convertedBy: 'drop' }
      }

      if (next.type === 'man' && d.shade) next.manCommit = d.shade
      if (next.type === 'zone') {
        next.zoneCenterX = (next.zoneCenterX ?? ballX) + d.zoneDx
        next.zoneCenterY = (next.zoneCenterY ?? losY) + d.zoneDy
      }

      out.set(id, next)
    }

    const opp = oppPersonnel(k)
    return projectAssignments(out, {
      receivers,
      oppHeavy: (opp.TE + opp.RB) >= 2,
      losY, ballX, warnings,
    })
  }

  return Object.assign(controller, {
    genome,
    decisions,
    adjustments,
    versions: { deepDefense: DEEP_DEFENSE_VERSION },
  })
}
