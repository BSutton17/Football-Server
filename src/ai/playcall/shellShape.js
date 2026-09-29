// ── The shape of a defensive shell ([defense]) ──────────────────────────────
//
// What a shell IS, independent of who is asking: how many rush, how many play man, how many drop
// deep, and whether the situation wants that. Its own module because both the player's shortlist
// (recommend.js) and the computer's own call (select.js) need it, and recommend.js already imports
// select.js — putting it in either one makes a cycle.
//
// ⚠️ THE COMPUTER USED TO CALL WITHOUT ANY OF THIS. `chooseDefensiveShell` fell back to a prior
// that weighted shells purely by defensive-back count against receiver count, so nothing in the
// computer's own call knew the down or the distance: measured over real snaps it played three or
// more deep on 35% of third-and-ONE and 34% of third-and-fifteen, statistically the same defense.
// That is the "cover 4 on third and short, nobody in the box" the shortlist never had, because the
// shortlist had this function and the computer did not.

import { distanceBand, fieldZone } from './situation.js'

// ⚠️ NOT "a non-lineman is rushing". In a 3-4 the fourth rusher IS a linebacker, and defining a
// blitz that way flagged twenty ordinary coverages as pressure.
export const BLITZ_RUSHERS = 5

export const countJobs = (shell) => {
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

// How many defenders this shell actually posts deep, which is what distance argues about.
export function deepCount(shell) {
  let deep = 0
  for (const a of Object.values(shell?.assignments ?? {})) {
    if (a?.job === 'zone' && (a.zone === 'deep' || (a.center?.depth ?? 0) >= 12)) deep++
  }
  return deep
}

// ⚠️ WITHOUT THIS THE DEFENSIVE CALL IGNORES THE SITUATION ENTIRELY. `personnelFit` reads only the
// receiver count, so until a bucket is solved the same shells come back on 3rd and 1 as on 3rd and
// 18 — the down and the distance change nothing at all.
export function situationalShellFit(shell, situation) {
  const band = distanceBand(situation?.distance ?? 10).id
  const zone = fieldZone(situation?.yardLine ?? 50).id
  const jobs = countJobs(shell)
  const kind = classifyShell(shell)
  const deep = deepCount(shell)

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
