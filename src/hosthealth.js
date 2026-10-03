// Sites that are down. A site whose server keeps failing (5xx, overloaded, timing out) is put aside
// for a while: every kind of work for it (re-reading its listings, verifying its events, exploring,
// sitemaps) waits, stays due, and runs when the wait is over. Waits double while it stays down.
// Errors that say nothing about the site's server (404, a page that isn't HTML, DNS while we may
// be offline: see crawler.js) don't count.
import { hostOf } from './urls.js';

const FAILS_BEFORE_DOWN = 3;
const FIRST_WAIT = 2 * 3600e3;
const MAX_WAIT = 24 * 3600e3;
const SERVER_ERROR = /ETIMEDOUT|ECONNREFUSED|ECONNRESET|EPIPE|UND_ERR|timeout|aborted|socket hang up|other side closed/i;

/** Did this fetch fail because the site's server is in trouble? */
export const serverTrouble = (res) => Boolean(res?.error)
  && (res.status >= 500 || res.status === 429 || (!res.status && SERVER_ERROR.test(res.error)));

const record = (state, url) => {
  const host = hostOf(url);
  return host ? (state.hosts[host] ??= { visits: 0, ok: 0, unchanged: 0, errors: 0, failStreak: 0, events: 0, added: 0, linksQueued: 0 }) : null;
};

/** When the site of this URL can be tried again (ms), or 0 if it isn't down. */
export function downUntil(state, url) {
  const t = Date.parse(state.hosts[hostOf(url)]?.downUntil || 0);
  return t > Date.now() ? t : 0;
}

/**
 * Note how a fetch went. Returns the time the site is down until when this fetch put it down
 * (so the caller can say so once), else 0.
 */
export function noteFetch(state, url, res) {
  const h = record(state, url);
  if (!h) return 0;
  if (!res.error || !serverTrouble(res)) {
    if (!res.error) {
      h.troubleStreak = 0;
      h.downs = 0;
      delete h.downUntil;
    }
    return 0;
  }
  h.troubleStreak = (h.troubleStreak || 0) + 1;
  h.lastTrouble = `${res.status || ''} ${res.error}`.trim();
  if (h.troubleStreak < FAILS_BEFORE_DOWN || downUntil(state, url)) return 0;
  const until = Date.now() + Math.min(MAX_WAIT, FIRST_WAIT * 2 ** (h.downs || 0));
  h.downs = (h.downs || 0) + 1;
  h.downUntil = new Date(until).toISOString();
  return until;
}
