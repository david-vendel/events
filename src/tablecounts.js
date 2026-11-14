// How many pages, templates and recipes data/crawler.db holds, for the status panel.
//
// Counting means reading the whole table: with 1.6M pages and 390k templates that took 14 s and
// 11 s, plus a JSON scan for recipes. Done on the main thread once a minute (Nov 2026), it held the
// event loop for half of every minute, so the public site timed out. Here a worker thread counts on
// its own read-only connection (WAL lets it read while the crawler writes), now and then; the
// status panel shows the last numbers it gave.
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';

const EVERY_MS = 10 * 60e3;

if (!isMainThread && workerData?.tableCounts) {
  const db = new DatabaseSync(path.join(workerData.dir, 'crawler.db'), { readOnly: true });
  const n = (sql) => db.prepare(sql).get().n;
  parentPort.on('message', () => {
    try {
      parentPort.postMessage({
        templates: n('SELECT count(*) AS n FROM patterns'),
        recipes: n("SELECT count(*) AS n FROM patterns WHERE json_extract(data, '$.recipe') IS NOT NULL"),
        pagesKnown: n('SELECT count(*) AS n FROM pages'),
      });
    } catch (err) {
      parentPort.postMessage({ error: err.message });
    }
  });
}

let latest = {}; // { templates, recipes, pagesKnown } once counted
let worker = null;
let busy = false;
let lastAt = 0;

/** The last counts (empty until the first are in); starts a new count when they're old. */
export function tableCounts(dir) {
  if (!busy && Date.now() - lastAt > EVERY_MS) {
    busy = true;
    lastAt = Date.now();
    try {
      worker ??= spawn(dir);
      worker.postMessage('count');
    } catch {
      busy = false;
      worker = null;
    }
  }
  return latest;
}

function spawn(dir) {
  const w = new Worker(new URL(import.meta.url), { workerData: { tableCounts: true, dir } });
  w.unref(); // never keeps the process alive
  w.on('message', (m) => {
    busy = false;
    if (!m.error) latest = m;
  });
  w.on('error', () => { busy = false; worker = null; });
  w.on('exit', () => { busy = false; worker = null; });
  return w;
}
