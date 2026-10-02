#!/usr/bin/env node
// Serves the events website and the admin panel, and runs the crawler in-process.
//   node server.js [--port 3000]       (HOST=0.0.0.0 to listen beyond localhost)
//   --start                            start crawling right away
// The admin API has no authentication, so by default it only listens on localhost.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Engine } from './src/engine.js';

const arg = (name) => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined; };
const port = Number(arg('port') || process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
const PUBLIC = path.resolve('public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const engine = new Engine();
if (process.argv.includes('--start')) engine.start();

function json(res, body, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

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

const routes = {
  'GET /api/events': () => engine.events(),
  'GET /api/sources': () => engine.sources(),
  'GET /api/status': () => engine.snapshot(),
  'GET /api/queue': () => engine.queue(),
  'GET /api/domains': () => engine.domains(),
  'GET /api/patterns': () => engine.patterns(),
  'GET /api/ai': () => engine.aiCalls(),
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
  const aiDetail = pathname.match(/^\/api\/ai\/([\w-]+)$/);
  if (aiDetail && req.method === 'GET') {
    const call = engine.aiCall(aiDetail[1]);
    return call ? json(res, call) : json(res, { error: 'not found' }, 404);
  }
  const route = routes[`${req.method} ${pathname}`];
  if (route) return json(res, await route(req.method === 'POST' ? await readBody(req) : undefined));

  const file = path.join(PUBLIC, pathname === '/' ? 'index.html' : pathname);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404).end('Not found');
    return;
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
