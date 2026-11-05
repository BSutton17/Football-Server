// ── Which season it is ([seasons]) ─────────────────────────────────────────
//
// "All seasons follow the current year and should update on September 1st to reflect the schedule of
// the current year."
//
// An NFL season is named for the year it kicks off, and it runs into the next: January 2027 is still
// the 2026 season. So the year turns over on September 1st, on the clock in the league's home time
// zone. A season already under way keeps the schedule it started with (it is copied onto the save).

const NY = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', year: 'numeric', month: 'numeric',
})

export function seasonYearFor(date = new Date()) {
  const parts = Object.fromEntries(NY.formatToParts(date).map(p => [p.type, p.value]))
  const year = Number(parts.year)
  const month = Number(parts.month)
  return month >= 9 ? year : year - 1
}

// The 2026 season ends in Super Bowl LXI.
export function superBowlNumber(seasonYear) {
  return seasonYear - 1965
}

const NUMERALS = [[50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']]

export function superBowlNumeral(seasonYear) {
  let n = superBowlNumber(seasonYear)
  let out = ''
  for (const [value, mark] of NUMERALS) {
    while (n >= value) { out += mark; n -= value }
  }
  return out
}
