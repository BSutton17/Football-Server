import { resolveDecision } from '../eventQueue.js'
import { decisionDefault } from '../specialTeams.js'

// [Special Teams][3] Counts down the 4th-down decision menu while it's pending. When it hits zero
// the server auto-selects the default option (server-authoritative, so both clients agree even if
// the offense never answers — or disconnects). Run during PRE_SNAP only while decisionPending.
export function runDecisionClock(state, io, dt) {
  if (!state.decisionPending) return
  state.decisionTimer = Math.max(0, (state.decisionTimer ?? 0) - dt)
  if (state.decisionTimer <= 0) {
    resolveDecision(state, io, decisionDefault(state))
  }
}
