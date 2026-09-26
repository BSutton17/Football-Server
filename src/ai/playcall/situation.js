// ── The situation a play is called in ([authored]) ──────────────────────────
//
// Play calling is not random and it is not uniform. Third and one is a different game from third
// and twelve, and the same formation is called for different reasons in each. Everything the
// selector does is keyed on the bucket a snap falls into, so a run out of a passing formation can
// be common on third and one and rare on first and ten — out of the SAME formation.
//
// ⚠️ BUCKETS, NOT RAW NUMBERS. A separate answer for third-and-7 and third-and-8 would need twice
// the simulation to learn two things that are the same thing. Buckets are chosen so that football
// actually changes across a boundary and barely changes inside one.

// Distance to go. The gaps are where the play-calling genuinely turns over.
export const DISTANCE_BANDS = [
  { id: 'short', max: 2, label: '1-2' },     // a run is always live
  { id: 'medium', max: 6, label: '3-6' },    // everything is available
  { id: 'long', max: 12, label: '7-12' },    // the run is a change-up
  { id: 'verylong', max: Infinity, label: '13+' },
]

// Where on the field. The two ends are their own games.
export const FIELD_ZONES = [
  { id: 'backedup', max: 20, label: 'own 1-20' },     // a mistake here is a safety or a short field
  { id: 'normal', max: 79, label: 'open field' },
  { id: 'redzone', max: 94, label: 'red zone' },      // the deep ball stops existing
  { id: 'goalline', max: 100, label: 'goal line' },   // and the field is a postage stamp
]

export function distanceBand(distance) {
  return DISTANCE_BANDS.find(b => distance <= b.max) ?? DISTANCE_BANDS[DISTANCE_BANDS.length - 1]
}

export function fieldZone(yardLine) {
  return FIELD_ZONES.find(z => yardLine <= z.max) ?? FIELD_ZONES[FIELD_ZONES.length - 1]
}

// ⚠️ FOURTH DOWN IS NOT A FIFTH KIND OF THIRD DOWN. A team that has chosen to go for it on fourth
// is in exactly the situation it was in on third — it has one play to get the distance — so the
// two share a bucket. Keeping them apart would halve the evidence behind both.
export function downBucket(down) {
  return down >= 3 ? 'late' : `down${down}`
}

export function situationKey({ down, distance, yardLine }) {
  return `${downBucket(down)}|${distanceBand(distance).id}|${fieldZone(yardLine).id}`
}

export function describeSituation({ down, distance, yardLine }) {
  const d = down >= 3 ? '3rd/4th' : down === 1 ? '1st' : '2nd'
  return `${d} & ${distanceBand(distance).label}, ${fieldZone(yardLine).label}`
}

// Every bucket that exists, for building or auditing a table.
export function allSituations() {
  const out = []
  for (const down of ['down1', 'down2', 'late']) {
    for (const band of DISTANCE_BANDS) {
      for (const zone of FIELD_ZONES) out.push(`${down}|${band.id}|${zone.id}`)
    }
  }
  return out
}

// ── What a situation asks for ───────────────────────────────────────────────
//
// The prior the selector falls back on before anything has been simulated, and the shape the
// solved table is expected to broadly agree with. These are not the answer — the solve is — but a
// prior that already knows third-and-one is a running down is a far better starting point than a
// uniform one, and it is what makes the AI sensible on day one.
//
// ⚠️ THIS IS A LEAN, NOT A RULE. It weights plays; it never forbids one. A defense that could rely
// on "they never throw deep on the goal line" would be reading the prior rather than the offense.
// ── How often the ball should be run here ───────────────────────────────────
//
// ⚠️ A SHARE, NOT A WEIGHT, AND THAT DISTINCTION IS THE WHOLE BUG. `runLean` returns a multiplier
// applied to each run play, which only works if the two play types are authored in similar
// numbers. They are not and never will be: the playbook holds 15 runs against 111 passes, because
// ONE authored run covers every lane — the angle is chosen at the line — while every pass concept
// has to be drawn separately.
//
// Weighting per play therefore made the run/pass mix an accident of how much drawing had been
// done. On 1st and 10 the single run in a formation scored 0.47 against seven passes at 1.00, so
// the offense threw 96% of the time; and the more pass plays get authored, the worse it gets.
//
// The mix is decided FIRST, from the situation alone, and the plays of each type then share out
// what their type was given. Authoring twenty more pass concepts now changes WHICH pass is called
// and not whether the team ever runs.
// ⚠️ A BUCKET IS COARSE BY DESIGN, so one representative snap stands for all of it — that is what
// bucketing means. Used to ask situational questions of a SOLVED bucket, which is stored by key and
// not by the numbers it came from.
const BAND_DISTANCE = { short: 1, medium: 5, long: 10, verylong: 16 }
const ZONE_YARDLINE = { backedup: 12, normal: 45, redzone: 90, goalline: 97 }

export function situationFromKey(key) {
  const [down, band, zone] = String(key).split('|')
  return {
    // '3rd/4th' share a bucket; three is the representative of the pair.
    down: down === 'down1' ? 1 : down === 'down2' ? 2 : 3,
    distance: BAND_DISTANCE[band] ?? 10,
    yardLine: ZONE_YARDLINE[zone] ?? 45,
  }
}

export function runShare(situation) {
  // League-ish baseline, then moved by the same reads `runLean` encodes. Expressed in odds so the
  // multipliers compose without ever leaving 0..1.
  const BASE_ODDS = 0.45 / 0.55
  const odds = BASE_ODDS * runLean(situation)
  const share = odds / (1 + odds)
  // Never certain either way: a team that literally never runs on 3rd and 12 is one the defense can
  // sit on, and the same in reverse on the goal line.
  return Math.max(0.05, Math.min(0.92, share))
}

export function runLean({ down, distance, yardLine }) {
  const band = distanceBand(distance).id
  const zone = fieldZone(yardLine).id

  let lean = 1
  if (band === 'short') lean *= 2.6         // short yardage is a running down
  else if (band === 'medium') lean *= 1.15
  else if (band === 'long') lean *= 0.75
  else lean *= 0.35                         // 13+ is a throwing down

  // ⚠️ THE DOWN, WHICH THIS USED TO IGNORE outside short yardage — so 1st and 10 and 3rd and 12
  // scored identically, both landing in the "7-12" band. They are not remotely the same call: one
  // is the most balanced snap in football and the other is a throwing down. First down is where
  // the run lives precisely BECAUSE the distance is usually ten; by third down the distance stops
  // being context and becomes the whole problem.
  if (down === 1) lean *= 1.65
  else if (down === 2) lean *= 1.1
  else lean *= band === 'short' ? 1.25 : 0.28   // third and fourth: convert, or give it up

  if (zone === 'goalline') lean *= 1.7      // the field is too short to throw over
  if (zone === 'backedup') lean *= 1.2      // a sack here is a safety
  return lean
}

// How much a deep play is worth here. ⚠️ THE ONE THE USER NAMED: a deep pass on 4th and goal from
// the two has nowhere to go — the end zone is ten yards away and the route needs twenty.
export function depthLean({ yardLine, distance }) {
  const toGoal = 100 - yardLine
  if (toGoal <= 6) return 0.05              // nothing deep exists here
  if (toGoal <= 12) return 0.25
  if (distance >= 13) return 1.5            // needing a lot makes a lot worth more
  return 1
}
