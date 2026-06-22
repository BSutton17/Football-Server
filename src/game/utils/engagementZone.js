// Engagement zone — the radius at which a blocker and a defender begin to interact
// physically before their bodies actually overlap.
//
// When a blocker is within ENGAGEMENT_RADIUS yards of a defender, both are flagged
// as engaged. The movement system uses these flags to cap speed (simulating the
// physical contest of a block/shed fight). Collision response then handles the
// actual body separation.
//
// Engagement is one-to-many: a single defender can be engaged by multiple blockers,
// and a single blocker can engage multiple defenders (double-team or scramble).

export const ENGAGEMENT_RADIUS = 2.5  // yards, center-to-center

// Positions that always act as blockers regardless of route assignment.
const LINEMAN_LABELS = new Set(['OL', 'C', 'G', 'T'])
// Skill positions that become full blockers on a run play ([priority 4]).
const RUN_BLOCK_SKILL = new Set(['WR', 'TE'])

// Returns true if this offensive player is acting as a blocker this play. On a run, receivers
// and tight ends fully engage (perimeter/seal blocking) just like linemen.
export function isBlocker(player, playType) {
  if (LINEMAN_LABELS.has(player.label ?? '')) return true
  if (player.route === 'block') return true
  if (playType === 'run' && RUN_BLOCK_SKILL.has(player.label ?? '')) return true
  return false
}

// Scans all blocker×defender pairs and returns those within the engagement radius.
// Returns an array of { offense, defense, dist } — `dist` lets callers compute
// engagement strength if needed (closer = more locked in).
export function detectEngagements(offensePlayers, defensePlayers, playType) {
  const engagements = []
  const r2 = ENGAGEMENT_RADIUS * ENGAGEMENT_RADIUS

  for (const o of offensePlayers.values()) {
    if (!isBlocker(o, playType)) continue

    for (const d of defensePlayers.values()) {
      const dx = o.x - d.x
      const dy = o.y - d.y
      const d2 = dx * dx + dy * dy

      if (d2 <= r2) {
        engagements.push({ offense: o, defense: d, dist: Math.sqrt(d2) })
      }
    }
  }

  return engagements
}
