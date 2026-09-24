// ── The trained defensive coordinator ([deep][pingpong]) ────────────────────
//
// HARD mode's defense is a NEAT network trained by ping-pong self-play; easy and medium stay on the
// hand-written heuristic with their usual handicaps. So the difficulty ladder is now:
//
//   easy    heuristic, vanilla shells only, sloppy alignment, misreads the field
//   medium  heuristic, full playbook, still loose and still misreading
//   hard    this network
//
// What it earned that place: across a round robin of every champion produced overnight, it scored
// 18.53 against the whole field where the hand-written defense scored 13.67 — and it beat the
// heuristic on a slate nothing had trained on.
//
// ⚠️ IT DOES NOT SEE ANY MORE THAN THE HEURISTIC DOES. The network replaces the CALL and the
// per-player adjustments; every input it reads comes from the same Knowledge object the heuristic
// uses, assembled only from events the seat actually received. The standing rule — the defense
// never sees the play call — is inherited rather than re-argued. See ai/knowledge.js.
//
// ⚠️ AND IT CANNOT PRODUCE AN ILLEGAL DEFENSE. Its wishes are projected onto legality before
// anything is fired (deepDefense.js): nobody uncovered, no empty box against heavy personnel, legal
// man matchups, landmarks on the field. A network is not trusted with the rules.
//
// If the brain file is missing or unreadable the heuristic plays instead, and hard mode is merely
// the un-handicapped heuristic rather than a broken game.

import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { DIFFICULTY } from '../constants.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const BRAIN_PATH = join(HERE, 'brains', 'hard-defense.json')

let cached = null       // parsed once per process; the file is ~100KB and never changes at runtime
let looked = false

export function trainedDefenseGenome() {
  if (looked) return cached
  looked = true
  try {
    if (existsSync(BRAIN_PATH)) {
      const saved = JSON.parse(readFileSync(BRAIN_PATH, 'utf8'))
      if (saved?.genome?.nodes?.length) {
        cached = saved.genome
        console.log(`[ai] hard-mode defense loaded (${saved.source ?? 'trained'}, ${cached.nodes.length} nodes)`)
      }
    }
  } catch (err) {
    console.log(`[ai] trained defense unavailable (${err.message}); hard mode will use the heuristic`)
  }
  return cached
}

// Should this seat play the trained brain? Hard only, and only if the genome actually loaded.
//
// ⚠️ NOT gated on the seat's role. The trained brain WRAPS a full controller, so it plays the
// network's defense while on defense and the ordinary heuristic offense after a turnover flips it.
// Gating on the kickoff role instead would make hard mode depend on the coin toss — a computer that
// happened to receive would play heuristic defense for the rest of the game.
export function useTrainedDefense(difficulty) {
  return difficulty === DIFFICULTY.HARD && !!trainedDefenseGenome()
}
