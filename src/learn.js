// What the crawler has learned about where events are, so it spends its visits there.
// Every visited page counts towards its URL template (urls.js: urlPattern, and the rougher
// coarsePattern) and its host: visits, visits that found upcoming events, events, new events.
// From that:
//   - linkBonus(): links into templates and hosts that keep producing events rank higher in the
//     frontier; templates that never do (news articles, archives, help pages…) sink,
//   - hostCap(): how many pages of one host a cycle may explore (productive hosts get more),
//   - crawler.js reuses a recipe the AI wrote for one page on every page of the same template,
//     and shows each template to the AI at most once a week (state.patterns[key].aiAt).
import { coarsePattern, hostOf, urlKey, urlPattern } from './urls.js';

const MIN_VISITS = 3; // below this a template's record says little; the coarse one is used instead
const blank = () => ({ visits: 0, withEvents: 0, events: 0, added: 0 });

/** [exact template, coarse template] of a URL. */
export const patternKeys = (url) => [urlPattern(url), coarsePattern(url)];

/** The exact template's record (recipe, AI verdict, counts), created if missing. */
export function templateOf(state, url) {
  const key = urlPattern(url);
  return key ? (state.patterns[key] ??= blank()) : blank();
}

/** Count one visit. `events` = upcoming events read from the page, `added` = how many were new. */
export function notePatternVisit(state, url, { events = 0, added = 0 } = {}, at = new Date().toISOString()) {
  for (const key of new Set(patternKeys(url))) {
    if (!key) continue;
    const p = (state.patterns[key] ??= blank());
    p.visits++;
    if (events > 0) p.withEvents++;
    p.events += events;
    p.added += added;
    p.lastAt = at;
    if (events > 0 || !p.example) p.example = url; // a sample page for the admin panel
  }
}

// What a template's record says about the next page from it: up to +8 for one that nearly always
// has events, down to -6 for one visited often without any. Events we already had (a detail page
// of an event its listing gave us) are worth little: after 5 visits without a new event, at most +1.
function yieldScore(p) {
  if (!p.withEvents) return -Math.min(6, 1 + Math.floor(p.visits / 3));
  const score = Math.min(7, Math.round(1 + 6 * (p.withEvents / p.visits))) + (p.added > 0 ? 1 : 0);
  return p.added === 0 && p.visits >= 5 ? Math.min(1, score) : score;
}

/** How a host has done so far: +2 (many new events), +1 (some events), 0 (unknown), down to -5. */
export function hostBonus(h) {
  if (!h) return 0;
  if (h.added >= 10) return 2;
  if (h.added > 0 || h.withEvents > 0) return 1;
  const read = (h.ok || 0) + (h.unchanged || 0);
  return read >= 6 ? -Math.min(5, 1 + Math.floor(read / 8)) : 0;
}

/**
 * Score adjustment for a link from what earlier visits taught: its template's yield (the coarse
 * template's while the exact one has few visits, half weight while both have few) plus its host's.
 * `keys` (the link's patternKeys) and `host` can be passed when the caller has them already.
 */
export function linkBonus(state, url, keys = patternKeys(url), host = hostOf(url)) {
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

/** Pages of one host a cycle may explore: more for hosts that produce events, 1 for dead ones. */
export function hostCap(state, host) {
  const b = hostBonus(state.hosts[host]);
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
