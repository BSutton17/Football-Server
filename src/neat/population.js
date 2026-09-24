// ── Population ([training]) ──────────────────────────────────────────────────
//
// The generation loop: score everybody, group them into species, let the good ones breed, repeat.
//
// The only subtle part is FITNESS SHARING. A species' members divide their fitness among
// themselves, so a big successful species does not simply take over — twenty copies of a good idea
// score the same in total as one copy of it, which leaves room for the other ideas to be tuned
// until they can compete. Without it NEAT converges on whatever worked first and then stops.
//
// Imports nothing from the game; see the note at the top of neat.js.

import {
  DEFAULT_CONFIG, createRng, createGenome, cloneGenome, connectFully,
  createInnovationRegistry, mutate, crossover, compatibility,
} from './neat.js'

export function createPopulation({
  inputs,
  outputs,
  config = DEFAULT_CONFIG,
  seed = 1,
} = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config }
  const rng = createRng(seed)
  const registry = createInnovationRegistry(inputs + 1 + outputs)

  let generation = 0
  let genomes = []
  let species = []
  let champion = null
  let championGeneration = -1
  let threshold = cfg.compatibilityThreshold

// How far off `targetSpecies` the grouping may drift before the threshold is re-solved, and how
// many bisection steps that takes. The tolerance stops the threshold twitching every generation
// over a difference of one species; the step count is ample for a monotone search.
const SPECIES_TOLERANCE = 2
const BISECT_STEPS = 14

  for (let i = 0; i < cfg.populationSize; i++) {
    const g = createGenome(inputs, outputs, { id: `g0-${i}` })
    connectFully(g, registry, rng)
    mutate(g, registry, rng, cfg)
    genomes.push(g)
  }

  // ── Speciation ──────────────────────────────────────────────────────────────
  //
  // Each species keeps a REPRESENTATIVE, frozen for the generation. Comparing against a live
  // member that is itself being replaced makes the grouping depend on iteration order.
  function speciate() {
    const carry = species.map(s => ({ ...s, members: [], prevBest: s.best ?? -Infinity }))

    // Memoised compatibility, keyed on (genome, representative) object identity.
    //
    // The bisection below re-groups the SAME population against the SAME representatives at a
    // dozen different thresholds, and a genome's distance to a representative does not depend on
    // the threshold at all — only the comparison against it does. Computing the distance once
    // instead of once per pass took a generation from 35.6s back to roughly what it cost before
    // the bisection existed. `compatibility` builds two Maps and a Set over every connection, so
    // on a 560-gene genome it is far from free.
    const seen = new WeakMap()
    let nextKey = 0
    const keyOf = (obj) => {
      let k = seen.get(obj)
      if (k === undefined) { k = nextKey++; seen.set(obj, k) }
      return k
    }
    const memo = new Map()
    const dist = (g, rep) => {
      const k = `${keyOf(g)}:${keyOf(rep)}`
      let v = memo.get(k)
      if (v === undefined) { v = compatibility(g, rep, cfg); memo.set(k, v) }
      return v
    }

    // Groups the population at a GIVEN threshold without touching the persistent species list, so
    // it can be called repeatedly while searching for a threshold that works.
    // A new species' representative is the live genome rather than a clone, so its identity stays
    // stable across passes and the memo can hit. speciate() reassigns every representative from
    // the species' members at the end regardless, so nothing downstream sees the difference.
    const groupAt = (th) => {
      const out = carry.map(s => ({ ...s, members: [] }))
      for (const g of genomes) {
        let home = null
        for (const s of out) {
          if (dist(g, s.representative) < th) { home = s; break }
        }
        if (!home) {
          home = { id: out.length, representative: g, members: [], best: -Infinity, staleFor: 0 }
          out.push(home)
        }
        home.members.push(g)
      }
      return out.filter(s => s.members.length > 0)
    }

    let grouped = groupAt(threshold)

    // ⚠️ BISECT THE THRESHOLD; DO NOT NUDGE IT.
    //
    // The old code moved the threshold by a fixed ±0.3 per generation toward `targetSpecies`. That
    // assumes species count responds SMOOTHLY to the threshold. Here it does not, and the reason is
    // in `compatibility`: excess and disjoint genes are divided by genome size, and `connectFully`
    // starts every genome with inputs x outputs connections (560 for this problem). Structure
    // therefore contributes almost nothing and the distance is essentially
    // `weightCoefficient * mean|weight difference|` — an average over 560 genes, which by the law
    // of large numbers concentrates almost all pairs onto nearly the same value.
    //
    // So the count is a STEP FUNCTION of the threshold, and a 0.3 step leaps straight over the
    // step: a real 250-generation run alternated 1, 32, 1, 38, 1, 42 species every single
    // generation. With one species, fitness sharing divides every genome by the same number and
    // does nothing; the stagnation counter and each species' best-ever score are meaningless when
    // the grouping is rebuilt from scratch every generation. Evolution had no selection structure
    // at all, which is exactly what a flat holdout looks like.
    //
    // Species count is monotonically non-increasing in the threshold, so a bisection finds a
    // workable value whatever shape the distance distribution has. It costs a few extra grouping
    // passes — negligible beside evaluating 150 genomes.
    const off = (n) => Math.abs(n - cfg.targetSpecies)
    if (off(grouped.length) > SPECIES_TOLERANCE) {
      let lo = 0.01
      let hi = Math.max(threshold * 4, 16)
      let bestTh = threshold
      for (let i = 0; i < BISECT_STEPS; i++) {
        const mid = (lo + hi) / 2
        const trial = groupAt(mid)
        if (off(trial.length) < off(grouped.length)) { grouped = trial; bestTh = mid }
        if (trial.length === cfg.targetSpecies) { bestTh = mid; break }
        // More species than wanted means genomes are being split too readily: raise the threshold.
        if (trial.length > cfg.targetSpecies) lo = mid
        else hi = mid
      }
      threshold = bestTh
    }

    species = grouped

    for (const s of species) {
      s.members.sort((a, b) => b.fitness - a.fitness)
      const best = s.members[0].fitness
      s.staleFor = best > s.best ? 0 : s.staleFor + 1
      s.best = Math.max(s.best, best)
      s.representative = cloneGenome(rng.pick(s.members))
    }
  }

  // Fitness sharing: divide by species size.
  function share() {
    for (const s of species) {
      for (const g of s.members) g.adjustedFitness = g.fitness / s.members.length
      s.totalAdjusted = s.members.reduce((a, g) => a + g.adjustedFitness, 0)
    }
  }

  function breed() {
    // Cull species that have stopped improving — but never all of them.
    const fresh = species.filter(s => s.staleFor < cfg.stagnationLimit)
    const pool = fresh.length >= 2 ? fresh : species

    const grandTotal = pool.reduce((a, s) => a + (s.totalAdjusted ?? 0), 0)
    const next = []

    // Offspring allocated in proportion to each species' share of total ADJUSTED fitness — which
    // is where fitness sharing does its work, since a large species divides its score among more
    // members and therefore earns proportionally fewer children per member.
    const quotas = pool.map(s => ({
      species: s,
      quota: grandTotal > 0
        ? Math.max(cfg.minSpeciesSize, Math.round((s.totalAdjusted / grandTotal) * cfg.populationSize))
        : Math.max(cfg.minSpeciesSize, Math.floor(cfg.populationSize / pool.length)),
    }))

    // Proportional rounding overshoots; trim from the largest so the population stays fixed.
    let allocated = quotas.reduce((a, q) => a + q.quota, 0)
    while (allocated > cfg.populationSize) {
      quotas.sort((a, b) => b.quota - a.quota)
      if (quotas[0].quota <= cfg.minSpeciesSize) break
      quotas[0].quota--
      allocated--
    }

    for (const { species: s, quota } of quotas) {
      if (next.length >= cfg.populationSize) break
      const room = Math.min(quota, cfg.populationSize - next.length)
      let made = 0

      // Elites pass through untouched — but only from a species big enough for "elite" to mean
      // something. Copying the single member of a two-genome species every generation just freezes
      // it in place.
      if (s.members.length > cfg.minSpeciesSize) {
        for (let e = 0; e < Math.min(cfg.elitism, s.members.length) && made < room; e++) {
          next.push(cloneGenome(s.members[e], `g${generation + 1}-e${next.length}`))
          made++
        }
      }

      const keep = Math.max(1, Math.round(s.members.length * cfg.survivalRate))
      const survivors = s.members.slice(0, keep)

      while (made < room) {
        const a = rng.pick(survivors)
        let child
        if (survivors.length > 1 && rng() < cfg.crossoverRate) {
          const b = (rng() < cfg.interspeciesMateRate && pool.length > 1)
            ? rng.pick(rng.pick(pool).members)
            : rng.pick(survivors)
          child = crossover(a, b, rng)
        } else {
          child = cloneGenome(a)
        }
        child.id = `g${generation + 1}-${next.length}`
        mutate(child, registry, rng, cfg)
        next.push(child)
        made++
      }
    }

    // Top up from the champion if rounding left the population short.
    while (next.length < cfg.populationSize) {
      const parent = champion ?? genomes[0]
      const child = cloneGenome(parent, `g${generation + 1}-${next.length}`)
      mutate(child, registry, rng, cfg)
      next.push(child)
    }

    genomes = next.slice(0, cfg.populationSize)
  }

  return {
    get generation() { return generation },
    get genomes() { return genomes },
    get species() { return species },
    get champion() { return champion },
    get championGeneration() { return championGeneration },
    config: cfg,

    // One generation. `evaluate(genomes)` must set `.fitness` on each and may run them in any order.
    step(evaluate) {
      evaluate(genomes)

      // ⚠️ The champion is snapshotted HERE, at evaluation time. Reading it back after breed()
      // returns a genome whose fitness belongs to its parent — elites are cloned with the parent's
      // score, so a "best genome" taken afterwards can be a stale-fitness impostor. That exact bug
      // cost a Kingdoms run its saved model.
      const best = genomes.reduce((a, g) => (g.fitness > a.fitness ? g : a), genomes[0])
      if (!champion || best.fitness > champion.fitness) {
        champion = cloneGenome(best)
        championGeneration = generation
      }

      const record = {
        generation,
        best: best.fitness,
        // THIS generation's best genome, not the all-time champion. A caller comparing generations
        // on a fixed holdout needs the current contender — handing it the all-time champion means
        // it re-scores the same genome forever and every generation looks identical.
        bestGenome: cloneGenome(best),
        mean: genomes.reduce((a, g) => a + g.fitness, 0) / genomes.length,
        species: species.length,
        threshold,
        championFitness: champion.fitness,
        championGeneration,
      }

      speciate()
      share()
      breed()
      generation++
      return record
    },

    // Everything needed to resume mid-stream.
    snapshot() {
      return {
        generation,
        rngState: rng.getState(),
        threshold,
        registry: registry.snapshot(),
        genomes: genomes.map(g => cloneGenome(g)),
        champion: champion ? cloneGenome(champion) : null,
        championGeneration,
        // ⚠️ Species history HAS to be here. A species carries its best-ever score and how long it
        // has gone without improving, and stagnation culling reads both — so a resume that started
        // from an empty species list would give every species a clean slate and cull nothing. The
        // run would then diverge from the one it was supposed to be continuing. Members are not
        // saved because speciate() reassigns them from scratch every generation.
        species: species.map(s2 => ({
          id: s2.id,
          representative: cloneGenome(s2.representative),
          best: s2.best,
          staleFor: s2.staleFor,
        })),
      }
    },

    restore(s) {
      generation = s.generation
      rng.setState(s.rngState)
      threshold = s.threshold
      registry.restore(s.registry)
      genomes = s.genomes.map(g => cloneGenome(g))
      champion = s.champion ? cloneGenome(s.champion) : null
      championGeneration = s.championGeneration
      species = (s.species ?? []).map(x => ({
        id: x.id,
        representative: cloneGenome(x.representative),
        members: [],
        best: x.best,
        staleFor: x.staleFor,
      }))
    },
  }
}
