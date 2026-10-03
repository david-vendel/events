// Polite HTTP fetching: robots.txt, per-host delay, conditional requests
// (ETag / Last-Modified) and a content hash so unchanged pages are skipped.
import crypto from 'node:crypto';
import zlib from 'node:zlib';

const USER_AGENT = 'KosiceEventsBot/0.1 (+https://github.com/david-vendel/events)';
const HOST_DELAY_MS = 2000;
const TIMEOUT_MS = 20000;
const MAX_BYTES = 3_000_000;

const lastHit = new Map(); // host -> timestamp of last request
const robotsCache = new Map(); // origin -> { rules: disallowed path prefixes, sitemaps: URLs }

export const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Reserve the next free slot for this host before sleeping, so parallel workers hitting the
// same host queue up HOST_DELAY_MS apart instead of all waking at once.
async function politeWait(host) {
  const slot = Math.max(Date.now(), (lastHit.get(host) || 0) + HOST_DELAY_MS);
  lastHit.set(host, slot);
  if (slot > Date.now()) await sleep(slot - Date.now());
}

// Minimal robots.txt support: "User-agent: *" (or our name) + Disallow prefixes, and Sitemap lines.
async function robots(origin) {
  if (robotsCache.has(origin)) return robotsCache.get(origin);
  const rules = [], sitemaps = [];
  try {
    await politeWait(new URL(origin).host);
    const res = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) {
      let applies = false;
      for (const raw of (await res.text()).split('\n')) {
        const line = raw.replace(/#.*/, '').trim();
        const [key, ...rest] = line.split(':');
        const value = rest.join(':').trim();
        if (/^user-agent$/i.test(key)) applies = value === '*' || /kosiceevents/i.test(value);
        else if (applies && /^disallow$/i.test(key) && value) rules.push(value);
        else if (/^sitemap$/i.test(key) && /^https?:\/\//.test(value)) sitemaps.push(value);
      }
    }
  } catch {
    // Unreachable robots.txt: treat as allowed.
  }
  const r = { rules, sitemaps };
  robotsCache.set(origin, r);
  return r;
}

const disallowed = async (u) => (await robots(u.origin)).rules.some((p) => u.pathname.startsWith(p));

/** Sitemap URLs a site's robots.txt names. */
export const robotsSitemaps = async (origin) => (await robots(origin)).sitemaps;

/**
 * Fetch a text file that isn't a web page (a sitemap, maybe gzipped), politely and within
 * robots.txt. Returns { status, text } or { status, error }.
 */
export async function fetchText(url, maxBytes = 30_000_000) {
  const u = new URL(url);
  if (await disallowed(u)) return { status: 0, error: 'robots.txt' };
  await politeWait(u.host);
  try {
    const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS * 2) });
    if (!res.ok) return { status: res.status, error: res.statusText || `HTTP ${res.status}` };
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf, { maxOutputLength: maxBytes });
    return { status: res.status, text: buf.subarray(0, maxBytes).toString('utf8') };
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message };
  }
}

/**
 * Page bytes as text, in the charset the server or the page declares (older Slovak sites use
 * windows-1250 and say so only in a <meta> tag); UTF-8 otherwise.
 */
export function decodeHtml(buf, contentType = '') {
  const label = contentType?.match(/charset=["']?([\w-]+)/i)?.[1]
    || buf.subarray(0, 4096).toString('latin1').match(/<meta[^>]+charset=["']?([\w-]+)/i)?.[1];
  try {
    return new TextDecoder(label || 'utf-8').decode(buf);
  } catch {
    return new TextDecoder('utf-8').decode(buf); // unknown label
  }
}

/**
 * Fetch a URL. Returns { status, url, html, hash, changed } or { status, error }.
 * `cache` is the stored record for this URL (from state.pages), updated in place.
 * `ignoreRobots` is only for sources the user explicitly opted into (see corroborate.js).
 */
export async function fetchPage(url, cache = {}, { ignoreRobots = false } = {}) {
  const u = new URL(url);
  if (!ignoreRobots && await disallowed(u)) return { status: 0, error: 'robots.txt' };

  await politeWait(u.host);
  const headers = { 'User-Agent': USER_AGENT, 'Accept-Language': 'sk,cs;q=0.9,en;q=0.8' };
  if (cache.etag) headers['If-None-Match'] = cache.etag;
  if (cache.lastModified) headers['If-Modified-Since'] = cache.lastModified;

  let res;
  try {
    res = await fetch(url, { headers, redirect: 'follow', signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    return { status: 0, error: err.cause?.code || err.message };
  }
  cache.fetchedAt = new Date().toISOString();
  cache.status = res.status;
  if (res.status === 304) return { status: 304, url, changed: false };
  if (!res.ok) return { status: res.status, error: res.statusText };
  if (!/html|xml/i.test(res.headers.get('content-type') || '')) {
    return { status: res.status, error: 'not html' };
  }

  const html = decodeHtml(Buffer.from(await res.arrayBuffer()), res.headers.get('content-type')).slice(0, MAX_BYTES);
  // Hash only the visible text: scripts and attributes often carry per-request
  // nonces/timestamps that would make every fetch look like a change.
  const hash = sha1(
    html
      .replace(/<(script|style|noscript)[\s\S]*?<\/\1>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' '),
  );
  const changed = hash !== cache.hash;
  Object.assign(cache, {
    hash,
    etag: res.headers.get('etag') || undefined,
    lastModified: res.headers.get('last-modified') || undefined,
  });
  return { status: res.status, url: res.url, html, hash, changed };
}
