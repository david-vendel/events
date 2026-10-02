// Runs the crawler inside the server so the admin panel can watch and control it:
// start/stop, number of parallel workers, budgets, and a live record of what's happening.
import { loadState, saveState } from './store.js';
import { runCycle } from './crawler.js';
import {
  AI_JOBS, AI_MODELS, aiAvailable, aiConfig, aiInput, aiStatus, lastPlanUsage, planUsage, setAiConfig, setAiRecorder,
} from './ai.js';
import { facebookEnabled } from './corroborate.js';
import { domainOf, hostOf } from './urls.js';
import { activeRuleCount, tagSources } from './tags.js';
import { parseLocation } from './geo.js';
import { linkBonus, patternKeys } from './learn.js';

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
    this.settings.ai = setAiConfig(this.settings.ai); // AI switches + model per job
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
    planUsage().catch(() => {}); // your Claude plan's usage, for the AI tab
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
    if (patch.ai) {
      this.settings.ai = setAiConfig(patch.ai);
      const a = this.settings.ai;
      this.message(`AI ${a.enabled ? 'on' : 'off'}: ${Object.entries(a.jobs)
        .map(([k, j]) => `${AI_JOBS[k].label.toLowerCase()} ${j.on ? `on (${j.model})` : 'off'}`).join(', ')}`);
    }
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
      planUsage({ refresh: true }).catch(() => {});
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
    // The same message again (a bug hit on every page, say) is counted, not repeated.
    const last = this.log[0];
    if (last && last.text === text) {
      last.repeat = (last.repeat || 1) + 1;
      last.at = Date.now();
      return;
    }
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
      t.costUsd += r.usage.costUsd || 0;
      if (r.at.slice(0, 10) === today) {
        t.todayCalls++;
        t.todayTokens += tokensIn(r) + r.usage.output;
        t.todayCostUsd += r.usage.costUsd || 0;
      }
      if (r.error) t.errors++;
      return t;
    }, { calls: 0, input: 0, output: 0, webSearches: 0, todayCalls: 0, todayTokens: 0, errors: 0, costUsd: 0, todayCostUsd: 0 });
    const c = this.cycle;
    return {
      running: this.running,
      stopping: this.stopping,
      phase: this.phase,
      settings: this.settings,
      cycles: this.cycles,
      nextCycleAt: this.nextCycleAt,
      cycle: c && { n: c.n, startedAt: c.startedAt, budget: c.budget, used: c.used, found: c.found, health: c.health },
      // One line per finished cycle (newest last): pages read, how many had events, new events…
      history: (s.meta.cycles || []).slice(-12),
      active: [...this.active.values()],
      recent: this.recent.slice(0, 40),
      log: this.log.slice(0, 30),
      counts: {
        upcoming: Object.values(s.events).filter((e) => (e.end || e.start) >= today).length,
        located: Object.values(s.events).filter((e) => (e.end || e.start) >= today && e.place).length,
        tagRules: activeRuleCount(s.tagRules),
        templates: Object.keys(s.patterns || {}).length,
        recipes: Object.values(s.patterns || {}).filter((p) => p.recipe).length,
        events: Object.keys(s.events).length,
        sources: sources.filter((x) => x.kind === 'events').length,
        irrelevant: sources.filter((x) => x.kind === 'irrelevant').length,
        sites: sources.length,
        queue: Object.keys(s.frontier).length,
        pagesKnown: Object.keys(s.pages).length,
        social: Object.keys(s.social).length,
      },
      ai: { ...ai, enabled: aiAvailable(), ...aiStatus(), jobs: this.aiJobs(today), models: AI_MODELS, byModel: this.aiByModel(), plan: lastPlanUsage() },
      facebook: facebookEnabled(),
    };
  }

  queue(limit = 200) {
    // Ranked the way the crawler picks: the link's own score plus what its template and host taught.
    return Object.entries(this.state.frontier)
      .map(([url, f]) => {
        const learned = Math.round(linkBonus(this.state, url, patternKeys(url)) * 10) / 10;
        return { url, ...f, learned, total: f.score + learned };
      })
      .sort((a, b) => b.total - a.total)
      .slice(0, limit);
  }

  /**
   * Page templates (learn.js) with what the crawler learned about each: visits, how many had
   * upcoming events, new events, AI verdict, recipe, and how much that moves their links' score.
   */
  patterns(limit = 400) {
    const list = Object.entries(this.state.patterns || {})
      .filter(([key]) => !key.includes('/…')) // the coarse ones are a fallback, not worth a row
      .map(([key, p]) => ({
        key, visits: p.visits, withEvents: p.withEvents, events: p.events, added: p.added, lastAt: p.lastAt,
        example: p.example, aiAt: p.aiAt, aiSaid: p.aiSaid, recipe: Boolean(p.recipe), recipeFrom: p.recipeFrom,
        effect: p.example ? Math.round(linkBonus(this.state, p.example, patternKeys(p.example)) * 10) / 10 : 0,
      }));
    const wasted = list.filter((p) => !p.withEvents).reduce((t, p) => t + p.visits, 0);
    const visits = list.reduce((t, p) => t + p.visits, 0);
    return {
      totals: { templates: list.length, visits, wasted, productive: list.filter((p) => p.withEvents).length },
      productive: [...list].filter((p) => p.withEvents).sort((a, b) => b.added - a.added || b.events - a.events).slice(0, limit),
      wasteful: [...list].filter((p) => !p.withEvents).sort((a, b) => b.visits - a.visits).slice(0, limit),
    };
  }

  sources() {
    return Object.values(this.state.sources)
      .filter((x) => x.kind !== 'unknown')
      .map((x) => ({
        origin: x.origin, kind: x.kind, siteKind: x.siteKind, summary: x.summary, city: x.city,
        intervalHours: x.intervalHours, lastCheckedAt: x.lastCheckedAt, nextCheckAt: x.nextCheckAt, stats: x.stats,
        pages: Object.entries(x.pages).map(([url, p]) => ({
          url, recipe: Boolean(p.recipe), lastCount: p.lastCount, analyzedAt: p.analyzedAt, failures: p.failures,
          lastRead: p.lastRead, tags: p.tags,
        })),
      }))
      .sort((a, b) => (a.kind === b.kind ? (b.stats.events - a.stats.events) : a.kind === 'events' ? -1 : 1));
  }

  /**
   * Crawl activity grouped by domain, with each subdomain inside: visits (all time and this
   * cycle), errors, events found, pages known and links waiting in the queue.
   */
  domains() {
    const s = this.state;
    const cycleVisits = this.cycle?.hostVisits || {};
    const hosts = {};
    const row = (host) => (hosts[host] ??= {
      host, visits: 0, cycleVisits: 0, errors: 0, events: 0, added: 0, pages: 0, queued: 0, kind: undefined,
    });
    for (const [host, h] of Object.entries(s.hosts)) {
      Object.assign(row(host), {
        visits: h.visits, errors: h.errors, failStreak: h.failStreak, lastError: h.lastError,
        events: h.events, added: h.added, lastVisitAt: h.lastVisitAt,
      });
    }
    for (const [host, n] of Object.entries(cycleVisits)) row(host).cycleVisits = n;
    for (const url of Object.keys(s.pages)) { const h = hostOf(url); if (h) row(h).pages++; }
    for (const url of Object.keys(s.frontier)) { const h = hostOf(url); if (h) row(h).queued++; }
    for (const src of Object.values(s.sources)) {
      const r = hosts[hostOf(src.origin)];
      if (r && src.kind !== 'unknown' && r.kind !== 'events') r.kind = src.kind;
    }

    const domains = {};
    const SUM = ['visits', 'cycleVisits', 'errors', 'events', 'added', 'pages', 'queued'];
    for (const h of Object.values(hosts)) {
      const d = (domains[domainOf(h.host)] ??= { domain: domainOf(h.host), hosts: [], ...Object.fromEntries(SUM.map((k) => [k, 0])) });
      d.hosts.push(h);
      for (const k of SUM) d[k] += h[k];
      if (h.kind === 'events' || (h.kind && !d.kind)) d.kind = h.kind;
      if (h.lastVisitAt > (d.lastVisitAt || '')) d.lastVisitAt = h.lastVisitAt;
    }
    const list = Object.values(domains);
    for (const d of list) d.hosts.sort((a, b) => b.visits - a.visits || b.queued - a.queued);
    const totals = Object.fromEntries(SUM.map((k) => [k, list.reduce((t, d) => t + d[k], 0)]));
    return { totals, domains: list.sort((a, b) => b.visits - a.visits || b.queued - a.queued) };
  }

  /** Each AI job: what it's for, its switch and model, and what it has done. */
  aiJobs(today) {
    const cfg = aiConfig();
    const jobs = Object.fromEntries(Object.entries(AI_JOBS).map(([k, j]) => [k, {
      ...j, ...cfg.jobs[k], calls: 0, todayCalls: 0, todayTokens: 0, costUsd: 0, todayCostUsd: 0, last: null,
    }]));
    for (const r of this.state.ai) {
      const j = jobs[r.kind === 'classify' ? 'tag' : r.kind];
      if (!j) continue;
      j.calls++;
      j.costUsd += r.usage.costUsd || 0;
      if (r.at.slice(0, 10) === today) {
        j.todayCalls++;
        j.todayTokens += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
        j.todayCostUsd += r.usage.costUsd || 0;
      }
      j.last = { id: r.id, at: r.at, target: r.target, outcome: r.outcome, error: r.error, model: r.model };
    }
    return jobs;
  }

  async refreshPlan() {
    await planUsage({ refresh: true });
    return this.snapshot();
  }

  /** Calls, tokens and API price per model: shows what the cheaper model saves. */
  aiByModel() {
    const by = {};
    for (const r of this.state.ai) {
      const m = (by[r.model || 'unknown'] ??= { model: r.model || 'unknown', calls: 0, tokens: 0, costUsd: 0 });
      m.calls++;
      m.tokens += r.usage.input + r.usage.cacheRead + r.usage.cacheWrite + r.usage.output;
      m.costUsd += r.usage.costUsd || 0;
    }
    return Object.values(by).sort((a, b) => b.costUsd - a.costUsd || b.calls - a.calls);
  }

  aiCalls() {
    return this.state.ai.slice(-500).reverse().map(({ result, ...r }) => r);
  }

  /** One AI call with everything about it: what it was sent (if still kept) and what it answered. */
  aiCall(id) {
    const rec = this.state.ai.find((r) => r.id === id);
    return rec && { ...rec, input: aiInput(id) };
  }

  events() {
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(this.state.events)
      .filter((e) => (e.end || e.start) >= today)
      .map((e) => {
        const tagFrom = tagSources(e, this.state.tagRules);
        // The town, for the website's filter (the map step stores it; older events get it here).
        const city = e.place?.city ?? parseLocation(e.location).city;
        return { ...e, tags: Object.keys(tagFrom), tagFrom, city };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || (a.time || '').localeCompare(b.time || ''));
  }
}
