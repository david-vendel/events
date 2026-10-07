// Pages waiting for the AI page reader. Crawling never waits for AI: a page that needs it (no
// recipe yet, or a recipe that stopped reading it well) is put here, and a step of each cycle works
// through the queue while AI is on, within its budget, and not paused by the plan's limit. A job
// that failed because AI wasn't available stays, and is tried again later. So AI is spent once per
// kind of page; after that the recipe it wrote reads every visit without it.
const MAX_JOBS = 1000;
const MAX_TRIES = 4;
const RETRY_AFTER = 3600e3; // after a failed try: 1, 2, 4 hours…

/**
 * Queue a page for AI. job: { url, origin, template, reason, priority, repair? }. A page already
 * waiting keeps its place and takes the higher priority. Returns true if it's new in the queue.
 */
export function enqueueAi(state, job) {
  const q = (state.aiQueue ??= {});
  const cur = q[job.url];
  if (cur) {
    if (job.priority > cur.priority) Object.assign(cur, { priority: job.priority, reason: job.reason, repair: job.repair });
    return false;
  }
  // One new page per template waits at a time: the recipe written for it reads the others.
  if (!job.repair && job.template && Object.values(q).some((j) => j.template === job.template)) return false;
  q[job.url] = { ...job, addedAt: new Date().toISOString(), tries: 0 };
  const urls = Object.keys(q);
  if (urls.length > MAX_JOBS) {
    const worst = urls.sort((a, b) => q[a].priority - q[b].priority || q[b].addedAt.localeCompare(q[a].addedAt))[0];
    delete q[worst];
  }
  return true;
}

/** Jobs that may run now, best first: repairs of pages that had events, then by priority, oldest first. */
export function aiJobsDue(state, now = Date.now()) {
  return Object.values(state.aiQueue || {})
    .filter((j) => !j.nextTryAt || Date.parse(j.nextTryAt) <= now)
    .sort((a, b) => Number(Boolean(b.repair)) - Number(Boolean(a.repair)) || b.priority - a.priority || a.addedAt.localeCompare(b.addedAt));
}

export function aiJobDone(state, url) {
  delete state.aiQueue?.[url];
}

/** A try that didn't get an answer from AI (limit hit, AI down): later, and dropped after a few. */
export function aiJobFailed(state, url, error) {
  const j = state.aiQueue?.[url];
  if (!j) return;
  j.tries++;
  j.lastError = error;
  if (j.tries >= MAX_TRIES) { delete state.aiQueue[url]; return; }
  j.nextTryAt = new Date(Date.now() + RETRY_AFTER * 2 ** (j.tries - 1)).toISOString();
}

/** A try that failed only because the plan's limit was hit doesn't count against the page. */
export function aiJobPostponed(state, url, until) {
  const j = state.aiQueue?.[url];
  if (j) j.nextTryAt = new Date(until).toISOString();
}
