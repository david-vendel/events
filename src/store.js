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
  return {
    // origin -> what we know about a website (kind, learned recipe, schedule)
    sources: load('sources'),
    // url -> HTTP cache info (etag, last-modified, content hash)
    pages: load('pages'),
    // url -> candidate link to explore later, with a priority score
    frontier: load('frontier'),
    // event id -> event
    events: load('events'),
    // social-network profile/page URLs we noticed, for later handling
    social: load('social'),
    // misc counters and timestamps (last AI discovery)
    meta: load('meta', { lastDiscoveryAt: null }),
    // every AI call: tokens, cost, what it returned
    ai: load('ai', []),
    // crawler settings changed from the admin panel
    settings: load('settings', {}),
  };
}

export function saveState(state) {
  for (const [name, value] of Object.entries(state)) save(name, value);
}
