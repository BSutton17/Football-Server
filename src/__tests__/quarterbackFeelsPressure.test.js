import { describe, it, expect } from '@jest/globals'
import { serializePositions } from '../game/serialization.js'
import { createKnowledge, applyEvent } from '../ai/knowledge.js'

// ⚠️ THE QUARTERBACK COULD NOT FEEL A PASS RUSH. AT ALL. ON ANY DIFFICULTY.
//
// `pressureUrgency` finds the man with the ball and returns 0 when it cannot. It looked for
// `carrier`, which comes from `findBallCarrier` — the designed runner, a receiver after the catch,
// an intercepting defender, or null. A quarterback standing in the pocket holding the ball is none
// of those, so on every pass play up to the throw the flag was false for all 22 players.
//
// Everything downstream inherited it: the throw bar never decayed under pressure, the bail-out
// could never fire (zero throwaways across hundreds of plays on all three tiers), and
// `estimateOpenness` was handed a null passer on every read. He stood still and got sacked.
//
// Reported as "the quarterback is constantly getting sacked and I'm only rushing 4 ... it might be
// because the qb won't throw". Sack rate on third and twelve against a four-man rush with man
// coverage afterwards: 21% -> 0% easy, 9% -> 2% medium, 11% -> 3% hard.
describe('the passer is findable while he is still holding the ball', () => {
  function stateWithPocketQb() {
    const qb = { id: 'o_qb', label: 'QB', x: 26, y: 45 }
    const wr = { id: 'o_wr', label: 'WR', x: 40, y: 55, routeWaypointIdx: 2 }
    const de = { id: 'd_de', label: 'DE', x: 27, y: 46 }
    return {
      roomId: 'r', direction: 1, difficulty: 'hard', phase: 'live',
      // ⚠️ NO ballCarrierId AND NOT A RUN — which is precisely a normal dropback.
      ballCarrierId: null,
      playDesign: { playType: 'pass' },
      offensePlayers: new Map([[qb.id, qb], [wr.id, wr]]),
      defensePlayers: new Map([[de.id, de]]),
      offenseSlot: 0,
    }
  }

  it('tags the quarterback even though nobody is the ball carrier', () => {
    const positions = serializePositions(stateWithPocketQb(), 0)
    const qb = positions.find(p => p.id === 'o_qb')
    expect(qb).toBeDefined()
    expect(qb.state).toBeUndefined()   // genuinely not the "carrier"
    expect(qb.qb).toBe(true)           // …and still findable
  })

  it('carries that through to what the AI knows', () => {
    const positions = serializePositions(stateWithPocketQb(), 0)
    let k = createKnowledge(0)
    k = applyEvent(k, 'positions_update', positions)
    const found = [...k.live.values()].find(p => p.qb || p.carrier)
    expect(found).toBeDefined()
    expect(found.id).toBe('o_qb')
  })

  // The bug was not that the flag was wrong, it was that NOTHING was flagged — so the assertion
  // that matters is that a search for the man with the ball finds somebody at all.
  it('finds nobody if the tag is dropped, which is the bug this replaces', () => {
    const positions = serializePositions(stateWithPocketQb(), 0).map(({ qb, ...rest }) => rest)
    let k = createKnowledge(0)
    k = applyEvent(k, 'positions_update', positions)
    expect([...k.live.values()].find(p => p.qb || p.carrier)).toBeUndefined()
  })
})
