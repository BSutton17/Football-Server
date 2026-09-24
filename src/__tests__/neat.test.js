import { describe, it, expect } from '@jest/globals'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  createRng, createGenome, cloneGenome, connectFully, createInnovationRegistry,
  mutate, crossover, compatibility, buildNetwork, topologicalOrder, DEFAULT_CONFIG,
} from '../neat/neat.js'
import { createPopulation } from '../neat/population.js'
import { runXor, runXorWithoutTopology, xorFitness, isSolved } from '../neat/xor.js'

// [training] NEAT. The benchmark and its control are the point of this file: XOR cannot be solved
// without growing hidden structure, so solving it proves the implementation is doing the thing it
// claims to. The CONTROL — the same run with structural mutation switched off — must FAIL, or the
// benchmark is measuring something else.

describe('the algorithm is independent of the game', () => {
  it('neat/ imports nothing but its own siblings', () => {
    const dir = join(process.cwd(), 'src', 'neat')
    const files = readdirSync(dir).filter(f => f.endsWith('.js'))
    expect(files.length).toBeGreaterThanOrEqual(3)
    for (const f of files) {
      const src = readFileSync(join(dir, f), 'utf8')
      const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map(m => m[1])
      for (const spec of imports) {
        expect({ file: f, spec, sibling: spec.startsWith('./') }).toEqual({ file: f, spec, sibling: true })
      }
    }
  })

  it('never calls Math.random — a training run must be reproducible', () => {
    const dir = join(process.cwd(), 'src', 'neat')
    for (const f of readdirSync(dir).filter(x => x.endsWith('.js'))) {
      expect({ file: f, bare: readFileSync(join(dir, f), 'utf8').includes('Math.random') })
        .toEqual({ file: f, bare: false })
    }
  })
})

describe('XOR — the gate', () => {
  it('solves it from every seed', () => {
    const results = []
    for (let seed = 1; seed <= 8; seed++) results.push(runXor({ seed, maxGenerations: 300 }))
    const solved = results.filter(r => r.solved)
    expect({ solved: solved.length, of: results.length }).toEqual({ solved: results.length, of: results.length })
  }, 120000)

  it('grows hidden structure to do it — XOR is not linearly separable', () => {
    const r = runXor({ seed: 3, maxGenerations: 300 })
    expect(r.solved).toBeTruthy()
    expect(r.solved.hidden).toBeGreaterThan(0)
  }, 60000)

  it('CONTROL: cannot solve it without structural mutation', () => {
    // If this ever passes, the benchmark above proves nothing.
    expect(runXorWithoutTopology({ seed: 1, maxGenerations: 80 }).solved).toBeNull()
  }, 60000)

  it('reports the SOLVING genome, not merely the highest-scoring one', () => {
    // Fitness rewards low total error, so a near-miss on all four cases can outscore a correct
    // classification. Reporting the top scorer as "solved" is a bug I have shipped before.
    const r = runXor({ seed: 5, maxGenerations: 300 })
    expect(r.solved).toBeTruthy()
    expect(isSolved(r.solved.outputs)).toBe(true)
  }, 60000)
})

describe('genomes', () => {
  const rng = createRng(42)

  it('starts minimal and fully connected', () => {
    const reg = createInnovationRegistry(4)
    const g = connectFully(createGenome(2, 1), reg, rng)
    expect(g.nodes.filter(n => n.kind === 'input')).toHaveLength(2)
    expect(g.nodes.filter(n => n.kind === 'bias')).toHaveLength(1)
    expect(g.nodes.filter(n => n.kind === 'output')).toHaveLength(1)
    expect(g.connections).toHaveLength(3)   // 2 inputs + bias, each to the one output
  })

  it('gives the same structural change the same innovation number, however far apart', () => {
    const reg = createInnovationRegistry(10)
    const first = reg.connection(0, 5)
    for (let i = 0; i < 50; i++) reg.connection(i + 20, i + 40)
    expect(reg.connection(0, 5)).toBe(first)
  })

  it('adding a node barely changes what the network does', () => {
    const reg = createInnovationRegistry(4)
    const g = connectFully(createGenome(2, 1), reg, createRng(1))
    const before = buildNetwork(g)([0.3, 0.7])

    // Force exactly one add-node mutation.
    mutate(g, reg, createRng(9), { ...DEFAULT_CONFIG, weightMutateRate: 0, addConnectionRate: 0, addNodeRate: 1, toggleEnableRate: 0 })
    expect(g.nodes.some(n => n.kind === 'hidden')).toBe(true)

    // The spliced pair is weighted 1 and w, so the signal is preserved APPROXIMATELY — it now
    // passes through the new node's sigmoid, so it is not identical, and claiming otherwise is a
    // common misreading of the NEAT paper. What matters is that the change is small enough that a
    // structural mutation is not immediately fatal.
    const after = buildNetwork(g)([0.3, 0.7])
    expect(Math.abs(after[0] - before[0])).toBeLessThan(0.05)
  })

  it('is evaluated in a deterministic order regardless of how the genome was built', () => {
    const reg = createInnovationRegistry(4)
    const g = connectFully(createGenome(3, 2), reg, createRng(4))
    for (let i = 0; i < 12; i++) mutate(g, reg, createRng(i + 1), DEFAULT_CONFIG)

    const forward = buildNetwork(g)([0.2, 0.9, 0.4])
    // Same genome, gene arrays reversed — Map iteration order would change the answer.
    const shuffled = cloneGenome(g)
    shuffled.connections.reverse()
    shuffled.nodes.reverse()
    expect(buildNetwork(shuffled)([0.2, 0.9, 0.4])).toEqual(forward)
  })

  it('never builds a cycle', () => {
    const reg = createInnovationRegistry(6)
    const g = connectFully(createGenome(3, 2), reg, createRng(11))
    for (let i = 0; i < 200; i++) mutate(g, reg, createRng(i + 50), { ...DEFAULT_CONFIG, addConnectionRate: 1, addNodeRate: 0.2 })

    const rank = new Map(topologicalOrder(g).map((id, i) => [id, i]))
    for (const c of g.connections) {
      if (!c.enabled) continue
      expect({ edge: `${c.from}>${c.to}`, forward: rank.get(c.from) < rank.get(c.to) })
        .toEqual({ edge: `${c.from}>${c.to}`, forward: true })
    }
  })

  it('crossover on equal fitness prefers the SMALLER genome (anti-bloat, and deterministic)', () => {
    const reg = createInnovationRegistry(4)
    const small = connectFully(createGenome(2, 1), reg, createRng(2))
    const big = cloneGenome(small, 'big')
    for (let i = 0; i < 6; i++) mutate(big, reg, createRng(i + 3), { ...DEFAULT_CONFIG, addNodeRate: 1, weightMutateRate: 0 })
    small.fitness = big.fitness = 5

    const child = crossover(big, small, createRng(7))
    expect(child.connections.length).toBe(small.connections.length)
  })

  it('scores identical genomes as compatible and different ones as not', () => {
    const reg = createInnovationRegistry(4)
    const a = connectFully(createGenome(2, 1), reg, createRng(3))
    const b = cloneGenome(a, 'b')
    expect(compatibility(a, b)).toBe(0)

    for (let i = 0; i < 10; i++) mutate(b, reg, createRng(i + 20), { ...DEFAULT_CONFIG, addNodeRate: 1 })
    expect(compatibility(a, b)).toBeGreaterThan(0)
  })
})

describe('the population', () => {
  it('holds its size across generations', () => {
    const pop = createPopulation({ inputs: 2, outputs: 1, seed: 1, config: { populationSize: 40 } })
    for (let i = 0; i < 10; i++) {
      pop.step(gs => gs.forEach(g => { g.fitness = xorFitness(g).fitness }))
      expect({ gen: pop.generation, size: pop.genomes.length }).toEqual({ gen: i + 1, size: 40 })
    }
  }, 30000)

  it('improves', () => {
    const pop = createPopulation({ inputs: 2, outputs: 1, seed: 6, config: { populationSize: 80 } })
    const history = []
    for (let i = 0; i < 40; i++) history.push(pop.step(gs => gs.forEach(g => { g.fitness = xorFitness(g).fitness })))
    const early = history.slice(0, 5).reduce((a, r) => a + r.best, 0) / 5
    const late = history.slice(-5).reduce((a, r) => a + r.best, 0) / 5
    expect(late).toBeGreaterThan(early)
  }, 60000)

  // ⚠️ THE BUG THAT COST A 250-GENERATION RUN.
  //
  // The threshold used to move by a fixed +/-0.3 per generation toward `targetSpecies`, which
  // assumes species count responds smoothly to it. On a wide problem it does not: `connectFully`
  // gives every genome inputs x outputs connections, `compatibility` divides structural difference
  // by genome size, and what is left is an average weight difference over hundreds of genes, which
  // concentrates nearly all pairs onto one value. The count becomes a step function and the fixed
  // step leaps over it — a real run alternated 1, 32, 1, 38, 1, 42 species EVERY generation, which
  // makes fitness sharing a no-op and every species' stagnation history meaningless.
  //
  // A wide population is what reproduces it; XOR (2 inputs) never could, which is why the XOR
  // benchmark stayed green through the whole thing.
  it('holds a STABLE species count on a wide problem, instead of oscillating', () => {
    const pop = createPopulation({ inputs: 35, outputs: 16, seed: 7, config: { populationSize: 60 } })
    const counts = []
    for (let i = 0; i < 12; i++) {
      const r = pop.step(gs => gs.forEach((g, j) => { g.fitness = 1 + (j % 7) }))
      counts.push(r.species)
    }

    // Nothing may collapse to a single species and then explode back.
    const settled = counts.slice(2)
    expect(Math.min(...settled)).toBeGreaterThan(1)

    // And no generation-to-generation swing anywhere near the 1 -> 35 the old code produced.
    const swings = settled.slice(1).map((n, i) => Math.abs(n - settled[i]))
    expect(Math.max(...swings)).toBeLessThan(15)
  })

  it('keeps more than one species alive', () => {
    const pop = createPopulation({ inputs: 3, outputs: 2, seed: 8, config: { populationSize: 60 } })
    for (let i = 0; i < 12; i++) pop.step(gs => gs.forEach((g, n) => { g.fitness = 1 + (n % 7) }))
    expect(pop.species.length).toBeGreaterThan(1)
  }, 30000)

  it('never loses the champion to a stale-fitness impostor', () => {
    // Elites are cloned WITH their parent's fitness, so a "best genome" read after breeding can be
    // a genome whose score belongs to someone else. The champion is snapshotted at evaluation time.
    const pop = createPopulation({ inputs: 2, outputs: 1, seed: 2, config: { populationSize: 30 } })
    let peak = -Infinity
    for (let i = 0; i < 15; i++) {
      const rec = pop.step(gs => gs.forEach(g => { g.fitness = xorFitness(g).fitness }))
      peak = Math.max(peak, rec.best)
      expect(pop.champion.fitness).toBeCloseTo(peak, 10)
    }
  }, 30000)

  it('resumes from a snapshot and reproduces the run exactly', () => {
    const run = (steps, resumeAt = null) => {
      const pop = createPopulation({ inputs: 2, outputs: 1, seed: 5, config: { populationSize: 30 } })
      const records = []
      let snap = null
      for (let i = 0; i < steps; i++) {
        if (resumeAt != null && i === resumeAt) {
          snap = pop.snapshot()
          pop.restore(JSON.parse(JSON.stringify(snap)))
        }
        records.push(pop.step(gs => gs.forEach(g => { g.fitness = xorFitness(g).fitness })))
      }
      return { records, champion: pop.champion }
    }

    const straight = run(8)
    const interrupted = run(8, 4)
    expect(interrupted.records).toEqual(straight.records)
    expect(interrupted.champion.id).toBe(straight.champion.id)
  }, 30000)
})
