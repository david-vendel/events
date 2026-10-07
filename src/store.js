// Tiny JSON-file store. Each collection is one file in data/, loaded whole and
// written atomically (write temp file, then rename). Good enough until we move
// to a real database; the rest of the code only talks to load()/save().
import fs from 'node:fs';
import path from 'node:path';

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
  fs.writeFileSync(`${file}.tmp`, JSON.stringify(value, null, 2));
  fs.renameSync(`${file}.tmp`, file);
}

// All crawler state, loaded once per run and saved at the end (and periodically).
export function loadState() {
  const sources = load('sources');
  return {
    // origin -> what we know about a website (kind, learned recipe, schedule)
    sources,
    // url -> HTTP cache info (etag, last-modified, content hash)
    pages: load('pages'),
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
    patterns: load('patterns'),
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

export function saveState(state) {
  for (const [name, value] of Object.entries(state)) save(name, value);
}
