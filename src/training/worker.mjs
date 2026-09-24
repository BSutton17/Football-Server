// ── One evaluation worker ([training]) ──────────────────────────────────────
//
// Plays one genome through one slate and posts back its fitness. Spawned by pool.js and reused for
// the whole run, because standing a worker up costs far more than an evaluation does.
//
// Each worker holds its OWN copy of the game's module state (the room and game registries), which
// is exactly what you want: two workers cannot collide on a room id or leak a half-finished game
// into each other. And because every play is seeded from the situation, which worker happened to
// run it makes no difference to the result — the run stays reproducible.

import { parentPort } from 'node:worker_threads'
import { evaluateGenome } from './train.js'
import { evaluateDeep } from './deepTrain.js'

parentPort.on('message', (msg) => {
  // [deep] One side against a frozen opponent. Same contract as 'evaluate': a genome in, a fitness
  // back, index-aligned by the pool. The opponent genome travels with the job because each worker
  // has its own module state and cannot see anything the parent set up.
  if (msg.type === 'evaluateDeep') {
    try {
      const { fitness, result } = evaluateDeep(msg.genome, {
        side: msg.side, slate: msg.slate, expected: msg.expected, opponents: msg.opponents,
      })
      parentPort.postMessage({
        type: 'result', index: msg.index, fitness,
        invalid: result.invalid, plays: msg.slate.situations.length,
      })
    } catch (err) {
      parentPort.postMessage({ type: 'result', index: msg.index, fitness: 0, error: err?.message ?? String(err), plays: 0 })
    }
    return
  }

  if (msg.type === 'evaluate') {
    try {
      const { fitness, result } = evaluateGenome(msg.genome, msg.slate, msg.expected)
      parentPort.postMessage({
        type: 'result',
        index: msg.index,
        fitness,
        invalid: result.invalid,
        plays: msg.slate.situations.length,
      })
    } catch (err) {
      // A broken genome must not take the worker down with it — the run has 149 others to get
      // through. It scores zero, which is the same thing a genome that cannot produce a legal call
      // gets anyway.
      parentPort.postMessage({
        type: 'result',
        index: msg.index,
        fitness: 0,
        error: err?.message ?? String(err),
        plays: 0,
      })
    }
    return
  }

  if (msg.type === 'stop') parentPort.close()
})

parentPort.postMessage({ type: 'ready' })
