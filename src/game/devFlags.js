// ── Dev-only switches ([dev flags]) ───────────────────────────────────────
//
// Affordances that exist to make the game easier to WORK ON, and which would be cheating or nonsense
// in a real one. They live behind one function so there is a single place that refuses in production,
// rather than a `process.env` test scattered wherever somebody needed one.
//
// ⚠️ PRODUCTION REFUSES FIRST, AND THAT IS NOT NEGOTIABLE. A flag set in a deployed environment — by
// accident, by a copied config, by a hosting panel someone forgot — must not be able to switch
// gameplay off. So NODE_ENV is checked before the flag is even looked at, and no flag can override it.
//
// Every switch is also OFF by default: absent means absent. The list is short on purpose; anything
// that changes what the AI does or knows belongs in the difficulty tiers, not here.

// Is this dev-only switch on? `name` is the environment variable, and the only accepted value is '1'
// — 'true', 'yes' and '0' are all off, because a flag that is ambiguous about being on is worse than
// no flag.
export function devFlag(name) {
  if (process.env.NODE_ENV === 'production') return false
  return process.env[name] === '1'
}

// [delay of game] No five-yard penalty when the play clock runs out. For sitting in pre-snap reading
// an alignment, or lining a scenario up by hand, without the down being replayed five yards back
// every twenty-five seconds. The clock still counts down and still reaches zero — it simply stops
// there instead of costing anything.
export const noDelayOfGame = () => devFlag('DISABLE_DELAY_OF_GAME')
