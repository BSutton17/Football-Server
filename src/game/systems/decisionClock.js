import { resolveDecision, resolveConversion } from '../eventQueue.js'
import { decisionDefault, conversionDefault } from '../specialTeams.js'

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

// [Special Teams][51] Counts down the post-touchdown extra-point / 2-pt menu; auto-selects the extra
// point on timeout. Server-authoritative, run during PRE_SNAP while conversionPending.
export function runConversionClock(state, io, dt) {
  if (!state.conversionPending) return
  state.conversionTimer = Math.max(0, (state.conversionTimer ?? 0) - dt)
  if (state.conversionTimer <= 0) {
    resolveConversion(state, io, conversionDefault())
  }
}
