// ── A simulated game's box score ([season stats]) ──────────────────────────
//
// "The game should track individual stats over the course of the season", and awards go to the whole
// league, so all 272 games need a line for every player. A simulated game has no plays to count, so its
// box score is written from the result: how many points and touchdowns each team had (simGame.js decides
// those), who is on the field, and how good they are. So a team that scored 38 threw for more than one
// that scored 10, the touchdowns add up to the score, and the better player gets more of it.
//
// Calibrated by eye over whole seasons against typical NFL figures, per team per game: about 34 attempts
// at 65%, 225 passing yards, 27 carries at 4.5, 2.4 sacks and 0.8 interceptions. Over a season the
// leaders come out near 4,500 passing yards, 36 touchdown passes, 1,800 rushing yards, 1,700 receiving
// yards, 25 sacks, 9 interceptions and 185 tackles.
//
// ⚠️ THE SAME FIELD NAMES AS game/stats.js, so a played game and a simulated one add up together.
//
// ⚠️ NO RANDOMNESS OF ITS OWN TO KEEP. Everything comes from `rng`, and from `formOf`, which a season
// seeds from its own seed and the player's id, so a line can be written again identically after a crash.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

function gaussian(rng) {
  const u = Math.max(rng(), 1e-9)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

function poisson(lambda, rng) {
  if (lambda <= 0) return 0
  const limit = Math.exp(-lambda)
  let k = 0, p = 1
  do { k++; p *= rng() } while (p > limit)
  return k - 1
}

function pick(entries, total, rng) {
  let roll = rng() * total
  for (const e of entries) {
    roll -= e.w
    if (roll <= 0) return e.p
  }
  return entries[entries.length - 1].p
}

// Hand `count` of something out by weight, one at a time. Returns a Map of player → how many.
function share(count, entries, rng) {
  const out = new Map()
  const usable = entries.filter(e => e.p && e.w > 0)
  if (!usable.length) return out
  const total = usable.reduce((n, e) => n + e.w, 0)
  for (let i = 0; i < count; i++) {
    const p = pick(usable, total, rng)
    out.set(p, (out.get(p) ?? 0) + 1)
  }
  return out
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0)

// Who gets the ball, before talent and the day's luck. Receivers and the backfield by depth chart.
const TARGET_SHARE = { wr: [0.22, 0.16, 0.11, 0.06], te: [0.15, 0.05, 0.01], rb: [0.12, 0.05] }
const YARDS_PER_CATCH = { wr: 13.2, te: 10.6, rb: 7.2 }
const SCORING_SHARE = { wr: 1, te: 1.25, rb: 0.65 }
const TACKLE_SHARE = {
  lb: [0.15, 0.12, 0.06, 0.02], s: [0.11, 0.09, 0.03], cb: [0.08, 0.07, 0.04, 0.015], dl: [0.05, 0.05, 0.04, 0.04],
}
const INT_SHARE = { cb: [0.2, 0.13, 0.05, 0.02], s: [0.2, 0.14, 0.04], lb: [0.1, 0.07, 0.03, 0.01], dl: [0.01, 0.01, 0, 0] }
const PD_SHARE = { cb: [0.2, 0.17, 0.09, 0.03], s: [0.13, 0.09, 0.03], lb: [0.07, 0.05, 0.02, 0.01], dl: [0.015, 0.015, 0.01, 0.01] }
const TFL_SHARE = { dl: [0.15, 0.13, 0.1, 0.09], lb: [0.17, 0.12, 0.05, 0.02], s: [0.06, 0.04, 0.01], cb: [0.03, 0.02, 0.01, 0] }

const SIDE_LEAGUE = { ol: 79, dl: 80, cover: 77, recv: 79 }

function unitEntries(team, shares, power, formOf) {
  const out = []
  for (const [unit, weights] of Object.entries(shares)) {
    const players = team[unit]
    if (unit === 'dl') {
      // Ordered by how good a rusher he is, whatever slot on the line he plays.
      const sorted = [...players].sort((a, b) => b.ovr - a.ovr)
      weights.forEach((w, i) => { if (sorted[i]) out.push({ p: sorted[i], w: w * (sorted[i].ovr / 80) ** power * formOf(sorted[i].id) }) })
    } else {
      weights.forEach((w, i) => { if (players[i]) out.push({ p: players[i], w: w * (players[i].ovr / 80) ** power * formOf(players[i].id) }) })
    }
  }
  return out
}

function lineOf(lines, player) {
  let line = lines[player.id]
  if (!line) { line = { g: 1 }; lines[player.id] = line }
  return line
}

const bump = (lines, player, field, by = 1) => {
  if (!player || !by) return
  const line = lineOf(lines, player)
  line[field] = (line[field] ?? 0) + by
}

// One team's offense against the other's defense. Writes both into `lines`.
function playSide(off, def, { points, tds, oppPoints }, lines, formOf, rng) {
  const qb = off.qb
  const margin = points - oppPoints
  const skill = [...off.wr.slice(0, 3), off.te[0]].filter(Boolean)
  const recvQuality = mean(skill.map(p => p.ovr))
  const cover = mean([...def.cb.slice(0, 3), ...def.s.slice(0, 2)].map(p => p.ovr))
  const passRush = mean(def.dl.map(p => p.passRush ?? p.ovr))
  const passBlock = mean(off.ol.map(p => p.passBlock ?? p.ovr))
  const runBlock = mean(off.ol.map(p => p.runBlock ?? p.ovr))
  const front = mean([...def.dl, ...def.lb.slice(0, 2)].map(p => p.ovr))
  const qbForm = formOf(qb.id)

  // ── The shape of the game. Whoever is behind throws, whoever is ahead runs. ──
  const attempts = Math.round(clamp(33.5 - 0.22 * margin + gaussian(rng) * 4.5, 16, 58))
  const carries = Math.round(clamp(26.5 + 0.22 * margin + gaussian(rng) * 4, 12, 44))

  // ── Passing ──
  const accuracy = qb.accuracy ?? qb.ovr
  const completionRate = clamp(
    0.615 + (accuracy - 85) * 0.0035 + (recvQuality - SIDE_LEAGUE.recv) * 0.001 - (cover - SIDE_LEAGUE.cover) * 0.0018
      + (qbForm - 1) * 0.08 + gaussian(rng) * 0.05,
    0.42, 0.84,
  )
  const yardsPerAttempt = clamp(
    6.75 + (qb.ovr - 82) * 0.035 + (recvQuality - SIDE_LEAGUE.recv) * 0.025 - (cover - SIDE_LEAGUE.cover) * 0.022
      + (points - 23) * 0.06 + (qbForm - 1) * 4 + gaussian(rng) * 0.75,
    3.2, 12.5,
  )

  const sacks = poisson(2.3 * Math.exp((passRush - SIDE_LEAGUE.dl) * 0.03 - (passBlock - SIDE_LEAGUE.ol) * 0.03), rng)
  const intRate = clamp(0.023 * (1 - (qb.ovr - 82) * 0.018) * (1 + (cover - SIDE_LEAGUE.cover) * 0.015) / qbForm, 0.006, 0.05)
  const picks = poisson(attempts * intRate, rng)

  // Who he throws to. Talent draws targets, and every game somebody has a day.
  const targetEntries = []
  for (const unit of ['wr', 'te', 'rb']) {
    TARGET_SHARE[unit].forEach((w, i) => {
      const p = off[unit][i]
      if (!p) return
      const talent = (p.ovr / 80) ** 1.5 * formOf(p.id)
      targetEntries.push({ p, unit, w: w * talent * Math.exp(gaussian(rng) * 0.32) })
    })
  }
  const targets = share(attempts, targetEntries, rng)

  let completions = 0
  const receptions = new Map()
  for (const { p, unit } of targetEntries) {
    const looks = targets.get(p) ?? 0
    if (!looks) continue
    bump(lines, p, 'targets', looks)
    const hands = clamp(completionRate + ((p.catching ?? p.ovr) - 82) * 0.004 + (unit === 'rb' ? 0.1 : unit === 'te' ? 0.03 : -0.01), 0.3, 0.93)
    let caught = 0
    for (let i = 0; i < looks; i++) if (rng() < hands) caught++
    if (caught) receptions.set(p, { caught, unit })
    completions += caught
  }

  const passYards = Math.max(0, Math.round(attempts * yardsPerAttempt))
  const shares = []
  let raw = 0
  for (const [p, { caught, unit }] of receptions) {
    const perCatch = YARDS_PER_CATCH[unit] * (1 + ((p.speed ?? p.ovr) - 85) * 0.012) * Math.exp(gaussian(rng) * 0.28)
    const yards = caught * perCatch
    shares.push({ p, yards, unit, caught })
    raw += yards
  }
  // The receivers' yards are the passer's yards, exactly, as on any real box score.
  let handedOut = 0
  shares.sort((a, b) => b.yards - a.yards)
  shares.forEach((s, i) => {
    const yards = i === shares.length - 1 ? passYards - handedOut : Math.round(s.yards * passYards / (raw || 1))
    handedOut += yards
    bump(lines, s.p, 'receptions', s.caught)
    bump(lines, s.p, 'recYards', yards)
  })

  // ── Rushing ──
  const qbSpeed = qb.speed ?? 75
  // Only a truly fast quarterback is a runner: a fairly mobile one takes off a couple of times a game.
  const qbCarries = poisson(Math.min(8.5, 1.1 + Math.max(0, qbSpeed - 80) ** 1.5 * 0.16), rng)
  const backs = off.rb
  const lead = backs[0], change = backs[1]
  const receiverCarries = poisson(0.45, rng)
  const backCarries = Math.max(0, carries - qbCarries - receiverCarries)
  const gap = lead && change ? lead.ovr - change.ovr : 12
  const leadShare = clamp(0.62 + gap * 0.005 + (formOf(lead?.id ?? '') - 1) * 0.4, 0.45, 0.8)
  const leadCarries = change ? Math.round(backCarries * leadShare) : backCarries
  const changeCarries = backCarries - leadCarries

  const yardsPerCarry = clamp(
    4.15 + (runBlock - SIDE_LEAGUE.ol) * 0.028 - (front - SIDE_LEAGUE.dl) * 0.028 + (points - 23) * 0.02 + gaussian(rng) * 0.62,
    1.8, 8.2,
  )
  const runner = (p, count, bonus) => {
    if (!p || !count) return
    const vision = (p.vision ?? p.ovr) - 82
    const yards = Math.round(count * Math.max(1, (yardsPerCarry + vision * 0.022 + bonus) * formOf(p.id) + gaussian(rng) * 0.4))
    bump(lines, p, 'carries', count)
    bump(lines, p, 'rushYards', yards)
  }
  runner(lead, leadCarries, 0)
  runner(change, changeCarries, -0.15)
  runner(qb, qbCarries, 0.5 + Math.max(0, qbSpeed - 80) * 0.09)
  runner(off.wr[0], receiverCarries, 1.8)

  // ── Touchdowns: exactly as many as the score says ──
  const passShare = clamp(0.61 + (qb.ovr - (lead?.ovr ?? 80)) * 0.003, 0.52, 0.76)
  const passTds = completions ? share(tds, [{ p: 'pass', w: passShare }, { p: 'run', w: 1 - passShare }], rng).get('pass') ?? 0 : 0
  const rushTds = tds - passTds

  bump(lines, qb, 'attempts', attempts)
  bump(lines, qb, 'completions', completions)
  bump(lines, qb, 'passYards', passYards)
  bump(lines, qb, 'passTD', passTds)
  bump(lines, qb, 'interceptionsThrown', picks)
  bump(lines, qb, 'sacksTaken', sacks)

  if (passTds) {
    const scorers = share(passTds, shares.map(s => ({ p: s.p, w: (s.yards + s.caught * 8) * SCORING_SHARE[s.unit] })), rng)
    for (const [p, n] of scorers) bump(lines, p, 'recTD', n)
  }
  if (rushTds) {
    const inside = [
      { p: lead, w: 0.5 * Math.max(1, leadCarries) },
      { p: change, w: 0.6 * Math.max(0.5, changeCarries) },
      { p: qb, w: (0.5 + Math.max(0, qbSpeed - 78) * 0.13) * Math.max(0.5, qbCarries) },
      { p: off.wr[0], w: 0.05 },
    ]
    for (const [p, n] of share(rushTds, inside, rng)) bump(lines, p, 'rushTD', n)
  }

  // ── The other side of the ball ──
  const rushEntries = []
  const rushers = [...def.dl].sort((a, b) => (b.passRush ?? b.ovr) - (a.passRush ?? a.ovr))
  rushers.forEach((p, i) => {
    rushEntries.push({ p, w: [1, 0.85, 0.7, 0.55][i] * Math.exp(((p.passRush ?? p.ovr) - 82) / 30) * formOf(p.id) ** 1.5 })
  })
  def.lb.slice(0, 2).forEach(p => rushEntries.push({ p, w: 0.14 * (p.ovr / 80) ** 3 * formOf(p.id) }))
  if (def.s[0]) rushEntries.push({ p: def.s[0], w: 0.04 })
  if (def.cb[0]) rushEntries.push({ p: def.cb[0], w: 0.02 })
  for (const [p, n] of share(sacks, rushEntries, rng)) {
    bump(lines, p, 'sacks', n)
    bump(lines, p, 'tfl', n)       // a sack is a tackle for loss by definition, as in game/stats.js
  }

  const tackles = Math.round((carries + completions) * 1.08)
  for (const [p, n] of share(tackles, unitEntries(def, TACKLE_SHARE, 1, formOf), rng)) bump(lines, p, 'tackles', n)
  for (const [p, n] of share(poisson(2.5, rng), unitEntries(def, TFL_SHARE, 2, formOf), rng)) bump(lines, p, 'tfl', n)
  for (const [p, n] of share(picks, unitEntries(def, INT_SHARE, 4, formOf), rng)) bump(lines, p, 'interceptions', n)
  for (const [p, n] of share(poisson(3.7, rng), unitEntries(def, PD_SHARE, 2, formOf), rng)) bump(lines, p, 'passesDefended', n)
}

// A whole game: { [playerId]: line } for both clubs, with the home and away results as simGame gave them.
export function simBoxScore(homeTeam, awayTeam, { homeScore, awayScore, homeTds, awayTds }, formOf, rng) {
  const lines = {}
  playSide(homeTeam, awayTeam, { points: homeScore, tds: homeTds ?? 0, oppPoints: awayScore }, lines, formOf, rng)
  playSide(awayTeam, homeTeam, { points: awayScore, tds: awayTds ?? 0, oppPoints: homeScore }, lines, formOf, rng)
  return lines
}
