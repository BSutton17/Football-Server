// ── A genome as a defensive brain ([training]) ──────────────────────────────
//
// Wraps a NEAT network so it can sit in a seat exactly where the heuristic does. The controller
// already does everything except CHOOSE — it places players, expands the shell into eleven legal
// assignments, follows motion, and answers special teams. All the network replaces is the call.
//
// That split is deliberate. The network is not asked to rediscover that a corner cannot cover a
// tight end, or where a curl zone belongs, or how to line up on the hash. It is asked the one
// question a coordinator is actually asked: given this picture, what do we run?

import { createController } from '../ai/controller.js'
import { buildNetwork } from '../neat/neat.js'
import { observe, OBSERVATION_SIZE, OBSERVATION_VERSION } from './observation.js'
import { decode, ACTION_SIZE, ACTION_VERSION } from './action.js'
import { SHELLS } from '../ai/playbook/coverages.js'

export { OBSERVATION_SIZE, ACTION_SIZE }

// Builds a brain that plays the heuristic's game with the network's calls.
export function createNetworkBrain({ socket, slot, roster, genome, seed = 1, log = false }) {
  const net = buildNetwork(genome)

  // What this seat can field, which is what the action mask is built against.
  const available = {
    CB: roster.filter(p => p.position === 'CB').length,
    S: roster.filter(p => p.position === 'S').length,
    LB: roster.filter(p => p.position === 'LB').length,
  }

  const controller = createController({ socket, slot, roster, seed, log })

  // The decisions the network made this play, kept for telemetry and for asserting in tests that
  // the network is actually varying its calls rather than answering everything the same way.
  const decisions = []

  // The controller asks for a defensive call through `callDefense`; swapping that one function is
  // the entire integration. Everything downstream — expandShell, the legality mask, alignment,
  // motion — is unchanged, so a network call is as legal as a heuristic one by construction.
  controller.overrideDefensiveCall = (k) => {
    const inputs = observe(k, { roster })
    const outputs = net(inputs)
    const action = decode(outputs, { available })

    const call = {
      shellId: action.shellId,
      shellName: SHELLS[action.shellId]?.name ?? action.shellId,
      personnel: action.personnel,
      extraRushers: SHELLS[action.shellId]?.rushers ?? 0,
      why: `network (${action.confidence.toFixed(2)})`,
      network: action,
    }
    decisions.push(call)
    return call
  }

  return Object.assign(controller, {
    genome,
    decisions,
    versions: { observation: OBSERVATION_VERSION, action: ACTION_VERSION },
  })
}
