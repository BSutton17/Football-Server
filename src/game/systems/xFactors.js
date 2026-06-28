// ── X-Factors ([294] full QB set) ──────────────────────────────────────────────
//
// X-Factors are in-game buffs a player earns by performing well. A player has ONE potential
// ability (entity.xFactor, from the roster). It activates the INSTANT its earn condition is met —
// no button, no client call: the activation flips a persistent flag both clients render as a gold
// star (serialization tags `xfActive` from the entity, drawn by the renderer).
//
// Progress and active state live in state.xFactors (Map<playerId, record>) so they survive across
// plays within a half. EVERYTHING is wiped at half-time and at game end (resetXFactors): both the
// active buffs and all progress toward earning them.
//
// This module is the single home for: per-player progress tracking, activation/deactivation,
// the per-snap restore of the star flag onto fresh play entities, and the effect hooks the sim
// reads (throw-chance modifiers + the sack shake-off roll).
//
// Currently wired: the five QB abilities and the four WR abilities. The structure (record + ability
// switch) is built to take RB/DB abilities later without reshaping anything.

import { OPENNESS_OPEN, OPENNESS_RED } from '../utils/passOutcome.js'

export const XF = {
  // QB
  SHAKE_IT_OFF:      'Shake It Off',
  SHORT_TERM_MEMORY: 'Short Term Memory',
  TIGHT_WINDOW:      'Tight Window',
  CANNON:            'Cannon',
  TEAM_CHEMISTRY:    'Team Chemistry',
  // WR
  HIGH_POINT:        'High Point',
  MOSSED:            'Mossed',
  IM_ALWAYS_OPEN:    "I'm Always F*cking Open",
  FAST_THINKING:     'Fast Thinking',
  // RB
  TRUCKED:           'Trucked',
  SHIFTY:            'Shifty',
  SERIOUS_DEDICATION: 'Serious Dedication',
  // DB (CB/S)
  SLANT_SLAYER:      'Slant Slayer',
  DEEP_PASS_DEMON:   'Deep Pass Demon',
  BALL_HAWK:         'Ball Hawk',
  INTIMIDATOR:       'Intimidator',
}

// Skill players who earn an X-Factor simply by scoring a touchdown (the universal path). QBs do NOT
// — their universal path is 2 PASSING TDs, so a QB rushing TD must not count here.
const TD_SCORER_LABELS = new Set(['WR', 'TE', 'RB'])

// Defensive backs — the positions that can be "the DB guarding the intended receiver".
const DB_LABELS = new Set(['CB', 'S'])

// ── Earn thresholds (per half) ──────────────────────────────────────────────────
const PASS_TD_EARN          = 2    // universal: 2 passing TDs earns ANY QB ability
const SCRAMBLE_EARN_YARDS   = 10   // Shake It Off: one scramble of ≥10 yds
const STM_STREAK_EARN       = 5    // Short Term Memory: 5 completions in a row
const TIGHT_CONTESTED_EARN  = 2    // Tight Window: 2 contested completions (1 heavily is enough)
const CANNON_DEEP_EARN      = 2    // Cannon: 2 deep completions
const CHEM_RECEIVERS_EARN   = 4    // Team Chemistry: completions to 4 different receivers

const WR_CONTESTED_CATCH_EARN = 2   // Mossed / Fast Thinking: 2 contested catches (1 heavily is enough)
const WR_CONTESTED_DEEP_EARN  = 2   // High Point: 2 contested deep catches (1 heavily-contested deep is enough)
const IAFO_CATCH_STREAK_EARN  = 3   // I'm Always F*cking Open: 3 catches in a row

const TRUCKED_BREAKS_EARN       = 2    // Trucked: break 2 tackles within the same run
const SHIFTY_LONG_RUN_EARN      = 20   // Shifty: a 20+ yard run
const SERIOUS_DED_FD_DRIVE_EARN = 3    // Serious Dedication: 3 first downs in one drive…
const SERIOUS_DED_FD_TOTAL_EARN = 7    // …or 7 first downs in the half

// DBs share one earn path (no per-ability condition was specified): an INT or 3 pass break-ups in a
// half, credited to the DB guarding the intended receiver.
const DB_PBU_EARN = 3

// ── Loss triggers (while active) ────────────────────────────────────────────────
const LOSS_CONSEC_INCOMPLETIONS = 3   // QB: 3 incompletions in a row (runs/punts don't interrupt)
const WR_DROPS_IN_A_ROW_LOSS    = 2   // WR: 2 dropped passes in a row
const WR_DROPS_TOTAL_LOSS       = 3   // WR: 3 dropped passes total while the X-Factor is active
const RB_NONPOS_RUNS_LOSS       = 3   // RB: 3 consecutive non-positive runs (no gain / tackle for loss)
const DB_CATCHES_ALLOWED_LOSS   = 2   // DB: allowing 2 catches (a contested/heavily-contested catch is instant)

// ── Effect magnitudes ───────────────────────────────────────────────────────────
// Short Term Memory's "+1 to all throwing chances (1-6 → 1-7)" is read as one pip on a 10-point
// scale → +10% completion. Tunable here if that reading is wrong.
const STM_BONUS           = 0.10   // Short Term Memory: +10% completion after a prior incomplete pass
const TIGHT_WINDOW_BONUS  = 0.10   // Tight Window: +10% completion on a contested/heavily-contested throw
const CANNON_BONUS        = 0.10   // Cannon: +10% completion on a deep throw
const CHEM_PER_SNAP       = 0.01   // Team Chemistry: +1% completion per snap…
const CHEM_CAP            = 0.15   // …capped at +15%
const CHEM_MAX_STACKS     = Math.round(CHEM_CAP / CHEM_PER_SNAP)   // 15

// WR catch/INT effects (on contested = covered, heavily contested = smothered windows).
const MOSSED_CATCH_BONUS     = 0.10   // Mossed: +10% catch on contested/heavily-contested
const FAST_THINKING_CATCH    = 0.05   // Fast Thinking: +5% catch on contested/heavily-contested…
const FAST_THINKING_INT      = -0.10  // …and −10% INT chance on those throws
const HIGH_POINT_ACCEL_BONUS = 4      // High Point: +4 acceleration (may exceed 99)

// RB tackle-break effects.
const SHIFTY_BREAK_BONUS      = 0.10  // Shifty: +10% break chance on the 1st/2nd/3rd tackle
const SERIOUS_DED_BREAK_BONUS = 0.20  // Serious Dedication: +20% on the FIRST tackle, near the marker
const SERIOUS_DED_RANGE_YDS   = 2     // …when the LOS is within 2 yds of the first-down line or end zone

// I'm Always F*cking Open widens the "open" window: any throw at or above this openness counts as
// open (vs the normal OPENNESS_OPEN gate), and an open throw to this WR is a guaranteed catch.
const IAFO_OPEN_THRESHOLD = (OPENNESS_OPEN + OPENNESS_RED) / 2   // 0.495 — halfway into the contested band

// DB effects (on contested = covered, heavily contested = smothered windows to the guarded receiver).
const SLANT_DEMON_CATCH_PENALTY = -0.10  // Slant Slayer / Deep Pass Demon: −10% catch on their route depth
const BALL_HAWK_INT_BONUS       = 0.05   // Ball Hawk: +5% INT on contested/heavily-contested
// Intimidator shrinks the guarded receiver's "open" window (opposite of I'm Always F*cking Open): a
// would-be open throw below this openness is knocked down to contested.
const INTIMIDATOR_OPEN_BAR      = OPENNESS_OPEN + 0.19   // 0.85 — must be THIS open to still read open

export const SHAKE_OFF_CHANCE  = 0.5    // Shake It Off: 50% to escape a sack (RNG 1–2)
export const SHAKE_IMMUNITY_S  = 0.6    // grace window after a shake-off so the same rush can't re-sack
export const SHAKE_KNOCKBACK_YD = 2.5   // how far the beaten rusher is shoved off the QB

// A throw is "deep" once it travels this many yards past the line of scrimmage.
export const DEEP_YARDS = 20

// ── Store helpers ───────────────────────────────────────────────────────────────

function ensureStore(state) {
  if (!state.xFactors) state.xFactors = new Map()
  return state.xFactors
}

export function findOffenseQB(state) {
  if (!state.offensePlayers) return null
  for (const p of state.offensePlayers.values()) {
    if (p.label === 'QB') return p
  }
  return null
}

// The progress record for a QB that actually carries an X-Factor potential. Returns null for a
// player with no ability. `create` lets read-only callers avoid materializing a record.
function getRecord(state, player, create = true) {
  if (!player?.xFactor) return null
  const m = ensureStore(state)
  let r = m.get(player.id)
  if (!r && create) {
    r = {
      ability:               player.xFactor,
      active:                false,
      lostThisHalf:          false,   // once lost early, can't be re-earned until the half resets

      // ── Universal earn flags ──
      scrambleEarned:        false,   // QB: a ≥10-yd scramble happened (Shake It Off)
      passTds:               0,       // QB: passing TDs (2 earns any QB ability)
      tdScored:              false,   // WR: scored a TD (earns any WR ability)

      // ── QB earn progress (wiped each half) ──
      completionStreak:      0,
      contestedCompletions:  0,
      heavyContestedComplete: false,
      deepCompletions:       0,
      receivers:             new Set(),
      consecIncompletions:   0,        // QB loss
      teamChemistryStacks:   0,        // runtime buff

      // ── WR earn progress ──
      wrContestedCatches:    0,        // contested (covered) catches — Mossed / Fast Thinking
      wrHeavyCatch:          false,    // a heavily-contested (smothered) catch
      wrContestedDeepCatches: 0,       // contested deep catches — High Point
      wrHeavyDeepCatch:      false,    // a heavily-contested deep catch
      wrCatchStreak:         0,        // catches in a row — I'm Always F*cking Open

      // ── WR loss tracking (only while active) ──
      wrDropsInARow:         0,
      wrDropsTotal:          0,

      // ── RB earn progress ──
      rbTruckedBreaks:       false,    // broke 2 tackles within one run (Trucked)
      rbLongRun:             false,    // had a 20+ yard run (Shifty)
      rbFirstDowns:          0,        // first downs gained as the runner this half (Serious Dedication)
      rbFirstDownsDrive:     0,        // …and on the current drive (reset on possession change)
      // ── RB loss tracking (only while active) ──
      rbNonPositiveRuns:     0,

      // ── DB earn progress ──
      dbInt:                 false,    // recorded an interception (credited to the guarding DB)
      dbPbus:                0,        // pass break-ups credited this half
      // ── DB loss tracking (only while active) ──
      dbCatchesAllowed:      0,
    }
    m.set(player.id, r)
  }
  return r ?? null
}

// ── Activation / loss ───────────────────────────────────────────────────────────

function activate(state, player, r, io) {
  if (!r || r.active) return
  r.active = true
  if (player) {
    player.xFactorActive = true   // star shows on the very next positions broadcast
    applyPassiveBuff(player, r)   // e.g. High Point's +4 acceleration
  }
  bumpActivationStamina(state)    // [xfactor] +25% stamina to the activating team on activation
  if (io) io.to(state.roomId).emit('xfactor_activated', { playerId: player?.id, ability: r.ability })
}

function deactivate(state, player, r, io, reason) {
  if (!r || !r.active) return
  r.active = false
  r.lostThisHalf = true   // an early loss is sticky — banked earn progress can't immediately re-trigger it
  r.teamChemistryStacks = 0
  if (player) {
    player.xFactorActive = false
    clearPassiveBuff(player)
  }
  if (io) io.to(state.roomId).emit('xfactor_lost', { playerId: player?.id, ability: r.ability, reason })
}

// Passive (always-on while active) stat buffs. Set ABSOLUTELY (never accumulate) so re-applying each
// snap can't stack. High Point is the only one so far: +4 acceleration, allowed to exceed 99.
function applyPassiveBuff(player, r) {
  if (r.ability === XF.HIGH_POINT) player.ratingBonus = { ...(player.ratingBonus ?? {}), acceleration: HIGH_POINT_ACCEL_BONUS }
}
function clearPassiveBuff(player) {
  if (player.ratingBonus) delete player.ratingBonus.acceleration
}

// +25% stamina to the activating player's whole side (non-linemen carry fatigue entries; linemen
// never do, so they're skipped naturally). Stamina is a 0–100 bar, so "+25%" is +25 points.
const STAMINA_ACTIVATION_BONUS = 25
function bumpActivationStamina(state) {
  if (!state.offensePlayers || !state.playerFatigue) return
  for (const p of state.offensePlayers.values()) {
    const f = state.playerFatigue.get(p.id)
    if (f && Number.isFinite(f.stamina)) {
      f.stamina = Math.min(100, f.stamina + STAMINA_ACTIVATION_BONUS)
    }
  }
}

// Re-check whether an earn condition is now met (idempotent once active).
//   QB universal path: 2 passing TDs.  WR universal path: scoring a TD.
function checkEarn(state, player, r, io) {
  if (r.active || r.lostThisHalf) return

  let earned = false
  switch (r.ability) {
    // ── QB ──
    case XF.SHAKE_IT_OFF:      earned = r.passTds >= PASS_TD_EARN || r.scrambleEarned; break
    case XF.SHORT_TERM_MEMORY: earned = r.passTds >= PASS_TD_EARN || r.completionStreak >= STM_STREAK_EARN; break
    case XF.TIGHT_WINDOW:      earned = r.passTds >= PASS_TD_EARN || r.heavyContestedComplete || r.contestedCompletions >= TIGHT_CONTESTED_EARN; break
    case XF.CANNON:            earned = r.passTds >= PASS_TD_EARN || r.deepCompletions >= CANNON_DEEP_EARN; break
    case XF.TEAM_CHEMISTRY:    earned = r.passTds >= PASS_TD_EARN || r.receivers.size >= CHEM_RECEIVERS_EARN; break
    // ── WR ──
    case XF.HIGH_POINT:        earned = r.tdScored || r.wrHeavyDeepCatch || r.wrContestedDeepCatches >= WR_CONTESTED_DEEP_EARN; break
    case XF.MOSSED:            earned = r.tdScored || r.wrHeavyCatch || r.wrContestedCatches >= WR_CONTESTED_CATCH_EARN; break
    case XF.FAST_THINKING:     earned = r.tdScored || r.wrHeavyCatch || r.wrContestedCatches >= WR_CONTESTED_CATCH_EARN; break
    case XF.IM_ALWAYS_OPEN:    earned = r.tdScored || r.wrCatchStreak >= IAFO_CATCH_STREAK_EARN; break
    // ── RB ──
    case XF.TRUCKED:           earned = r.tdScored || r.rbTruckedBreaks; break
    case XF.SHIFTY:            earned = r.tdScored || r.rbLongRun; break
    case XF.SERIOUS_DEDICATION: earned = r.tdScored || r.rbFirstDownsDrive >= SERIOUS_DED_FD_DRIVE_EARN || r.rbFirstDowns >= SERIOUS_DED_FD_TOTAL_EARN; break
    // ── DB (CB/S) — all share the INT / 3-PBU earn path ──
    case XF.SLANT_SLAYER:
    case XF.DEEP_PASS_DEMON:
    case XF.BALL_HAWK:
    case XF.INTIMIDATOR:      earned = r.dbInt || r.dbPbus >= DB_PBU_EARN; break
    default: break
  }

  if (earned) activate(state, player, r, io)
}

// ── Event hooks (called from the event queue) ───────────────────────────────────

// A pass resolved (instant-resolution model — outcome is known at release).
//   outcome: 'complete' | 'incomplete' | 'intercepted'
//   tier:    'open' | 'covered' | 'smothered'  (covered = contested, smothered = heavily contested)
//   deep:    boolean
export function recordPassOutcome(state, qb, { outcome, tier, deep, receiverId }, io) {
  const r = getRecord(state, qb)
  if (!r) return

  if (outcome === 'complete') {
    r.consecIncompletions = 0
    r.completionStreak    += 1
    if (receiverId) r.receivers.add(receiverId)
    if (tier === 'smothered') r.heavyContestedComplete = true
    else if (tier === 'covered') r.contestedCompletions += 1
    if (deep) r.deepCompletions += 1
    checkEarn(state, qb, r, io)
  } else if (outcome === 'incomplete') {
    r.completionStreak     = 0
    r.consecIncompletions += 1
    if (r.active && r.consecIncompletions >= LOSS_CONSEC_INCOMPLETIONS) {
      deactivate(state, qb, r, io, '3 incompletions')
    }
  } else if (outcome === 'intercepted') {
    r.completionStreak    = 0
    r.consecIncompletions = 0
    if (r.active) deactivate(state, qb, r, io, 'interception')
  }
}

// A QB scramble ended for `yards` net (Shake It Off earn path).
export function recordScramble(state, qb, yards, io) {
  const r = getRecord(state, qb)
  if (!r) return
  if (yards >= SCRAMBLE_EARN_YARDS) { r.scrambleEarned = true; checkEarn(state, qb, r, io) }
}

// A passing touchdown (the universal 2-TD earn path).
export function recordPassingTouchdown(state, qb, io) {
  const r = getRecord(state, qb)
  if (!r) return
  r.passTds += 1
  checkEarn(state, qb, r, io)
}

// ── WR hooks ─────────────────────────────────────────────────────────────────────

// A throw resolved with `receiver` as the TARGET. Drives WR earn progress (catches, classified by
// contested/heavily-contested + deep) and the WR loss triggers (drops).
//   reason: 'caught' | 'drop' (open-window miss) | 'broken_up' (contested miss) | 'intercepted'
export function recordReceiverOutcome(state, receiver, { outcome, reason, tier, deep }, io) {
  const r = getRecord(state, receiver)
  if (!r) return

  if (outcome === 'complete') {
    r.wrCatchStreak += 1
    r.wrDropsInARow  = 0
    if (tier === 'smothered') {
      r.wrHeavyCatch = true
      if (deep) r.wrHeavyDeepCatch = true
    } else if (tier === 'covered') {
      r.wrContestedCatches += 1
      if (deep) r.wrContestedDeepCatches += 1
    }
    checkEarn(state, receiver, r, io)
  } else if (outcome === 'incomplete') {
    // Any non-catch breaks the catch streak. A WR loses its active ability on a wide-open drop
    // (open window), 2 drops in a row, or 3 drops total while active.
    r.wrCatchStreak = 0
    if (r.active) {
      r.wrDropsInARow += 1
      r.wrDropsTotal  += 1
      const wideOpenDrop = reason === 'drop'
      if (wideOpenDrop) {
        deactivate(state, receiver, r, io, 'dropped a wide-open pass')
      } else if (r.wrDropsInARow >= WR_DROPS_IN_A_ROW_LOSS || r.wrDropsTotal >= WR_DROPS_TOTAL_LOSS) {
        deactivate(state, receiver, r, io, 'drops')
      }
    }
  } else if (outcome === 'intercepted') {
    r.wrCatchStreak = 0   // a pick off this WR isn't a "drop", but it does break the streak
  }
}

// A skill player (WR/TE/RB) scored a touchdown — the universal earn path (a single TD earns any of
// their abilities). QBs are excluded (their universal path is 2 passing TDs).
export function recordTouchdownScorer(state, scorer, io) {
  if (!scorer || !TD_SCORER_LABELS.has(scorer.label)) return
  const r = getRecord(state, scorer)
  if (!r) return
  r.tdScored = true
  checkEarn(state, scorer, r, io)
}

// ── RB hooks ─────────────────────────────────────────────────────────────────────

// A run by `carrier` (the RB) ended for `yards` net, optionally moving the chains. Drives the Shifty
// (20+ yd run) and Serious Dedication (3 first downs) earns, and the RB loss trigger (3 consecutive
// non-positive runs).
export function recordRun(state, carrier, { yards, firstDown }, io) {
  const r = getRecord(state, carrier)
  if (!r) return

  if (yards >= SHIFTY_LONG_RUN_EARN) r.rbLongRun = true
  if (firstDown) { r.rbFirstDowns += 1; r.rbFirstDownsDrive += 1 }

  if (yards <= 0) {
    r.rbNonPositiveRuns += 1
    if (r.active && r.rbNonPositiveRuns >= RB_NONPOS_RUNS_LOSS) {
      deactivate(state, carrier, r, io, '3 non-positive runs')
    }
  } else {
    r.rbNonPositiveRuns = 0
  }

  checkEarn(state, carrier, r, io)
}

// A tackle was broken on the current run; brokenCount is the carrier's break total THIS run. Two
// breaks within one run earns Trucked.
export function recordTackleBroken(state, carrier, brokenCount, io) {
  const r = getRecord(state, carrier)
  if (!r) return
  if (brokenCount >= TRUCKED_BREAKS_EARN) { r.rbTruckedBreaks = true; checkEarn(state, carrier, r, io) }
}

// ── DB hooks ─────────────────────────────────────────────────────────────────────

// The DB "guarding" a receiver: in man, the CB/S whose coverage targets it; otherwise (zone or no
// man assignment) the nearest CB/S. Used for both earn credit and the DB throw effects/loss.
export function findGuardingDB(state, receiver) {
  if (!receiver || !state.defensePlayers) return null

  // Man coverage — the defender explicitly assigned to this receiver.
  if (state.defenseCoverage) {
    for (const [defId, cov] of state.defenseCoverage) {
      if (cov?.type === 'man' && cov.targetId === receiver.id) {
        const d = state.defensePlayers.get(defId)
        if (d && DB_LABELS.has(d.label)) return d
      }
    }
  }

  // Zone / unassigned — the nearest CB or S to the receiver.
  let best = null, bestDist = Infinity
  for (const d of state.defensePlayers.values()) {
    if (!DB_LABELS.has(d.label)) continue
    const dist = Math.hypot(d.x - receiver.x, d.y - receiver.y)
    if (dist < bestDist) { bestDist = dist; best = d }
  }
  return best
}

// A throw to the receiver `db` is guarding resolved. Credit drives the DB earn (INT or 3 PBUs) and
// the DB loss (a contested/heavily-contested catch allowed → instant; 2 catches allowed → loss).
//   reason: 'caught' | 'drop' | 'broken_up' | 'intercepted'
export function recordDefenderOutcome(state, db, { outcome, reason, tier }, io) {
  const r = getRecord(state, db)
  if (!r) return

  if (outcome === 'complete') {
    r.dbCatchesAllowed += 1
    if (r.active) {
      const contested = tier === 'covered' || tier === 'smothered'
      if (contested) {
        deactivate(state, db, r, io, 'contested catch allowed')
      } else if (r.dbCatchesAllowed >= DB_CATCHES_ALLOWED_LOSS) {
        deactivate(state, db, r, io, '2 catches allowed')
      }
    }
  } else if (outcome === 'intercepted') {
    // The guarding DB is credited the pick regardless of which defender physically caught it.
    r.dbInt = true
    checkEarn(state, db, r, io)
  } else if (outcome === 'incomplete' && reason === 'broken_up') {
    // A defended incompletion is a pass break-up; a 'drop' (open-window miss) is not.
    r.dbPbus += 1
    checkEarn(state, db, r, io)
  }
}

// ── Per-snap upkeep ─────────────────────────────────────────────────────────────

// Restore each fresh play-entity's star from the persistent record (play entities are rebuilt every
// snap), and tick the Team Chemistry per-snap ramp for an active QB.
export function onSnapXFactors(state) {
  applyXFactorFlags(state)
  const qb = findOffenseQB(state)
  const r  = qb ? getRecord(state, qb, false) : null
  if (r?.active && r.ability === XF.TEAM_CHEMISTRY) {
    r.teamChemistryStacks = Math.min(CHEM_MAX_STACKS, r.teamChemistryStacks + 1)
  }
}

// [294] Ids of every player whose X-Factor is currently ACTIVE. Sent in game_state so the client can
// draw the gold star BEFORE the snap as well — the per-tick position updates only carry xfActive
// during live play, so a placed pre-snap player would otherwise miss it.
export function activeXFactorIds(state) {
  const ids = []
  if (state.xFactors) for (const [id, r] of state.xFactors) if (r.active) ids.push(id)
  return ids
}

// Copy active state from records onto the live entities so the star — and any passive stat buff —
// follows a player across plays (play entities are rebuilt each snap).
export function applyXFactorFlags(state) {
  const m = state.xFactors
  if (!m) return
  const apply = (p) => {
    if (!p.xFactor) return
    const r = m.get(p.id)
    p.xFactorActive = !!r?.active
    if (r?.active) applyPassiveBuff(p, r)
    else           clearPassiveBuff(p)
  }
  if (state.offensePlayers) for (const p of state.offensePlayers.values()) apply(p)
  if (state.defensePlayers) for (const p of state.defensePlayers.values()) apply(p)
}

// ── Effect reads (called from the sim) ──────────────────────────────────────────

// Additive completion-probability bonus from the QB's active ability for THIS throw.
//   ctx: { tier, deep }   (Short Term Memory also reads state.prevPlayIncompletePass)
export function throwCompletionBonus(state, qb, { tier, deep } = {}) {
  const r = getRecord(state, qb, false)
  if (!r || !r.active) return 0
  switch (r.ability) {
    case XF.SHORT_TERM_MEMORY: return state.prevPlayIncompletePass ? STM_BONUS : 0
    case XF.TIGHT_WINDOW:      return (tier === 'covered' || tier === 'smothered') ? TIGHT_WINDOW_BONUS : 0
    case XF.CANNON:            return deep ? CANNON_BONUS : 0
    case XF.TEAM_CHEMISTRY:    return Math.min(CHEM_CAP, r.teamChemistryStacks * CHEM_PER_SNAP)
    default:                   return 0   // Shake It Off doesn't touch throws
  }
}

// RB tackle-break bonus from an active RB ability, added to the base break chance.
//   brokenCount — how many tackles the carrier has already broken this run (0 = the first tackle).
//   • Shifty — +10% on the 1st/2nd/3rd tackle.
//   • Serious Dedication — +20% on the FIRST tackle only, when the LOS is within 2 yds of the
//     first-down line or the end zone.
export function tackleBreakBonus(state, carrier, brokenCount) {
  const r = getRecord(state, carrier, false)
  if (!r || !r.active) return 0
  if (r.ability === XF.SHIFTY) return brokenCount < 3 ? SHIFTY_BREAK_BONUS : 0
  if (r.ability === XF.SERIOUS_DEDICATION) {
    if (brokenCount !== 0) return 0
    const nearFirstDown = (state.distance ?? Infinity) <= SERIOUS_DED_RANGE_YDS
    const nearEndZone   = (100 - (state.yardLine ?? 0)) <= SERIOUS_DED_RANGE_YDS
    return (nearFirstDown || nearEndZone) ? SERIOUS_DED_BREAK_BONUS : 0
  }
  return 0
}

// Trucked: a carrier with the ACTIVE ability keeps its speed when it breaks a tackle.
export function keepsSpeedOnBreak(state, carrier) {
  const r = getRecord(state, carrier, false)
  return !!(r && r.active && r.ability === XF.TRUCKED)
}

// Shake It Off: a QB with the ACTIVE ability has a 50% chance to escape a would-be sack.
export function shakeOffSack(state, qb, rng = Math.random) {
  const r = getRecord(state, qb, false)
  if (!r || !r.active || r.ability !== XF.SHAKE_IT_OFF) return false
  return rng() < SHAKE_OFF_CHANCE
}

// Receiver-side window reclassification from an active WR ability — applied to the raw openness
// BEFORE the pass resolves, so the upgraded window drives the catch/INT odds:
//   • High Point — on a deep route the WR is never heavily contested (smothered → contested).
//   • I'm Always F*cking Open — a wider "open" window (the contested band's upper half reads open).
export function adjustOpennessForReceiver(state, receiver, openness, deep) {
  const r = getRecord(state, receiver, false)
  if (!r || !r.active) return openness
  if (r.ability === XF.HIGH_POINT && deep && openness < OPENNESS_RED) return OPENNESS_RED
  if (r.ability === XF.IM_ALWAYS_OPEN && openness >= IAFO_OPEN_THRESHOLD && openness < OPENNESS_OPEN) return OPENNESS_OPEN
  return openness
}

// Defender-side window reclassification — Intimidator shrinks the guarded receiver's "open" window
// (the inverse of I'm Always F*cking Open): a would-be open throw below INTIMIDATOR_OPEN_BAR drops
// to contested. Apply AFTER the receiver's own openness adjustment.
export function applyDefenderOpenness(state, db, openness) {
  const r = getRecord(state, db, false)
  if (!r || !r.active || r.ability !== XF.INTIMIDATOR) return openness
  if (openness >= OPENNESS_OPEN && openness < INTIMIDATOR_OPEN_BAR) return OPENNESS_OPEN - 0.001
  return openness
}

// Defender-side catch / INT modifiers from the guarding DB's active ability for THIS throw.
//   ctx.tier — the (already-reclassified) window; ctx.deep — is it a deep route.
//   • Slant Slayer — −10% catch on contested/heavily-contested SHORT-route throws.
//   • Deep Pass Demon — −10% catch on contested/heavily-contested DEEP-route throws.
//   • Ball Hawk — +5% INT on contested/heavily-contested throws.
export function defenderThrowMods(state, db, { tier, deep } = {}) {
  const r = getRecord(state, db, false)
  if (!r || !r.active) return { catchBonus: 0, intDelta: 0 }
  const contested = tier === 'covered' || tier === 'smothered'
  if (!contested) return { catchBonus: 0, intDelta: 0 }
  switch (r.ability) {
    case XF.SLANT_SLAYER:    return { catchBonus: deep ? 0 : SLANT_DEMON_CATCH_PENALTY, intDelta: 0 }
    case XF.DEEP_PASS_DEMON: return { catchBonus: deep ? SLANT_DEMON_CATCH_PENALTY : 0, intDelta: 0 }
    case XF.BALL_HAWK:       return { catchBonus: 0, intDelta: BALL_HAWK_INT_BONUS }
    default:                 return { catchBonus: 0, intDelta: 0 }   // Intimidator acts via openness
  }
}

// Receiver-side catch / INT modifiers from an active WR ability for THIS throw (tier is the
// already-reclassified window). catchBonus adds to completion; intDelta adds to the pick chance.
export function receiverThrowMods(state, receiver, { tier } = {}) {
  const r = getRecord(state, receiver, false)
  if (!r || !r.active) return { catchBonus: 0, intDelta: 0 }
  const contested = tier === 'covered' || tier === 'smothered'
  switch (r.ability) {
    case XF.MOSSED:         return { catchBonus: contested ? MOSSED_CATCH_BONUS : 0, intDelta: 0 }
    case XF.FAST_THINKING:  return contested ? { catchBonus: FAST_THINKING_CATCH, intDelta: FAST_THINKING_INT } : { catchBonus: 0, intDelta: 0 }
    // I'm Always F*cking Open — a guaranteed catch on an open window (+1.0 clamps completion to 100%).
    case XF.IM_ALWAYS_OPEN: return { catchBonus: tier === 'open' ? 1.0 : 0, intDelta: 0 }
    // High Point's effect is the tier reclassification (above) + the acceleration buff.
    default:                return { catchBonus: 0, intDelta: 0 }
  }
}

// ── Drive reset ─────────────────────────────────────────────────────────────────

// Reset per-drive progress when possession changes (the offense's drive ended). Currently just
// Serious Dedication's per-drive first-down count. Call from the one possession-swap path.
export function resetDriveProgress(state) {
  const m = state.xFactors
  if (!m) return
  for (const r of m.values()) r.rbFirstDownsDrive = 0
}

// ── Half / game reset ───────────────────────────────────────────────────────────

// Wipe ALL X-Factors and progress (half-time, game end). Notifies clients to clear any active star.
export function resetXFactors(state, io) {
  const m = state.xFactors
  if (!m || m.size === 0) return
  if (io) {
    for (const [pid, r] of m) {
      if (r.active) io.to(state.roomId).emit('xfactor_lost', { playerId: pid, ability: r.ability, reason: 'half' })
    }
  }
  m.clear()
  // Clear stars off any live entities too (defensive — entities are normally gone by reset time).
  if (state.offensePlayers) for (const p of state.offensePlayers.values()) p.xFactorActive = false
  if (state.defensePlayers) for (const p of state.defensePlayers.values()) p.xFactorActive = false
}
