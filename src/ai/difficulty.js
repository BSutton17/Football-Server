// ── How well the computer plays ([offline]) ─────────────────────────────────
//
// Easy / medium / hard. One rule governs every knob in this file, and it is not negotiable:
//
//   ⚠️ DIFFICULTY CHANGES WHAT THE AI DOES WITH WHAT IT KNOWS. IT NEVER CHANGES WHAT IT KNOWS.
//
// A harder computer is not a computer that has been shown the play call, the routes, or a receiver
// read a human in its seat would be denied. Every tier is fed the identical Knowledge object,
// assembled by knowledge.js from the identical events — see the note at the top of that file. What
// a tier gets is worse JUDGEMENT: a noisier read of the field, sloppier alignment, a smaller menu
// of coverages to call from. Those are handicaps applied to the output side of the decision, which
// is why none of them can leak information in the other direction however they are tuned.
//
// The practical consequence for anyone adding a knob here: if the knob's value would change what
// the AI can SEE, it does not belong in this file. Put it in the serializer, where it applies to
// humans and computers alike.
//
// The other half of the room's difficulty — whether the OFFENSE is shown the openness colors — is
// a separate mechanism (HIDES_OPENNESS, applied in serialization.js per viewer) and applies to a
// human and to the AI identically. The two halves share a name because a player wants one dial,
// not two; they do not share any code.

import { DIFFICULTY } from '../constants.js'

// The vanilla shells — two-deep, three-deep, quarters, single-high. What a defense lines up in when
// it is not trying to fool anybody. No pressure packages, no pattern-matching wrinkles.
const VANILLA = ['cover_1', 'cover_2', 'cover_3', 'cover_4']

// Everything, including the pressure packages and Tampa 2's carried deep middle.
const FULL = [...VANILLA, 'cover_2_man', 'tampa_2', 'man_blitz_5', 'man_blitz_6', 'zone_blitz_5', 'prevent']

export const AI_SKILL = {
  [DIFFICULTY.EASY]: {
    id: DIFFICULTY.EASY,
    name: 'Easy',
    // ── Defense ──
    // Only the vanilla shells: it will never surprise you with pressure, and it will never carry a
    // route the way Tampa 2 does. Beatable by watching what it lines up in.
    shells: VANILLA,
    // Yards of sloppiness in where each defender lines up relative to his landmark. A corner a
    // yard and a half off his spot gives up the throw a precise one takes away. Deterministic per
    // play (drawn from the controller's own seeded stream), so a replay is still a replay.
    alignSlop: 1.6,
    // ── Offense ──
    // How wrong its read of the field is. Noise is added to each receiver's score BEFORE ranking,
    // so the quarterback picks the wrong man some of the time — the same mistake a bad passer
    // makes. It is a handicap on the ranking, never a peek at anything.
    readNoise: 0.28,
    // Indecisive: holds out for a window better than it needs, then panics into a bad one.
    // [pressure] How much of the closing rush this tier actually registers. Panics late and eats sacks a better passer would avoid.
    pressureAware: 0.45,
    throwThreshold: 0.74,
    throwFloor: 0.18,
    patience: 4.2,
  },

  [DIFFICULTY.MEDIUM]: {
    id: DIFFICULTY.MEDIUM,
    name: 'Medium',
    // The full menu, so it can pressure you — but it still misreads the field and lines up loose.
    shells: FULL,
    alignSlop: 0.7,
    readNoise: 0.12,
    // [pressure] How much of the closing rush this tier actually registers. Feels the rush, but not as early as it should.
    pressureAware: 0.8,
    throwThreshold: 0.66,
    throwFloor: 0.28,
    patience: 3.2,
  },

  [DIFFICULTY.HARD]: {
    id: DIFFICULTY.HARD,
    name: 'Hard',
    // Everything, lined up exactly where the shell asks, reading the field as well as the engine
    // lets anybody read it. This is the tier NEAT is trained at and the tier a trained champion
    // brain is installed into — the handicaps below are all zero or near it, so the champion's
    // calls reach the field unmodified.
    shells: FULL,
    alignSlop: 0,
    readNoise: 0,
    // [pressure] How much of the closing rush this tier actually registers. Feels the rush the moment it is real, and bails out rather than taking a sack.
    pressureAware: 1.0,
    throwThreshold: 0.62,
    throwFloor: 0.32,
    patience: 2.6,
  },
}

// The tier for a difficulty, defaulting to easy for anything unrecognised — the same fallback the
// room manager applies, so an old client that sends nothing gets the gentlest opponent rather than
// the hardest one.
export function skillFor(difficulty) {
  return AI_SKILL[difficulty] ?? AI_SKILL[DIFFICULTY.EASY]
}

// Narrows a list of shell ids to the ones this tier is allowed to call. Falls back to the whole
// menu if a tier would be left with nothing — a defense with no call to make would place nobody,
// and eleven missing defenders is a worse bug than an over-strong easy mode.
export function allowedShells(skill, ids) {
  const allowed = ids.filter(id => skill.shells.includes(id))
  return allowed.length > 0 ? allowed : ids
}
