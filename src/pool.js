// Run tasks with a concurrency limit that can change while running.
// `next()` returns the next task (a function returning a promise) or null when there is nothing
// to start right now. Returns when nothing is running and next() has no more work.
export async function runPool(next, control) {
  const running = new Set();
  for (;;) {
    while (!control.stopped() && running.size < control.concurrency()) {
      const task = next();
      if (!task) break;
      const p = Promise.resolve()
        .then(task)
        .catch((err) => control.report.log(`task failed: ${err.stack || err}`))
        .finally(() => running.delete(p));
      running.add(p);
    }
    if (!running.size) return;
    // Wake on a finished task, or after a moment so a raised concurrency limit applies right away.
    await Promise.race([...running, new Promise((r) => setTimeout(r, 500))]);
  }
}

// What the crawler tells the outside world. The CLI prints to the console; the server's
// engine collects the same calls for the live dashboard.
export const consoleReport = {
  phase(name, detail) { console.log(`\n${name}${detail ? ` — ${detail}` : ''}`); },
  start(phase, url, label) { return { phase, url, label, startedAt: Date.now() }; },
  end(job, r) {
    const mark = r.status === 'ok' ? '✓' : r.status === 'unchanged' ? '=' : r.status === 'error' ? '✗' : '·';
    const what = r.status === 'ok' && r.events !== undefined ? ` — ${r.events} events (${r.added} new)` : '';
    console.log(`  ${mark} ${job.label ? `${job.label} ← ` : ''}${job.url}${what}${r.note ? ` (${r.note})` : ''}`);
  },
  log(msg) { console.log(`  ${msg}`); },
};

export const defaultControl = (concurrency = 1) => ({
  concurrency: () => concurrency,
  stopped: () => false,
  report: consoleReport,
});
