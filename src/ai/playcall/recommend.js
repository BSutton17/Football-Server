// ── Handing the AI's read to the player ([authored]) ────────────────────────
//
// The selector already answers "what should be called here" — it samples from a solved table where
// one exists and from a situational prior where one does not. This asks the same question and
// returns the TOP few instead of drawing one, so the human gets the coordinator's shortlist rather
// than the coordinator's decision.
//
// ⚠️ RANKED, NOT SAMPLED, AND THAT DIFFERENCE IS THE POINT. The AI mixes because anything it always
// calls is a thing the opponent can sit on. A human picking from a menu is not predictable in that
// way — they are the one deciding — so showing them the third-most-likely play because a die said
// so would just be worse advice. The mixing stays where it belongs: in what the AI itself calls.
//
// ⚠️ IT NEVER LOOKS AT THE OPPONENT'S CALL. The offensive shortlist is built from down, distance
// and field position; the defensive one adds the formation and personnel it can see on the field.
// That is exactly the information each side is allowed, and it is the same information the AI runs
// on — so this cannot leak anything a player could not already read for themselves.

import { situationKey, distanceBand, fieldZone } from './situation.js'
import { playDepth } from './select.js'
import { shellFit } from './tendencies.js'
import { layoutAuthored, routeFor } from '../playbook/authored.js'
import { alignAuthored, clampFieldY } from '../playbook/alignAuthored.js'

// At or above this many rushers a shell is a blitz rather than a coverage that happens to send
// somebody. Four is the ordinary front.
//
// ⚠️ NOT "a non-lineman is rushing". In a 3-4 the fourth rusher IS a linebacker, and defining a
// blitz that way flagged twenty ordinary coverages as pressure.
const BLITZ_RUSHERS = 5

const countJobs = (shell) => {
  const out = { rush: 0, man: 0, zone: 0 }
  for (const a of Object.values(shell?.assignments ?? {})) {
    if (a?.job && out[a.job] !== undefined) out[a.job]++
  }
  return out
}

// Which of the three buckets a shell belongs in. Blitz wins over both: a five-man pressure out of
// man coverage is a blitz first, and offering it as the "man" option would waste one of three slots
// on something the player is already being shown.
export function classifyShell(shell) {
  const jobs = countJobs(shell)
  if (jobs.rush >= BLITZ_RUSHERS) return 'blitz'
  return jobs.man > jobs.zone ? 'man' : 'zone'
}

const normalize = (w) => {
  const total = w.reduce((a, b) => a + b, 0)
  return total > 0 ? w.map(x => x / total) : w.map(() => 1 / w.length)
}

// ⚠️ THE SHORTLIST IS SAMPLED, NOT RANKED, AND THAT IS A REVERSAL. Taking the strict top three
// made the panel show the SAME three plays and the SAME three shells on every snap of every game,
// because the scoring is deterministic — open it on 1st and 10 in the first quarter and in the
// fourth and it was identical. A menu that never changes is a menu you stop opening, and it also
// quietly retires most of an authored playbook.
//
// Weighted by score, so a good option is still far likelier than a poor one; it is the tie-break
// among comparable options that varies. The AI's own call is unaffected — it samples through
// `select.js` and always did.
// ⚠️ VARIETY NEVER REACHES AN OPTION THAT DOES NOT BELONG. Sampling straight across the scores
// put a thirty-yard route back on the 4th-and-goal-from-the-2 menu: its weight was tiny, but tiny
// is not zero and three draws found it. Anything scoring below a fraction of the best is out of
// the pool entirely, so the shortlist varies among plays that are all actually callable here.
// Tuned against the real playbook: low enough that several comparable plays qualify on an ordinary
// down, high enough that a route which cannot physically be run here scores orders of magnitude
// below it and never enters the pool.
const VARIETY_FLOOR = 0.08

function sampleWeighted(items, weights, count, rng) {
  const best = Math.max(...weights, 0)
  const cutoff = best * VARIETY_FLOOR
  const eligible = items
    .map((item, i) => ({ item, w: weights[i] ?? 0 }))
    .filter(p => p.w >= cutoff)
  // Never hand back an empty menu because the floor was too aggressive for this playbook.
  const pool = (eligible.length ? eligible : items.map((item, i) => ({ item, w: weights[i] ?? 0 })))
    .map(p => ({ item: p.item, w: Math.max(p.w, 1e-9) }))
  const out = []
  while (out.length < count && pool.length) {
    const total = pool.reduce((a, p) => a + p.w, 0)
    let r = rng() * total
    let idx = pool.length - 1
    for (let i = 0; i < pool.length; i++) {
      r -= pool[i].w
      if (r <= 0) { idx = i; break }
    }
    out.push(pool[idx].item)
    pool.splice(idx, 1)      // without replacement: three slots, three different answers
  }
  return out
}

// ── Offense ─────────────────────────────────────────────────────────────────
//
// Pass plays only, from ANY formation — which is what makes this worth opening. The player is not
// being asked to pick a formation first and then live with what is behind it; the shortlist is
// drawn across the whole playbook and brings its formation with it.
export function recommendOffense(book, situation, { solved = null, count = 3, rng = Math.random } = {}) {
  const all = Object.entries(book?.plays ?? {}).map(([id, p]) => ({ ...p, id }))
  const plays = all.filter(p => p.playType !== 'run')
  if (!plays.length) return []

  const table = solved?.[situationKey(situation)]
  // Where the bucket is solved, the solved distribution ranks them — it is measured outcomes and
  // it already knows a route that runs out of the end zone is worthless.
  //
  // ⚠️ THE PRIOR CANNOT RANK, ONLY SAMPLE. `priorWeights` scores every non-deep pass at exactly 1.0
  // and leans only on deep-vs-short, which is fine when a die breaks the ties and useless when
  // three names have to be put on screen: the shortlist came out IDENTICAL on 1st and 10 from the
  // 25 and on 4th and goal from the 2, right down to recommending a thirteen-yard double post into
  // a two-yard end zone. Ranking needs a score that actually varies with the situation.
  const scores = table && plays.some(p => table[p.id] > 0)
    ? normalize(plays.map(p => table[p.id] ?? 0))
    : normalize(plays.map(p => situationalFit(p, situation)))

  const ranked = plays
    .map((p, i) => ({ play: p, score: scores[i] }))
    .sort((a, b) => b.score - a.score)

  // ⚠️ ONE PER FORMATION, so three recommendations are three real choices. Three plays out of the
  // same formation look like a choice and are not — same personnel, same picture for the defense,
  // only the routes differ.
  //
  // The formation is sampled by its BEST play's score, then that play comes with it.
  const best = new Map()
  for (const r of ranked) {
    if (!best.has(r.play.formationId)) best.set(r.play.formationId, r)
  }
  const formations = [...best.values()]
  const chosen = sampleWeighted(formations, formations.map(r => r.score), count, rng)
  const out = chosen.map(r => describeOffense(r, book, situation))

  // ⚠️ A SHORT MENU BEATS A PADDED ONE. This used to top the list up to three from the full
  // ranking, which walked straight past the quality floor — a twenty-yard route reappeared on the
  // 4th-and-goal-from-the-2 menu purely to make the count. Two callable plays are a better answer
  // than three where one cannot be run, so the list is simply as long as it deserves to be.
  return out
}

// ── How well a play fits the down, the distance and the room left ───────────
//
// What the prior is reaching for but cannot express at this resolution.
function situationalFit(play, { distance = 10, yardLine = 50 } = {}) {
  const depth = playDepth(play)
  const toGoal = 100 - yardLine

  // ⚠️ ROUTES CANNOT BE RUN THROUGH THE BACK OF THE END ZONE. On the 2-yard line a twelve-yard dig
  // is not a low-percentage call, it is not a call at all — the receiver runs out of field. This is
  // a hard collapse rather than a nudge, because no amount of being otherwise-good rescues it.
  //
  // ⚠️ AND WHEN THEY ALL RUN OUT OF FIELD, RANK THE LEAST BAD. A flat floor ties every play on the
  // 2-yard line, and a tie falls back to playbook order — which is how a thirteen-yard double post
  // stayed top of the goal-line menu. Decaying with the overrun keeps "these are all too deep"
  // while still putting the shallowest concept first, which is the honest advice.
  if (depth > toGoal + 2) return 1e-4 / (1 + depth - toGoal)

  // The ball has to get to the sticks. Short of them it needs yards after the catch, well past them
  // it is holding the ball longer than the down requires — so the peak sits just beyond the marker,
  // and shallow is punished harder than deep because a throw short of the sticks on 4th down is
  // simply a turnover.
  const want = Math.min(distance + 1, toGoal)
  const miss = depth - want
  const penalty = miss < 0 ? (miss / 3.5) ** 2 : (miss / 6) ** 2
  return Math.max(Math.exp(-penalty), 1e-3)
}

function describeOffense({ play, score }, book, situation) {
  const formation = book.formations?.[play.formationId]
  const depth = playDepth(play)
  return {
    id: play.id,
    name: play.name,
    formationId: play.formationId,
    formationName: formation?.name ?? play.formationId,
    playType: play.playType,
    depth: Math.round(depth * 10) / 10,
    score,
    why: whyOffense(depth, situation),
  }
}

// One short line the player can act on. Plain football, not a probability — the number behind it is
// already the ranking, and restating it as "0.07" would read as precision this does not have.
function whyOffense(depth, { distance = 10, yardLine = 50 } = {}) {
  const toGoal = 100 - yardLine
  if (toGoal <= 5) return 'Quick throw — no room behind the defense'
  if (depth >= distance + 2) return 'Gets past the sticks on its own'
  if (depth >= 12) return 'Shot play — takes time to develop'
  if (depth <= 4) return 'Ball out fast, yards after the catch'
  return 'Works the sticks'
}

// ── Defense ─────────────────────────────────────────────────────────────────
//
// ⚠️ ALWAYS ONE ZONE, ONE MAN AND ONE BLITZ. Ranking the whole shell list and taking the top three
// collapses onto whatever the situation favours — three zones on 3rd and 12 — which is both a
// worse menu and a readable one. Filling one slot per bucket guarantees the player is always being
// offered a genuine change of answer rather than three shades of the same one.
export function recommendDefense(book, situation, look,
  { solved = null, adjust = null, rng = Math.random } = {}) {
  const shells = Object.entries(book?.shells ?? {}).map(([id, s]) => ({ ...s, id }))
  if (!shells.length) return []

  const key = `${situationKey(situation)}|${look?.id ?? 'unknown'}`
  const table = solved?.[key]
  const fit = adjust ? shells.map(s => shellFit(s, adjust)) : shells.map(() => 1)

  const scored = shells.map((s, i) => ({
    shell: s,
    kind: classifyShell(s),
    score: (table?.[s.id] ?? personnelFit(s, look) * situationalShellFit(s, situation)) * fit[i],
  }))

  // ⚠️ ALWAYS ONE ZONE, ONE MAN AND ONE BLITZ — and, where the playbook allows it, three
  // different PACKAGES. Three calls out of the same defensive formation show the offense the same
  // eleven bodies in the same places, which is the thing a shortlist is supposed to avoid.
  const out = []
  const usedFormations = new Set()
  for (const kind of ['zone', 'man', 'blitz']) {
    const ofKind = scored.filter(s => s.kind === kind)
    if (!ofKind.length) continue
    const fresh = ofKind.filter(s => !usedFormations.has(s.shell.formationId))
    const pool = fresh.length ? fresh : ofKind
    const [pick] = sampleWeighted(pool, pool.map(s => s.score), 1, rng)
    usedFormations.add(pick.shell.formationId)
    out.push(describeDefense(pick, book, look))
  }
  return out
}

// ⚠️ WITHOUT THIS THE DEFENSIVE SHORTLIST IGNORED THE SITUATION ENTIRELY. `personnelFit` reads
// only the receiver count, so until a bucket is solved the same three shells came back on 3rd and
// 1 as on 3rd and 18 — the down and the distance changed nothing at all.
function situationalShellFit(shell, situation) {
  const band = distanceBand(situation?.distance ?? 10).id
  const zone = fieldZone(situation?.yardLine ?? 50).id
  const jobs = countJobs(shell)
  const kind = classifyShell(shell)

  // How deep this shell is actually playing, which is what distance argues about.
  let deep = 0
  for (const a of Object.values(shell?.assignments ?? {})) {
    if (a?.job === 'zone' && (a.zone === 'deep' || (a.center?.depth ?? 0) >= 12)) deep++
  }

  let w = 1
  if (band === 'short') {
    w *= 1 + 0.30 * Math.max(jobs.rush - 4, 0)    // crowd the line
    w *= deep >= 3 ? 0.55 : 1                     // three deep on 3rd and 1 is a giveaway
    if (kind === 'blitz') w *= 1.35
  } else if (band === 'verylong') {
    w *= deep >= 2 ? 1.45 : 0.75                  // keep it in front of the sticks
    if (kind === 'blitz') w *= 0.8
  } else if (band === 'long') {
    w *= deep >= 2 ? 1.15 : 0.95
  }

  // The deep ball stops existing near the goal line, so depth stops being worth paying for.
  if (zone === 'goalline' || zone === 'redzone') w *= deep >= 3 ? 0.6 : 1.15

  return Math.max(w, 0.05)
}

// The same shape-matching the selector's prior uses: answering four receivers with a base defense
// is not an interesting gamble, it is simply wrong.
function personnelFit(shell, look) {
  const wr = look?.wr ?? 3
  const backs = shell.personnel ? (shell.personnel.CB ?? 0) + (shell.personnel.S ?? 0) : 4
  const want = wr >= 4 ? 6 : wr === 3 ? 5 : 4
  return 1 / (1 + Math.abs(backs - want))
}

function describeDefense({ shell, kind, score }, book, look) {
  const formation = book.defFormations?.[shell.formationId]
  const jobs = countJobs(shell)
  return {
    id: shell.id,
    name: shell.name,
    kind,
    formationId: shell.formationId,
    formationName: formation?.name ?? shell.formationId,
    rushers: jobs.rush,
    score,
    why: whyDefense(kind, jobs, look),
  }
}

function whyDefense(kind, jobs, look) {
  if (kind === 'blitz') return `${jobs.rush}-man pressure — get there before the throw`
  if (kind === 'man') return (look?.wr ?? 3) >= 4 ? 'Match every receiver' : 'Lock the routes, help over the top'
  return 'Keep it in front, make the catch contested'
}

export { BLITZ_RUSHERS }


// ── Putting a chosen play on the field ──────────────────────────────────────
//
// ⚠️ THE SERVER HAS NO ROSTER. Player data lives on the client (see ai/roster.js), so this returns
// the SHAPE of the play — a spot and a route per slot, in field coordinates — and the client fills
// each slot from its own bench. That split is also what makes substitution work without any new
// protocol: the client already knows who its best available receiver is.
export function layoutPlayForClient(book, playId, { losY, ballX, mirror = false }) {
  const play = book?.plays?.[playId]
  const formation = book?.formations?.[play?.formationId]
  if (!play || !formation) return null

  const spots = layoutAuthored(formation, { losY, ballX, mirror })
  return {
    id: playId,
    name: play.name,
    playType: play.playType,
    formationId: play.formationId,
    formationName: formation.name,
    spots: spots.map(sp => ({
      slot: sp.slot,
      label: sp.label,
      x: sp.x,
      y: sp.y,
      // A blocker carries NO route rather than an empty one: the engine reads "has a drawn route"
      // as "is running it", so an empty array would send him nowhere at full speed.
      route: routeFor(play, sp.slot, { mirror }) ?? null,
      blocking: play.assignments?.[sp.slot]?.kind === 'block',
    })),
  }
}

// The same for a shell — and ⚠️ THROUGH `alignAuthored`, NOT OFF THE RAW SPOTS. The authored shell
// is where the eleven stand against nobody; the alignment layer is what puts a corner across from
// the receiver he is covering, decides his shade, presses or plays off, creeps a rusher toward the
// line and stops two zones crossing. Handing the player the raw shell would give them a shape that
// looks right and is aligned against an offense that is not on the field.
//
// This is the literal promise of the feature: the player gets the AI's defense, not a picture of it.
// How many linemen the CLIENT auto-places for a defense. It is a fixed four (`getDLPlayers` in
// Client/src/game/formation.ts) and it is not negotiable from here.
export const CLIENT_AUTO_DL = 4

export function layoutShellForClient(book, shellId,
  { losY, ballX, receivers = [], adjust = null, autoDL = CLIENT_AUTO_DL }) {
  const shell = book?.shells?.[shellId]
  const formation = book?.defFormations?.[shell?.formationId]
  if (!shell || !formation) return null

  const rows = alignAuthored({
    formation: { ...formation, id: shell.formationId },
    shell: { ...shell, id: shellId },
    receivers,
    ballX,
    losY,
    ready: true,
    adjust,
  })

  // ⚠️ THE CLIENT ALWAYS FIELDS FOUR LINEMEN, AND FIVE OF THE AUTHORED FORMATIONS ONLY HAVE
  // THREE. Those five are 3 DL plus EIGHT behind them — eleven on the server, where the front is
  // built to match the shell. The client's front is a fixed four, so loading one of them put four
  // linemen and eight defenders on the grass: TWELVE MEN. It showed up on nickel and the other
  // three-down fronts, which is precisely the five.
  //
  // The extra auto lineman is already rushing, so the defender who gives way is a RUSHER: the
  // fourth man in the front is simply somebody else now. Dropping a coverage player instead would
  // leave a hole in the shell and change what the call actually is.
  const back = rows.filter(r => r.label !== 'DL')
  const authoredFront = rows.length - back.length
  let surplus = Math.max(0, autoDL - authoredFront)

  // Who gives way, in order of how little the shell loses by it. The extra auto lineman is already
  // rushing, so a spare rusher costs nothing at all; a spy costs a little; a man defender with
  // NOBODY TO COVER costs nothing either, because six in man against five receivers always leaves
  // one over. Only past all of those does a real coverage player go, and then the deepest
  // duplicate — two men on the same deep third is the one place the shell can spare a body.
  const kept = [...back]
  const dropOne = (pick) => {
    const i = kept.findIndex(pick)
    if (i === -1) return false
    kept.splice(i, 1)
    surplus--
    return true
  }
  while (surplus > 0) {
    if (dropOne(r => r.job === 'rush')) continue
    if (dropOne(r => r.job === 'spy')) continue
    if (dropOne(r => r.job === 'man' && !r.covers)) continue
    // Deepest zone last, and only when there is more than one deep defender to begin with.
    const deep = kept.filter(r => r.job === 'zone').sort((a, b) => (b.zoneCenter?.depth ?? b.depth ?? 0) - (a.zoneCenter?.depth ?? a.depth ?? 0))
    if (deep.length > 1 && dropOne(r => r === deep[0])) continue
    break     // nothing left that can be spared without wrecking the call
  }

  return {
    id: shellId,
    name: shell.name,
    kind: classifyShell(shell),
    formationId: shell.formationId,
    formationName: formation.name ?? shell.formationId,
    // The linemen are auto-placed by both sides already (see the note in authored.js), so they are
    // dropped here rather than fought over.
    spots: kept.map(r => ({
      slot: r.slot,
      label: r.label,
      x: r.x,
      y: r.y,
      job: r.job,
      zone: r.zone ?? null,
      // ⚠️ A ZONE CENTRE IS ALWAYS A NUMBER. `assign_coverage` validates it as one, so a shell whose
      // zone was authored without a landmark sent null and had the WHOLE assignment refused —
      // which leaves that defender with no job, and the engine rushes anyone it has no job for. One
      // unlandmarked zone silently became a free rusher and an empty hook. The server path learned
      // this already; this path was written later and repeated it.
      //
      // Falling back to the defender's own spot is what the engine would compute anyway: a zone
      // with no landmark is a zone centred on the man playing it.
      zoneCenterX: clampX(r.zoneCenter ? ballX + r.zoneCenter.dx : r.x),
      // Clamped for the same reason the server path is: a landmark past the back of the end zone
      // gets the whole assignment refused, and an unassigned defender rushes.
      zoneCenterY: clampFieldY(r.zoneCenter ? losY + r.zoneCenter.depth : r.y + (DEFAULT_ZONE_DEPTH[r.zone] ?? 4)),
      covers: r.covers ?? null,
      shade: r.shade ?? 'none',
    })),
  }
}

const FIELD_W = 53.33
// How far in front of the defender an unlandmarked zone sits, by kind — mirrors runAuthored.js.
const DEFAULT_ZONE_DEPTH = { flat: 2, curl: 5, hook: 4, deep: 8 }
const clampX = (x) => Math.max(0.5, Math.min(FIELD_W - 0.5, x))
