// One crawl cycle (events from any place are kept; link priorities favour Slovakia, Košice first):
//   1. re-check known event sources that are due (cheap: conditional GET + saved recipe),
//   2. verify upcoming events against the other places they're published (Facebook, tickets…),
//   3. occasionally ask AI to web-search for new sources,
//   4. read the sitemaps of sites that produce events, for event pages no listing links to,
//   5. spend the rest of the page budget exploring the frontier, picked pseudo-randomly with a
//      bias towards links that look like events and towards page templates and hosts that have
//      produced events before (learn.js); templates that never do sink,
//   6. check new date formats, 7. tag events the rules couldn't (cheap AI; answers become rules),
//   8. geocode new places.
// AI is only called for promising pages that have no working recipe yet, at most once per page
// template a week; a recipe it writes is reused for every page built from the same template.
// Work runs in a pool of parallel workers; `control` sets how many and reports progress.
import fs from 'node:fs';
import dns from 'node:dns/promises';
import * as cheerio from 'cheerio';
import { fetchPage } from './fetcher.js';
import {
  PARSER_VERSION, applyRecipe, clean, extractLinks, makeEvent, isSocial, jsonLdEvents, pageSignals, partialStructured, scoreLink,
  simplifyHtml,
} from './extract.js';
import { checkDates } from './datecheck.js';
import { useDateFormats } from './dates.js';
import { aiAvailable, analyzePage, classifyEvents, discoverUrls, setAiConfig } from './ai.js';
import { eventTags, headingTags, learnTags } from './tags.js';
import { locateEvents } from './geo.js';
import { EventIndex, migrate } from './events.js';
import { dueForVerification, verifyEvent } from './corroborate.js';
import { defaultControl, runPool } from './pool.js';
import { domainOf, hostOf, normalizeUrl, urlKey, urlPattern } from './urls.js';
import {
  MAX_BONUS, bootstrapPatterns, hostCap, linkBonus, notePatternVisit, patternKeys, siblingRecipes, templateOf,
} from './learn.js';
import { readSitemaps, sitemapsDue } from './sitemaps.js';

const HOUR = 3600e3;
const DAY = 24 * HOUR;
const RELEARN_AFTER = 7 * DAY; // don't re-ask AI about the same page more often than this
const REVISIT_EXPLORED_AFTER = 30 * DAY; // non-source pages are re-explored at most monthly
const RETRY_FAILED_AFTER = DAY; // a failed page waits 1, 2, 4… days (up to a month) before a retry
const HOST_FAIL_STREAK = 3; // a host whose last 3 visits failed is skipped for a day
const DISCOVERY_EVERY = Number(process.env.EVENTS_DISCOVERY_HOURS || 6) * HOUR;
const MAX_FRONTIER = 5000;
const SITEMAP_SITES_PER_CYCLE = 4;
const RECHECK_PAGES = 12; // listing pages re-read per due source per cycle
const TEMPLATE_DEAD_AFTER = 5; // visits of a template without any event before AI stops looking at it
const EMPTY_READS_BEFORE_REST = 3; // a listing page empty this many reads in a row is read only now and then
const EMPTY_LISTING_REST = 14 * DAY;
const NOT_LISTING_FOR = 30 * DAY; // a page AI said lists no events isn't taken as a listing again for this long
const CRASHES_BEFORE_GIVING_UP = 10;
// Errors that mean "we can't reach the internet" rather than "this site is down".
const NET_DOWN = /ENOTFOUND|EAI_AGAIN|ENETUNREACH|ENETDOWN|EHOSTUNREACH|UND_ERR_CONNECT_TIMEOUT|fetch failed/;
const NET_FAILS_BEFORE_CHECK = 6; // network errors in a row before checking whether we're offline
const SCORE_VERSION = 3; // bump when scoreLink() changes a lot: queued links get scored again
const TAG_BATCH = 40; // events per cheap-AI tagging call
const TAG_BATCHES = 2; // tagging calls per cycle

const iso = (t) => new Date(t).toISOString();
const fmtN = (n) => (n || 0).toLocaleString('en');
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
  ix = { seen: new Map(), queued: new Map(), keys: new Map() }; // keys: url -> its page templates
  indexes.set(state, ix);
  for (const [url, rec] of Object.entries(state.pages)) {
    ix.seen.set(urlKey(url), rec);
    if (rec.finalUrl) ix.seen.set(urlKey(rec.finalUrl), rec);
  }
  // Rebuild the queue once: merge duplicate URLs and drop pages visited recently. Links queued
  // before the current scoreLink() are scored again from their URL (their anchor text is gone).
  const frontier = {};
  for (const [url, f] of Object.entries(state.frontier)) {
    const n = normalizeUrl(url);
    if (!n || (f.foundOn !== 'cli' && visitedRecently(state, n))) continue;
    if (f.v !== SCORE_VERSION && f.foundOn !== 'cli' && f.foundOn !== 'seed') {
      f.score = scoreLink(n, '');
      f.v = SCORE_VERSION;
      if (f.score < 0) continue;
    }
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
  return queue(state, n, { score, v: SCORE_VERSION, foundOn, addedAt: iso(Date.now()) });
}

/** Queue a URL even if it was visited recently (the user asked for it). */
export function queueUrl(state, url, score = 100, foundOn = 'cli') {
  const n = normalizeUrl(url);
  if (n) queue(state, n, { score, foundOn, addedAt: iso(Date.now()) });
}

// What a frontier link is worth now: its own score plus what its template and host have taught.
function effectiveScore(state, url, f) {
  const { keys } = idx(state);
  let k = keys.get(url);
  if (!k) keys.set(url, (k = patternKeys(url)));
  return f.score + linkBonus(state, url, k);
}

function trimFrontier(state) {
  const entries = Object.entries(state.frontier);
  if (entries.length <= MAX_FRONTIER) return;
  const worth = new Map(entries.map(([url, f]) => [url, effectiveScore(state, url, f)]));
  entries.sort((a, b) => worth.get(b[0]) - worth.get(a[0]));
  state.frontier = Object.fromEntries(entries.slice(0, MAX_FRONTIER));
  idx(state).queued = new Map(Object.keys(state.frontier).map((u) => [urlKey(u), u]));
}

// ---------------------------------------------------------------- per-host statistics

function hostStats(state, host) {
  return (state.hosts[host] ??= {
    visits: 0, ok: 0, unchanged: 0, errors: 0, failStreak: 0, events: 0, withEvents: 0, added: 0, linksQueued: 0,
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
  h.events += r.events || 0; // upcoming events read
  // How often a visit lately found something new (moving average; see hostBonus).
  if (r.status === 'ok') h.newRate = 0.85 * (h.newRate ?? 0.5) + 0.15 * (r.added > 0 ? 1 : 0);
  if (r.events > 0) h.withEvents = (h.withEvents || 0) + 1;
  h.added += r.added || 0;
  h.linksQueued += r.links || 0;
}

// A host that keeps failing (DNS gone, server down, blocking us) gets a day's rest.
function hostPaused(state, host) {
  const h = state.hosts[host];
  return h?.failStreak >= HOST_FAIL_STREAK && Date.now() - Date.parse(h.lastVisitAt) < DAY;
}

/**
 * Weighted pseudo-random pick: score (the link's own, plus what its template and host taught us)
 * plus noise, so good links win but anything can be chosen. Skips hosts another worker is fetching
 * right now and hosts that used up their share this cycle (hostCap: more for productive hosts).
 */
function pickFromFrontier(state, hostCounts, busyHosts, eventPages) {
  let best = null, bestKey = -Infinity;
  const caps = new Map();
  for (const [url, f] of Object.entries(state.frontier)) {
    if (f.score + MAX_BONUS + 4 <= bestKey) continue; // can't win
    if (eventPages.has(urlKey(url))) { dequeue(state, url); continue; } // verification re-reads those
    let fullHost;
    try { fullHost = new URL(url).hostname; } catch { dequeue(state, url); continue; }
    const host = fullHost.replace(/^www\./, ''); // www.x.sk and x.sk are one site for the per-site cap
    if (busyHosts.has(host) || hostPaused(state, fullHost)) continue;
    let cap = caps.get(host);
    if (cap === undefined) caps.set(host, (cap = hostCap(state, fullHost)));
    if ((hostCounts.get(host) || 0) >= cap) continue;
    const key = effectiveScore(state, url, f) + Math.random() * 4;
    if (key <= bestKey) continue;
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
    if (ev.url && ev.url !== via) ctx.eventPages.add(urlKey(ev.url));
  }
  source.stats.events += events.length;
  source.stats.newEvents += added;
  if (added) source.stats.lastNewEventAt = iso(Date.now());
  return added;
}

/** Can we resolve well-known names? False when this machine is offline (asleep, Wi-Fi gone). */
async function online() {
  const tries = ['sk-nic.sk', 'www.google.com', 'cloudflare.com'].map((h) =>
    Promise.race([dns.lookup(h), new Promise((_, no) => setTimeout(() => no(new Error('timeout')), 5000))]));
  return (await Promise.allSettled(tries)).some((r) => r.status === 'fulfilled');
}

// A visit that failed only because we were offline: as if it never happened.
function forgetVisit(state, url, host) {
  const p = state.pages[url];
  if (p) for (const k of ['visitedAt', 'error', 'failures']) delete p[k];
  const h = state.hosts[host];
  if (h) {
    h.errors = Math.max(0, h.errors - 1);
    h.failStreak = Math.max(0, h.failStreak - 1);
  }
}

/**
 * While many fetches in a row fail with network errors, check whether we are offline. If so, end
 * the cycle and forget those visits, so pages and sites aren't marked as failing.
 */
async function watchNetwork(state, url, ctx, r) {
  if (ctx.offline) {
    if (r.status === 'error' && NET_DOWN.test(r.note || '')) forgetVisit(state, url, hostOf(url));
    return;
  }
  if (r.status !== 'error' || !NET_DOWN.test(r.note || '')) { ctx.netFails = []; return; }
  ctx.netFails.push(url);
  if (ctx.netFails.length < NET_FAILS_BEFORE_CHECK || ctx.checkingNet) return;
  ctx.checkingNet = true;
  const up = await online();
  ctx.checkingNet = false;
  if (up) { ctx.netFails = []; return; } // just dead domains
  ctx.offline = true;
  ctx.budget.pages = 0;
  for (const u of ctx.netFails) forgetVisit(state, u, hostOf(u));
  ctx.control.report.log(`The network is down (DNS lookups fail): ending the cycle; ${ctx.netFails.length} failed visits forgotten`);
  ctx.netFails = [];
}

/**
 * Visit one URL: fetch, extract events (JSON-LD / recipe / AI), harvest links.
 * Returns the number of new events. A bug in the crawler's own code is caught here: it's counted
 * and shown (ctx.health), and the visit is forgotten so the page is read again once it's fixed.
 */
async function visit(state, url, ctx, phase) {
  const report = ctx.control.report;
  const job = report.start(phase, url);
  let r;
  try {
    r = await readPage(state, url, ctx, job);
  } catch (err) {
    const h = ctx.health;
    h.crashes++;
    h.lastCrash = { url, at: iso(Date.now()), error: String(err.stack || err).split('\n').slice(0, 4).join('\n') };
    if (h.crashes <= 3) report.log(`CRAWLER BUG while reading ${url}: ${err.stack || err}`);
    const cache = state.pages[url];
    if (cache) { delete cache.visitedAt; delete cache.hash; }
    if (h.crashes >= CRASHES_BEFORE_GIVING_UP && h.crashes > h.read && ctx.budget.pages > 0) {
      ctx.budget.pages = 0; // don't burn the whole queue on a bug
      report.log(`${h.crashes} crawler bugs this cycle and only ${h.read} pages read: ending the cycle early. Last: ${h.lastCrash.error}`);
    }
    report.end(job, { status: 'error', note: `crawler bug: ${err.message}` });
    return 0;
  }
  recordVisit(state, ctx, url, r);
  // Unchanged pages say nothing new about their template; offline failures say nothing at all.
  const offlineFail = r.status === 'error' && NET_DOWN.test(r.note || '');
  if (r.status !== 'unchanged' && !offlineFail) notePatternVisit(state, url, { events: r.events || 0, added: r.added || 0 });
  await watchNetwork(state, url, ctx, r);
  report.end(job, ctx.offline && offlineFail ? { ...r, note: `${r.note} (offline; not counted)` } : r);
  return r.added || 0;
}

/** The work of visit(); returns the result row for the dashboard ({ status, events, added… }). */
async function readPage(state, url, ctx, job) {
  const report = ctx.control.report;
  const health = ctx.health;
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
  health.fetched++;
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
    health.errors++;
    if (listing) listing.failures = (listing.failures || 0) + 1;
    return { status: 'error', http: res.status, note: res.error };
  }
  if (!res.changed && listing?.recipe && listing.parsedWith === PARSER_VERSION) {
    health.unchanged++;
    cache.readAt = iso(Date.now());
    return { status: 'unchanged', http: res.status };
  }

  const $ = cheerio.load(res.html);
  const links = extractLinks($, res.url);

  const events = jsonLdEvents($, res.url);
  const structured = events.length;
  const signals = pageSignals($);
  // Some sites give structured data for only the first few items ("4 of 20 films today"): then the
  // page is read like one without it, and the structured events are kept too.
  const partial = events.length > 0 && partialStructured(events, links, res.url);
  const unread = !events.length || partial;
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
  // A recipe the AI wrote for another page built from the same template, or failing that, for a
  // sibling template of the same site (same depth): no AI needed here. A sibling's recipe that
  // works is kept for this template.
  const tpl = templateOf(state, url);
  if (unread && !listing?.recipe && tpl.recipe) {
    const found = withTags(applyRecipe($, tpl.recipe, res.url), tpl.tags);
    events.push(...found);
    if (found.length) how = partial ? 'json-ld + template recipe' : 'template recipe';
  }
  if (unread && !listing?.recipe && !tpl.recipe) {
    for (const sib of siblingRecipes(state, url)) {
      const found = applyRecipe($, sib.recipe, res.url);
      if (!found.length) continue;
      Object.assign(tpl, { recipe: sib.recipe, recipeFrom: sib.key });
      events.push(...found);
      how = partial ? 'json-ld + template recipe' : 'template recipe';
      break;
    }
  }

  // The AI looks at one page per template a week, and not at templates that never have events
  // (listing pages it named itself and seeds are always worth a look).
  const tplAsked = Date.now() - Date.parse(tpl.aiAt || 0) < RELEARN_AFTER;
  const tplDead = tpl.visits >= TEMPLATE_DEAD_AFTER && !tpl.withEvents;
  // Pages of this template carry structured data: one without any just has nothing listed yet
  // (a cinema's programme for next week), and AI would find nothing either.
  if (structured && !partial) tpl.structured = true;
  const wantsAi = aiAvailable('analyze')
    && (!listing?.recipe || recipeBroken)
    && (signals.looksLikeListing || ctx.seeds.has(url) || listing)
    && (events.length === 0 || (partial && how === 'json-ld'))
    && ctx.budget.ai > 0
    && Date.now() - Date.parse(listing?.analyzedAt || 0) > RELEARN_AFTER
    && (listing || ctx.seeds.has(url) || !(tplAsked || tplDead))
    && (!tpl.structured || partial)
    && source.kind !== 'irrelevant';

  if (wantsAi) {
    ctx.budget.ai--;
    ctx.used.ai++;
    health.ai++;
    // AI runs one page at a time; parallel workers wait their turn here.
    report.update?.(job, { note: 'waiting for AI…', ai: 'waiting' });
    const { html, truncated, title } = simplifyHtml(res.html);
    const { analysis: a, call } = await analyzePage({
      url: res.url, title, html, truncated, links, today: ctx.today,
      onStart: () => report.update?.(job, { note: 'AI is reading the page…', ai: 'running' }),
    });
    aiCall = call;
    tpl.aiAt = iso(Date.now());
    if (a) {
      const outcome = learnFromAnalysis(state, source, url, a, $, res.url, events, report, tpl);
      if (call) call.outcome = outcome;
      how = source.pages[url]?.recipe ? 'AI → recipe' : 'AI';
      if (tpl.recipe && how === 'AI → recipe') health.aiRecipes++;
    }
  } else if (isListing(events, ctx.today) && source.kind !== 'irrelevant') {
    // Several upcoming events without AI: treat this page as a listing worth re-checking.
    source.kind = 'events';
    source.pages[url] ??= {};
  }

  if (source.kind === 'events' && !source.nextCheckAt) {
    source.nextCheckAt = iso(Date.now() + source.intervalHours * HOUR);
  }
  // How this listing page was read last time, for the Sources tab ("json-ld · 19 events").
  // Only upcoming events count: a page full of past events (an archive) is not a good page.
  const upcoming = events.filter((e) => (e.end || e.start) >= ctx.today);
  const page = source.pages[url];
  if (page) {
    page.lastRead = { how: how || 'nothing found', events: events.length, at: iso(Date.now()) };
    page.parsedWith = PARSER_VERSION;
    page.emptyReads = upcoming.length ? 0 : (page.emptyReads || 0) + 1;
    // A "listing" that is one event's own page (with its past dates, or "more events" alongside) is
    // read through that event's verification instead. (Events without their own link get the page's,
    // so a listing of those has many such events, not one.)
    const own = upcoming.filter((e) => urlKey(e.url) === urlKey(res.url)).length;
    if (!page.recipe && !page.analyzedAt && own === 1) delete source.pages[url];
  }
  // A listing whose heading names one kind ("Program kina CINEMAX") gives that tag to all its events.
  if (events.length >= 2) withTags(events, headingTags(`${$('title').first().text()} ${$('h1').first().text()}`));
  const added = upsertEvents(state, upcoming, source, ctx);
  const queued = harvestLinks(state, links, source, res.url, ctx, upcoming.length);
  cache.readAt = iso(Date.now());
  health.read++;
  if (upcoming.length) health.withEvents++;
  health.events += upcoming.length;
  health.added += added;
  ctx.found.events += upcoming.length;
  ctx.found.added += added;
  return {
    status: 'ok', http: res.status, events: upcoming.length, past: events.length - upcoming.length || undefined,
    added, links: queued, how, ai: aiSummary(aiCall), kind: source.kind !== 'unknown' ? source.kind : undefined,
  };
}

function learnFromAnalysis(state, source, url, a, $, pageUrl, events, report, tpl) {
  tpl.aiSaid = a.pageListsEvents ? 'lists events' : a.publishesEvents ? 'event site, but no events on this page' : 'not about events';
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
      // Other pages built from the same template ("…/podujatia/<any event>") get the same recipe.
      tpl.recipe = a.recipe;
      tpl.tags = listing.tags;
      events.push(...found);
      said.push(`recipe saved, finds ${found.length} events (later visits, and pages like ${urlPattern(url)}, need no AI)`);
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
    if (!a.pageListsEvents) {
      delete source.pages[url];
      (source.notListings ??= {})[url] = iso(Date.now());
    }
  }
  if (listing.tags) said.push(`every event here: ${listing.tags.join(', ')}`);
  if (source.venue && a.venue?.name) said.push(`venue: ${source.venue}`);
  // Other listing pages on this site: remember them and visit soon.
  if (a.publishesEvents) {
    for (const u of a.eventListUrls.slice(0, 5)) {
      try {
        if (originOf(u) !== source.origin || notListing(source, u)) continue;
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

/** Several different upcoming events: a listing (one event's page may also show its past dates). */
function isListing(events, today) {
  return new Set(events.filter((e) => (e.end || e.start) >= today).map((e) => e.title)).size >= 2;
}

/** AI said recently that this page lists no events. */
const notListing = (source, url) => Date.now() - Date.parse(source.notListings?.[url] || 0) < NOT_LISTING_FOR;

/** A listing page that has been empty for several reads is read again only every couple of weeks. */
const resting = (p) => p.emptyReads >= EMPTY_READS_BEFORE_REST && Date.now() - Date.parse(p.lastRead?.at || 0) < EMPTY_LISTING_REST;

// "Next page" links of a listing: rel=next style anchor texts, or a page number in the URL.
const NEXT_TEXT = /^(›|»|>|→|ďalš(ia|ie)|nasledujúc[aie]|next|older|staršie|viac|zobraziť viac|načítať viac)\b/i;
const PAGE_URL = /[?&](page|paged|strana|stranka|p|offset|start)=\d+|\/(page|strana|stranka)\/\d+/i;

function harvestLinks(state, links, source, pageUrl, ctx, eventsHere) {
  const scored = [];
  const pagePattern = urlPattern(pageUrl);
  for (const [href, text] of links) {
    if (isSocial(href)) {
      state.social[href] ??= { foundOn: pageUrl, text, addedAt: iso(Date.now()) };
      continue;
    }
    // Pages of events we already have are re-read by verification, not by exploring.
    if (ctx.eventPages.has(urlKey(href))) continue;
    let score = scoreLink(href, text);
    if (score < 0) continue;
    const target = state.sources[originOf(href)];
    if (target?.kind === 'irrelevant') score -= 3;
    if (target?.kind === 'events') score += 1;
    if (source.kind === 'events' && originOf(href) !== source.origin) score += 1; // event sites link to other event sites
    // More pages of a listing that has events: "page 2", "ďalšie", "?page=3".
    if (eventsHere >= 2 && hostOf(href) === hostOf(pageUrl)
      && (NEXT_TEXT.test(text) || (PAGE_URL.test(href) && (/^\d{1,3}$/.test(text) || urlPattern(href) === pagePattern)))) score += 3;
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

// 2 Oct 2026, from 10:36 UTC: after a refactor, every page that loaded made the crawler throw
// (MONTH_RE missing in extract.js) after it was fetched but before it was read. Those pages were
// marked visited (so not retried for a month) and listing pages got a new text hash (so they'd
// look unchanged). Forget those visits and queue the pages again, once.
const CRASH_REPAIR = { id: 'unread-pages-2026-10-02', from: '2026-10-02T10:36:00Z' };

function repairUnreadVisits(state, report) {
  state.meta.repairs ??= [];
  if (state.meta.repairs.includes(CRASH_REPAIR.id)) return;
  let n = 0;
  for (const [url, p] of Object.entries(state.pages)) {
    if (!p.visitedAt || p.visitedAt < CRASH_REPAIR.from || p.readAt || p.error) continue;
    for (const k of ['visitedAt', 'hash', 'etag', 'lastModified']) delete p[k];
    const score = scoreLink(url, '');
    if (score >= 0) queue(state, normalizeUrl(url) || url, { score, v: SCORE_VERSION, foundOn: 'repair', addedAt: iso(Date.now()) });
    n++;
  }
  state.meta.repairs.push(CRASH_REPAIR.id);
  if (n) report.log(`Repaired ${n} pages that a crawler bug fetched but never read (since ${CRASH_REPAIR.from}); queued again`);
}

// 2 Oct 2026, ~16:40–17:10 UTC: the machine was offline and every fetch failed with ENOTFOUND,
// marking pages as failed (retry in a day) and pausing their sites. Forget those visits, once.
const OFFLINE_REPAIR = { id: 'offline-2026-10-02', from: '2026-10-02T16:35:00Z', to: '2026-10-02T17:15:00Z' };

function repairOfflineVisits(state, report) {
  state.meta.repairs ??= [];
  if (state.meta.repairs.includes(OFFLINE_REPAIR.id)) return;
  let n = 0;
  for (const [url, p] of Object.entries(state.pages)) {
    if (p.error !== 'ENOTFOUND' || !(p.visitedAt >= OFFLINE_REPAIR.from && p.visitedAt <= OFFLINE_REPAIR.to)) continue;
    forgetVisit(state, url, hostOf(url));
    const score = scoreLink(url, '');
    if (score >= 0) queue(state, normalizeUrl(url) || url, { score, v: SCORE_VERSION, foundOn: 'repair', addedAt: iso(Date.now()) });
    n++;
  }
  for (const h of Object.values(state.hosts)) {
    if (h.lastError === 'ENOTFOUND' && h.lastVisitAt >= OFFLINE_REPAIR.from && h.lastVisitAt <= OFFLINE_REPAIR.to) h.failStreak = 0;
  }
  state.meta.repairs.push(OFFLINE_REPAIR.id);
  if (n) report.log(`Repaired ${n} pages that failed while this machine was offline (${OFFLINE_REPAIR.from.slice(11, 16)}–${OFFLINE_REPAIR.to.slice(11, 16)} UTC); queued again`);
}

/** One line per cycle for the dashboard: is the crawl finding events, and at what cost? */
function cycleSummary(ctx, startedAt) {
  const h = ctx.health;
  return {
    at: iso(startedAt), ms: Date.now() - startedAt, pages: ctx.used.pages, read: h.read, unchanged: h.unchanged,
    errors: h.errors, crashes: h.crashes, withEvents: h.withEvents, events: h.events, added: h.added,
    ai: ctx.used.ai, sitemapQueued: h.sitemapQueued,
  };
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
  state.patterns ??= {};
  state.sitemaps ??= {};
  const startedAt = Date.now();
  // Pages of events we already have (their own pages, not the listing they came from).
  const eventPages = new Set();
  for (const ev of Object.values(state.events)) {
    for (const s of ev.sources || []) if (s.url && s.url !== s.via) eventPages.add(urlKey(s.url));
  }
  const ctx = {
    budget: { pages: maxPages, ai: aiAvailable() ? maxAi : 0, verify: maxVerify },
    used: { pages: 0, ai: 0, verify: 0 },
    found: { events: 0, added: 0 },
    // How well this cycle is going: pages fetched / read / failed, crawler bugs, pages with events…
    health: {
      fetched: 0, read: 0, unchanged: 0, errors: 0, crashes: 0, lastCrash: null,
      withEvents: 0, events: 0, added: 0, ai: 0, aiRecipes: 0, sitemapFiles: 0, sitemapQueued: 0,
    },
    hostVisits: {}, // host -> pages fetched this cycle
    netFails: [], offline: false, // network errors in a row; set when we found we're offline
    today, seeds, control, eventPages, index: new EventIndex(state),
  };
  report.begin?.(ctx);
  report.phase('Starting cycle', `budget ${maxPages} pages, ${ctx.budget.ai} AI calls` +
    (aiAvailable() ? '' : ' (AI is off)'));

  if (!(await online())) {
    report.phase('Offline', 'no network (DNS lookups fail); trying again next cycle');
    ctx.offline = true;
    return ctx;
  }
  repairUnreadVisits(state, report);
  repairOfflineVisits(state, report);
  if (!Object.keys(state.patterns).length) {
    const n = bootstrapPatterns(state, CRASH_REPAIR.from);
    report.log(`Page templates: learned from ${n} earlier visits which kinds of pages hold events`);
  }
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
      // The listing pages read longest ago first, so a site with many (one per town and kind of
      // event) gets all of them re-read over a few checks.
      const pages = Object.entries(source.pages)
        .filter(([, p]) => !(p.failures >= 5) && !resting(p)) // dead, or empty for a while
        .sort((a, b) => (a[1].lastRead?.at || '').localeCompare(b[1].lastRead?.at || ''))
        .slice(0, RECHECK_PAGES);
      for (const [url] of pages) {
        if (ctx.budget.pages <= 0 || control.stopped()) break;
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
      if (!ev || ctx.offline) return null;
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

  // 4. Sitemaps of sites that produce events: event pages no listing links to.
  if (!control.stopped() && ctx.budget.pages > 0) {
    const due = sitemapsDue(state, seeds).slice(0, SITEMAP_SITES_PER_CYCLE);
    if (due.length) report.phase('Reading sitemaps', `${due.length} sites`);
    await runPool(() => {
      const origin = due.shift();
      if (!origin || ctx.budget.pages <= 0) return null;
      return async () => {
        const job = report.start('sitemap', origin);
        let r;
        try {
          r = await readSitemaps(state, origin, {
            queue: (u, score) => addToFrontier(state, u, score, 'sitemap'),
            skip: (u) => ctx.eventPages.has(urlKey(u)) || visitedRecently(state, u),
            takePage: () => {
              if (ctx.budget.pages <= 0) return false;
              ctx.budget.pages--;
              ctx.used.pages++;
              ctx.health.sitemapFiles++;
              return true;
            },
          });
        } catch (err) {
          report.end(job, { status: 'error', note: `crawler bug: ${err.message}` });
          return;
        }
        ctx.health.sitemapQueued += r.queued;
        report.end(job, r.files.length
          ? { status: 'ok', links: r.queued, note: `${fmtN(r.urls)} pages listed, ${fmtN(r.wanted)} look like events, ${r.queued} queued` }
          : { status: 'nothing', note: 'no sitemap found' });
      };
    }, control);
  }

  // 5. Explore.
  if (!control.stopped()) {
    const hostCounts = new Map();
    const busyHosts = new Set();
    report.phase('Exploring', `${Object.keys(state.frontier).length} URLs in queue`);
    await runPool(() => {
      if (ctx.budget.pages <= 0) return null;
      const pick = pickFromFrontier(state, hostCounts, busyHosts, ctx.eventPages);
      if (!pick) return null;
      hostCounts.set(pick.host, (hostCounts.get(pick.host) || 0) + 1);
      busyHosts.add(pick.host);
      return () => visit(state, pick.url, ctx, 'explore').finally(() => busyHosts.delete(pick.host));
    }, control);
  }

  // Dates, tagging and locating run last, so events found this cycle get done this cycle.
  // 6. Date formats not confirmed yet (or due for a re-check), and schedules written as prose.
  if (!control.stopped() && aiAvailable('dates')) await checkDates(state, ctx, report);

  // 7. Tag events the rules couldn't place, with the cheap model; its answers become rules.
  if (!control.stopped() && aiAvailable('tag')) await tagUncertainEvents(state, today, report);

  // 8. Coordinates for upcoming events (cached per place; OpenStreetMap lookups for new places).
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
  const sum = cycleSummary(ctx, startedAt);
  state.meta.cycles = [...(state.meta.cycles || []).slice(-49), sum];
  report.log(`Yield: ${sum.read} pages read, ${sum.withEvents} had upcoming events (${sum.read ? Math.round((100 * sum.withEvents) / sum.read) : 0} %), `
    + `${sum.added} new events, ${sum.ai} AI calls${sum.errors ? `, ${sum.errors} fetch errors` : ''}`
    + `${sum.crashes ? `, ${sum.crashes} CRAWLER BUGS (see the health box)` : ''}`);
  report.phase(control.stopped() ? 'Stopped' : 'Cycle done',
    `${ctx.found.added} new events; ${upcoming} upcoming from ${sources} event sources`);
  return ctx;
}
