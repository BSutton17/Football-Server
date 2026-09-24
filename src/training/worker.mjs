// ── One evaluation worker ([coevolve]) ──────────────────────────────────────
//
// Plays one job's worth of series and posts back the scores. Spawned by pool.js and reused for the
// whole run, because standing a worker up costs far more than an evaluation does.
//
// Each worker holds its OWN copy of the game's module state (the room and game registries), which
// is exactly what you want: two workers cannot collide on a room id or leak a half-finished game
// into each other. And because every series is seeded from its situation, which worker happened to
// run it makes no difference to the result — the run stays reproducible.
//
// ⚠️ A job carries its own genomes. A worker can see nothing the parent set up, so anything
// referenced by index would be resolved against whatever happened to be in this worker's memory.

import { parentPort } from 'node:worker_threads'
import { runJob } from './coevolve.js'

parentPort.on('message', (msg) => {
  if (msg.type === 'series') {
    try {
      parentPort.postMessage({ type: 'result', index: msg.index, job: runJob(msg.job) })
    } catch (err) {
      // A broken genome must not take the worker down with it — the run has ninety-nine others to
      // get through. It scores nothing, which is the same as a genome that could not produce a
      // legal call anyway.
      parentPort.postMessage({
        type: 'result', index: msg.index, job: null, error: err?.message ?? String(err),
      })
    }
    return
  }

  if (msg.type === 'stop') parentPort.close()
})

parentPort.postMessage({ type: 'ready' })
