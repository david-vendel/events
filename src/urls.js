// URL identity: the same page is often linked as http/https, with or without www, with a
// trailing slash, a #fragment, tracking parameters or a session id. normalizeUrl() cleans the
// parts that never change the page; urlKey() also ignores scheme, www and the trailing slash,
// and is what "have we seen this page?" compares.

const TRACKING = /^(utm_\w+|fbclid|gclid|dclid|msclkid|mc_cid|mc_eid|_ga|_gl|igshid|ref_src|yclid)$/i;

/** Absolute http(s) URL without fragment, tracking params or ;jsessionid. Undefined if invalid. */
export function normalizeUrl(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return undefined; }
  if (!/^https?:$/.test(u.protocol)) return u.href;
  u.hash = '';
  u.pathname = u.pathname.replace(/;jsessionid=[^/?]*/i, '');
  for (const name of [...u.searchParams.keys()]) if (TRACKING.test(name)) u.searchParams.delete(name);
  return u.href.replace(/\?$/, '');
}

/** Key that is equal for URLs that almost certainly show the same page. */
export function urlKey(url) {
  const n = normalizeUrl(url);
  if (!n) return url;
  const u = new URL(n);
  u.searchParams.sort();
  const path = u.pathname.replace(/\/+$/, '') || '/';
  return `${u.hostname.replace(/^www\./, '')}${u.port ? `:${u.port}` : ''}${path}${u.search}`;
}

export const hostOf = (url) => { try { return new URL(url).hostname; } catch { return ''; } };

/**
 * Registrable domain of a host ("www.kosice.sk" → "kosice.sk", "debata.pravda.sk" → "pravda.sk").
 * Approximate: handles the common two-part suffixes (co.uk, com.au…), not the full public suffix list.
 */
export function domainOf(host) {
  const h = host.replace(/^www\./, '');
  if (/^[\d.]+$/.test(h) || h.includes(':')) return h;
  const parts = h.split('.');
  const n = /^(co|com|net|org|gov|ac|edu)\.[a-z]{2}$/.test(parts.slice(-2).join('.')) ? 3 : 2;
  return parts.slice(-n).join('.');
}
