// ── Substitutions ([fatigue][AI subs]) ───────────────────────────────────────
//
// "Allow the AI to sub out tired players. Each AI bot should have a sub system on three tiers…"
//
// The computer used to field the best available player at every position on every snap, so its
// starters played the whole game and finished it in the red — while a human was benching tired
// players the whole time. A substitution here is nothing more than WHO the lineup builders pick: a
// benched player is sorted behind everyone at his position, so the next man up takes his spot, and
// he comes back once he has his legs. No new event, no new rule: the server already lets either side
// put anybody from the roster on the field before any snap.
//
// The three tiers, as asked for (stamina bands are the client bar's: yellow at 60, red at 30):
//
//   GRIND  — "Grind it out": sub out only in the red.
//   BREAK  — "Have a break": sub out on entering the yellow, unless it is late in the half or a
//            crucial play (3rd or 4th down, either side of the ball) — then only in the red.
//            In the SECOND HALF the yellow trigger moves to somewhere between the start of the
//            yellow and halfway through it (60 → 45), drawn per player.
//   FRESH  — "Keep 'em fresh": sub out on entering the yellow, no matter what.
//
// Each skill position gets a tier at game start (RBs might all be FRESH while the LBs GRIND), and a
// benched player — the better player, or he would not have been starting — comes back as soon as he
// is back to 80–85% (drawn each time he sits).
//
// Linemen and the quarterback are auto-placed by the server and never sub; neither are they in the
// fatigue map.

import { STAMINA_YELLOW_AT as YELLOW_AT, STAMINA_RED_AT as RED_AT } from '../constants.js'

export const SUB = { GRIND: 'grind_it_out', BREAK: 'have_a_break', FRESH: 'keep_em_fresh' }

// The positions the AI places itself, and so the only ones it can sub.
export const SUB_POSITIONS = ['WR', 'TE', 'RB', 'CB', 'S', 'LB']

// How likely each tier is at each position. Weighted rather than uniform so the plans read like a
// coaching staff's: backs and corners are rotated, big bodies and linebackers are left out there.
const PLAN_WEIGHTS = {
  RB: { [SUB.FRESH]: 0.5,  [SUB.BREAK]: 0.35, [SUB.GRIND]: 0.15 },
  WR: { [SUB.FRESH]: 0.25, [SUB.BREAK]: 0.5,  [SUB.GRIND]: 0.25 },
  TE: { [SUB.FRESH]: 0.15, [SUB.BREAK]: 0.4,  [SUB.GRIND]: 0.45 },
  CB: { [SUB.FRESH]: 0.2,  [SUB.BREAK]: 0.5,  [SUB.GRIND]: 0.3 },
  S:  { [SUB.FRESH]: 0.15, [SUB.BREAK]: 0.45, [SUB.GRIND]: 0.4 },
  LB: { [SUB.FRESH]: 0.15, [SUB.BREAK]: 0.4,  [SUB.GRIND]: 0.45 },
}

// Second-half "Have a break" window: from the start of the yellow to halfway through it.
export const SECOND_HALF_BREAK_FLOOR = (YELLOW_AT + RED_AT) / 2          // 45
// A benched player comes back at a stamina drawn from this range.
export const RETURN_MIN = 80
export const RETURN_MAX = 85
// "Towards the end of the half": the last 30% of the 2nd or 4th quarter (1:30 of a five-minute one).
export const END_OF_HALF_FRACTION = 0.3

// Draws one tier per position. `rng` is the controller's seeded generator, so a seed replays.
export function assignSubPlans(rng = Math.random) {
  const plans = {}
  for (const pos of SUB_POSITIONS) {
    const weights = Object.entries(PLAN_WEIGHTS[pos])
    let r = rng() * weights.reduce((a, [, w]) => a + w, 0)
    plans[pos] = weights[weights.length - 1][0]
    for (const [tier, w] of weights) { r -= w; if (r <= 0) { plans[pos] = tier; break } }
  }
  return plans
}

export function isSecondHalf(k) { return (k.quarter ?? 1) >= 3 }

export function isEndOfHalf(k) {
  const q = k.quarter ?? 1
  if (q !== 2 && q !== 4) return false
  return (k.clock ?? Infinity) <= END_OF_HALF_FRACTION * (k.quarterSeconds ?? 300)
}

// 3rd and 4th downs, for either side: a third-down stop, a fourth-down conversion.
export function isCrucialPlay(k) { return (k.down ?? 1) >= 3 }

// The stamina at or below which a player at this tier comes off, right now. `player` carries his
// own second-half trigger (drawn once per game).
export function subOutAt(tier, k, breakTrigger = YELLOW_AT) {
  if (tier === SUB.FRESH) return YELLOW_AT
  if (tier === SUB.GRIND) return RED_AT
  // BREAK
  if (isEndOfHalf(k) || isCrucialPlay(k)) return RED_AT
  return isSecondHalf(k) ? breakTrigger : YELLOW_AT
}

// The coaching staff for one AI seat: the plans, who is sitting, and when each sitter comes back.
export function createSubSystem(rng = Math.random) {
  const plans = assignSubPlans(rng)
  // Per player, drawn the first time he is seen: his second-half "Have a break" trigger.
  const breakTrigger = new Map()
  // Benched players: id → the stamina he returns at.
  const bench = new Map()

  const triggerFor = (id) => {
    if (!breakTrigger.has(id)) {
      breakTrigger.set(id, SECOND_HALF_BREAK_FLOOR + rng() * (YELLOW_AT - SECOND_HALF_BREAK_FLOOR))
    }
    return breakTrigger.get(id)
  }

  // Updates who is sitting from the stamina the server sent. Called once per play.
  function update(roster, k) {
    const fatigue = k.fatigue ?? {}
    for (const p of roster) {
      const tier = plans[p.position]
      if (!tier) continue
      const stamina = fatigue[p.id]
      if (!Number.isFinite(stamina)) continue        // never played: fresh
      if (bench.has(p.id)) {
        if (stamina >= bench.get(p.id)) bench.delete(p.id)
        continue
      }
      if (stamina <= subOutAt(tier, k, triggerFor(p.id))) {
        bench.set(p.id, RETURN_MIN + rng() * (RETURN_MAX - RETURN_MIN))
      }
    }
  }

  // The roster as the lineup builders should see it this play: the same players, each marked with
  // whether he is sitting and how much he has left, so `byDepth` can put the sitters last.
  function lineup(roster, k) {
    update(roster, k)
    const fatigue = k.fatigue ?? {}
    return roster.map(p => ({
      ...p,
      benched: bench.has(p.id),
      stamina: Number.isFinite(fatigue[p.id]) ? fatigue[p.id] : 100,
    }))
  }

  return { plans, bench, update, lineup }
}

// The order a position group is filled in: everyone available by overall, then the sitters —
// freshest first — only if the formation needs more bodies than there are fresh ones. A sitter
// is never left off a field that would otherwise be short.
export function byDepth(a, b) {
  const sitA = a.benched ? 1 : 0
  const sitB = b.benched ? 1 : 0
  if (sitA !== sitB) return sitA - sitB
  if (sitA) return (b.stamina ?? 100) - (a.stamina ?? 100)
  return (b.ovr ?? 0) - (a.ovr ?? 0)
}
