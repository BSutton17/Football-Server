import { TEAM_DATA } from './teamData.js'

// The 32 clubs as the season engine sees them: conference, division and ratings.

export const TEAMS = TEAM_DATA
export const TEAM = Object.fromEntries(TEAM_DATA.map(t => [t.id, t]))
export const CONFERENCES = ['AFC', 'NFC']
export const DIVISIONS = ['East', 'North', 'South', 'West']

export function isTeam(id) {
  return typeof id === 'string' && Object.hasOwn(TEAM, id)
}

export function teamsIn(conference, division = null) {
  return TEAM_DATA.filter(t => t.conference === conference && (!division || t.division === division))
}
