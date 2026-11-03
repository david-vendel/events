// Tiny JSON-file store. Each collection is one file in data/, loaded whole and
// written atomically (write temp file, then rename). The two big ones (pages,
// patterns) are in SQLite instead (records.js).
import fs from 'node:fs';
import path from 'node:path';
import { Records, openDb } from './records.js';
import { hostOf, urlKey } from './urls.js';

export const DATA_DIR = path.resolve(process.env.EVENTS_DATA_DIR || 'data');

export function load(name, fallback = {}) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, `${name}.json`), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export function save(name, value) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `${name}.json`);
  // Compact: the big collections are 100+ MB; indenting made them a third bigger and slower to write.
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value));
  fs.renameSync(`${file}.tmp`, file);
}

// All crawler state, loaded once per run and saved at the end (and periodically).
export function loadState() {
  const sources = load('sources');
  return {
    // origin -> what we know about a website (kind, learned recipe, schedule)
    sources,
    // url -> HTTP cache info (etag, last-modified, content hash), in SQLite (records.js)
    pages: openPages(),
    // url -> candidate link to explore later, with a priority score
    frontier: load('frontier'),
    // event id -> event
    events: load('events'),
    // social-network profile/page URLs we noticed, for later handling
    social: load('social'),
    // host -> visits, errors, events found (for spotting hosts that eat the crawl budget)
    hosts: load('hosts', null) ?? hostsFromSources(sources),
    // tag rules learned from the AI's verdicts: venue / listing page / title word -> tag counts
    tagRules: load('tagRules', { venues: {}, pages: {}, words: {} }),
    // URL template -> visits, visits with events, AI verdict, shared recipe (see learn.js)
    patterns: openPatterns(),
    // site -> when its sitemap was last read and what it gave
    sitemaps: load('sitemaps'),
    // place -> coordinates (geocoder cache; set status "manual" to pin a place by hand)
    venues: load('venues'),
    // date text shape -> how it's read (built-in parser / AI-written rule), when AI last checked it
    dateFormats: load('dateFormats'),
    // misc counters and timestamps (last AI discovery)
    meta: load('meta', { lastDiscoveryAt: null }),
    // every AI call: tokens, cost, what it returned
    ai: load('ai', []),
    // crawler settings changed from the admin panel
    settings: load('settings', {}),
    // pages waiting for the AI page reader: url -> { reason, priority, tries… } (see aiqueue.js)
    aiQueue: load('aiQueue', {}),
  };
}

// pages and patterns were JSON files (pages.json, patterns.json) until 2026-11-03: hundreds of
// thousands of records each, all in memory. They live in data/crawler.db now; the first start
// imports the old file and renames it to *.json.imported.
let pages = null, patterns = null;
function openPages() {
  // ukey / fkey: urlKey of the page and of where it redirected (crawler.js: seenPage); host: per-host counts
  pages ??= imported(new Records(openDb(DATA_DIR), 'pages', {
    ukey: (url) => urlKey(url),
    fkey: (url, rec) => (rec.finalUrl ? urlKey(rec.finalUrl) : null),
    host: (url) => hostOf(url),
  }), 'pages');
  return pages;
}
function openPatterns() {
  patterns ??= imported(new Records(openDb(DATA_DIR), 'patterns'), 'patterns');
  return patterns;
}
function imported(records, name) {
  const file = path.join(DATA_DIR, `${name}.json`);
  if (fs.existsSync(file) && records.query(`SELECT 1 FROM ${name} LIMIT 1`).length === 0) {
    const n = records.importObject(load(name));
    fs.renameSync(file, `${file}.imported`);
    console.log(`Imported ${n} ${name} from ${name}.json into crawler.db`);
  }
  return records;
}

// Before per-host stats existed, visits were only counted per origin in sources.json.
function hostsFromSources(sources) {
  const hosts = {};
  for (const s of Object.values(sources)) {
    const h = (hosts[new URL(s.origin).hostname] ??= {
      visits: 0, ok: 0, unchanged: 0, errors: 0, failStreak: 0, events: 0, added: 0, linksQueued: 0,
    });
    h.visits += s.stats?.visits || 0;
    h.events += s.stats?.events || 0;
    h.added += s.stats?.newEvents || 0;
  }
  return hosts;
}

const put = (name, value) => (value instanceof Records ? value.flush() : save(name, value));

export function saveState(state) {
  for (const name of saveOrder(state)) put(name, state[name]);
}

/**
 * The same, one collection at a time with a break between them, so the server answers requests
 * while the crawler's state is written (all of it at once held the event loop for seconds).
 */
export async function saveStateGently(state) {
  for (const name of saveOrder(state)) {
    put(name, state[name]);
    await new Promise((resolve) => setImmediate(resolve));
  }
}

// Events before the page cache: after a crash between the two, a page whose new events weren't
// saved is still read again (its stored hash is the old one), not skipped as unchanged.
const LAST = ['pages', 'patterns'];
const saveOrder = (state) => [...Object.keys(state).filter((k) => !LAST.includes(k)), ...LAST.filter((k) => k in state)];
