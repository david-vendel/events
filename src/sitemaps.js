// Sitemaps of sites that are proven event sources. A listing shows only its first page and links
// only some events; a sitemap lists every page. For a host whose pages have produced events (or a
// seed), the sitemap is read at most once a day, and URLs whose template has produced events
// before (learn.js), or that look like event pages, go into the frontier, newest first.
// GoOut, for example, lists ~27,000 event pages per language this way.
import { fetchText, robotsSitemaps } from './fetcher.js';
import { productiveTemplate } from './learn.js';
import { scoreLink } from './extract.js';
import { hostOf } from './urls.js';

const DAY = 864e5;
const MAX_FETCHES = 6; // sitemap files read per host per visit (index + children)
const MAX_CHILDREN = 3; // children of a sitemap index, the most event-like first
const MAX_QUEUED = 150; // URLs queued per host per visit
const EVENTY = /event|podujat|akci|kalendar|program|listk|ticket|vstupenk|predstaven|koncert|festival|vystav|udalost/i;
// Language markers in sitemap names (GoOut: event-SK-0.xml, event-CS-0.xml…): Slovak first.
const SLOVAK = /(^|[^a-z])sk([^a-z]|$)/i;
const OTHER_LANG = /(^|[^a-z])(cs|cz|en|pl|de|uk|ua|hu|ru|fr|it|es)([^a-z]|$)/i;

const site = (h) => h.replace(/^www\./, '');

export function parseSitemap(xml) {
  const entries = [];
  for (const m of xml.matchAll(/<(url|sitemap)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const loc = m[2].match(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\]\s]+)/i)?.[1];
    const lastmod = m[2].match(/<lastmod>\s*([^<\s]+)/i)?.[1];
    if (loc) entries.push({ loc: loc.replace(/&amp;/g, '&'), lastmod });
  }
  return { isIndex: /<sitemapindex/i.test(xml), entries };
}

// Children of a sitemap index worth reading: event-like names, Slovak before other languages.
function pickChildren(entries) {
  if (entries.length <= MAX_CHILDREN) return entries;
  const score = (u) => {
    const name = u.split('/').pop();
    return (EVENTY.test(name) ? 2 : 0) + (SLOVAK.test(name) ? 1 : OTHER_LANG.test(name) ? -1 : 0);
  };
  return entries.map((e) => [e, score(e.loc)]).filter(([, s]) => s >= 1)
    .sort((a, b) => b[1] - a[1] || (b[0].lastmod || '').localeCompare(a[0].lastmod || ''))
    .slice(0, MAX_CHILDREN).map(([e]) => e);
}

/** Sites whose sitemap is due: productive hosts and seeds, read at most daily, best first. */
export function sitemapsDue(state, seeds) {
  const origins = new Map(); // origin -> priority
  for (const [host, h] of Object.entries(state.hosts)) {
    if (h.added > 0 || h.withEvents > 0) origins.set(`https://${host}`, (h.added || 0) + (h.withEvents || 0));
  }
  for (const s of Object.values(state.sources)) if (s.kind === 'events' && !origins.has(s.origin)) origins.set(s.origin, 1);
  for (const u of seeds) { try { const o = new URL(u).origin; if (!origins.has(o)) origins.set(o, 0); } catch {} }
  const now = Date.now();
  return [...origins].filter(([o]) => now - Date.parse(state.sitemaps[o]?.checkedAt || 0) > DAY)
    .sort((a, b) => b[1] - a[1]).map(([o]) => o);
}

/**
 * Read one site's sitemaps and queue its likely event pages. `queue(url, score)` returns true when
 * the URL is new in the frontier; `skip(url)` says it's already known or visited. Each file read
 * takes one page of the cycle's budget through `takePage()`, which returns false when none is left.
 */
export async function readSitemaps(state, origin, { queue, skip, takePage }) {
  const rec = (state.sitemaps[origin] = { checkedAt: new Date().toISOString() });
  const host = site(hostOf(origin));
  let files = await robotsSitemaps(origin);
  const guessed = !files.length;
  if (guessed) files = [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/wp-sitemap.xml`];

  const urls = [];
  const read = [];
  let fetches = 0;
  while (files.length && fetches < MAX_FETCHES && takePage()) {
    const file = files.shift();
    fetches++;
    const res = await fetchText(file);
    if (res.error || !/<(urlset|sitemapindex)\b/i.test(res.text || '')) continue;
    const { isIndex, entries } = parseSitemap(res.text);
    read.push(`${file.replace(origin, '')} (${entries.length})`);
    if (isIndex) files.unshift(...pickChildren(entries).map((e) => e.loc));
    else urls.push(...entries);
    if (guessed && !isIndex) break; // found the site's sitemap; the other guesses are aliases
  }

  // Pages on this site that look like events, or whose template has produced events. Newest first.
  const today = new Date().toISOString().slice(0, 10);
  const wanted = urls.filter(({ loc, lastmod }) => {
    if (site(hostOf(loc)) !== host || skip(loc)) return false;
    if (lastmod && lastmod.slice(0, 10) < today && Date.parse(lastmod) < Date.now() - 365 * DAY) return false; // untouched for a year
    return productiveTemplate(state, loc) || (EVENTY.test(new URL(loc).pathname) && scoreLink(loc, '') >= 4);
  }).sort((a, b) => (b.lastmod || '').localeCompare(a.lastmod || ''));

  let queued = 0;
  for (const { loc } of wanted) {
    if (queued >= MAX_QUEUED) break;
    const score = scoreLink(loc, '');
    if (score >= 0 && queue(loc, score + 2)) queued++;
  }
  Object.assign(rec, { files: read, urls: urls.length, wanted: wanted.length, queued });
  return rec;
}
