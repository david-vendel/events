// One crawl cycle:
//   1. re-check known event sources that are due (cheap: conditional GET + saved recipe),
//   2. verify upcoming events against the other places they're published (Facebook, tickets…),
//   3. occasionally ask AI to web-search for new sources,
//   4. spend the rest of the page budget exploring the frontier, picked pseudo-randomly
//      with a bias towards links that look like Košice events.
// AI is only called for promising pages that have no working recipe yet.
// Work runs in a pool of parallel workers; `control` sets how many and reports progress.
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { fetchPage } from './fetcher.js';
import {
  applyRecipe, clean, extractLinks, makeEvent, isSocial, jsonLdEvents, pageSignals, scoreLink, simplifyHtml,
} from './extract.js';
import { aiAvailable, analyzePage, discoverUrls } from './ai.js';
import { EventIndex, migrate } from './events.js';
import { dueForVerification, verifyEvent } from './corroborate.js';
import { defaultControl, runPool } from './pool.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RELEARN_AFTER = 7 * DAY; // don't re-ask AI about the same page more often than this
const REVISIT_EXPLORED_AFTER = 30 * DAY; // non-source pages are re-explored at most monthly
const DISCOVERY_EVERY = Number(process.env.EVENTS_DISCOVERY_HOURS || 24) * HOUR;
const MAX_FRONTIER = 5000;
const MAX_PER_HOST_EXPLORE = 3;
const KOSICE = /kosic|cassovia|kassa|kaschau/;

const fold = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
const iso = (t) => new Date(t).toISOString();
const clampInterval = (h) => Math.min(168, Math.max(12, Math.round(h || 24)));
const originOf = (url) => new URL(url).origin;

function sourceFor(state, url) {
  const origin = originOf(url);
  return (state.sources[origin] ??= {
    origin,
    kind: 'unknown', // unknown | events | irrelevant
    summary: undefined,
    kosiceOnly: undefined,
    intervalHours: 24,
    nextCheckAt: undefined,
    lastCheckedAt: undefined,
    pages: {}, // listing url -> { recipe, lastCount, analyzedAt, failures }
    stats: { visits: 0, events: 0, newEvents: 0, lastNewEventAt: undefined },
  });
}

function addToFrontier(state, url, score, foundOn) {
  if (score < 0) return;
  const seen = state.pages[url];
  if (seen && Date.now() - Date.parse(seen.fetchedAt || 0) < REVISIT_EXPLORED_AFTER) return;
  const cur = state.frontier[url];
  if (!cur || cur.score < score) state.frontier[url] = { score, foundOn, addedAt: cur?.addedAt || iso(Date.now()) };
}

function trimFrontier(state) {
  const entries = Object.entries(state.frontier);
  if (entries.length <= MAX_FRONTIER) return;
  entries.sort((a, b) => b[1].score - a[1].score);
  state.frontier = Object.fromEntries(entries.slice(0, MAX_FRONTIER));
}

/**
 * Weighted pseudo-random pick: score plus noise, so good links win but anything can be chosen.
 * Skips hosts another worker is fetching right now and hosts that used up their share this cycle.
 */
function pickFromFrontier(state, hostCounts, busyHosts) {
  let best = null, bestKey = -Infinity;
  for (const [url, f] of Object.entries(state.frontier)) {
    const key = f.score + Math.random() * 4;
    if (key <= bestKey) continue;
    let host;
    try { host = new URL(url).host; } catch { delete state.frontier[url]; continue; }
    if (busyHosts.has(host) || (hostCounts.get(host) || 0) >= MAX_PER_HOST_EXPLORE) continue;
    best = { url, host };
    bestKey = key;
  }
  return best;
}

// What the dashboard shows about the AI call a page needed.
function aiSummary(call) {
  if (!call) return undefined;
  const u = call.usage;
  return { id: call.id, tokens: u.input + u.cacheRead + u.cacheWrite + u.output, ms: call.ms, error: call.error };
}

function upsertEvents(state, events, source, ctx) {
  let added = 0;
  for (const ev of events) {
    if ((ev.end || ev.start) < ctx.today) continue; // already over
    if (source.kosiceOnly !== true && !KOSICE.test(fold(`${ev.title} ${ev.location} ${ev.description}`))) continue;
    const { id, source: via, ...fields } = ev;
    const { isNew } = ctx.index.add({ kind: 'web', status: 'ok', via, ...fields });
    if (isNew) added++;
  }
  source.stats.events += events.length;
  source.stats.newEvents += added;
  if (added) source.stats.lastNewEventAt = iso(Date.now());
  return added;
}

/**
 * Visit one URL: fetch, extract events (JSON-LD / recipe / AI), harvest links.
 * Returns the number of new events.
 */
async function visit(state, url, ctx, phase) {
  const report = ctx.control.report;
  const job = report.start(phase, url);
  const cache = (state.pages[url] ??= {});
  delete state.frontier[url];
  ctx.budget.pages--;
  ctx.used.pages++;

  const res = await fetchPage(url, cache);
  const source = sourceFor(state, res.url || url);
  source.stats.visits++;
  const listing = source.pages[url];
  if (res.error) {
    if (listing) listing.failures = (listing.failures || 0) + 1;
    report.end(job, { status: 'error', http: res.status, note: res.error });
    return 0;
  }
  if (!res.changed && listing?.recipe) {
    report.end(job, { status: 'unchanged', http: res.status });
    return 0;
  }

  const $ = cheerio.load(res.html);
  const links = extractLinks($, res.url);
  const queued = harvestLinks(state, links, source, res.url);

  const events = jsonLdEvents($, res.url);
  let recipeBroken = false;
  let how = events.length ? 'json-ld' : undefined;
  let aiCall = null;
  if (listing?.recipe) {
    const found = applyRecipe($, listing.recipe, res.url);
    // A recipe that used to work and now finds nothing means the site changed.
    recipeBroken = found.length === 0 && listing.lastCount > 0;
    listing.lastCount = found.length;
    events.push(...found);
    if (found.length) how = 'recipe';
  }

  const signals = pageSignals($);
  const wantsAi = (!listing?.recipe || recipeBroken)
    && (signals.looksLikeListing || ctx.seeds.has(url) || listing)
    && events.length === 0
    && ctx.budget.ai > 0
    && Date.now() - Date.parse(listing?.analyzedAt || 0) > RELEARN_AFTER
    && source.kind !== 'irrelevant';

  if (wantsAi) {
    ctx.budget.ai--;
    ctx.used.ai++;
    // AI runs one page at a time; parallel workers wait their turn here.
    report.update?.(job, { note: 'waiting for AI…', ai: 'waiting' });
    const { html, truncated, title } = simplifyHtml(res.html);
    const { analysis: a, call } = await analyzePage({
      url: res.url, title, html, truncated, links, today: ctx.today,
      onStart: () => report.update?.(job, { note: 'AI is reading the page…', ai: 'running' }),
    });
    aiCall = call;
    if (a) {
      learnFromAnalysis(state, source, url, a, $, res.url, events, report);
      how = source.pages[url]?.recipe ? 'AI → recipe' : 'AI';
    }
  } else if (events.length >= 2 && source.kind !== 'irrelevant') {
    // Several structured events without AI: treat this page as a listing worth re-checking.
    // (A single event is usually a detail page; we keep the event but don't schedule the page.)
    source.kind = 'events';
    source.pages[url] ??= {};
  }

  if (source.kind === 'events' && !source.nextCheckAt) {
    source.nextCheckAt = iso(Date.now() + source.intervalHours * HOUR);
  }
  const added = upsertEvents(state, events, source, ctx);
  ctx.found.events += events.length;
  ctx.found.added += added;
  report.end(job, {
    status: 'ok', http: res.status, events: events.length, added, links: queued, how, ai: aiSummary(aiCall),
    kind: source.kind !== 'unknown' ? source.kind : undefined,
  });
  return added;
}

function learnFromAnalysis(state, source, url, a, $, pageUrl, events, report) {
  source.summary = a.summary;
  source.siteKind = a.siteKind;
  source.kosiceOnly = a.listingIsKosiceOnly;
  source.kind = a.publishesKosiceEvents ? 'events' : (source.kind === 'events' ? 'events' : 'irrelevant');
  source.intervalHours = clampInterval(a.checkEveryHours);

  const listing = (source.pages[url] ??= {});
  listing.analyzedAt = iso(Date.now());
  if (a.recipe) {
    const found = applyRecipe($, a.recipe, pageUrl);
    if (found.length) {
      listing.recipe = a.recipe;
      listing.lastCount = found.length;
      events.push(...found);
    } else {
      report.log(`AI recipe for ${url} matched nothing; keeping AI-extracted events only`);
    }
  }
  if (!listing.recipe) {
    for (const e of a.events) {
      const ev = makeEvent({ ...e, url: e.url || undefined }, pageUrl);
      if (ev) events.push(ev);
    }
    if (!a.pageListsEvents) delete source.pages[url];
  }
  // Other listing pages on this site: remember them and visit soon.
  if (a.publishesKosiceEvents) {
    for (const u of a.eventListUrls.slice(0, 5)) {
      try {
        if (originOf(u) !== source.origin) continue;
        source.pages[u] ??= {};
        addToFrontier(state, u, 8, url);
      } catch {}
    }
  }
}

function harvestLinks(state, links, source, pageUrl) {
  const scored = [];
  for (const [href, text] of links) {
    if (isSocial(href)) {
      state.social[href] ??= { foundOn: pageUrl, text, addedAt: iso(Date.now()) };
      continue;
    }
    let score = scoreLink(href, text);
    if (score < 0) continue;
    const target = state.sources[originOf(href)];
    if (target?.kind === 'irrelevant') score -= 3;
    if (target?.kind === 'events') score += 1;
    if (source.kind === 'events' && originOf(href) !== source.origin) score += 1; // event sites link to other event sites
    scored.push([href, score]);
  }
  scored.sort((a, b) => b[1] - a[1]);
  for (const [href, score] of scored.slice(0, 80)) addToFrontier(state, href, score, pageUrl);
  return Math.min(scored.length, 80);
}

function scheduleNext(source, newEvents) {
  // Adaptive frequency: sources that keep producing new events get checked more often.
  source.intervalHours = clampInterval(newEvents > 0 ? source.intervalHours * 0.8 : source.intervalHours * 1.25);
  source.lastCheckedAt = iso(Date.now());
  source.nextCheckAt = iso(Date.now() + source.intervalHours * HOUR);
}

function pruneEvents(state, today) {
  const cutoff = new Date(Date.parse(today) - 14 * DAY).toISOString().slice(0, 10);
  for (const [id, ev] of Object.entries(state.events)) if ((ev.end || ev.start) < cutoff) delete state.events[id];
}

export async function runCycle(state, options = {}, control = defaultControl()) {
  const { maxPages = 60, maxAi = 5, maxVerify = 15, seedsFile = 'seeds.json' } = options;
  const { report } = control;
  const today = new Date().toISOString().slice(0, 10);
  const seeds = new Set(fs.existsSync(seedsFile) ? JSON.parse(fs.readFileSync(seedsFile, 'utf8')) : []);
  migrate(state);
  const ctx = {
    budget: { pages: maxPages, ai: aiAvailable() ? maxAi : 0, verify: maxVerify },
    used: { pages: 0, ai: 0, verify: 0 },
    found: { events: 0, added: 0 },
    today, seeds, control, index: new EventIndex(state),
  };
  report.begin?.(ctx);
  report.phase('Starting cycle', `budget ${maxPages} pages, ${ctx.budget.ai} AI calls` +
    (aiAvailable() ? '' : ' (AI off: EVENTS_AI=off)'));

  for (const url of seeds) if (!state.pages[url]) addToFrontier(state, url, 10, 'seed');

  // 1. Known sources that are due. Each source's pages are fetched one after another;
  //    different sources run in parallel.
  const due = Object.values(state.sources)
    .filter((s) => s.kind === 'events' && (!s.nextCheckAt || Date.parse(s.nextCheckAt) <= Date.now()))
    .sort((a, b) => Date.parse(a.nextCheckAt || 0) - Date.parse(b.nextCheckAt || 0));
  report.phase('Re-checking sources', `${due.length} due`);
  await runPool(() => {
    const source = due.shift();
    if (!source || ctx.budget.pages <= 0) return null;
    return async () => {
      let added = 0;
      for (const url of Object.keys(source.pages).slice(0, 5)) {
        if (ctx.budget.pages <= 0 || control.stopped()) break;
        if (source.pages[url].failures >= 5) continue; // dead listing page
        added += await visit(state, url, ctx, 'recheck');
      }
      scheduleNext(source, added);
    };
  }, control);

  // 2. Build the net of sources for upcoming events (detail pages, Facebook, ticket shops).
  if (!control.stopped()) {
    const toVerify = dueForVerification(state, today, maxVerify);
    report.phase('Verifying events', `${toVerify.length} due`);
    await runPool(() => {
      const ev = toVerify.shift();
      if (!ev) return null;
      ctx.used.verify++;
      return () => verifyEvent(ctx.index, ev, report);
    }, control);
  }

  // 3. Occasional AI web search for new sources.
  if (!control.stopped() && ctx.budget.ai > 0 && Date.now() - Date.parse(state.meta.lastDiscoveryAt || 0) > DISCOVERY_EVERY) {
    report.phase('AI discovery search');
    ctx.budget.ai--;
    ctx.used.ai++;
    const known = Object.values(state.sources).filter((s) => s.kind !== 'unknown').map((s) => new URL(s.origin).host);
    const job = report.start('discover', 'web search');
    const { urls, call } = await discoverUrls(known, {
      onStart: () => report.update?.(job, { note: 'AI is searching the web…', ai: 'running' }),
    });
    state.meta.lastDiscoveryAt = iso(Date.now());
    for (const u of urls) addToFrontier(state, u, 7, 'ai-discovery');
    report.end(job, { status: call?.error ? 'error' : 'ok', links: urls.length, ai: aiSummary(call), note: call?.error });
  }

  // 4. Explore.
  if (!control.stopped()) {
    const hostCounts = new Map();
    const busyHosts = new Set();
    report.phase('Exploring', `${Object.keys(state.frontier).length} URLs in queue`);
    await runPool(() => {
      if (ctx.budget.pages <= 0) return null;
      const pick = pickFromFrontier(state, hostCounts, busyHosts);
      if (!pick) return null;
      hostCounts.set(pick.host, (hostCounts.get(pick.host) || 0) + 1);
      busyHosts.add(pick.host);
      return () => visit(state, pick.url, ctx, 'explore').finally(() => busyHosts.delete(pick.host));
    }, control);
  }

  pruneEvents(state, today);
  trimFrontier(state);
  const upcoming = Object.values(state.events).filter((e) => (e.end || e.start) >= today).length;
  const sources = Object.values(state.sources).filter((s) => s.kind === 'events').length;
  report.phase(control.stopped() ? 'Stopped' : 'Cycle done',
    `${ctx.found.added} new events; ${upcoming} upcoming from ${sources} event sources`);
  return ctx;
}
