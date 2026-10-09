#!/usr/bin/env node
// Serves the events website (/) and the admin dashboard (/admin/), and runs the crawler in-process.
//   node server.js [--port 3000]       (HOST=0.0.0.0 to listen beyond localhost)
//   --start                            start crawling right away
// The admin API has no authentication, so by default it only listens on localhost.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { Engine } from './src/engine.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg('port') || process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const STATIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const engine = new Engine();
if (process.argv.includes('--start')) engine.start();

function json(req, res, body, status = 200) {
  send(req, res, encode(body), status);
}

// The events list is large; browsers all accept gzip.
function encode(body) {
  const text = JSON.stringify(body);
  return { text, gzip: text.length > 10_000 ? zlib.gzipSync(text) : null };
}

function send(req, res, { text, gzip }, status = 200) {
  if (gzip && /\bgzip\b/.test(req.headers['accept-encoding'] || '')) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' });
    res.end(gzip);
    return;
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(text);
}

// What the public page reads is built at most every 30 s, however many people open it.
const PUBLIC = { 'GET /api/events': () => engine.events(), 'GET /api/sites': () => engine.sites() };
const PUBLIC_CACHE_MS = 30_000;
const publicCache = new Map();
function cachedJson(key, ms, build) {
  let c = publicCache.get(key);
  if (!c || Date.now() - c.at > ms) publicCache.set(key, (c = { at: Date.now(), ...encode(build()) }));
  return c;
}

// The public page's Admin view: read-only copies of the admin GET routes, at ro/<name>: outside api/,
// so a proxy that guards api/ leaves them public. No settings to change, and nothing about the Claude account (plan usage).
const READONLY = {
  status: [2_000, () => { const s = engine.snapshot(); return { ...s, ai: { ...s.ai, plan: undefined } }; }],
  queue: [5_000, () => engine.queue()],
  domains: [5_000, () => engine.domains()],
  sources: [5_000, () => engine.sources()],
  coverage: [30_000, () => engine.coverage()],
  ai: [5_000, () => engine.aiCalls()],
  'ai-usage': [30_000, () => engine.aiUsage()],
};

async function readBody(req) {
  let body = '';
  for await (const chunk of req) body += chunk;
  try { return JSON.parse(body || '{}'); } catch { return {}; }
}

// Live status: one snapshot per second to every connected admin panel.
const streams = new Set();
setInterval(() => {
  if (!streams.size) return;
  const data = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
  for (const res of streams) res.write(data);
}, 1000).unref();

// Admin API. Behind a proxy, only the PUBLIC and ro/ routes above should be reachable without a login.
const routes = {
  'GET /api/sources': () => engine.sources(),
  'GET /api/status': () => engine.snapshot(),
  'GET /api/queue': () => engine.queue(),
  'GET /api/domains': () => engine.domains(),
  'GET /api/patterns': () => engine.patterns(),
  'GET /api/coverage': () => engine.coverage(),
  'GET /api/ai': () => engine.aiCalls(),
  'GET /api/ai-usage': () => engine.aiUsage(),
  'POST /api/plan': () => engine.refreshPlan(),
  'POST /api/start': () => { engine.start(); return engine.snapshot(); },
  'POST /api/run-once': () => { engine.start({ once: true }); return engine.snapshot(); },
  'POST /api/stop': () => { engine.stop(); return engine.snapshot(); },
  'POST /api/settings': (body) => { engine.updateSettings(body); return engine.snapshot(); },
};

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, 'http://x');

  if (pathname === '/api/stream') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    streams.add(res);
    req.on('close', () => streams.delete(res));
    return;
  }
  const aiDetail = pathname.match(/^\/(?:api|ro)\/ai\/([\w-]+)$/); // read-only too
  if (aiDetail && req.method === 'GET') {
    const call = engine.aiCall(aiDetail[1]);
    return call ? json(req, res, call) : json(req, res, { error: 'not found' }, 404);
  }
  const pub = PUBLIC[`${req.method} ${pathname}`];
  if (pub) return send(req, res, cachedJson(pathname, PUBLIC_CACHE_MS, pub));
  const ro = req.method === 'GET' && pathname.match(/^\/ro\/([\w-]+)$/);
  if (ro && READONLY[ro[1]]) return send(req, res, cachedJson(`ro ${ro[1]}`, ...READONLY[ro[1]]));
  const route = routes[`${req.method} ${pathname}`];
  if (route) return json(req, res, await route(req.method === 'POST' ? await readBody(req) : undefined));

  // The website at /, the admin dashboard at /admin/ (index.html in each folder).
  let file = path.join(STATIC, pathname);
  if (!file.startsWith(STATIC) || !fs.existsSync(file)) {
    res.writeHead(404).end('Not found');
    return;
  }
  if (fs.statSync(file).isDirectory()) {
    // Relative, so it also works behind a proxy that serves us under a path (/events/admin → /events/admin/).
    if (!pathname.endsWith('/')) return res.writeHead(301, { Location: `${path.basename(pathname)}/` }).end();
    file = path.join(file, 'index.html');
    if (!fs.existsSync(file)) return res.writeHead(404).end('Not found');
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}).listen(port, host, () => console.log(`Košice events + admin on http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));

// Save state on exit.
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    engine.dirty = true;
    engine.save();
    process.exit(0);
  });
}
