// ── What does the computer actually kick? ([special teams]) ─────────────────
//
//   NODE_ENV=test node scripts/kickLab.mjs [kicks per scenario]
//
// Reported twice: "the punts for the AI are broken they are only punting 22 yards", then, after a
// fix aimed squarely at the power meter, "the AI is still punting at the minimum". A fix that does
// not move the number means the thing it fixed was not the fault, so this stopped measuring the
// meter and measured the whole path instead — the real menu, the real choice, the real kick clock,
// the real distance curve — and reports THE POWER THE BALL WAS STRUCK AT alongside the distance.
//
// That one extra column is what found it. 22 yards is PUNT_FLOOR_MAX, the distance a punt travels
// at zero power, and the power at the whistle was exactly full-meter-minus-a-full-drain. The
// computer was not kicking badly; it was not touching the meter at all.
//
// Field goals are measured here too, because they run through the same input path and had the same
// silence — the make/miss intent was being decided and then never expressed as an aim.

import { createTrainingGame, destroyTrainingGame } from '../src/training/game.js'
import { stepUntil } from '../src/headless/harness.js'
import { serializeGameState } from '../src/game/serialization.js'
import { DECISION_SECONDS } from '../src/game/specialTeams.js'
import { getRoom } from '../src/game/roomManager.js'

const N = Number(process.argv[2] ?? 12)

// Each scenario is a 4th down the AI should answer a particular way.
const SCENARIOS = [
  { name: 'punt, own 30, 4th & 12',   down: 4, distance: 12, yardLine: 30, want: 'punt' },
  { name: 'punt, own 45, 4th & 9',    down: 4, distance: 9,  yardLine: 45, want: 'punt' },
  { name: 'FG, opp 20 (37 yd kick)',  down: 4, distance: 8,  yardLine: 80, want: 'field_goal' },
  { name: 'FG, opp 32 (49 yd kick)',  down: 4, distance: 9,  yardLine: 68, want: 'field_goal' },
]

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null)
const f = (v, d = 2) => (v == null ? '  -  ' : v.toFixed(d))

console.log('')
for (const sc of SCENARIOS) {
  const rows = []
  for (let i = 0; i < N; i++) {
    const ctx = createTrainingGame({ seed: 7700 + i * 13 })
    try {
      const st = ctx.state
      st.down = sc.down; st.distance = sc.distance; st.yardLine = sc.yardLine
      st.quarter = 1; st.clock = 200; st.score = [0, 0]

      // Arm the menu exactly as beginNextPlay does, then tell both seats — the AI acts on game_state.
      st.decisionPending = true
      st.decisionTimer = DECISION_SECONDS
      const room = getRoom(ctx.roomId)
      room.players.forEach((id, slot) => {
        if (id) ctx.io.to(id).emit('game_state', serializeGameState(st, slot))
      })

      const chose = st.specialTeams?.kickType ?? (st.decisionPending ? '(no answer)' : 'go_for_it')
      const kicker = st.possession
      const before = st.score[kicker]

      // ⚠️ SAMPLED DURING THE KICK, NOT AFTER IT. A field goal clears `state.specialTeams` the
      // moment it resolves, so reading it at the end of the run saw nothing at all and this reported
      // every field goal as a miss -- a measurement bug that looked exactly like the thing being
      // measured. The last tick that still had a struck ball on it is the one that holds the answer.
      let last = null
      stepUntil(ctx.roomId, ctx.io, s => !s.specialTeams || s.specialTeams.result, {
        maxTicks: 400,
        onTick: (s) => { if (s.specialTeams?.started) last = { power: s.specialTeams.power, angle: s.specialTeams.angle, result: s.specialTeams.result } },
      })
      // Run on a little so the points land, then read the scoreboard: three points is a made kick,
      // which is the outcome a player sees and does not depend on any internal flag.
      stepUntil(ctx.roomId, ctx.io, () => false, { maxTicks: 40 })
      rows.push({
        chose,
        power: last?.power ?? null,
        angle: last?.angle ?? null,
        distance: last?.result?.distance ?? null,
        good: sc.want === 'field_goal' ? ctx.state.score[kicker] > before : null,
      })
    } finally { destroyTrainingGame(ctx) }
  }

  // ⚠️ STRUCK, NOT RESOLVED. A field goal's distance is never observable from out here -- the
  // kick clears `state.specialTeams` in the tick that resolves it -- so filtering on distance threw
  // away the power and aim readings for every field goal and printed dashes.
  const kicked = rows.filter(r => r.power != null)
  const wrong = rows.filter(r => r.chose !== sc.want).length
  const made = rows.filter(r => r.good === true).length
  const isFg = sc.want === 'field_goal'
  console.log(`  ${sc.name}`)
  console.log(`    chose ${sc.want}: ${rows.length - wrong}/${rows.length}` +
    `   power at the whistle ${f(mean(kicked.map(r => r.power)))}` +
    `   aim ${f(mean(kicked.map(r => Math.abs(r.angle ?? 0))))}` +
    `   distance ${f(mean(kicked.map(r => r.distance).filter(v => v != null)), 1)}` +
    (isFg ? `   MADE ${made}/${rows.length}` : ''))
  const powers = kicked.map(r => r.power).filter(v => v != null)
  if (powers.length) console.log(`      power range ${f(Math.min(...powers))} - ${f(Math.max(...powers))}` +
    `   distances ${[...new Set(kicked.map(r => r.distance).filter(v => v != null).map(v => f(v, 1)))].join(' ') || '(not observable from here)'}`)
}
console.log('')
