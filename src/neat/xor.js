// ── The XOR gate ([training]) ────────────────────────────────────────────────
//
// The standard NEAT benchmark, and the one thing that must pass before this is pointed at a
// football field. XOR has four training cases and cannot be solved by a network with no hidden
// nodes — so solving it proves the implementation is actually GROWING topology, not merely tuning
// weights on the structure it started with.
//
// The control test matters as much as the benchmark: a configuration forbidden from adding nodes
// must FAIL. Without that, a passing XOR run might just mean the scoring was too generous.

import { createPopulation } from './population.js'
import { buildNetwork, DEFAULT_CONFIG } from './neat.js'

const CASES = [
  { in: [0, 0], out: 0 },
  { in: [0, 1], out: 1 },
  { in: [1, 0], out: 1 },
  { in: [1, 1], out: 0 },
]

// Fitness is (4 − total error)², squared to sharpen the pressure near the top: the difference
// between 3.6 and 3.9 matters far more than between 1.0 and 1.3.
export function xorFitness(genome) {
  const net = buildNetwork(genome)
  let error = 0
  const outputs = []
  for (const c of CASES) {
    const [y] = net(c.in)
    outputs.push(y)
    error += Math.abs(c.out - y)
  }
  return { fitness: (4 - error) ** 2, error, outputs }
}

// Solved means every case lands on the right side of 0.5 — a real classification, not merely a low
// total error. These are different things: a network can have a very low summed error while still
// getting one case wrong, and reporting THAT as solved is a bug I have shipped before.
export function isSolved(outputs) {
  return outputs[0] < 0.5 && outputs[1] >= 0.5 && outputs[2] >= 0.5 && outputs[3] < 0.5
}

export function runXor({ seed = 1, maxGenerations = 200, config = {} } = {}) {
  const pop = createPopulation({
    inputs: 2,
    outputs: 1,
    seed,
    config: { populationSize: 150, targetSpecies: 8, ...config },
  })

  const history = []
  let solved = null

  for (let gen = 0; gen < maxGenerations; gen++) {
    let best = null

    const record = pop.step(genomes => {
      for (const g of genomes) {
        const r = xorFitness(g)
        g.fitness = r.fitness
        // ⚠️ Track the SOLVING genome, not the highest-scoring one. Fitness rewards low total
        // error, so a near-miss on all four cases can outscore a correct classification — an
        // earlier version of this reported "solved" with outputs that failed a case.
        if (isSolved(r.outputs) && (!best || r.fitness > best.fitness)) {
          best = { fitness: r.fitness, genome: g, outputs: r.outputs, error: r.error }
        }
      }
    })

    history.push(record)
    if (best) {
      solved = { generation: gen, ...best, hidden: best.genome.nodes.filter(n => n.kind === 'hidden').length }
      break
    }
  }

  return { solved, generations: history.length, history, config: pop.config }
}

// The control: with structural mutation switched off, XOR must be UNSOLVABLE. If this passes, the
// benchmark is not measuring what it claims to.
export function runXorWithoutTopology({ seed = 1, maxGenerations = 60 } = {}) {
  return runXor({
    seed,
    maxGenerations,
    config: { addNodeRate: 0, addConnectionRate: 0 },
  })
}

export { DEFAULT_CONFIG }
