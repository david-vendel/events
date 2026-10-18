// What the crawler has learned about where events are, so it spends its visits there.
// Every visited page counts towards its URL template (urls.js: urlPattern, and the rougher
// coarsePattern) and its host: visits, visits that found upcoming events, events, new events.
// From that:
//   - linkBonus(): links into templates and hosts that keep producing events rank higher in the
//     frontier; templates that never do (news articles, archives, help pages…) sink,
//   - hostCap(): how many pages of one host a pass may explore (productive hosts get more),
//   - where the events of a template or host are (regionAt: Slovakia, abroad, mixed): the crawler
//     collects events in Slovakia only, so links into templates and hosts whose events are abroad
//     are never queued, and their pages aren't read again,
//   - crawler.js reuses a recipe the AI wrote for one page on every page of the same template,
//     and shows each template to the AI at most once a week (state.patterns[key].aiAt).
import { coarsePattern, hostOf, urlKey, urlPattern } from './urls.js';
import { countryInUrl, foreignHost, regionOf } from './slovakia.js';

const MIN_VISITS = 3; // below this a template's record says little; the coarse one is used instead
const blank = () => ({ visits: 0, withEvents: 0, events: 0, added: 0 });

/** [exact template, coarse template] of a URL. */
export const patternKeys = (url) => [urlPattern(url), coarsePattern(url)];

/** The exact template's record (recipe, AI verdict, counts), created if missing. */
export function templateOf(state, url) {
  const key = urlPattern(url);
  return key ? (state.patterns[key] ??= blank()) : blank();
}

/**
 * Count one visit. `events` = upcoming events in Slovakia (or not known to be elsewhere) read from
 * the page, `added` = how many were new; `sk` / `abroad` = events known to be in Slovakia / abroad.
 */
export function notePatternVisit(state, url, { events = 0, added = 0, sk = 0, abroad = 0 } = {}, at = new Date().toISOString()) {
  for (const key of new Set(patternKeys(url))) {
    if (!key) continue;
    const p = (state.patterns[key] ??= blank());
    p.visits++;
    if (sk) p.sk = (p.sk || 0) + sk;
    if (abroad) p.abroad = (p.abroad || 0) + abroad;
    if (events > 0) p.withEvents++;
    p.events += events;
    // How often a visit lately found something new (a moving average): filter and sort variants
    // of one listing (…/koncerty:vstup-zdarma/, ?sort=…) keep showing events, but no new ones.
    p.newRate = 0.7 * newRate(p) + 0.3 * (added > 0 ? 1 : 0);
    p.added += added;
    p.lastAt = at;
    if (events > 0 || !p.example) p.example = url; // a sample page for the admin panel
  }
}

// Records from before newRate existed: new events per visit, as a rate.
const newRate = (p) => p.newRate ?? Math.min(0.5, p.visits ? p.added / p.visits : 0);

// What a template's record says about the next page from it: up to +8 for one that nearly always
// has events, down to -6 for one visited often without any. Events we already had (a detail page
// of an event its listing gave us, the same listing filtered another way) are worth little: once
// visited 5 times, a template that has lately rarely found a new event gets at most +1.
function yieldScore(p) {
  if (!p.withEvents) return -Math.min(6, 1 + Math.floor(p.visits / 3));
  const score = Math.min(7, Math.round(1 + 6 * (p.withEvents / p.visits))) + (p.added > 0 ? 1 : 0);
  return p.visits >= 5 && newRate(p) < 0.1 ? Math.min(1, score) : score;
}

/**
 * How a host has done so far: +2 (many new events), +1 (some events), 0 (unknown), down to -5.
 * A host whose pages lately bring nothing new (the same events under endless filter and date
 * combinations) gets no bonus, whatever it found before.
 */
export function hostBonus(h) {
  if (!h) return 0;
  if ((h.newRate ?? 1) < 0.05) return 0;
  if (h.added >= 10) return 2;
  if (h.added > 0 || h.withEvents > 0) return 1;
  const read = (h.ok || 0) + (h.unchanged || 0);
  return read >= 6 ? -Math.min(5, 1 + Math.floor(read / 8)) : 0;
}

/** Count events found abroad (or in Slovakia) on a page after it was read: its templates and host. */
export function noteCountry(state, url, { sk = 0, abroad = 0 }) {
  const h = state.hosts[hostOf(url)];
  for (const rec of [...new Set(patternKeys(url))].filter(Boolean).map((k) => state.patterns[k]).concat(h)) {
    if (!rec) continue;
    if (sk) rec.sk = (rec.sk || 0) + sk;
    if (abroad) rec.abroad = (rec.abroad || 0) + abroad;
  }
}

/**
 * Where the events on pages like this one are: 'sk', 'abroad', 'mixed', or undefined (not known).
 * A page of a site abroad whose address names the country or a town ("eventbrite.com/d/australia--
 * byron-bay/networking", "…/festivals/berlin") is that; else the exact template's record when it
 * knows, else the coarse template's, else the host's. (A Slovak site's page naming Wien is a trip
 * from Slovakia, or a guest from there.)
 */
export function regionAt(state, url, keys = patternKeys(url), host = hostOf(url)) {
  const inUrl = !host?.endsWith('.sk') && countryInUrl(url);
  if (inUrl) return inUrl;
  for (const rec of [state.patterns[keys[0]], state.patterns[keys[1]], state.hosts[host]]) {
    const r = regionOf(rec);
    if (r) return r;
  }
  return undefined;
}

/**
 * A site that has never had an event in Slovakia, and is on another country's domain (kinoaero.cz)
 * or has had events abroad (too few yet for regionAt to say so).
 */
export function siteAbroad(state, host) {
  const h = state.hosts[host];
  return !h?.sk && (foreignHost(host) || h?.abroad > 0);
}

/**
 * Is an event read from this page, whose place isn't known yet, more likely abroad? On pages whose
 * events are abroad, and on a site abroad (siteAbroad) while its pages' record says nothing.
 */
export function unknownIsAbroad(state, url) {
  const r = regionAt(state, url);
  return r === 'abroad' || (!r && siteAbroad(state, hostOf(url)));
}

/**
 * Score adjustment for a link from what earlier visits taught: its template's yield (the coarse
 * template's while the exact one has few visits, half weight while both have few) plus its host's.
 * `keys` (the link's patternKeys) and `host` can be passed when the caller has them already.
 */
export function linkBonus(state, url, keys = patternKeys(url), host = hostOf(url)) {
  if (regionAt(state, url, keys, host) === 'abroad') return ABROAD_PENALTY;
  const fine = state.patterns[keys[0]], coarse = state.patterns[keys[1]];
  const p = fine?.visits >= MIN_VISITS ? fine : coarse?.visits >= MIN_VISITS ? coarse : fine || coarse;
  const t = p?.visits ? yieldScore(p) * (p.visits >= MIN_VISITS ? 1 : 0.5) : 0;
  return t + hostBonus(state.hosts[host]);
}

/**
 * Recipes of other templates on the same host and at the same depth, best first: a site usually
 * builds "kamdomesta.sk/kosice/koncerty" and "kamdomesta.sk/bratislava/vystavy" from one layout, so
 * a recipe written for one often reads the other, and the AI isn't needed again.
 */
export function siblingRecipes(state, url, limit = 3) {
  const key = urlPattern(url);
  const host = key.slice(0, key.indexOf('/'));
  const depth = key.split('/').length;
  return Object.entries(state.patterns)
    .filter(([k, p]) => p.recipe && k !== key && k.startsWith(`${host}/`) && k.split('/').length === depth)
    .sort((a, b) => b[1].events - a[1].events)
    .slice(0, limit)
    .map(([k, p]) => ({ key: k, recipe: p.recipe }));
}

/** Has this template (or, for odd ids, its coarse template) produced events? Used for sitemaps. */
export function productiveTemplate(state, url) {
  const [fine, coarse] = patternKeys(url).map((k) => state.patterns[k]);
  return fine?.withEvents > 0 || (coarse?.withEvents >= 2 && coarse.withEvents / coarse.visits >= 0.2);
}

/** Most a link can gain from linkBonus (best template + best host). */
export const MAX_BONUS = 10;
/** A link to pages whose events are abroad: below anything else. */
const ABROAD_PENALTY = -20;

/** Pages of one host a pass may explore: more for hosts that produce events, 1 for dead ones. */
export function hostCap(state, host) {
  const h = state.hosts[host];
  if (regionOf(h) === 'abroad') return 0; // its events are outside Slovakia
  if ((h?.newRate ?? 1) < 0.05) return 3; // lately nothing new
  const b = hostBonus(h);
  return b >= 2 ? 15 : b >= 1 ? 8 : b < 0 ? 1 : 3;
}

/**
 * First run with template learning: fill it from what's on disk. Every page read before `before`
 * counts as a visit; a page that some stored event was read from counts as one with events.
 */
export function bootstrapPatterns(state, before) {
  const found = new Map(); // page -> events read from it
  for (const ev of Object.values(state.events)) {
    for (const s of ev.sources || []) {
      if (s.kind !== 'web' || s.linked || !s.via) continue;
      const k = urlKey(s.via);
      found.set(k, (found.get(k) || 0) + 1);
    }
  }
  let pages = 0;
  for (const [url, p] of Object.entries(state.pages)) {
    if (!p.visitedAt || p.visitedAt >= before) continue;
    // Every stored event was new when it was first read.
    const events = p.error ? 0 : found.get(urlKey(url)) || 0;
    notePatternVisit(state, url, { events, added: events }, p.visitedAt);
    pages++;
  }
  return pages;
}
