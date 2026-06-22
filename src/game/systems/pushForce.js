import { detectEngagements, ENGAGEMENT_RADIUS } from '../utils/engagementZone.js'
import { computeLeverage }                       from '../utils/leverageModel.js'
import { findBallRef }                            from './engagement.js'
import { ratingOf, strengthModifier, passRushModifier } from '../../data/ratings.js'

// ── Tuning constants ──────────────────────────────────────────────────────────

// Base acceleration applied per unit of leverage score per unit of engagement depth.
// Calibrated so a blocker with 0.5 leverage at medium depth adds ~0.6 yd/s per second
// to the defender's lateral velocity — enough to shape the pocket over 1–2 seconds.
const BASE_PUSH_FORCE = 6  // yards/sec²

// Run blocking is about DISPLACEMENT, not pocket shaping ([priority 5]). A won run block
// drives the defender the way the blocker is moving — downfield and off the hole — with a
// much larger force, so successful blocks physically move defenders and drive the pile.
const RUN_PUSH_FORCE = 35  // yards/sec²  ([run feedback] raised from 16)

// Offensive linemen and tight ends are the dedicated run blockers — their drive is amplified on
// run plays only. Calibrated with the RB-vision change ([run feedback]) so that with even OL/DL
// ratings the line drives the engaged pile ~1–3 yards downfield, which is the gain the back
// follows it for before the second level fills.
const BLOCK_POWER_LABELS = new Set(['OL', 'C', 'G', 'T', 'TE'])
const BLOCK_POWER_MULT   = 4.5  // [run feedback] raised from 1.25 (OL/TE run drive)

// The advantage player (winning the block fight) absorbs a reaction force in the
// opposite direction, but their footwork lets them resist it better.
const REACTION_FACTOR = 0.35

// ── Pass-RUSH power ([pass-block feedback]) ───────────────────────────────────────
// The mirror of the run-block inflation above: just as a won RUN block drives the defender back
// with RUN_PUSH_FORCE × BLOCK_POWER_MULT, a won PASS RUSH drives the BLOCKER back toward the QB with
// PASS_RUSH_FORCE × RUSH_POWER_MULT — a displacement push that collapses the pocket and closes the
// rush in, not the light pocket-shaping force the rush used before.
//
//   RUSH_POWER_MULT — THE knob for pass-rush strength. Higher = stronger rush (and therefore pass
//       protection is effectively weaker, the pocket caves faster); lower = weaker rush.
//
const PASS_RUSH_FORCE   = 80                          // yd/s² base won-pass-rush drive (mirror of RUN_PUSH_FORCE)
const RUSH_POWER_LABELS = new Set(['DL', 'DE', 'DT', 'NT'])
const RUSH_POWER_MULT   = 4.0                         // DL/edge drive amplified on pass plays (mirror of BLOCK_POWER_MULT)

// When the blocker WINS pass pro, how hard it rides the rusher off his track (1 = neutral, >1 stronger).
const PASS_BLOCK_DRIVE  = 1.0

// ── Push force system ─────────────────────────────────────────────────────────

// Runs after runMovement so steering forces are already applied.
// For each engaged blocker-defender pair, applies bilateral push forces:
//
//   Offense wins (leverageScore > 0):
//     Defender  ← pushed in the leverage direction, scaled by strMod (blocker's strength edge)
//     Blocker   ← light reaction scaled by (2 - strMod) (stronger blocker resists more)
//
//   Defense wins (leverageScore < 0):
//     Blocker   ← pushed back toward the ball, scaled by (2 - strMod) (defender's strength edge)
//     Defender  ← light follow-through scaled by strMod
//
// strMod and (2 - strMod) always sum to 2, so the total force added to the system
// is constant — strength only transfers it from the losing side to the winning side.
export function runPushForce(state, _io, dt) {
  const ballRef = findBallRef(state)
  const pairs   = detectEngagements(state.offensePlayers, state.defensePlayers, state.playDesign?.playType)

  for (const { offense: o, defense: d, dist } of pairs) {
    // A shed rusher has broken free — no block-fight forces apply to it.
    if (d.shedBlock) continue

    const lev = computeLeverage(o, d, ballRef)

    // Pass-rush bias: shifts the block-fight outcome toward the defender when they
    // outclass the blocker as a pass rusher. Elite DL vs average C tips neutral
    // contests in the rusher's favor; a blitzing LB vs a tackle faces an uphill fight.
    const rushBias     = passRushModifier(ratingOf(d, 'passRush') ?? 0, ratingOf(o, 'strength'))
    const effectiveLev = Math.max(-1, Math.min(1, lev.score - rushBias))

    if (effectiveLev === 0) continue

    // Engagement depth: 0 at the zone boundary, 1 at full body contact.
    const depth  = Math.max(0, (ENGAGEMENT_RADIUS - dist) / ENGAGEMENT_RADIUS)
    const isRun  = state.playDesign?.playType === 'run'

    const strMod    = strengthModifier(ratingOf(o, 'strength'), ratingOf(d, 'strength'))
    const defStrMod = 2 - strMod   // defender's effective strength multiplier

    if (effectiveLev > 0 && isRun) {
      // Run block won: DRIVE the defender straight back off the ball, ALONG THE RUN LINE (the way
      // the offense is advancing) — NOT off the blocker's own sideways drift, which only shaded the
      // man and left him sitting at the LOS. The blocker rides with it at the same velocity so they
      // stay locked (a real drive block, not a force-field shove), and the front gets ROOTED
      // BACKWARD — that's what opens the hole and the 1–3 yards the back follows. The lateral seal
      // is left to the blocker's steering, not the push. collisionResponse keeps them touching.
      const ra  = ((state.playDesign?.runAngle ?? 0) * Math.PI) / 180
      const ddx = Math.sin(ra)
      const ddy = Math.cos(ra) * state.direction   // downfield in the called run direction

      let force = RUN_PUSH_FORCE
      if (BLOCK_POWER_LABELS.has(o.label)) force *= BLOCK_POWER_MULT   // OL/TE drive harder
      const mag = force * Math.abs(effectiveLev) * depth * dt

      const dvx = ddx * mag * strMod
      const dvy = ddy * mag * strMod
      d.vx += dvx;  d.vy += dvy   // defender driven straight back
      o.vx += dvx;  o.vy += dvy   // blocker drives WITH it (stays in contact — no recoil)
    } else if (effectiveLev > 0) {
      // Pass pro: shape the pocket — push the defender away from the ball; the blocker absorbs a
      // light backward reaction (a stronger blocker resists it better). The winning blocker rides
      // the rusher a touch farther off his track ([pass-block feedback]).
      const pdx = lev.pushX, pdy = lev.pushY
      const mag = BASE_PUSH_FORCE * Math.abs(effectiveLev) * depth * dt * PASS_BLOCK_DRIVE

      d.vx += pdx * mag * strMod
      d.vy += pdy * mag * strMod

      o.vx -= pdx * mag * REACTION_FACTOR * defStrMod
      o.vy -= pdy * mag * REACTION_FACTOR * defStrMod
    } else {
      // Defense has effective leverage — drive the blocker back toward the ball.
      const toBallX = ballRef.x - o.x
      const toBallY = ballRef.y - o.y
      const len     = Math.sqrt(toBallX * toBallX + toBallY * toBallY)

      if (len > 0.001) {
        const nx = toBallX / len
        const ny = toBallY / len

        if (!isRun) {
          // PASS: a won pass rush is a DISPLACEMENT push, the mirror of a won run block. Drive the
          // blocker back toward the QB with the inflated rush force and let the rusher ride WITH it
          // (same velocity, no recoil) so the pocket collapses and the rush closes in ([pass-block
          // feedback]). RUSH_POWER_MULT amplifies the dedicated rushers.
          let force = PASS_RUSH_FORCE
          if (RUSH_POWER_LABELS.has(d.label)) force *= RUSH_POWER_MULT
          const mag = force * Math.abs(effectiveLev) * depth * dt
          const dvx = nx * mag * defStrMod
          const dvy = ny * mag * defStrMod
          o.vx += dvx;  o.vy += dvy   // blocker driven back toward the QB
          d.vx += dvx;  d.vy += dvy   // rusher drives WITH it, closing on the QB
        } else {
          // RUN: light penetration push — blocker driven toward the ball, rusher a small recoil.
          const mag = BASE_PUSH_FORCE * Math.abs(effectiveLev) * depth * dt
          o.vx += nx * mag * defStrMod
          o.vy += ny * mag * defStrMod
          d.vx -= nx * mag * REACTION_FACTOR * strMod
          d.vy -= ny * mag * REACTION_FACTOR * strMod
        }
      }
    }
  }
}
