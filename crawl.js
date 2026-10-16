#!/usr/bin/env node
// Košice events crawler.
//   node crawl.js                 one crawl pass through every step
//   node crawl.js --watch         keep crawling, pass after pass, until Ctrl+C (5 min break when there's nothing to do)
//   node crawl.js --url <url>     also visit this URL first (e.g. a site you just heard about)
//   --pages N   pages per pass (default 200)    --ai N   max AI calls per pass (default 30)
//   --verify N  events to cross-check against their other sources per pass (default 15)
//   --concurrency N  pages fetched in parallel (default 5)
// For a live dashboard with start/stop, run `node server.js` instead.
//   EVENTS_FACEBOOK=on  also read dates from linked Facebook events (see src/corroborate.js)
import { loadState, saveState } from './src/store.js';
import { crawlPass, queueUrl } from './src/crawler.js';
import { defaultControl } from './src/pool.js';
import { setAiRecorder } from './src/ai.js';

const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : def;
};
const watch = args.includes('--watch');
const options = { maxPages: Number(opt('pages', 200)), maxAi: Number(opt('ai', 30)), maxVerify: Number(opt('verify', 15)) };

let state = loadState();
const extra = opt('url');
if (extra) queueUrl(state, /^https?:\/\//.test(extra) ? extra : `https://${extra}`);

// Keep every AI call, so the admin panel's AI log also shows what CLI runs used AI for.
setAiRecorder((rec) => {
  state.ai.push(rec);
  const u = rec.usage;
  console.log(`  [AI ${rec.job || rec.kind}] ${rec.target}: ${rec.error || `${u.input + u.cacheRead + u.cacheWrite} in / ${u.output} out tokens`}`);
});

// Save what we have if interrupted mid-pass.
process.on('SIGINT', () => {
  saveState(state);
  console.log('\nSaved state, bye.');
  process.exit(0);
});

do {
  let ctx = null;
  try {
    ctx = await crawlPass(state, options, defaultControl(Number(opt('concurrency', 5))));
  } catch (err) {
    console.error('Crawl failed:', err);
  }
  saveState(state);
  if (watch && (!ctx || ctx.offline || ctx.halted || (!ctx.used.pages && !ctx.used.verify && !ctx.used.ai))) {
    console.log(`${ctx?.offline ? 'Offline' : ctx?.halted || (ctx ? 'Nothing to crawl' : 'Crawl failed')}: trying again in 5 min.\n`);
    await new Promise((r) => setTimeout(r, 5 * 60e3));
    state = loadState(); // pick up edits made to data/ while we slept
  }
} while (watch);
