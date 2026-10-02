// One crawl cycle (events from any place are kept; link priorities still favour Košice, where we started):
//   1. re-check known event sources that are due (cheap: conditional GET + saved recipe),
//   2. verify upcoming events against the other places they're published (Facebook, tickets…),
//   3. occasionally ask AI to web-search for new sources,
//   4. spend the rest of the page budget exploring the frontier, picked pseudo-randomly
//      with a bias towards links that look like Košice events,
//   5. tag events the rules couldn't (cheap AI; answers become rules), 6. geocode new places.
// AI is only called for promising pages that have no working recipe yet.
// Work runs in a pool of parallel workers; `control` sets how many and reports progress.
import fs from 'node:fs';
import * as cheerio from 'cheerio';
import { fetchPage } from './fetcher.js';
import {
  PARSER_VERSION, applyRecipe, clean, extractLinks, makeEvent, isSocial, jsonLdEvents, pageSignals, scoreLink, simplifyHtml,
} from './extract.js';
import { checkDates } from './datecheck.js';
import { useDateFormats } from './dates.js';
import { aiAvailable, analyzePage, classifyEvents, discoverUrls, setAiConfig } from './ai.js';
import { eventTags, headingTags, learnTags } from './tags.js';
import { locateEvents } from './geo.js';
import { EventIndex, migrate } from './events.js';
import { dueForVerification, verifyEvent } from './corroborate.js';
import { defaultControl, runPool } from './pool.js';
import { domainOf, hostOf, normalizeUrl, urlKey } from './urls.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RELEARN_AFTER = 7 * DAY; // don't re-ask AI about the same page more often than this
const REVISIT_EXPLORED_AFTER = 30 * DAY; // non-source pages are re-explored at most monthly
const RETRY_FAILED_AFTER = DAY; // a failed page waits 1, 2, 4… days (up to a month) before a retry
const HOST_FAIL_STREAK = 3; // a host whose last 3 visits failed is skipped for a day
const DISCOVERY_EVERY = Number(process.env.EVENTS_DISCOVERY_HOURS || 24) * HOUR;
const MAX_FRONTIER = 5000;
const MAX_PER_HOST_EXPLORE = 3;
const TAG_BATCH = 40; // events per cheap-AI tagging call
const TAG_BATCHES = 2; // tagging calls per cycle

const iso = (t) => new Date(t).toISOString();
const clampInterval = (h) => Math.min(168, Math.max(12, Math.round(h || 24)));
const originOf = (url) => new URL(url).origin;

function sourceFor(state, url) {
  const origin = originOf(url);
  return (state.sources[origin] ??= {
    origin,
    kind: 'unknown', // unknown | events | irrelevant
    summary: undefined,
    city: undefined, // the city all its events are in, when the AI says so
    intervalHours: 24,
    nextCheckAt: undefined,
    lastCheckedAt: undefined,
    pages: {}, // listing url -> { recipe, lastCount, analyzedAt, failures }
    stats: { visits: 0, events: 0, newEvents: 0, lastNewEventAt: undefined },
  });
}

// ---------------------------------------------------------------- what we've seen / queued

// Per state object: urlKey -> page record (visited pages) and urlKey -> frontier URL (queued),
// so http/https, www and trailing-slash variants of one page count as the same page.
const indexes = new WeakMap();

function idx(state) {
  let ix = indexes.get(state);
  if (ix) return ix;
  ix = { seen: new Map(), queued: new Map() };
  indexes.set(state, ix);
  for (const [url, rec] of Object.entries(state.pages)) {
    ix.seen.set(urlKey(url), rec);
    if (rec.finalUrl) ix.seen.set(urlKey(rec.finalUrl), rec);
  }
  // Rebuild the queue once: merge duplicate URLs and drop pages visited recently.
  const frontier = {};
  for (const [url, f] of Object.entries(state.frontier)) {
    const n = normalizeUrl(url);
    if (!n || (f.foundOn !== 'cli' && visitedRecently(state, n))) continue;
    const key = urlKey(n);
    const cur = frontier[ix.queued.get(key)];
    if (!cur) { frontier[n] = f; ix.queued.set(key, n); } else if (f.score > cur.score) Object.assign(cur, { score: f.score, foundOn: f.foundOn });
  }
  state.frontier = frontier;
  return ix;
}

/** Visited (or tried and failed) recently enough that exploring it again is a waste. */
function visitedRecently(state, url) {
  const rec = idx(state).seen.get(urlKey(url));
  const at = Date.parse(rec?.visitedAt || rec?.fetchedAt);
  if (!at) return false;
  const wait = rec.error
    ? Math.min(REVISIT_EXPLORED_AFTER, RETRY_FAILED_AFTER * 2 ** ((rec.failures || 1) - 1))
    : REVISIT_EXPLORED_AFTER;
  return Date.now() - at < wait;
}

// Put a URL in the frontier, or raise the score of the entry already there for the same page.
function queue(state, url, entry) {
  const { queued } = idx(state);
  const key = urlKey(url);
  const cur = state.frontier[queued.get(key)];
  if (cur) {
    if (entry.score > cur.score) Object.assign(cur, { score: entry.score, foundOn: entry.foundOn });
    return false;
  }
  state.frontier[url] = entry;
  queued.set(key, url);
  return true;
}

function dequeue(state, url) {
  const { queued } = idx(state);
  const key = urlKey(url);
  delete state.frontier[queued.get(key) ?? url];
  queued.delete(key);
}

/** Queue a link unless that page was visited recently. Returns true if it's new in the queue. */
function addToFrontier(state, url, score, foundOn) {
  if (score < 0) return false;
  const n = normalizeUrl(url);
  if (!n || visitedRecently(state, n)) return false;
  return queue(state, n, { score, foundOn, addedAt: iso(Date.now()) });
}

/** Queue a URL even if it was visited recently (the user asked for it). */
export function queueUrl(state, url, score = 100, foundOn = 'cli') {
  const n = normalizeUrl(url);
  if (n) queue(state, n, { score, foundOn, addedAt: iso(Date.now()) });
}

function trimFrontier(state) {
  const entries = Object.entries(state.frontier);
  if (entries.length <= MAX_FRONTIER) return;
  entries.sort((a, b) => b[1].score - a[1].score);
  state.frontier = Object.fromEntries(entries.slice(0, MAX_FRONTIER));
  idx(state).queued = new Map(Object.keys(state.frontier).map((u) => [urlKey(u), u]));
}

// ---------------------------------------------------------------- per-host statistics

function hostStats(state, host) {
  return (state.hosts[host] ??= {
    visits: 0, ok: 0, unchanged: 0, errors: 0, failStreak: 0, events: 0, added: 0, linksQueued: 0,
  });
}

function recordVisit(state, ctx, url, r) {
  const host = hostOf(url);
  const h = hostStats(state, host);
  h.visits++;
  h.lastVisitAt = iso(Date.now());
  ctx.hostVisits[host] = (ctx.hostVisits[host] || 0) + 1;
  if (r.status === 'error') {
    h.errors++;
    h.failStreak++;
    h.lastError = r.note;
    return;
  }
  h.failStreak = 0;
  if (r.status === 'unchanged') h.unchanged++;
  else h.ok++;
  h.events += r.events || 0;
  h.added += r.added || 0;
  h.linksQueued += r.links || 0;
}

// A host that keeps failing (DNS gone, server down, blocking us) gets a day's rest.
function hostPaused(state, host) {
  const h = state.hosts[host];
  return h?.failStreak >= HOST_FAIL_STREAK && Date.now() - Date.parse(h.lastVisitAt) < DAY;
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
    let fullHost;
    try { fullHost = new URL(url).host; } catch { dequeue(state, url); continue; }
    const host = fullHost.replace(/^www\./, ''); // www.x.sk and x.sk are one site for the per-site cap
    if (busyHosts.has(host) || (hostCounts.get(host) || 0) >= MAX_PER_HOST_EXPLORE || hostPaused(state, fullHost)) continue;
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
    // A venue's own site often omits the address; a single-city listing at least gives the city.
    if (!ev.location && (source.venue || source.city)) ev.location = source.venue || source.city;
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
  const end = (r) => { recordVisit(state, ctx, url, r); report.end(job, r); };
  const { seen } = idx(state);
  const cache = (state.pages[url] ??= {});
  // Mark the visit before fetching, so links found meanwhile by other workers don't re-queue it,
  // and so failed fetches are remembered too.
  cache.visitedAt = iso(Date.now());
  seen.set(urlKey(url), cache);
  dequeue(state, url);
  ctx.budget.pages--;
  ctx.used.pages++;

  const res = await fetchPage(url, cache);
  if (res.url && urlKey(res.url) !== urlKey(url)) {
    // Redirected: the target is the same page, so it counts as visited too.
    cache.finalUrl = res.url;
    seen.set(urlKey(res.url), cache);
    dequeue(state, res.url);
  }
  if (res.error) {
    cache.error = res.error;
    cache.failures = (cache.failures || 0) + 1;
  } else {
    delete cache.error;
    delete cache.failures;
  }
  const source = sourceFor(state, res.url || url);
  source.stats.visits++;
  const listing = source.pages[url];
  if (res.error) {
    if (listing) listing.failures = (listing.failures || 0) + 1;
    end({ status: 'error', http: res.status, note: res.error });
    return 0;
  }
  if (!res.changed && listing?.recipe && listing.parsedWith === PARSER_VERSION) {
    end({ status: 'unchanged', http: res.status });
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
    const found = withTags(applyRecipe($, listing.recipe, res.url), listing.tags);
    // A recipe that used to work and now finds nothing means the site changed.
    recipeBroken = found.length === 0 && listing.lastCount > 0;
    listing.lastCount = found.length;
    events.push(...found);
    if (found.length) how = 'recipe';
  }

  const signals = pageSignals($);
  const wantsAi = aiAvailable('analyze')
    && (!listing?.recipe || recipeBroken)
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
      const outcome = learnFromAnalysis(state, source, url, a, $, res.url, events, report);
      if (call) call.outcome = outcome;
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
  // How this listing page was read last time, for the Sources tab ("json-ld · 19 events").
  if (source.pages[url]) {
    source.pages[url].lastRead = { how: how || 'nothing found', events: events.length, at: iso(Date.now()) };
    source.pages[url].parsedWith = PARSER_VERSION;
  }
  // A listing whose heading names one kind ("Program kina CINEMAX") gives that tag to all its events.
  if (events.length >= 2) withTags(events, headingTags(`${$('title').first().text()} ${$('h1').first().text()}`));
  const added = upsertEvents(state, events, source, ctx);
  ctx.found.events += events.length;
  ctx.found.added += added;
  end({
    status: 'ok', http: res.status, events: events.length, added, links: queued, how, ai: aiSummary(aiCall),
    kind: source.kind !== 'unknown' ? source.kind : undefined,
  });
  return added;
}

function learnFromAnalysis(state, source, url, a, $, pageUrl, events, report) {
  source.summary = a.summary;
  source.siteKind = a.siteKind;
  if (a.venue?.name) source.venue = [a.venue.name, a.venue.address].filter(Boolean).join(', ');
  if (a.listingCity) source.city = a.listingCity;
  source.kind = a.publishesEvents ? 'events' : (source.kind === 'events' ? 'events' : 'irrelevant');
  source.judgedFor = 'any place';
  source.intervalHours = clampInterval(a.checkEveryHours);

  const listing = (source.pages[url] ??= {});
  listing.analyzedAt = iso(Date.now());
  const said = [`${a.publishesEvents ? 'event source' : 'not an event source'} (${a.siteKind})${a.listingCity ? `, events in ${a.listingCity}` : ''}`];
  listing.tags = a.pageTags?.length ? a.pageTags : undefined; // e.g. a cinema programme: every event is "cinema"
  if (a.recipe) {
    const found = withTags(applyRecipe($, a.recipe, pageUrl), listing.tags);
    if (found.length) {
      listing.recipe = a.recipe;
      listing.lastCount = found.length;
      events.push(...found);
      said.push(`recipe saved, finds ${found.length} events (later visits need no AI)`);
    } else {
      report.log(`AI recipe for ${url} matched nothing; keeping AI-extracted events only`);
      said.push('recipe matched nothing, not saved');
    }
  }
  if (!listing.recipe) {
    if (a.events.length) said.push(`${a.events.length} events read by AI`);
    for (const e of a.events) {
      const ev = makeEvent({ ...e, url: e.url || undefined, tags: [...new Set([...(e.tags || []), ...(listing.tags || [])])] }, pageUrl);
      if (ev) events.push(ev);
    }
    if (!a.pageListsEvents) delete source.pages[url];
  }
  if (listing.tags) said.push(`every event here: ${listing.tags.join(', ')}`);
  if (source.venue && a.venue?.name) said.push(`venue: ${source.venue}`);
  // Other listing pages on this site: remember them and visit soon.
  if (a.publishesEvents) {
    for (const u of a.eventListUrls.slice(0, 5)) {
      try {
        if (originOf(u) !== source.origin) continue;
        source.pages[u] ??= {};
        addToFrontier(state, u, 8, url);
      } catch {}
    }
    if (a.eventListUrls.length) said.push(`${Math.min(5, a.eventListUrls.length)} more listing pages queued`);
  }
  return said.join('; ');
}

// Events from a listing page the AI tagged as a whole (say, a cinema programme) get its tags.
function withTags(events, tags) {
  if (tags?.length) for (const ev of events) ev.tags = [...new Set([...(ev.tags || []), ...tags])];
  return events;
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
  let added = 0;
  for (const [href, score] of scored.slice(0, 80)) if (addToFrontier(state, href, score, pageUrl)) added++;
  return added;
}

function scheduleNext(source, newEvents) {
  // Adaptive frequency: sources that keep producing new events get checked more often.
  source.intervalHours = clampInterval(newEvents > 0 ? source.intervalHours * 0.8 : source.intervalHours * 1.25);
  source.lastCheckedAt = iso(Date.now());
  source.nextCheckAt = iso(Date.now() + source.intervalHours * HOUR);
}

/**
 * Events with no tag after all rules: ask the cheap AI model, in batches. Each answer is kept on the
 * event and counted towards learned rules (venue / listing page / title word), so the next events
 * from the same place are tagged without AI. Each event is asked about once.
 */
async function tagUncertainEvents(state, today, report) {
  const rules = state.tagRules;
  const upcoming = Object.values(state.events).filter((e) => (e.end || e.start) >= today);
  // Unsure = no tag after all rules, or no location at all. Each event is asked about once.
  const unsure = upcoming.filter((e) => !e.aiTaggedAt && (eventTags(e, rules).length === 0 || !e.location));
  if (!unsure.length) return;
  report.phase('Tagging events', `${unsure.length} without a tag or a location`);
  for (let b = 0; b < TAG_BATCHES && unsure.length; b++) {
    const batch = unsure.splice(0, TAG_BATCH);
    const job = report.start('tag', `${batch.length} events`, 'cheap AI');
    const { tags, places, call } = await classifyEvents(batch.map((e) => ({
      title: e.title, location: e.location, description: e.description, page: e.source,
    })), { onStart: () => report.update?.(job, { note: 'AI is tagging…', ai: 'running' }) });
    let tagged = 0;
    const learned = [];
    batch.forEach((ev, i) => {
      if (!tags[i]) return; // no answer for this one: ask again next cycle
      ev.aiTags = tags[i];
      ev.aiTaggedAt = iso(Date.now());
      if (places[i] && !ev.location) Object.assign(ev, { location: places[i].city, country: places[i].country, locationFrom: 'ai' });
      learned.push(...learnTags(rules, ev, tags[i]));
      if (tags[i].length) tagged++;
    });
    for (const rule of learned) report.log(`Learned tag rule: ${rule}`);
    if (call && learned.length) call.outcome = `${call.outcome}\nNew rules (no AI needed next time):\n${learned.join('\n')}`;
    report.end(job, { status: call?.error ? 'error' : 'ok', note: call?.error || `${tagged} of ${batch.length} tagged, ${learned.length} new rules`, ai: aiSummary(call) });
  }
  for (const ev of upcoming) ev.tags = eventTags(ev, rules); // new rules may cover more events now
}

function pruneEvents(state, today) {
  const cutoff = new Date(Date.parse(today) - 14 * DAY).toISOString().slice(0, 10);
  for (const [id, ev] of Object.entries(state.events)) if ((ev.end || ev.start) < cutoff) delete state.events[id];
}

export async function runCycle(state, options = {}, control = defaultControl()) {
  const { maxPages = 60, maxAi = 5, maxVerify = 15, maxGeocode = 40, seedsFile = 'seeds.json' } = options;
  const { report } = control;
  const today = new Date().toISOString().slice(0, 10);
  const seeds = new Set(fs.existsSync(seedsFile) ? JSON.parse(fs.readFileSync(seedsFile, 'utf8')) : []);
  migrate(state);
  useDateFormats((state.dateFormats ??= {})); // learned date formats, filled as pages are read
  setAiConfig(state.settings?.ai); // AI switches and models from the admin panel
  const ctx = {
    budget: { pages: maxPages, ai: aiAvailable() ? maxAi : 0, verify: maxVerify },
    used: { pages: 0, ai: 0, verify: 0 },
    found: { events: 0, added: 0 },
    hostVisits: {}, // host -> pages fetched this cycle
    today, seeds, control, index: new EventIndex(state),
  };
  report.begin?.(ctx);
  report.phase('Starting cycle', `budget ${maxPages} pages, ${ctx.budget.ai} AI calls` +
    (aiAvailable() ? '' : ' (AI is off)'));

  for (const url of seeds) addToFrontier(state, url, 10, 'seed');

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
  if (!control.stopped() && aiAvailable('discover') && ctx.budget.ai > 0 && Date.now() - Date.parse(state.meta.lastDiscoveryAt || 0) > DISCOVERY_EVERY) {
    report.phase('AI discovery search');
    ctx.budget.ai--;
    ctx.used.ai++;
    const known = Object.values(state.sources).filter((s) => s.kind !== 'unknown').map((s) => new URL(s.origin).host);
    const job = report.start('discover', 'web search');
    const { urls, call } = await discoverUrls(known, {
      onStart: () => report.update?.(job, { note: 'AI is searching the web…', ai: 'running' }),
    });
    state.meta.lastDiscoveryAt = iso(Date.now());
    let queuedUrls = 0;
    for (const u of urls) if (addToFrontier(state, u, 7, 'ai-discovery')) queuedUrls++;
    if (call) call.outcome = `found ${urls.length} links, ${queuedUrls} new in the queue`;
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

  // Dates, tagging and locating run last, so events found this cycle get done this cycle.
  // 5. Date formats not confirmed yet (or due for a re-check), and schedules written as prose.
  if (!control.stopped() && aiAvailable('dates')) await checkDates(state, ctx, report);

  // 6. Tag events the rules couldn't place, with the cheap model; its answers become rules.
  if (!control.stopped() && aiAvailable('tag')) await tagUncertainEvents(state, today, report);

  // 7. Coordinates for upcoming events (cached per place; OpenStreetMap lookups for new places).
  if (!control.stopped()) {
    report.phase('Locating events');
    const r = await locateEvents(state, today, maxGeocode, report);
    report.log(`Located ${r.located} of ${r.total} upcoming events (${r.looked} new places looked up, ${r.found} found)`);
  }

  pruneEvents(state, today);
  trimFrontier(state);
  const upcoming = Object.values(state.events).filter((e) => (e.end || e.start) >= today).length;
  const sources = Object.values(state.sources).filter((s) => s.kind === 'events').length;
  const byDomain = {};
  for (const [host, n] of Object.entries(ctx.hostVisits)) byDomain[domainOf(host)] = (byDomain[domainOf(host)] || 0) + n;
  const top = Object.entries(byDomain).sort((a, b) => b[1] - a[1]).slice(0, 5);
  if (top.length) report.log(`Most visited domains this cycle: ${top.map(([d, n]) => `${d} ${n}`).join(', ')}`);
  report.phase(control.stopped() ? 'Stopped' : 'Cycle done',
    `${ctx.found.added} new events; ${upcoming} upcoming from ${sources} event sources`);
  return ctx;
}
