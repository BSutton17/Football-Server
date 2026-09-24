// ── A genome as an offensive brain ([deep]) ─────────────────────────────────
//
// The mirror of deepBrainDefense.js. Two questions to one genome: "what play?", then "what about
// THIS receiver?" once per skill player. Everything else — building the formation from the roster,
// assigning the concept's routes, the legality clamps — is inherited from the controller unchanged.

import { createController } from '../ai/controller.js'
import { buildNetwork } from '../neat/neat.js'
import { legalSpot } from '../ai/playbook/formations.js'
import {
  observeOffenseDeep, decodeOffenseCall, decodeOffenseDelta,
  DEEP_OFF_OBSERVATION_SIZE, DEEP_OFF_ACTION_SIZE, DEEP_OFFENSE_VERSION,
} from './deepOffense.js'

export { DEEP_OFF_OBSERVATION_SIZE, DEEP_OFF_ACTION_SIZE }

export function createDeepOffenseBrain({ socket, slot, roster, genome, seed = 1, log = false }) {
  const net = buildNetwork(genome)
  const controller = createController({ socket, slot, roster, seed, log })
  const decisions = []
  const adjustments = []

  controller.overrideOffensiveCall = (k, _rng, ballX) => {
    const call = decodeOffenseCall(net(observeOffenseDeep(k, { roster, ballX })))
    decisions.push(call)
    return call
  }

  controller.adjustFormation = (players, { k, losY, ballX }) => players.map((p) => {
    const d = decodeOffenseDelta(net(observeOffenseDeep(k, { roster, player: p, ballX })))
    adjustments.push({ id: p.id, ...d })

    // legalSpot is the same clamp the formation table uses, so a moved receiver is exactly as legal
    // as one the playbook placed — offside and out-of-bounds stay impossible.
    const { x, y } = legalSpot(p.label, p.x + d.alignDx, p.y + d.alignDy, losY)
    return { ...p, x, y, routeDepthScale: d.stemScale }
  })

  return Object.assign(controller, {
    genome,
    decisions,
    adjustments,
    versions: { deepOffense: DEEP_OFFENSE_VERSION },
  })
}
