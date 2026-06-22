// Canonical list of the 32 selectable teams. The full rosters/ratings live on the CLIENT
// (Client/src/data/nflTeams.ts); the server only needs the ids to stay authoritative over which
// teams are valid during team selection ([268][269]). `id` matches the client's team id (the abbr).

export const TEAMS = [
  { id: 'BUF', name: 'Buffalo Bills' },        { id: 'MIA', name: 'Miami Dolphins' },
  { id: 'NE',  name: 'New England Patriots' }, { id: 'NYJ', name: 'New York Jets' },
  { id: 'BAL', name: 'Baltimore Ravens' },     { id: 'CIN', name: 'Cincinnati Bengals' },
  { id: 'CLE', name: 'Cleveland Browns' },     { id: 'PIT', name: 'Pittsburgh Steelers' },
  { id: 'HOU', name: 'Houston Texans' },       { id: 'IND', name: 'Indianapolis Colts' },
  { id: 'JAX', name: 'Jacksonville Jaguars' }, { id: 'TEN', name: 'Tennessee Titans' },
  { id: 'DEN', name: 'Denver Broncos' },       { id: 'KC',  name: 'Kansas City Chiefs' },
  { id: 'LV',  name: 'Las Vegas Raiders' },    { id: 'LAC', name: 'Los Angeles Chargers' },
  { id: 'DAL', name: 'Dallas Cowboys' },       { id: 'NYG', name: 'New York Giants' },
  { id: 'PHI', name: 'Philadelphia Eagles' },  { id: 'WAS', name: 'Washington Commanders' },
  { id: 'CHI', name: 'Chicago Bears' },        { id: 'DET', name: 'Detroit Lions' },
  { id: 'GB',  name: 'Green Bay Packers' },    { id: 'MIN', name: 'Minnesota Vikings' },
  { id: 'ATL', name: 'Atlanta Falcons' },      { id: 'CAR', name: 'Carolina Panthers' },
  { id: 'NO',  name: 'New Orleans Saints' },   { id: 'TB',  name: 'Tampa Bay Buccaneers' },
  { id: 'ARI', name: 'Arizona Cardinals' },    { id: 'LAR', name: 'Los Angeles Rams' },
  { id: 'SF',  name: 'San Francisco 49ers' },  { id: 'SEA', name: 'Seattle Seahawks' },
]

export const TEAM_IDS = new Set(TEAMS.map(t => t.id))

export function isValidTeamId(id) {
  return TEAM_IDS.has(id)
}
