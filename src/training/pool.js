// ── The worker pool ([training]) ────────────────────────────────────────────
//
// Evaluating a generation is embarrassingly parallel: every genome plays the same slate, and no
// genome's result depends on any other's. So the whole generation fans out across cores and the
// wall-clock cost drops by roughly the worker count.
//
// ⚠️ THIS DOES NOT CHANGE THE RESULT. Every play is seeded from its situation, so which worker
// happened to run it is irrelevant — a run with eight workers produces the same fitness values, in
// the same order, as a run with one. A test asserts that, because a parallel trainer that quietly
// disagreed with the serial one would be worse than no parallelism at all.
//
// Work is handed out one genome at a time rather than sliced up front. Genomes vary a lot in cost
// (a coverage that gives up a long completion runs three times the ticks of one that forces a
// quick sack), so a static split leaves most workers idle waiting for the unlucky one.

import { Worker } from 'node:worker_threads'
import { fileURLToPath } from 'node:url'
import { cpus } from 'node:os'

const WORKER_URL = new URL('./worker.mjs', import.meta.url)

// Leave a couple of cores for the OS and the parent process; saturating every core makes the whole
// machine unresponsive and does not actually finish sooner.
export function defaultWorkerCount() {
  return Math.max(1, Math.min(10, cpus().length - 2))
}

export function createPool(size = defaultWorkerCount()) {
  const workers = []
  const idle = []
  let queue = []
  let onDone = null
  let results = null
  let pending = 0
  let errors = []

  for (let i = 0; i < size; i++) {
    const w = new Worker(fileURLToPath(WORKER_URL))
    w.on('message', (msg) => {
      // ⚠️ pump() here too, not just on a completed result. A worker takes a moment to load the
      // module graph, so `evaluate()` almost always runs BEFORE the first `ready` arrives — the
      // queue is full, `idle` is empty, and without this the work simply sits there. The run does
      // not error, it just never finishes.
      if (msg.type === 'ready') { idle.push(w); pump(); return }
      if (msg.type !== 'result') return

      // ⚠️ A worker that threw still posts a result — with fitness 0 and an `error` string. Nothing
      // read that field, so a genome that CRASHED was indistinguishable from a genome that played
      // badly, and 59% of a real population was being culled for a bug nobody could see.
      if (msg.error) {
        errors.push(msg.error)
        if (errors.length <= 3) console.error(`[pool] genome ${msg.index} threw: ${msg.error}`)
      }
      results[msg.index] = msg
      pending--
      idle.push(w)
      pump()
      if (pending === 0 && queue.length === 0 && onDone) { const d = onDone; onDone = null; d(results) }
    })
    w.on('error', (err) => {
      // A worker that dies takes its genome's score with it. Recording a zero and carrying on is
      // right: one bad genome must not end a run that has been going for hours.
      console.error('[pool] worker error:', err?.message ?? err)
      pending--
      if (pending === 0 && queue.length === 0 && onDone) { const d = onDone; onDone = null; d(results) }
    })
    // ⚠️ NOT unref'd. A pending promise does not keep Node alive by itself, so unref'ing every
    // worker let the process exit the moment the main thread ran out of synchronous work — the
    // parallel run simply produced nothing and looked like a hang. The pool is shut down
    // explicitly by destroy() instead, which train() always calls.
    workers.push(w)
  }

  function pump() {
    while (idle.length && queue.length) {
      const w = idle.pop()
      w.postMessage(queue.shift())
    }
  }

  return {
    size,



    // [coevolve] Fan out a generation of series jobs. Each result carries a fitness for one offense
    // genome and one per defense it faced, so a single pass scores both populations.
    evaluateSeries(jobs) {
      return new Promise((resolve) => {
        if (jobs.length === 0) { resolve([]); return }
        errors = []
        results = new Array(jobs.length).fill(null)
        pending = jobs.length
        queue = jobs.map((job, index) => ({ type: 'series', index, job }))
        onDone = resolve
        pump()
      })
    },

    async destroy() {
      for (const w of workers) w.postMessage({ type: 'stop' })
      await Promise.all(workers.map(w => w.terminate().catch(() => {})))
      workers.length = 0
      idle.length = 0
    },
  }
}
