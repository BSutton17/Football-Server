// ── Lining an authored defense up against what it sees ([authored]) ─────────
//
// An authored formation says where the eleven START. A real defense does not stand there: the
// corner walks out to whoever is split wide, a blitzer creeps toward the line, the zones squeeze
// toward the formation. This turns the drawn picture into the one the defense actually shows,
// using only what it is allowed to know.
//
// ⚠️ NOTHING HAPPENS UNTIL THE OFFENSE HAS SET. Every adjustment here reads where the receivers
// are, so making it while they are still being placed means aligning to a formation that does not
// exist yet — and then twitching as the rest arrive. `k.offenseSet` is the engine's own word for
// "the adjust window opens"; this refuses to do anything before it.
//
// ⚠️ THIS IS ALIGNMENT, NOT A NEW CALL. The shell was chosen already and is not revisited. A
// defense that re-decided its coverage every time a receiver moved would be re-deciding on
// information the offense controls, which is how motion becomes a free way to read the defense.
//
// ⚠️ AND IT STILL NEVER SEES THE PLAY CALL. Where receivers stand is public; what they are about
// to run is not. Everything below reads positions and personnel only.

import { slotLabel } from './authored.js'

// How close a pressing defender gets to the line. Deliberately not zero — the offside rule holds
// a defender's centre a full player-radius back, and pressing from on top of the line is a flag.
const PRESS_DEPTH = 1.5

// A blitz is what makes pressing worth it: with a four-man rush the quarterback has time, and a
// corner pressing with nobody getting home is just a corner with his back turned.
//
// ⚠️ FIVE, COUNTED PLAINLY — and NOT "a non-lineman is rushing", which is the clever-looking
// version and is wrong. In a 3-4 the fourth rusher IS a linebacker; that is what a 3-4 is. Run
// over the real playbook that definition flagged twenty ordinary coverages as blitzes.
const BLITZ_RUSHERS = 5

// ⚠️ HOW FAR A NON-LINEMAN RUSHER MAY CREEP, and no further. Showing blitz early is a real tactic;
// walking onto the line from twelve yards deep is not a disguise, it is an announcement.
const RUSHER_CREEP_MAX = 4

// How far a zone may slide toward the offense. A zone that chases the formation completely is not
// a zone any more — it is man coverage with extra steps, and it vacates the area it was drawn to
// hold. This is also what stops anyone running across the field to reach a zone.
const MAX_ZONE_SLIDE = 4

// How far a man defender may travel laterally from where he was drawn. Unbounded, a corner drawn
// at the numbers would sprint across the formation to reach a receiver on the far hash and leave
// the picture unrecognisable.
const MAX_MAN_TRAVEL = 14

// Deeper than this behind the line and a player is in the backfield, not split out.
const BACKFIELD_DEPTH = 2

// ⚠️ HOW FAR OFF A MAN DEFENDER STANDS, so he is near his receiver without being nose to nose.
// Directly across is both unrealistic and worse football: it gives the leverage away and leaves no
// room to play the release. The lean IS the shade, made visible.
const MAN_OFFSET = 1.0

// Zone defenders keep their left-to-right order, with at least this much between them.
const MIN_ZONE_GAP = 2.5

export const SHADES = ['none', 'in', 'out', 'over', 'under']

export function readyToAlign(k) {
  return Boolean(k?.offenseSet)
}

export function isBlitz(shell) {
  const rushers = Object.values(shell?.assignments ?? {}).filter(a => a?.job === 'rush').length
  return rushers >= BLITZ_RUSHERS
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const splitOut = (r, losY) => r.y >= losY - BACKFIELD_DEPTH

// ── Who takes whom ──────────────────────────────────────────────────────────
//
// ⚠️ CORNERS ON RECEIVERS, LINEBACKERS ON THE TIGHT END AND THE BACK — unless there is nobody left,
// in which case somebody still takes the spare rather than leaving him uncovered.
//
// Matching purely by proximity put a corner on the running back while linebackers chased the
// outside receivers, which is the matchup the engine's own `matchMen` exists to prevent. Position
// is the first sort; distance only breaks ties inside it.
const PREFERS = {
  CB: ['WR'],
  S: ['WR', 'TE'],
  LB: ['TE', 'RB'],
}

export function pairMan(manSlots, receivers, ballX) {
  const pairs = new Map()
  const free = [...receivers].sort((a, b) => a.x - b.x)
  const nearestOf = (list, d) => list.reduce(
    (best, r) => (Math.abs(r.x - (ballX + d.dx)) < Math.abs(best.x - (ballX + d.dx)) ? r : best), list[0])
  const take = (d, r) => { if (r) { pairs.set(d.slot, r); free.splice(free.indexOf(r), 1) } }

  // 1. Corners take the widest receiver on their OWN side, outside in.
  //
  //    ⚠️ `dx` is an offset from the ball, so the side test is against ZERO. Comparing it to the
  //    absolute hash made every offset look negative and every corner take the leftmost receiver.
  for (const d of manSlots.filter(s => slotLabel(s.slot) === 'CB').sort((a, b) => a.dx - b.dx)) {
    const wanted = free.filter(r => PREFERS.CB.includes(r.label))
    if (!wanted.length) continue
    take(d, d.dx < 0 ? wanted[0] : wanted[wanted.length - 1])
  }

  // 2. Everyone else takes the position he is meant to have, nearest first.
  for (const d of manSlots.filter(s => !pairs.has(s.slot)).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))) {
    const prefer = PREFERS[slotLabel(d.slot)] ?? []
    const wanted = free.filter(r => prefer.includes(r.label))
    if (wanted.length) take(d, nearestOf(wanted, d))
  }

  // 3. ⚠️ OUT OF OPTIONS. Anyone still unassigned takes whoever is left, whatever the positions —
  //    a bad matchup is recoverable and an uncovered receiver is a touchdown.
  for (const d of manSlots.filter(s => !pairs.has(s.slot)).sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))) {
    if (!free.length) break
    take(d, nearestOf(free, d))
  }
  return pairs
}

// ── Shading ─────────────────────────────────────────────────────────────────
//
// Which single thing this defender sells out to take away. Decided PER DEFENDER rather than once
// for the whole call, because the right answer genuinely differs across the formation: a corner on
// an isolated receiver with the sideline helping him is in a different situation from a linebacker
// on a back in the middle of the field.
//
// ⚠️ THE SAFETY RULES OUTRANK THE PREFERENCE, ALWAYS. With nobody over the top, anything but UNDER
// is a way to lose deep, and no situational cleverness makes that a good trade.
export function decideShade(defender, receiver, { hasDeepHelp, ballX, forced = null }) {
  if (!receiver) return 'none'
  if (receiver.label === 'RB') return 'under'   // a back releasing is a short threat
  if (!hasDeepHelp) return 'under'              // nothing behind you: never get beaten deep
  if (forced === 'in' || forced === 'out') return forced

  const outsideness = Math.abs(receiver.x - ballX)
  if (outsideness > 14) return 'in'             // wide: the sideline is your help outside
  if (outsideness < 6) return 'out'             // tight: the traffic inside is your help
  return 'over'
}

// Which way a shade leans a defender laterally. `over` and `under` are depth ideas rather than
// lateral ones, so they do not move him sideways at all.
export function shadeLean(shade, receiver, ballX) {
  if (shade === 'in') return receiver.x < ballX ? MAN_OFFSET : -MAN_OFFSET
  if (shade === 'out') return receiver.x < ballX ? -MAN_OFFSET : MAN_OFFSET
  return 0
}

// ── No crossing ─────────────────────────────────────────────────────────────
//
// ⚠️ ZONE DEFENDERS KEEP THEIR ORDER. Two zones that swap sides have both abandoned the area they
// were drawn to hold and are running past each other to do it. Unless the formation was AUTHORED
// that way — which is the author's business, and is why the order preserved is the DRAWN one
// rather than any canonical left-to-right — the order after adjustment matches the order before.
export function enforceNoCrossing(rows) {
  const zones = rows.filter(r => r.job === 'zone')
  if (zones.length < 2) return rows

  let floor = -Infinity
  for (const z of [...zones].sort((a, b) => a.dx - b.dx)) {
    if (z.x < floor) z.x = floor
    floor = z.x + MIN_ZONE_GAP
  }
  return rows
}

// ── The adjustment ──────────────────────────────────────────────────────────
export function alignAuthored({ formation, shell, receivers, ballX, losY, ready = true }) {
  const spots = formation?.spots ?? []
  const assignments = shell?.assignments ?? {}

  const base = spots.map(s => ({
    slot: s.slot,
    label: slotLabel(s.slot),
    job: assignments[s.slot]?.job ?? 'rush',
    dx: s.dx,
    depth: s.depth,
    x: ballX + s.dx,
    y: losY + s.depth,
    zone: assignments[s.slot]?.zone ?? null,
    zoneCenter: assignments[s.slot]?.center ?? null,
    shade: 'none',
    pressing: false,
    covers: null,
  }))

  // ⚠️ Not ready is not a failure — it is the normal state while the offense is still setting.
  if (!ready || !receivers?.length) return base

  const blitzing = isBlitz(shell)
  const forced = shell?.forcedLeverage ?? null
  // Somebody deep enough to be help. Without one, nobody may shade anything but UNDER.
  const hasDeepHelp = base.some(d => d.job === 'zone' && d.zone === 'deep' && d.depth >= 10)

  const pairs = pairMan(base.filter(d => d.job === 'man'), receivers, ballX)

  const out = base.map(d => {
    if (d.job === 'man') {
      const target = pairs.get(d.slot)
      if (!target) return d
      const shade = decideShade(d, target, { hasDeepHelp, ballX, forced })
      const x = clamp(target.x + shadeLean(shade, target, ballX),
        d.x - MAX_MAN_TRAVEL, d.x + MAX_MAN_TRAVEL)

      // ⚠️ FORWARD ONLY. The authored depth is a CEILING: a defender may creep up to press and may
      // never drop off deeper than he was drawn. Backing up would let alignment quietly rewrite
      // the coverage — a corner drawn at 5 bailing to 12 is playing a different call entirely.
      //
      // Corners are the ones who press. A linebacker on a back is already near the line, and
      // walking him onto it just vacates the middle he is standing in.
      const mayPress = d.label === 'CB' && (blitzing || shade === 'under')
      const depth = mayPress ? Math.min(d.depth, PRESS_DEPTH) : d.depth
      return { ...d, x, y: losY + depth, depth, shade, pressing: depth < d.depth, covers: target.id }
    }

    if (d.job === 'rush' && d.label !== 'DL') {
      // A non-lineman rusher may show himself, up to a point.
      const depth = Math.max(PRESS_DEPTH, d.depth - RUSHER_CREEP_MAX)
      return { ...d, y: losY + depth, depth, pressing: depth < d.depth }
    }

    if (d.job === 'zone') {
      // Squeeze toward the receivers on his side, so the zone sits over the route distribution
      // rather than over grass — but only a little, which is also what stops anyone running
      // across the field to get there.
      //
      // ⚠️ ONLY THE ONES SPLIT OUT. A back beside the quarterback is on somebody's side of the ball
      // but is not part of the distribution a zone should sit over — counting him dragged a
      // flat-zone corner four yards inside, away from the receiver he was out there for.
      const side = receivers.filter(r =>
        splitOut(r, losY) && (d.dx < 0 ? r.x < ballX : r.x >= ballX))
      if (!side.length) return d
      const meanX = side.reduce((a, r) => a + r.x, 0) / side.length
      const slide = clamp(meanX - d.x, -MAX_ZONE_SLIDE, MAX_ZONE_SLIDE)

      // A corner in a shallow zone may also come forward onto the receiver aligned in it.
      const nearest = side.reduce((a, r) => (Math.abs(r.x - d.x) < Math.abs(a.x - d.x) ? r : a), side[0])
      const mayPress = d.label === 'CB' && d.zone === 'flat' && Math.abs(nearest.x - d.x) < 8
      const depth = mayPress ? Math.min(d.depth, PRESS_DEPTH + 2) : d.depth

      return {
        ...d,
        x: d.x + slide,
        y: losY + depth,
        depth,
        pressing: depth < d.depth,
        zoneCenter: d.zoneCenter ? { dx: d.zoneCenter.dx + slide, depth: d.zoneCenter.depth } : null,
      }
    }

    return d
  })

  return enforceNoCrossing(out)
}
