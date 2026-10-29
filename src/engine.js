// Runs the crawler inside the server so the admin panel can watch and control it:
// one continuous Run (Run/Stop), parallel workers, and a live record of what's happening.
import { loadState, saveState } from './store.js';
import { crawlPass } from './crawler.js';
import {
  AI_JOBS, AI_MODELS, aiAvailable, aiConfig, aiInput, aiPausedUntil, aiStatus, lastPlanUsage, planUsage, setAiConfig, setAiParallel, setAiRecorder,
} from './ai.js';
import { facebookEnabled } from './corroborate.js';
import { domainOf, hostOf } from './urls.js';
import { activeRuleCount, tagSources } from './tags.js';
import { eventCountry, parseLocation, placeFor, venueKey } from './geo.js';
import { SK_PLACES, isTown, skPlace } from './slovakia.js';
import { linkBonus, patternKeys } from './learn.js';
import { coverageReport, discoveryEveryHours, discoveryTargets, searchResult } from './coverage.js';
import { aiJobsDue } from './aiqueue.js';

/**
 * Where and when an event is on, day by day, when that's more than one place or time (a film at two
 * cinemas in town): { "2026-10-03": [{ venue: "CINEMAX", times: ["13:10", "18:20"] }, …] }. Places
 * are told apart by address, since sites write one cinema differently.
 */
function showings(state, e) {
  const days = {};
  for (const r of e.sources) {
    if (r.linked || !r.start || r.end) continue;
    const loc = r.location || e.location;
    const key = (loc && venueKey(loc)) || loc || '';
    const day = (days[r.start] ??= new Map());
    // A location that's only the town names no venue.
    const name = (loc && parseLocation(loc).name) || '';
    // Its own pin on the map, once the place is known.
    const v = day.get(key) || { venue: name, times: new Set(), place: loc && placeFor(state, { location: loc, source: e.source }) };
    if (name && (!v.venue || name.length < v.venue.length)) v.venue = name; // the shortest way the sites write it
    if (r.time) v.times.add(r.time);
    day.set(key, v);
  }
  const out = {};
  for (const [d, m] of Object.entries(days)) {
    const list = [...m.values()].map((v) => ({ venue: v.venue, times: [...v.times].sort(),
      ...(v.place && { place: { lat: v.place.lat, lon: v.place.lon, name: v.place.name, address: v.place.address, precision: v.place.precision } }) }));
    if (list.length > 1 || list[0].times.length > 1) out[d] = list.sort((a, b) => (a.times[0] || '').localeCompare(b.times[0] || ''));
  }
  return Object.keys(out).length ? out : undefined;
}

// Fields of an event, and of each of its source rows, that the public website uses.
const PUBLIC_EVENT = ['id', 'title', 'start', 'end', 'time', 'endTime', 'location', 'description', 'url', 'source',
  'place', 'schedule', 'firstSeenAt'];
const PUBLIC_ROW = ['url', 'site', 'kind', 'linked', 'status', 'note', 'title', 'start', 'end', 'time', 'endTime'];

export const DEFAULT_SETTINGS = {
  concurrency: 5, // pages fetched in parallel
  // Run pauses when the area's coverage reaches coverageGoal %, or when the plan's
  // 5-hour or weekly window is over its limit %.
  coverageGoal: 90,
  limitFiveHour: 80,
  limitWeekly: 80,
  // A Run works in passes (crawler.js), so every step (re-checks, verifying, exploring, the AI queue,
  // dates, tags, the map) keeps getting its turn. They follow each other without a break.
  pagesPerPass: 200,
  aiPerPass: 30, // pages the bigger model reads a pass
  triagePerPass: 60, // cheap pre-checks a pass
  aiParallel: 1, // AI calls at the same time; each is a Claude Code process (~200 MB)
};
const LIMITS = {
  concurrency: [1, 50], coverageGoal: [1, 100], limitFiveHour: [1, 100], limitWeekly: [1, 100],
  pagesPerPass: [20, 2000], aiPerPass: [1, 300], triagePerPass: [0, 500], aiParallel: [1, 4],
};
// One click in Settings sets all of these (and the pre-check model).
export const PRESETS = {
  normal: { ...DEFAULT_SETTINGS, triageModel: 'haiku' },
  berserk: { concurrency: 20, coverageGoal: 100, limitFiveHour: 95, limitWeekly: 95,
    pagesPerPass: 600, aiPerPass: 100, triagePerPass: 200, aiParallel: 3, triageModel: 'sonnet' },
};
const PAUSE_CHECK_MS = 30 * 60e3; // a Run paused at a goal or limit looks again this often
const IDLE_CHECK_MS = 5 * 60e3; // …with nothing to crawl
const OFFLINE_CHECK_MS = 60e3; // …without a network
const MAX_RECENT = 300;
const fmtTokens = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const MAX_AI_LOG = 5000;
const SAVE_EVERY_MS = 15000;

// Pass health (crawler.js) added up: counts summed, the latest crawler bug kept.
function sumHealth(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (typeof v === 'number') out[k] = (out[k] || 0) + v;
    else if (v) out[k] = v;
  }
  return out;
}

export class Engine {
  constructor() {
    this.state = loadState();
    this.settings = { ...DEFAULT_SETTINGS, ...this.state.settings };
    this.settings.ai = setAiConfig(this.settings.ai); // AI switches + model per job
    for (const k of ['pagesPerCycle', 'aiPerCycle', 'verifyPerCycle', 'cycleEveryMin']) delete this.settings[k]; // no more cycles
    delete this.state.meta.cycles;
    this.state.settings = this.settings;
    setAiParallel(this.settings.aiParallel);
    this.running = false; // a Run is active (crawling or paused)
    this.stopping = false;
    this.phase = { name: 'Stopped', detail: '' };
    this.pass = null; // ctx of the pass in progress
    this.active = new Map(); // job id -> job (pages being fetched right now)
    this.recent = []; // finished jobs, newest first
    this.log = []; // phase changes and messages, newest first
    this.seq = 0;
    this.wake = null;
    this.dirty = false;
    // The current (or last) Run: { area, startedAt, endedAt, paused: { reason, since, checkAt } | null,
    // health: totals of its passes, hostVisits }
    this.run = null;

    setAiRecorder((rec) => {
      this.state.ai.push(rec);
      if (this.state.ai.length > MAX_AI_LOG) this.state.ai.splice(0, this.state.ai.length - MAX_AI_LOG);
      const u = rec.usage;
      this.message(`AI ${rec.kind}: ${rec.target} — ${rec.error || `${fmtTokens(u.input + u.cacheRead + u.cacheWrite + u.output)} tokens, ${(rec.ms / 1000).toFixed(1)} s`}`);
    });
    setInterval(() => this.save(), SAVE_EVERY_MS).unref();
    planUsage().catch(() => {}); // your Claude plan's usage, for the AI tab
    if (this.state.meta.run) this.start(this.state.meta.run); // a Run carries on after a restart
  }

  // ---------------------------------------------------------------- control

  /**
   * Run: crawl continuously, for one area (a town, or all of them when empty), until Stop. It pauses
   * while the area's coverage is at the goal or the plan's 5-hour or weekly use is over its limit
   * (looking again every 30 minutes), while there's nothing to crawl, and while offline.
   */
  start({ area = '' } = {}) {
    if (this.running) return;
    this.run = { area: String(area || ''), startedAt: Date.now(), paused: null, health: {}, hostVisits: {} };
    this.state.meta.run = { area: this.run.area };
    this.dirty = true;
    this.running = true;
    this.stopping = false;
    this.message(`Run started${this.run.area ? ` for ${this.run.area}` : ''}`);
    this.loop().catch((err) => this.message(`engine error: ${err.stack || err}`));
  }

  /** Why a Run should not crawl now, or null. */
  async pauseReason() {
    const { area } = this.run;
    const report = coverageReport(this.state);
    const row = area ? report.towns.find((t) => t.town === area) : report.overall;
    if (row?.coverage !== undefined && row.coverage * 100 >= this.settings.coverageGoal) {
      return `coverage of ${area || 'all towns'} is ${Math.round(row.coverage * 100)} % (goal ${this.settings.coverageGoal} %)`;
    }
    if (!aiAvailable()) return null;
    const plan = await planUsage({ refresh: true }).catch(() => null);
    for (const w of plan?.windows || []) {
      const limit = /^5-hour/.test(w.name) ? this.settings.limitFiveHour : /^Weekly/.test(w.name) ? this.settings.limitWeekly : null;
      if (limit != null && w.used > limit) return `${w.name} AI use is ${Math.round(w.used)} % (limit ${limit} %)`;
    }
    return null;
  }

  // Sleep until ms from now, or until wake() (Stop).
  async sleep(ms) {
    await new Promise((resolve) => {
      const t = setTimeout(resolve, ms);
      this.wake = () => { clearTimeout(t); resolve(); };
    });
    this.wake = null;
  }

  /** Finish the pages being fetched right now, then stop the Run. */
  stop() {
    if (!this.running) return;
    this.stopping = true;
    delete this.state.meta.run;
    this.dirty = true;
    this.message('Stopping after current pages finish…');
    this.wake?.();
  }

  updateSettings(patch) {
    if (PRESETS[patch.preset]) {
      this.message(`Settings: ${patch.preset}`);
      const { triageModel, ...preset } = PRESETS[patch.preset];
      patch = { ...preset, ai: { jobs: { triage: { model: triageModel } } } };
    }
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
    setAiParallel(this.settings.aiParallel);
    this.dirty = true;
    this.save();
  }

  async loop() {
    let wait = null; // { reason, ms }: why the last pass says to hold off
    while (!this.stopping) {
      if (!wait) {
        const reason = await this.pauseReason();
        if (reason) wait = { reason, ms: PAUSE_CHECK_MS };
      }
      if (wait) {
        const { paused } = this.run;
        if (paused?.reason !== wait.reason) this.message(`Run paused: ${wait.reason}`);
        this.run.paused = { reason: wait.reason, since: paused?.since || Date.now(), checkAt: Date.now() + wait.ms };
        this.phase = { name: 'Paused', detail: wait.reason };
        await this.sleep(wait.ms);
        wait = null;
        continue;
      }
      if (this.run.paused) this.message('Run resumed');
      this.run.paused = null;
      let ctx = null;
      try {
        const st = this.settings;
        ctx = await crawlPass(this.state, { maxPages: st.pagesPerPass, maxAi: st.aiPerPass, maxTriage: st.triagePerPass, maxVerify: 15 },
          this.control());
      } catch (err) {
        this.message(`crawler error: ${err.stack || err}`);
        wait = { reason: 'crawler error (see the log)', ms: PAUSE_CHECK_MS };
      }
      this.pass = null;
      if (ctx) {
        this.addPass(ctx);
        const idle = !ctx.used.pages && !ctx.used.verify && !ctx.used.ai;
        if (ctx.offline) wait = { reason: 'offline (DNS lookups fail)', ms: OFFLINE_CHECK_MS };
        else if (ctx.halted) wait = { reason: ctx.halted, ms: PAUSE_CHECK_MS };
        else if (idle && !ctx.control.stopped()) wait = { reason: 'nothing to crawl right now', ms: IDLE_CHECK_MS };
      }
      this.dirty = true;
      this.save();
      planUsage({ refresh: true }).catch(() => {});
    }
    this.running = false;
    this.stopping = false;
    this.run.paused = null;
    this.run.endedAt = Date.now();
    this.phase = { name: 'Stopped', detail: '' };
    this.message('Run stopped');
  }

  /** Add a finished pass to the Run's totals. */
  addPass(ctx) {
    const r = this.run;
    r.health = sumHealth(r.health, ctx.health);
    for (const [host, n] of Object.entries(ctx.hostVisits)) r.hostVisits[host] = (r.hostVisits[host] || 0) + n;
  }

  // What crawlPass uses to read settings and report progress.
  control() {
    return {
      concurrency: () => this.settings.concurrency,
      stopped: () => this.stopping,
      report: {
        begin: (ctx) => { this.pass = ctx; },
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
    const r = this.run;
    return {
      running: this.running,
      stopping: this.stopping,
      phase: this.phase,
      settings: this.settings,
      presets: PRESETS,
      // The Run's totals so far, the pass in progress included.
      run: r && { area: r.area, startedAt: r.startedAt, endedAt: r.endedAt, paused: r.paused,
        health: this.pass ? sumHealth(r.health, this.pass.health) : r.health },
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
      unknownCountry: this.unknownCountry(today),
      ai: { ...ai, enabled: aiAvailable(), ...aiStatus(), jobs: this.aiJobs(today), models: AI_MODELS, byModel: this.aiByModel(), plan: lastPlanUsage(),
        pausedUntil: aiPausedUntil() || null, queue: this.aiQueue() },
      facebook: facebookEnabled(),
    };
  }

  /**
   * Upcoming events whose country isn't known yet (geo.js: eventCountry), with a sample of them, to
   * see whether events abroad slip through: { count, sample: [{ title, location, via }] }. Kept a minute.
   */
  unknownCountry(today) {
    if (this.unknownCache && Date.now() - this.unknownCache.at < 60_000) return this.unknownCache.value;
    const unknown = Object.values(this.state.events)
      .filter((e) => (e.end || e.start) >= today && !eventCountry(this.state, e));
    const sample = unknown.map((e) => [Math.random(), e]).sort((a, b) => a[0] - b[0]).slice(0, 12)
      .map(([, e]) => ({ title: e.title, location: e.location, via: e.sources?.find((r) => !r.linked)?.via || e.source }));
    this.unknownCache = { at: Date.now(), value: { count: unknown.length, sample } };
    return this.unknownCache.value;
  }

  /** Pages waiting for AI (aiqueue.js): how many, why, and the first ones in line. */
  aiQueue() {
    const all = Object.values(this.state.aiQueue || {});
    const due = aiJobsDue(this.state);
    const order = new Map(due.map((j, i) => [j.url, i]));
    return {
      size: all.length,
      repairs: all.filter((j) => j.repair).length,
      due: due.length,
      next: [...all].sort((a, b) => (order.get(a.url) ?? 1e9) - (order.get(b.url) ?? 1e9)).slice(0, 25)
        .map((j) => ({ url: j.url, reason: j.reason, repair: j.repair, priority: j.priority, addedAt: j.addedAt, tries: j.tries,
          nextTryAt: j.nextTryAt, lastError: j.lastError })),
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
        sk: p.sk, abroad: p.abroad,
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

  /** For the public page: the sites events come from, without the crawler's notes about them. */
  sites() {
    return Object.values(this.state.sources).filter((x) => x.kind === 'events').map((x) => ({ origin: x.origin }));
  }

  /**
   * Crawl activity grouped by domain, with each subdomain inside: visits (all time and this
   * Run), errors, events found, pages known and links waiting in the queue.
   */
  domains() {
    const s = this.state;
    const runVisits = { ...this.run?.hostVisits };
    for (const [host, n] of Object.entries(this.pass?.hostVisits || {})) runVisits[host] = (runVisits[host] || 0) + n;
    const hosts = {};
    const row = (host) => (hosts[host] ??= {
      host, visits: 0, runVisits: 0, errors: 0, events: 0, added: 0, pages: 0, queued: 0, sk: 0, abroad: 0, kind: undefined,
    });
    for (const [host, h] of Object.entries(s.hosts)) {
      Object.assign(row(host), {
        visits: h.visits, errors: h.errors, failStreak: h.failStreak, lastError: h.lastError,
        downUntil: Date.parse(h.downUntil || 0) > Date.now() ? h.downUntil : undefined, lastTrouble: h.lastTrouble,
        events: h.events, added: h.added, lastVisitAt: h.lastVisitAt, sk: h.sk || 0, abroad: h.abroad || 0,
      });
    }
    for (const [host, n] of Object.entries(runVisits)) row(host).runVisits = n;
    for (const url of Object.keys(s.pages)) { const h = hostOf(url); if (h) row(h).pages++; }
    for (const url of Object.keys(s.frontier)) { const h = hostOf(url); if (h) row(h).queued++; }
    for (const src of Object.values(s.sources)) {
      const r = hosts[hostOf(src.origin)];
      if (r && src.kind !== 'unknown' && r.kind !== 'events') r.kind = src.kind;
    }

    const domains = {};
    const SUM = ['visits', 'runVisits', 'errors', 'events', 'added', 'pages', 'queued', 'sk', 'abroad'];
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

  /**
   * How much of what's on we probably have, per town and kind (coverage.js), and what the discovery
   * search did about the gaps: the searches so far (did each find a new event source?) and the next ones.
   */
  coverage() {
    const s = this.state;
    const report = coverageReport(s);
    const everyHours = discoveryEveryHours(report, Number(process.env.EVENTS_DISCOVERY_HOURS || 6));
    const searches = (s.meta.discoveries || []).slice(-40).reverse().map((d) => ({
      at: d.at, place: d.place, tag: d.tag, query: d.query, why: d.why, urls: d.urls, queued: d.queued,
      result: searchResult(s, d),
      found: (d.origins || []).filter((o) => s.sources[o]?.kind === 'events'),
    }));
    return {
      ...report,
      towns: report.towns.slice(0, 40),
      searches,
      next: discoveryTargets(s, report).slice(0, 8),
      everyHours,
      lastDiscoveryAt: s.meta.lastDiscoveryAt,
      discoverOn: aiAvailable('discover'),
    };
  }

  aiCalls() {
    return this.state.ai.slice(-500).reverse().map(({ result, ...r }) => r);
  }

  /**
   * Where AI tokens went, for the AI tab's treemap: every call ever made, summed per day, job and
   * page ([day, job, page, calls, tokens, usd]). Jobs not about one page (tagging, discovery, date
   * checks) have the query or nothing as their page. Tokens count everything the model read and
   * wrote, cached input included.
   */
  aiUsage() {
    const rows = new Map();
    for (const c of this.state.ai) {
      const job = c.kind === 'classify' ? 'tag' : c.kind;
      const page = /^https?:\/\//.test(c.target || '') ? c.target.replace(/#.*$/, '') : job === 'discover' ? c.target || '' : '';
      const key = `${c.at.slice(0, 10)}\n${job}\n${page}`;
      const u = c.usage || {};
      const r = rows.get(key) || rows.set(key, [c.at.slice(0, 10), job, page, 0, 0, 0]).get(key);
      r[3]++;
      r[4] += (u.input || 0) + (u.output || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0);
      r[5] += u.costUsd || 0;
    }
    return { rows: [...rows.values()].map((r) => [...r.slice(0, 5), Math.round(r[5] * 1e4) / 1e4]) };
  }

  /** One AI call with everything about it: what it was sent (if still kept) and what it answered. */
  aiCall(id) {
    const rec = this.state.ai.find((r) => r.id === id);
    return rec && { ...rec, input: aiInput(id) };
  }

  /**
   * Towns for the website's town filter, with their centres ([name, lat, lon]): every Slovak town,
   * and the villages events are in. The website shows a town's events within 25 km of its centre.
   */
  towns() {
    const today = new Date().toISOString().slice(0, 10);
    const named = new Set();
    for (const e of Object.values(this.state.events)) {
      if ((e.end || e.start) < today) continue;
      const p = skPlace(e.place?.city ?? parseLocation(e.location).city);
      if (p && !p.partOf) named.add(p);
    }
    for (const p of SK_PLACES) if (isTown(p) && !p.partOf) named.add(p);
    return [...named].map((p) => [p.name, p.lat, p.lon]);
  }

  events() {
    const today = new Date().toISOString().slice(0, 10);
    return Object.values(this.state.events)
      .filter((e) => (e.end || e.start) >= today)
      .map((e) => {
        const tagFrom = tagSources(e, this.state.tagRules);
        // The town, for the website's filter (the map step stores it; older events get it here).
        const city = e.place?.city ?? parseLocation(e.location).city;
        // Only what the website shows: the full record (AI inputs, row descriptions…) is several MB.
        const pick = (o, keys) => Object.fromEntries(keys.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));
        return {
          ...pick(e, PUBLIC_EVENT), tags: Object.keys(tagFrom), tagFrom, city, showings: showings(this.state, e),
          sources: e.sources.map((r) => pick(r, r.title === e.title ? PUBLIC_ROW.filter((k) => k !== 'title') : PUBLIC_ROW)),
        };
      })
      .sort((a, b) => a.start.localeCompare(b.start) || (a.time || '').localeCompare(b.time || ''));
  }
}
