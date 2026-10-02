#!/usr/bin/env node
// Košice events crawler.
//   node crawl.js                 run one crawl cycle
//   node crawl.js --watch         keep running, one cycle every --every minutes (default 60)
//   node crawl.js --url <url>     also visit this URL first (e.g. a site you just heard about)
//   --pages N   page budget per cycle (default 60)    --ai N   max AI calls per cycle (default 5)
//   --verify N  events to cross-check against their other sources per cycle (default 15)
//   --concurrency N  pages fetched in parallel (default 5)
// For a live dashboard with start/stop, run `node server.js` instead.
//   EVENTS_FACEBOOK=on  also read dates from linked Facebook events (see src/corroborate.js)
import { loadState, saveState } from './src/store.js';
import { runCycle } from './src/crawler.js';
import { defaultControl } from './src/pool.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const watch = args.includes('--watch');
const everyMin = Number(opt('every', 60));
const options = { maxPages: Number(opt('pages', 60)), maxAi: Number(opt('ai', 5)), maxVerify: Number(opt('verify', 15)) };

let state = loadState();
const extra = opt('url');
if (extra) state.frontier[/^https?:\/\//.test(extra) ? extra : `https://${extra}`] = { score: 100, foundOn: 'cli' };

// Save what we have if interrupted mid-cycle.
process.on('SIGINT', () => {
  saveState(state);
  console.log('\nSaved state, bye.');
  process.exit(0);
});

do {
  try {
    await runCycle(state, options, defaultControl(Number(opt('concurrency', 5))));
  } catch (err) {
    console.error('Cycle failed:', err);
  }
  saveState(state);
  if (watch) {
    console.log(`Next cycle in ${everyMin} min.\n`);
    await new Promise((r) => setTimeout(r, everyMin * 60e3));
    state = loadState(); // pick up edits made to data/ while we slept
  }
} while (watch);
