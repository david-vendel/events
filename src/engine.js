// Runs the crawler inside the server so the admin panel can watch and control it:
// start/stop, number of parallel workers, budgets, and a live record of what's happening.
import { loadState, saveState } from './store.js';
import { runCycle } from './crawler.js';
import { aiAvailable, aiStatus, setAiRecorder } from './ai.js';
import { facebookEnabled } from './corroborate.js';

export const DEFAULT_SETTINGS = {
  concurrency: 5, // pages fetched in parallel
  pagesPerCycle: 60,
  aiPerCycle: 5,
  verifyPerCycle: 15,
  cycleEveryMin: 60,
};
const LIMITS = {
  concurrency: [1, 50], pagesPerCycle: [1, 2000], aiPerCycle: [0, 100], verifyPerCycle: [0, 500], cycleEveryMin: [1, 1440],
};
const MAX_RECENT = 300;
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const MAX_AI_LOG = 5000;
const SAVE_EVERY_MS = 15000;

export class Engine {
  constructor() {
    this.state = loadState();
    this.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
    this.state.settings = this.settings;
    this.running = false; // a loop is active (cycle running or waiting for the next one)
    this.stopping = false;
    this.phase = { name: 'Idle', detail: '' };
    this.cycle = null; // ctx of the current/last cycle: budget, used, found
    this.cycles = 0;
    this.nextCycleAt = null;
    this.active = new Map(); // job id -> job (pages being fetched right now)
    this.recent = []; // finished jobs, newest first
    this.log = []; // phase changes and messages, newest first
    this.seq = 0;
    this.wake = null;
    this.dirty = false;

    setAiRecorder((rec) => {
      this.state.ai.push(rec);
      if (this.state.ai.length > MAX_AI_LOG) this.state.ai.splice(0, this.state.ai.length - MAX_AI_LOG);
      const u = rec.usage;
      this.message(`AI ${rec.kind}: ${rec.target} — ${rec.error || `${fmtTokens(u.input + u.cacheRead + u.cacheWrite + u.output)} tokens, ${(rec.ms / 1000).toFixed(1)} s`}`);
    });
    setInterval(() => this.save(), SAVE_EVERY_MS).unref();
  }

  // ---------------------------------------------------------------- control

  /** Start crawling: cycles repeat every cycleEveryMin until stopped (or just one with once). */
  start({ once = false } = {}) {
    if (this.running) {
      this.wake?.(); // waiting between cycles: start the next one now
      return;
    }
    this.running = true;
    this.stopping = false;
    this.loop(once).catch((err) => this.message(`engine error: ${err.stack || err}`));
  }

  /** Finish the pages being fetched right now, then stop. */
  stop() {
    if (!this.running) return;
    this.stopping = true;
    this.message('Stopping after current pages finish…');
    this.wake?.();
  }

  updateSettings(patch) {
    for (const [k, [min, max]] of Object.entries(LIMITS)) {
      if (patch[k] === undefined) continue;
      const v = Math.round(Number(patch[k]));
      if (Number.isFinite(v)) this.settings[k] = Math.min(max, Math.max(min, v));
    }
    this.dirty = true;
    this.save();
  }

  async loop(once) {
    while (!this.stopping) {
      this.cycles++;
      this.nextCycleAt = null;
      try {
        await runCycle(this.state, {
          maxPages: this.settings.pagesPerCycle,
          maxAi: this.settings.aiPerCycle,
          maxVerify: this.settings.verifyPerCycle,
        }, this.control());
      } catch (err) {
        this.message(`cycle failed: ${err.stack || err}`);
      }
      this.dirty = true;
      this.save();
      if (once || this.stopping) break;
      this.nextCycleAt = Date.now() + this.settings.cycleEveryMin * 60e3;
      this.phase = { name: 'Waiting', detail: 'for the next cycle' };
      await new Promise((resolve) => {
        const t = setTimeout(resolve, this.nextCycleAt - Date.now());
        this.wake = () => { clearTimeout(t); resolve(); };
      });
      this.wake = null;
    }
    this.running = false;
    this.stopping = false;
    this.nextCycleAt = null;
    this.phase = { name: 'Idle', detail: '' };
  }

  // What runCycle uses to read settings and report progress.
  control() {
    return {
      concurrency: () => this.settings.concurrency,
      stopped: () => this.stopping,
      report: {
        begin: (ctx) => { this.cycle = { ...ctx, startedAt: Date.now(), n: this.cycles }; },
        phase: (name, detail) => {
          this.phase = { name, detail: detail || '' };
          this.message(`${name}${detail ? ` — ${detail}` : ''}`);
        },
        start: (phase, url, label) => {
          const job = { id: ++this.seq, phase, url, label, startedAt: Date.now() };
          this.active.set(job.id, job);
          return job;
        },
        update: (job, patch) => Object.assign(job, patch),
        end: (job, result) => {
          this.active.delete(job.id);
          this.dirty = true;
          this.recent.unshift({ ...job, ...result, ms: Date.now() - job.startedAt, endedAt: Date.now() });
          if (this.recent.length > MAX_RECENT) this.recent.length = MAX_RECENT;
        },
        log: (msg) => this.message(msg),
      },
    };
  }

  message(text) {
    this.log.unshift({ at: Date.now(), text });
    if (this.log.length > 100) this.log.length = 100;
  }

  save() {
    if (!this.dirty) return;
    this.dirty = false;
    saveState(this.state);
  }

  // ---------------------------------------------------------------- views for the API

  snapshot() {
    const today = new Date().toISOString().slice(0, 10);
    const s = this.state;
    const sources = Object.values(s.sources);
    // Subscription usage is measured in calls and tokens (input includes cached input).
    const tokensIn = (r) => r.usage.input + r.usage.cacheRead + r.usage.cacheWrite;
    const ai = s.ai.reduce((t, r) => {
      t.calls++;
      t.input += tokensIn(r);
      t.output += r.usage.output;
      t.webSearches += r.usage.webSearches || 0;
      if (r.at.slice(0, 10) === today) { t.todayCalls++; t.todayTokens += tokensIn(r) + r.usage.output; }
      if (r.error) t.errors++;
      return t;
    }, { calls: 0, input: 0, output: 0, webSearches: 0, todayCalls: 0, todayTokens: 0, errors: 0 });
    const c = this.cycle;
    return {
      running: this.running,
      stopping: this.stopping,
      phase: this.phase,
      settings: this.settings,
      cycles: this.cycles,
      nextCycleAt: this.nextCycleAt,
      cycle: c && { n: c.n, startedAt: c.startedAt, budget: c.budget, used: c.used, found: c.found },
      active: [...this.active.values()],
      recent: this.recent.slice(0, 40),
      log: this.log.slice(0, 30),
      counts: {
        upcoming: Object.values(s.events).filter((e) => (e.end || e.start) >= today).length,
        events: Object.keys(s.events).length,
        sources: sources.filter((x) => x.kind === 'events').length,
        irrelevant: sources.filter((x) => x.kind === 'irrelevant').length,
        sites: sources.length,
        queue: Object.keys(s.frontier).length,
        pagesKnown: Object.keys(s.pages).length,
        social: Object.keys(s.social).length,
      },
      ai: { ...ai, enabled: aiAvailable(), ...aiStatus() },
      facebook: facebookEnabled(),
    };
  }

  queue(limit = 200) {
    return Object.entries(this.state.frontier)
      .map(([url, f]) => ({ url, ...f }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  sources() {
    return Object.values(this.state.sources)
      .filter((x) => x.kind !== 'unknown')
      .map((x) => ({
        origin: x.origin, kind: x.kind, siteKind: x.siteKind, summary: x.summary, kosiceOnly: x.kosiceOnly,
        intervalHours: x.intervalHours, lastCheckedAt: x.lastCheckedAt, nextCheckAt: x.nextCheckAt, stats: x.stats,
        pages: Object.entries(x.pages).map(([url, p]) => ({
          url, recipe: Boolean(p.recipe), lastCount: p.lastCount, analyzedAt: p.analyzedAt, failures: p.failures,
        })),
      }))
      .sort((a, b) => (a.kind === b.kind ? (b.stats.events - a.stats.events) : a.kind === 'events' ? -1 : 1));
  }

  aiCalls() {
    return this.state.ai.slice(-500).reverse().map(({ result, ...r }) => r);
  }

  aiCall(id) {
    return this.state.ai.find((r) => r.id === id);
  }

  events() {
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(this.state.events)
      .filter((e) => (e.end || e.start) >= today)
      .sort((a, b) => a.start.localeCompare(b.start) || (a.time || '').localeCompare(b.time || ''));
  }
}
