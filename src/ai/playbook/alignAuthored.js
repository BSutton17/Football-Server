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
// ⚠️ THE FIELD ENDS. A defensive spot is `losY + depth`, and nothing clamped it — so on the
// goal line a safety drawn fifteen yards deep came out at y = 115 and `place_player` refused him,
// while a deep zone's landmark went past the back of the end zone and `assign_coverage` refused
// the WHOLE assignment. A defender with no assignment is one the engine RUSHES, so a red-zone
// shell quietly turned into a blitz with two holes in it. Offensive spots were already clamped by
// `legalSpot`; the defense never was.
//
// The validator's range is -10..110. Half a yard inside it, so rounding cannot push a spot back
// over the line.
export const FIELD_MIN_Y = -9.5
export const FIELD_MAX_Y = 109.5
export const clampFieldY = (y) => Math.max(FIELD_MIN_Y, Math.min(FIELD_MAX_Y, y))
// The sidelines, for the same reason: a zone slide or a man-coverage travel can push a defender
// past them, and `place_player` refuses an x outside 0..53.33.
// ⚠️ TWO DEFENDERS MAY NOT STAND ON EACH OTHER. A non-lineman rusher creeps up to four yards
// toward the line to show blitz, and nothing checked what was already there — so a walked-down
// linebacker routinely ended up inside a defensive lineman. Two bodies in one place is one body's
// worth of pass rush, and it looks broken.
//
// A player is a yard across (PLAYER_RADIUS 0.5 each), so a yard and a quarter leaves daylight.
const MIN_DEFENDER_GAP = 1.25

// How strong a half-time lean has to be before it changes where somebody stands. Matches the
// threshold the half-time report uses to decide a tendency is worth mentioning at all, so the
// defense never adjusts to something it would not have bothered saying out loud.
const SHAPE_LEAN = 0.12

// The deepest anyone may line up while covering a man. Beyond this he is not covering him, he is
// watching him. A safety over the top of a RECEIVER is the one exception — see where it is used.
const MAN_MAX_DEPTH = 5

// How far the quick-game and deep leans move a corner's cushion, in yards at a maximal read.
// Small: this is leverage, not a different coverage.
const CUSHION_SWING = 2.5

export const FIELD_MIN_X = 0.5
export const FIELD_MAX_X = 52.8
export const clampFieldX = (x) => Math.max(FIELD_MIN_X, Math.min(FIELD_MAX_X, x))

const MAX_ZONE_SLIDE = 4

// ⚠️ A DEEP ZONE SLIDES LESS, BECAUSE ITS JOB IS THE MIDDLE. A single-high safety shades toward
// the strength; he does not follow it. Sliding him the same four yards as a flat defender put the
// only deep landmark on the field a dozen yards off centre against a three-receiver side, which is
// how the back half gets thrown behind on the other one. Reported as "the safety deep zone should
// be more to the middle".
const MAX_DEEP_SLIDE = 2

// How far an UNDERNEATH zone may travel to start across from the man in it.
//
// ⚠️ THIS WAS 9, WHICH IS NOT "A LITTLE". The rule this file is built on is that a zone slides
// toward the formation but only a little, because one that chases completely is man coverage with
// extra steps — and nine yards is most of the way across a hook zone's whole area. In the reported
// Cover 4 it let the middle curl defender chase eight yards to the play side, which turned three
// evenly drawn underneath landmarks (gaps of 16 and 16) into gaps of 7 and 27: two defenders on one
// patch and a twenty-seven yard hole beside them.
//
// Four matches MAX_ZONE_SLIDE and the bound the tests have always asserted on a zone defender's
// movement, so the file now says one thing rather than two. Measured over 1,800 downs this is a
// wash on yardage (3.82 -> 3.86 yds/play) and takes explosive plays from 1.9% to 1.6%; it is chosen
// for holding the shape of the coverage, which is what was actually reported, not for the number.
const MAX_ZONE_ALIGN = 4

// Which zones align on a man. A flat, curl or hook defender starts over somebody; a deep defender
// is responsible for an area behind everyone and aligning him on a receiver opens the space he is
// there to protect.
const UNDERNEATH_ZONES = new Set(['flat', 'curl', 'hook'])

// ⚠️ MAN COVERAGE TRAVELS, AND THIS CAP USED TO STOP IT. The idea was that a corner should not
// sprint across the formation and leave the picture unrecognisable. But a man defender has no area
// to abandon — he has a MAN, and one who stops fourteen yards short of him is not playing coverage,
// he is standing in a gap the offense does not have to account for. Reported from a real game: "a
// corner in the box manned up with a man all the way across the field", with two receivers open
// before the snap.
//
// Against trips a real defense shifts to the formation; the picture is SUPPOSED to change. So the
// cap is now only a guard against nonsense (a defender leaving the field of play), and the job of
// keeping travel sane belongs where it should have been all along — the assignment (see pairMan),
// which no longer hands anybody a receiver on the far hash while somebody nearer is free.
const MAX_MAN_TRAVEL = 53.33

// ⚠️ A DEEP ZONE DIVIDES THE FIELD, SO IT IS ANCHORED TO THE FIELD — NOT TO THE BALL.
//
// This is the single most consequential line in the file. Every zone landmark was resolved as
// `ballX + dx`, and the authored deep landmarks are field divisions: read them off the playbook and
// they are exactly ±13.3 for two-deep (halves), ±17.8 and 0 for three (thirds), ±20 and ±6.7 for
// four (quarters). Those numbers are measured from the middle of a 53.33-yard field.
//
// With the ball on a hash — which is most snaps — the ball is eight yards off centre, so the whole
// deep structure slid eight yards with it. In Cover 4 that put two quarters on top of each other by
// one sideline and left seventeen yards of the other side with nobody responsible for it. Reported
// as "look how congested the zones are, multiple people basically guarding the same area", with a
// screenshot of a hand-set defense next to it whose landmarks sat almost exactly on the quarters.
//
// UNDERNEATH zones stay ball-relative, and that is not an inconsistency: a flat or a hook relates to
// the formation, which lines up on the ball. A deep quarter relates to the grass.
const FIELD_CENTER_X = 53.33 / 2

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

// How much lateral travel a bad matchup is worth avoiding, in yards. A corner will walk this much
// further to get a receiver rather than take a tight end standing next to him — but no further,
// because a defender who never reaches anybody covers nothing at all.
const MISMATCH_YARDS = { 0: 0, 1: 7, 2: 14 }
const UNPREFERRED_YARDS = 22

// Larger than any real cost, so a spare defender is only ever chosen when there is no one left.
const SPARE_COST = 1000

// ⚠️ A CORNER WANTS THE OUTERMOST MAN ON HIS SIDE, and pure distance loses that. The widest
// receiver is the one who can run away from you with the whole sideline to work in; inside
// receivers have help around them. Left to distance alone a corner drawn at the numbers takes the
// SLOT (two yards nearer) and leaves the outside man to a safety, which is backwards.
//
// Priced per receiver still outside him rather than enforced, so it yields when the alternative is
// somebody standing twenty yards from anybody — which is the failure that started all this.
const CB_INSIDE_YARDS = 3

function matchCost(d, r, ballX, receivers) {
  const label = slotLabel(d.slot)
  const prefer = PREFERS[label] ?? []
  const rank = prefer.indexOf(r.label)
  const penalty = rank === -1 ? UNPREFERRED_YARDS : (MISMATCH_YARDS[rank] ?? UNPREFERRED_YARDS)

  let leverage = 0
  if (label === 'CB') {
    const side = d.dx < 0 ? -1 : 1
    // Only counts receivers on the corner's own side: against a formation with nobody over there
    // he has no outside to protect, and the term correctly falls away.
    for (const other of receivers) {
      if (other === r) continue
      if (Math.sign(other.x - ballX) !== side) continue
      if (Math.sign(r.x - ballX) !== side) continue
      if (Math.abs(other.x - ballX) > Math.abs(r.x - ballX)) leverage += CB_INSIDE_YARDS
    }
  }
  return Math.abs(r.x - (ballX + d.dx)) + penalty + leverage
}

// ⚠️ ASSIGNED AS A GROUP, NOT ONE AT A TIME. This used to hand each corner "the widest receiver on
// his own side, outside in", taking them in order. Against three receivers to one side that is
// catastrophic and was reported as such: the play-side corner took the outside man, and the
// BACKSIDE corner — forty yards from anybody — was handed a receiver on the far hash, while a
// safety got another. Two receivers were effectively uncovered before the snap.
//
// The failure is that a greedy pass cannot see what its choice costs everybody else. So every
// assignment is scored (lateral distance, plus a penalty for a matchup the position is wrong for)
// and the cheapest COMBINATION wins. With at most six man defenders that is a handful of
// permutations, so it is simply solved rather than approximated.
//
// Position still comes first in practice — the penalty for a corner on a back is larger than any
// sane travel — but it is now a price rather than a veto, which is what stops the matcher painting
// itself into a corner on the last defender.
export function pairMan(manSlots, receivers, ballX) {
  const pairs = new Map()
  if (!manSlots.length || !receivers?.length) return pairs

  // Nearest-first is a good starting order and makes the search settle quickly.
  const defs = [...manSlots].sort((a, b) => Math.abs(a.dx) - Math.abs(b.dx))
  const recv = [...receivers]

  let bestCost = Infinity
  let best = null
  const current = new Array(defs.length).fill(-1)
  const used = new Array(recv.length).fill(false)

  const search = (i, cost) => {
    if (cost >= bestCost) return                 // this branch is already worse than one we have
    if (i === defs.length) { bestCost = cost; best = [...current]; return }
    for (let j = 0; j < recv.length; j++) {
      if (used[j]) continue
      used[j] = true
      current[i] = j
      search(i + 1, cost + matchCost(defs[i], recv[j], ballX, recv))
      used[j] = false
      current[i] = -1
    }
    // ⚠️ COVERING NOBODY IS AN OPTION FOR EVERY DEFENDER, NOT JUST THE LAST ONE. More men than
    // receivers means somebody is spare (he spies — see coverageFor), and WHICH one is a real
    // choice: the first version only allowed a skip once every receiver was taken, so the spare was
    // always whoever came last in the order. That made a CORNER the odd man out against three
    // receivers while linebackers covered them, which is the matchup this file exists to prevent.
    //
    // The cost is large enough that covering always beats not covering, so no solution ever leaves
    // a receiver free while a defender stands idle. Every complete solution pays it the same number
    // of times, so it cancels out and only the distribution is actually being compared.
    current[i] = -1
    search(i + 1, cost + SPARE_COST)
  }
  search(0, 0)

  if (best) {
    for (let i = 0; i < defs.length; i++) {
      if (best[i] >= 0) pairs.set(defs[i].slot, recv[best[i]])
    }
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
export function decideShade(defender, receiver,
  { hasDeepHelp, ballX, forced = null, preferUnderneath = false, adjust = null }) {
  if (!receiver) return 'none'
  if (receiver.label === 'RB') return 'under'   // a back releasing is a short threat
  if (!hasDeepHelp) return 'under'              // nothing behind you: never get beaten deep

  // [halftime shapes] What the opponent has actually been throwing decides leverage before any
  // default does. These sit BELOW the two safety rules above — nothing outranks not getting beaten
  // deep — and ABOVE the shell's pinned leverage, because half a game of evidence outranks a
  // drawing made before kickoff.
  //
  // Read in order of how much they cost to be wrong about. A team taking shots gets played over
  // the top even if they also cross a lot; only then does crossing pull you inside, and an
  // outside-heavy team push you out.
  // Ordered by how much it costs to be wrong. Getting beaten deep is worst, so a team taking shots
  // is played over the top whatever else they do. Then the short game, which is the oldest and
  // best-evidenced of these reads. Only then the lateral tendencies, which decide a hip rather
  // than a depth — and putting them above `preferUnderneath` let an outside lean quietly cancel
  // "they live underneath", which is a stronger signal about a whole half of football.
  if (adjust?.deepBias > SHAPE_LEAN) return 'over'
  if (preferUnderneath) return 'under'
  if (adjust) {
    if (adjust.crossingBias > SHAPE_LEAN) return 'in'    // take away the inside they keep running to
    if (adjust.outsideBias > SHAPE_LEAN) return 'out'
  }
  if (forced === 'in' || forced === 'out') return forced

  // ⚠️ I FLIPPED THIS AND IT MADE THE DEFENSE WORSE. The argument was sound football — the deep
  // help is a safety in the MIDDLE, so a corner on a receiver split wide should own the outside —
  // and it did fix the reported problem, comebacks against a star split wide. Measured over ~1,600
  // plays it also cost 0.30 yards a play and nine touchdowns, because taking the outside away
  // opens everything working back in, and there is far more of that.
  //
  // So the default stands: funnel a wide receiver toward the sideline and the help, and take the
  // outside away from somebody tight who already has help inside him. What handles the comeback is
  // the HALF-TIME read above — `outsideBias` shades out once an opponent has actually shown they
  // throw outs. Evidence about this opponent, rather than a blanket rule about every opponent.
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
// Greedy nearest-receiver pairing for the underneath zones, in the same spirit as `pairMan`: the
// defender closest to a receiver claims him, and nobody is claimed twice. Deep zones and anyone
// not in a zone are skipped, and a back still in the backfield is not a body to line up on.
export function pairUnderneathZones(rows, receivers, losY, ballX) {
  const out = new Map()
  const free = (receivers ?? []).filter(r => splitOut(r, losY))
  if (!free.length) return out

  const claimed = new Set()
  const eligible = rows.filter(d => d.job === 'zone' && UNDERNEATH_ZONES.has(d.zone ?? ''))

  // Closest pairing first, so the defender with the clearest claim gets it rather than whoever
  // happens to come first in the formation.
  const candidates = []
  for (const d of eligible) {
    for (const r of free) {
      const sameSide = d.dx < 0 ? r.x < ballX : r.x >= ballX
      if (!sameSide) continue
      candidates.push({ d, r, dist: Math.abs(r.x - d.x) })
    }
  }
  candidates.sort((a, b) => a.dist - b.dist)

  for (const c of candidates) {
    if (out.has(c.d.slot) || claimed.has(c.r.id)) continue
    if (c.dist > MAX_ZONE_ALIGN) continue     // too far to be his man; he holds his landmark
    out.set(c.d.slot, c.r)
    claimed.add(c.r.id)
  }
  return out
}

// ⚠️ ZONE DEFENDERS KEEP THEIR ORDER. Two zones that swap sides have both abandoned the area they
// were drawn to hold and are running past each other to do it. Unless the formation was AUTHORED
// that way — which is the author's business, and is why the order preserved is the DRAWN one
// rather than any canonical left-to-right — the order after adjustment matches the order before.
// Every row's y, brought inside the field. Applied last, so no adjustment above can push a
// defender back out.
export function clampRowsToField(rows) {
  for (const r of rows) {
    r.x = clampFieldX(r.x)
    const y = clampFieldY(r.y)
    if (y !== r.y) {
      r.y = y
      // Depth is read downstream (press checks, deep-help tests), so it has to agree with where he
      // actually is rather than where the shell drew him.
      if (r.losY != null) r.depth = y - r.losY
    }
    if (r.zoneCenter) r.zoneCenter = { ...r.zoneCenter }
  }
  return rows
}

// ⚠️ IN MAN, EVERYBODY IS SOMEBODY'S. A Cover 1 is drawn with five man defenders because five
// eligible receivers is the common case; come out in four wides with a tight end and a back and
// there are SIX, and the sixth ran free. Measured against the real playbook: with 4WR+TE+RB,
// 27 of 30 man shells left exactly one man uncovered, every time, and in man there is nobody
// behind him — an uncovered receiver in Cover 1 is a touchdown, not a completion.
//
// So a man shell finds a body for anyone left over, in order of what it costs to take him:
//
//   1. THE SPY. He is already assigned to nobody in particular; this is what he is for.
//   2. AN UNDERNEATH ZONE. Giving up a short zone to cover a man is the trade Cover 1 already
//      makes everywhere else on the field.
//   3. A SURPLUS RUSHER, and only above a four-man rush. Dropping the fourth rusher would leave
//      the quarterback untouched, which loses the play a different way.
//
// A DEEP zone is never taken: that defender is the "1" in Cover 1, and using him is how the whole
// call becomes Cover 0 by accident.
//
// Only for shells that are ALREADY man. A Cover 3 has uncovered receivers by design — that is what
// a zone is — and pulling its defenders onto men would quietly rewrite the call.
const BASE_RUSH = 4

export function accountForEveryone(rows, receivers, losY) {
  const manCount = rows.filter(r => r.job === 'man').length
  const zoneCount = rows.filter(r => r.job === 'zone').length
  if (!manCount || manCount <= zoneCount) return rows      // not a man call

  const covered = new Set(rows.filter(r => r.job === 'man' && r.covers).map(r => r.covers))
  const loose = (receivers ?? []).filter(r => !covered.has(r.id))
  if (!loose.length) return rows

  const rushers = rows.filter(r => r.job === 'rush').length
  let spare = rushers - BASE_RUSH

  for (const receiver of loose) {
    // Nearest available body of each kind, best kind first.
    const pick = (test) => rows
      .filter(r => r.label !== 'DL' && test(r))
      .sort((a, b) => Math.hypot(a.x - receiver.x, a.y - receiver.y) - Math.hypot(b.x - receiver.x, b.y - receiver.y))[0]

    // ⚠️ THE LAST DEEP DEFENDER IS NEVER TAKEN. He is the "1" in Cover 1, and using him turns the
    // call into Cover 0 by accident — every man now with nobody behind him. A SECOND deep defender
    // is fair game: dropping from two-deep to one-deep to cover a loose receiver is a trade a real
    // defense makes, and it beats leaving somebody running free with no help anywhere.
    const deepLeft = rows.filter(r => r.job === 'zone' && r.zone === 'deep').length
    const taken =
      pick(r => r.job === 'spy') ??
      pick(r => r.job === 'zone' && r.zone !== 'deep') ??
      (spare > 0 ? pick(r => r.job === 'rush') : null) ??
      (deepLeft > 1 ? pick(r => r.job === 'zone' && r.zone === 'deep') : null)

    if (!taken) break          // nothing left that can be spared; better one free than no rush
    if (taken.job === 'rush') spare--
    taken.job = 'man'
    taken.covers = receiver.id
    taken.zone = null
    taken.zoneCenter = null
  }
  return rows
}

// Separates two defenders standing on top of each other.
//
// ⚠️ BY CREEPING LESS, NEVER BY BACKING UP. The authored depth is a CEILING everywhere else in
// this file — "a corner drawn at 5 bailing to 12 is playing a different call entirely" — and the
// first version of this pass pushed the overlapping man straight back off the line, which broke
// exactly that rule and was caught by the test protecting it.
//
// The cure belongs where the cause is. The overlap comes from a rusher walking up to four yards
// toward the line without checking what is already standing there, so he walks up LESS: back
// toward the depth he was drawn at and no further. Only if he is still inside somebody at his own
// drawn spot does he give ground sideways, and then by the smallest amount that clears.
export function enforceSpacing(rows, losY) {
  const toward = losY <= 0 ? 1 : 1   // depth is always measured away from the line
  // Nearest the line first, so a creeping defender resolves against what is already settled.
  const order = [...rows].sort((a, b) => Math.abs(a.depth ?? 0) - Math.abs(b.depth ?? 0))

  for (let i = 0; i < order.length; i++) {
    const a = order[i]
    if (a.label === 'DL') continue            // the front holds its drawn spot
    // ⚠️ AND A MAN DEFENDER IS NOT MOVED EITHER. His spot is decided by the receiver he is
    // covering and is already bounded by MAX_MAN_TRAVEL; nudging him aside to make room breaks
    // that bound and puts him off his man, which costs more than the overlap does. The overlap
    // this pass exists for is a walked-down RUSHER standing inside a lineman.
    if (a.job === 'man') continue
    const ceiling = a.baseDepth ?? a.depth    // as deep as he is allowed to be

    for (let j = 0; j < i; j++) {
      const b = order[j]
      const dx = a.x - b.x
      if (Math.hypot(dx, a.y - b.y) >= MIN_DEFENDER_GAP) continue

      // Give back creep first: how deep would clear him, capped at where he was drawn.
      const needDy = Math.sqrt(Math.max(0, MIN_DEFENDER_GAP ** 2 - dx * dx))
      const wantDepth = (b.y - losY) + needDy * toward
      const depth = Math.min(ceiling, wantDepth)
      a.depth = depth
      a.y = clampFieldY(losY + depth)

      // Still inside him at his own drawn depth? Then, and only then, step aside.
      if (Math.hypot(a.x - b.x, a.y - b.y) < MIN_DEFENDER_GAP) {
        const push = MIN_DEFENDER_GAP - Math.abs(a.x - b.x)
        a.x = clampFieldX(a.x + (a.x >= b.x ? push : -push))
      }
      a.pressing = a.depth < ceiling
    }
  }
  return rows
}

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

// ⚠️ THE DEEP ZONES SHIFT AS ONE BODY, THEY DO NOT EACH DRIFT.
//
// Letting every deep defender slide toward the receivers on his own side is what closes the gaps
// between them: in Cover 4 with two receivers left, the boundary quarter slid right and the left
// inside quarter slid left, and the pair ended seven yards apart with fourteen between the others.
// Two men covering one patch of grass is exactly the "multiple people basically guarding the same
// area" that was reported, and it is a compression, not a rotation.
//
// A real secondary rotates as a unit. So one shift is computed for the whole structure — the
// average of what each deep defender wanted — and everybody moves by it. The shape the shell was
// drawn with is preserved exactly; only where it sits on the field changes.
function deepStructureSlide(rows, receivers, losY, ballX) {
  const deeps = rows.filter(d => d.job === 'zone' && d.zone === 'deep' && d.zoneCenter)
  if (!deeps.length) return 0
  const split = (receivers ?? []).filter(r => splitOut(r, losY))
  if (!split.length) return 0

  let total = 0
  let n = 0
  for (const d of deeps) {
    const side = split.filter(r => (d.dx < 0 ? r.x < ballX : r.x >= ballX))
    if (!side.length) continue
    const mean = side.reduce((a, r) => a + r.x, 0) / side.length
    total += mean - (FIELD_CENTER_X + d.zoneCenter.dx)
    n++
  }
  if (!n) return 0
  return clamp(total / n, -MAX_DEEP_SLIDE, MAX_DEEP_SLIDE)
}

// ── The adjustment ──────────────────────────────────────────────────────────
export function alignAuthored({ formation, shell, receivers, ballX, losY, ready = true, adjust = null }) {
  const spots = formation?.spots ?? []
  const assignments = shell?.assignments ?? {}

  const base = spots.map(s => ({
    slot: s.slot,
    label: slotLabel(s.slot),
    // ⚠️ AN UNASSIGNED DEFENDER COVERS SOMEBODY — he does not rush. A slot the shell forgot used to
    // fall through to 'rush', which is the worst possible default: a free runner the offense never
    // accounted for, and a receiver nobody is on. Covering is the safe failure. Linemen are the
    // exception, because rushing IS their assignment and a shell does not state it.
    job: assignments[s.slot]?.job ?? (slotLabel(s.slot) === 'DL' ? 'rush' : 'man'),
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
  const zonePairs = pairUnderneathZones(base, receivers, losY, ballX)
  const deepSlide = deepStructureSlide(base, receivers, losY, ballX)

  const out = base.map(d => {
    if (d.job === 'man') {
      const target = pairs.get(d.slot)
      if (!target) return d
      const shade = decideShade(d, target,
        { hasDeepHelp, ballX, forced, preferUnderneath: !!adjust?.preferUnderneath, adjust })
      const x = clamp(target.x + shadeLean(shade, target, ballX),
        d.x - MAX_MAN_TRAVEL, d.x + MAX_MAN_TRAVEL)

      // ⚠️ FORWARD ONLY. The authored depth is a CEILING: a defender may creep up to press and may
      // never drop off deeper than he was drawn. Backing up would let alignment quietly rewrite
      // the coverage — a corner drawn at 5 bailing to 12 is playing a different call entirely.
      //
      // Corners are the ones who press. A linebacker on a back is already near the line, and
      // walking him onto it just vacates the middle he is standing in.
      // [halftime shapes] ALIGNMENT, not only leverage. A half of quick game says get hands on him
      // at the line; a half of shots says give yourself room. Both move the cushion rather than
      // the call, and both respect the ceiling: a corner may come up but never drop off deeper
      // than he was drawn, which is the rule everything else in this file obeys.
      const quick = adjust?.quickBias ?? 0
      const deep = adjust?.deepBias ?? 0
      const mayPress = d.label === 'CB' && (blitzing || shade === 'under' || quick > SHAPE_LEAN)
      let depth = mayPress ? Math.min(d.depth, PRESS_DEPTH) : d.depth
      if (d.label === 'CB' && deep > SHAPE_LEAN) {
        // Back off toward the depth he was drawn at — never past it.
        depth = Math.min(d.depth, depth + deep * CUSHION_SWING)
      }

      // ⚠️ YOU CANNOT COVER A MAN FROM TWELVE YARDS AWAY. Man coverage means travelling with him,
      // and a defender drawn deep in a shell is drawn for a ZONE responsibility — when the shell
      // hands him a man instead, that depth stops making sense. A safety standing twelve yards off
      // the tight end he is supposedly covering is the case that showed it.
      //
      // The exception is a safety on a RECEIVER with NOBODY BEHIND HIM: that is him playing over the
      // top of a vertical threat as the last line, which is a real assignment and needs the
      // cushion. On a tight end or a back there is nothing to get over the top of — he is just late.
      //
      // ⚠️ AND IT DOES NOT APPLY WHEN THERE IS A DEEP SAFETY BEHIND HIM. The cushion is bought with
      // the field at his back; with single-high help already there he is buying nothing and simply
      // standing thirteen yards off the man he is supposed to be covering — reported from a real
      // game as a defender "15 yards off" an outside receiver who was open before the snap. A
      // safety manned up underneath a single-high safety is ordinary Cover 1, and he plays it tight.
      const overTheTop = d.label === 'S' && target.label !== 'TE' && target.label !== 'RB' && !hasDeepHelp
      const capped = overTheTop ? depth : Math.min(depth, MAN_MAX_DEPTH)
      // ⚠️ THE CAP IS NOT A PRESS. `pressing` means he walked up to jam, and the renderer and the
      // engine both read it that way; a defender merely brought to a sane man-coverage depth has
      // not decided anything. Conflating them had every man defender showing press on every snap.
      const pressed = mayPress && capped < d.depth
      depth = capped
      return { ...d, x, y: losY + depth, depth, shade, pressing: pressed, covers: target.id }
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
      // ⚠️ NOBODY ON HIS SIDE STILL MEANS HIS QUARTER NEEDS COVERING. Returning the drawn row
      // untouched left a deep zone on the ball-relative spot, so the boundary quarter stayed
      // bunched exactly when there was nothing over there to justify it.
      if (!side.length) {
        if (d.zone !== 'deep' || !d.zoneCenter) return d
        // He still moves with the structure — a quarter with nobody in it is still his quarter.
        const shift = (FIELD_CENTER_X - ballX) + deepSlide
        return {
          ...d,
          x: d.x + shift,
          zoneCenterX: FIELD_CENTER_X + d.zoneCenter.dx + deepSlide,
          zoneCenter: { dx: d.zoneCenter.dx + deepSlide, depth: d.zoneCenter.depth },
        }
      }

      // ⚠️ AN UNDERNEATH ZONE LINES UP ON A MAN, NOT ON THE AVERAGE OF SEVERAL. Sliding to the
      // MEAN of the receivers on his side parks a flat defender between two of them, covering the
      // grass in between and neither of the people in it. Against trips it was worse: the mean sat
      // well inside the widest receiver, who was then uncovered at the snap.
      //
      // Each underneath zone takes the nearest receiver nobody nearer has already claimed, which
      // is the same greedy pairing man coverage uses. It is still ZONE — he plays his landmark and
      // his area once the ball is snapped, and `enforceNoCrossing` below still guarantees two
      // zones never run past each other to get there. This only decides where he STARTS.
      //
      // Deep zones are deliberately excluded: a defender responsible for a third does not align on
      // a man, and shadowing one is how the third behind him comes open.
      const paired = zonePairs.get(d.slot)
      const targetX = paired ? paired.x : side.reduce((a, r) => a + r.x, 0) / side.length
      const reach = paired ? MAX_ZONE_ALIGN : (d.zone === 'deep' ? MAX_DEEP_SLIDE : MAX_ZONE_SLIDE)

      // Where this zone actually belongs before any shading. A deep zone belongs at its share of
      // the FIELD (see FIELD_CENTER_X above); everything else belongs where the shell drew it
      // relative to the ball.
      const deepZone = d.zone === 'deep' && d.zoneCenter != null
      // ⚠️ THE BODY MOVES WITH THE LANDMARK, IT DOES NOT MOVE ONTO IT. A shell draws a safety's
      // body INSIDE the zone he owns on purpose — he aligns there and widens at the snap. Parking
      // him on top of his landmark throws that away and is a different call. So re-anchoring a
      // deep zone to the field shifts the pair together and their relationship is preserved.
      const fieldShift = deepZone ? FIELD_CENTER_X - ballX : 0
      const anchorX = deepZone ? FIELD_CENTER_X + d.zoneCenter.dx : d.x
      // A deep zone takes the structure's shared shift; everyone else answers his own side.
      const slide = deepZone ? deepSlide : clamp(targetX - anchorX, -reach, reach)

      // A corner in a shallow zone may also come forward onto the receiver aligned in it.
      const nearest = side.reduce((a, r) => (Math.abs(r.x - d.x) < Math.abs(a.x - d.x) ? r : a), side[0])
      const mayPress = d.label === 'CB' && d.zone === 'flat' && Math.abs(nearest.x - d.x) < 8
      const depth = mayPress ? Math.min(d.depth, PRESS_DEPTH + 2) : d.depth

      return {
        ...d,
        x: d.x + fieldShift + slide,
        y: losY + depth,
        depth,
        pressing: depth < d.depth,
        zoneCenter: d.zoneCenter ? { dx: d.zoneCenter.dx + slide, depth: d.zoneCenter.depth } : null,
        // The landmark in absolute yards, resolved here because this is where ballX is known.
        // Downstream (coverageFor) has the row and nothing else; leaving it to resolve `dx` itself
        // is what led to it giving up and using the defender's own position instead.
        zoneCenterX: d.zoneCenter ? (deepZone ? anchorX : ballX + d.zoneCenter.dx) + slide : null,
      }
    }

    return d
  })

  // Order matters here. Crossing first (it moves people sideways), then spacing (which moves them
  // backward off whatever they landed on), then the field bounds last — nothing after that may
  // move anyone, or a defender goes back out of bounds.
  for (const r of out) { r.losY = losY; r.baseDepth = r.depth }
  // Accounting first: it changes JOBS, and everything after it is about where bodies stand.
  return clampRowsToField(enforceSpacing(enforceNoCrossing(accountForEveryone(out, receivers, losY)), losY))
}
