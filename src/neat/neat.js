// ── NEAT ([training]) ────────────────────────────────────────────────────────
//
// NeuroEvolution of Augmenting Topologies. In one paragraph, because the rest of this file assumes
// you have it: you keep a POPULATION of small neural networks. Each is scored on a task. The best
// ones breed; their offspring are mutated — a weight nudged, a new connection, occasionally a new
// neuron spliced into an existing connection. Over generations the networks get bigger and better.
// The "augmenting topologies" part is the point: you do not choose the network's shape up front,
// it grows one.
//
// Two ideas make it work rather than collapse:
//
//   INNOVATION NUMBERS. When a new connection appears, it gets a permanent id. Two networks that
//     independently grew "input 3 → output 1" share that id, so crossover can line their genes up
//     instead of guessing. The registry is memoised for the WHOLE RUN, not per generation — the
//     same structure appearing in generation 2 and generation 40 must get the same number or the
//     alignment is worthless.
//
//   SPECIATION. A brand-new structural mutation is almost always worse at first; it needs a few
//     generations to be tuned before it can compete. So genomes are grouped into species by
//     similarity and compete mainly WITHIN their species, which protects innovation long enough
//     for it to pay off.
//
// ⚠️ THIS FILE IMPORTS NOTHING FROM THE GAME, on purpose. It is validated on XOR before it is ever
// pointed at football — if it cannot learn a problem with four training cases, nothing it reports
// about a defensive playbook is worth reading. `test/neat.test.js` enforces the no-imports rule.

// ── Random ────────────────────────────────────────────────────────────────────
//
// Own generator, so a training run is reproducible and can be checkpointed mid-stream. The whole
// state is one uint32.
export function createRng(seed = 1) {
  let s = (seed >>> 0) || 0x9e3779b9
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000
  }
  next.getState = () => s
  next.setState = (v) => { s = (v >>> 0) || 0x9e3779b9 }
  next.pick = (arr) => arr[Math.floor(next() * arr.length)]
  next.range = (lo, hi) => lo + next() * (hi - lo)
  return next
}

// ── Configuration ─────────────────────────────────────────────────────────────

export const DEFAULT_CONFIG = {
  populationSize: 150,

  // Mutation rates, per genome per generation.
  weightMutateRate: 0.8,      // chance any given weight is touched at all
  weightPerturbRate: 0.9,     // …and if touched, nudged rather than replaced outright
  weightPerturbPower: 0.5,
  addConnectionRate: 0.05,
  addNodeRate: 0.03,
  toggleEnableRate: 0.01,

  // Crossover.
  crossoverRate: 0.75,        // the rest are asexual clones of a parent
  interspeciesMateRate: 0.001,

  // Speciation. `compatibilityThreshold` is tuned automatically toward `targetSpecies` — leaving it
  // fixed is the classic way to end up with either one giant species or a hundred singletons.
  excessCoefficient: 1.0,
  disjointCoefficient: 1.0,
  weightCoefficient: 0.4,
  compatibilityThreshold: 3.0,
  targetSpecies: 12,
  thresholdAdjust: 0.3,

  // Survival.
  survivalRate: 0.3,          // top fraction of a species allowed to breed
  elitism: 2,                 // copied into the next generation untouched
  stagnationLimit: 15,        // generations without improvement before a species is culled
  minSpeciesSize: 2,
}

// ── Genome ────────────────────────────────────────────────────────────────────
//
// Nodes and connections. Node ids 0..inputs-1 are inputs, then a bias, then the outputs; hidden
// nodes are allocated above those. Connections are stored SORTED BY INNOVATION and nodes sorted by
// id, so two genomes built by different routes (one by mutation, one by crossover) serialize
// identically — Map iteration order would not, and that difference is invisible until a checkpoint
// fails to reproduce a run.

export function createGenome(inputs, outputs, { id = 'g' } = {}) {
  const nodes = []
  for (let i = 0; i < inputs; i++) nodes.push({ id: i, kind: 'input' })
  nodes.push({ id: inputs, kind: 'bias' })
  for (let o = 0; o < outputs; o++) nodes.push({ id: inputs + 1 + o, kind: 'output' })
  return { id, inputs, outputs, nodes, connections: [], fitness: 0, adjustedFitness: 0 }
}

export function cloneGenome(g, id = g.id) {
  return {
    ...g,
    id,
    nodes: g.nodes.map(n => ({ ...n })),
    connections: g.connections.map(c => ({ ...c })),
  }
}

export function inputNodeIds(g) { return g.nodes.filter(n => n.kind === 'input' || n.kind === 'bias').map(n => n.id) }
export function outputNodeIds(g) { return g.nodes.filter(n => n.kind === 'output').map(n => n.id) }

// ── Innovation registry ───────────────────────────────────────────────────────
//
// Memoised for the whole run. `key` is the (from, to) pair, so the same structural change always
// gets the same number however many generations apart it appears.
export function createInnovationRegistry(startNodeId = 0) {
  const connections = new Map()
  let nextInnovation = 0
  let nextNodeId = startNodeId

  return {
    connection(from, to) {
      const key = `${from}>${to}`
      if (!connections.has(key)) connections.set(key, nextInnovation++)
      return connections.get(key)
    },
    node() { return nextNodeId++ },
    reserveNodes(n) { nextNodeId = Math.max(nextNodeId, n) },
    snapshot() { return { connections: [...connections], nextInnovation, nextNodeId } },
    restore(s) {
      connections.clear()
      for (const [k, v] of s.connections) connections.set(k, v)
      nextInnovation = s.nextInnovation
      nextNodeId = s.nextNodeId
    },
  }
}

// Fully connects every input (and the bias) to every output. The usual NEAT starting point:
// minimal structure, and everything it grows from here is earned.
export function connectFully(genome, registry, rng) {
  for (const from of inputNodeIds(genome)) {
    for (const to of outputNodeIds(genome)) {
      addConnection(genome, from, to, rng.range(-1, 1), registry)
    }
  }
  return genome
}

function addConnection(genome, from, to, weight, registry) {
  const innovation = registry.connection(from, to)
  genome.connections.push({ from, to, weight, enabled: true, innovation })
  genome.connections.sort((a, b) => a.innovation - b.innovation)
  return genome
}

// ── Mutation ──────────────────────────────────────────────────────────────────

export function mutate(genome, registry, rng, config = DEFAULT_CONFIG) {
  if (rng() < config.weightMutateRate) mutateWeights(genome, rng, config)
  if (rng() < config.addConnectionRate) mutateAddConnection(genome, registry, rng)
  if (rng() < config.addNodeRate) mutateAddNode(genome, registry, rng)
  if (rng() < config.toggleEnableRate) mutateToggle(genome, rng)
  return genome
}

function mutateWeights(genome, rng, config) {
  for (const c of genome.connections) {
    if (rng() < config.weightPerturbRate) {
      c.weight += rng.range(-1, 1) * config.weightPerturbPower
    } else {
      c.weight = rng.range(-2, 2)     // occasional full reset, to escape a local minimum
    }
    c.weight = Math.max(-8, Math.min(8, c.weight))
  }
}

// Adds a connection between two previously unconnected nodes — but only in a direction that keeps
// the network acyclic, since this is a feed-forward implementation.
function mutateAddConnection(genome, registry, rng) {
  const order = topologicalOrder(genome)
  const rank = new Map(order.map((id, i) => [id, i]))
  const existing = new Set(genome.connections.map(c => `${c.from}>${c.to}`))

  const candidates = []
  for (const from of genome.nodes) {
    if (from.kind === 'output') continue
    for (const to of genome.nodes) {
      if (to.kind === 'input' || to.kind === 'bias') continue
      if (from.id === to.id) continue
      if (existing.has(`${from.id}>${to.id}`)) continue
      if ((rank.get(from.id) ?? 0) >= (rank.get(to.id) ?? 0)) continue   // would make a cycle
      candidates.push([from.id, to.id])
    }
  }
  if (candidates.length === 0) return
  const [from, to] = rng.pick(candidates)
  addConnection(genome, from, to, rng.range(-1, 1), registry)
}

// Splices a new neuron into an existing connection. The old connection is DISABLED rather than
// removed (its gene stays, for alignment), and the two new ones are weighted 1 and w.
//
// The usual claim is that this leaves behaviour "unchanged". It does not, quite: the signal now
// passes through the new node's SIGMOID, so it is preserved only approximately, and only near the
// middle of the curve. That is fine and it is what the original paper does — the point is that the
// change is SMALL, so a structural mutation is not immediately fatal and gets a few generations to
// be tuned before it has to justify itself.
function mutateAddNode(genome, registry, rng) {
  const live = genome.connections.filter(c => c.enabled)
  if (live.length === 0) return
  const c = rng.pick(live)
  c.enabled = false

  const id = registry.node()
  genome.nodes.push({ id, kind: 'hidden' })
  genome.nodes.sort((a, b) => a.id - b.id)

  addConnection(genome, c.from, id, 1, registry)
  addConnection(genome, id, c.to, c.weight, registry)
}

function mutateToggle(genome, rng) {
  if (genome.connections.length === 0) return
  const c = rng.pick(genome.connections)
  c.enabled = !c.enabled
}

// ── Crossover ─────────────────────────────────────────────────────────────────
//
// Genes with matching innovation numbers are inherited from either parent at random; genes only
// one parent has come from the FITTER one. On equal fitness the SMALLER genome wins, which is a
// deliberate anti-bloat rule and also makes the operation deterministic.
export function crossover(a, b, rng) {
  let fitter = a, other = b
  if (b.fitness > a.fitness) { fitter = b; other = a }
  else if (b.fitness === a.fitness && b.connections.length < a.connections.length) { fitter = b; other = a }

  const child = createGenome(fitter.inputs, fitter.outputs, { id: `${fitter.id}+${other.id}` })
  const otherByInnovation = new Map(other.connections.map(c => [c.innovation, c]))
  const nodeIds = new Set(child.nodes.map(n => n.id))

  for (const c of fitter.connections) {
    const match = otherByInnovation.get(c.innovation)
    const gene = match && rng() < 0.5 ? { ...match } : { ...c }
    // A disabled gene in either parent has a chance to come back on, so a useful connection is not
    // lost forever to one unlucky toggle.
    if (!c.enabled || (match && !match.enabled)) gene.enabled = rng() < 0.25
    child.connections.push(gene)
    for (const id of [gene.from, gene.to]) {
      if (!nodeIds.has(id)) { child.nodes.push({ id, kind: 'hidden' }); nodeIds.add(id) }
    }
  }

  child.nodes.sort((a2, b2) => a2.id - b2.id)
  child.connections.sort((x, y) => x.innovation - y.innovation)
  return child
}

// ── Compatibility ─────────────────────────────────────────────────────────────

export function compatibility(a, b, config = DEFAULT_CONFIG) {
  const ai = new Map(a.connections.map(c => [c.innovation, c]))
  const bi = new Map(b.connections.map(c => [c.innovation, c]))
  const maxA = a.connections.length ? a.connections[a.connections.length - 1].innovation : -1
  const maxB = b.connections.length ? b.connections[b.connections.length - 1].innovation : -1
  const cutoff = Math.min(maxA, maxB)

  let excess = 0, disjoint = 0, matching = 0, weightDiff = 0
  for (const inn of new Set([...ai.keys(), ...bi.keys()])) {
    const x = ai.get(inn), y = bi.get(inn)
    if (x && y) { matching++; weightDiff += Math.abs(x.weight - y.weight) }
    else if (inn > cutoff) excess++
    else disjoint++
  }

  // Normalizing by genome size matters once networks get big; below 20 genes it distorts more than
  // it helps, which is the standard NEAT carve-out.
  const n = Math.max(a.connections.length, b.connections.length)
  const norm = n < 20 ? 1 : n
  const avgWeight = matching ? weightDiff / matching : 0

  return (config.excessCoefficient * excess) / norm
       + (config.disjointCoefficient * disjoint) / norm
       + config.weightCoefficient * avgWeight
}

// ── Network ───────────────────────────────────────────────────────────────────
//
// Compiles a genome into something you can call. The topological sort is keyed on node id, so the
// evaluation order is identical however the genome was built — a test reverses the gene arrays and
// asserts the output is bit-identical.
export function topologicalOrder(genome) {
  const ids = genome.nodes.map(n => n.id).sort((a, b) => a - b)
  const incoming = new Map(ids.map(id => [id, 0]))
  const edges = new Map(ids.map(id => [id, []]))
  for (const c of genome.connections) {
    if (!c.enabled) continue
    if (!edges.has(c.from) || !incoming.has(c.to)) continue
    edges.get(c.from).push(c.to)
    incoming.set(c.to, incoming.get(c.to) + 1)
  }

  for (const list of edges.values()) list.sort((a, b) => a - b)
  const ready = ids.filter(id => incoming.get(id) === 0)
  const order = []
  while (ready.length) {
    const id = ready.shift()
    order.push(id)
    for (const to of (edges.get(id) ?? [])) {
      incoming.set(to, incoming.get(to) - 1)
      if (incoming.get(to) === 0) {
        ready.push(to)
        ready.sort((a, b) => a - b)
      }
    }
  }
  // Any node left over sat in a cycle; append it deterministically rather than dropping it.
  for (const id of ids) if (!order.includes(id)) order.push(id)
  return order
}

export function buildNetwork(genome) {
  const order = topologicalOrder(genome)
  const byId = new Map(genome.nodes.map(n => [n.id, n]))
  const incoming = new Map(genome.nodes.map(n => [n.id, []]))
  for (const c of genome.connections) {
    if (c.enabled && incoming.has(c.to)) incoming.get(c.to).push(c)
  }
  // ⚠️ Sorted, because FLOATING-POINT ADDITION IS NOT ASSOCIATIVE. Summing the same inputs in a
  // different order gives a slightly different answer, and "slightly" compounds through a network
  // into a different decision. Two genomes that are structurally identical but were BUILT
  // differently — one by mutation, one by crossover — hold their genes in different array order,
  // so without this they do not agree and a checkpointed run cannot reproduce itself.
  for (const list of incoming.values()) list.sort((a, b) => a.innovation - b.innovation)
  const outputs = outputNodeIds(genome).sort((a, b) => a - b)

  return function activate(inputs) {
    const value = new Map()
    for (const n of genome.nodes) {
      if (n.kind === 'input') value.set(n.id, inputs[n.id] ?? 0)
      else if (n.kind === 'bias') value.set(n.id, 1)
      else value.set(n.id, 0)
    }
    for (const id of order) {
      const node = byId.get(id)
      if (!node || node.kind === 'input' || node.kind === 'bias') continue
      let sum = 0
      for (const c of incoming.get(id)) sum += (value.get(c.from) ?? 0) * c.weight
      value.set(id, sigmoid(sum))
    }
    return outputs.map(id => value.get(id) ?? 0)
  }
}

// The classic steepened sigmoid from the NEAT paper. The steepness matters: a plain sigmoid is so
// flat that weights have to grow large before the network can make a confident decision.
function sigmoid(x) { return 1 / (1 + Math.exp(-4.9 * x)) }
