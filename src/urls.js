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

/**
 * The template a URL belongs to: host plus the shape of its path, so pages built from one template
 * share what the crawler learns about them (do they hold events?) and one AI-written recipe.
 * Numbers become #, dates D, slugs *; short words stay ("sk", "podujatia", "page"). Query values
 * are dropped, names kept.
 *   nasekosice.sk/podujatia/1022-taste-of-fire  → nasekosice.sk/podujatia/*
 *   www.kosicak.sk/clanky/6463/video-kosicky-…  → kosicak.sk/clanky/#/*
 *   www.kosice.sk/kalendar-primatora?year=2020&month=7 → kosice.sk/kalendar-primatora?month&year
 */
const shapeSegment = (seg) => {
  let s;
  try { s = decodeURIComponent(seg).toLowerCase(); } catch { s = seg.toLowerCase(); }
  if (/^\d+$/.test(s)) return '#';
  if (/^\d{4}-\d{2}(-\d{2})?$/.test(s)) return 'D';
  if (s.length <= 24 && /^[a-z_]+(-[a-z_]+)?(\.(html?|php|aspx?))?$/.test(s)) return s;
  return '*';
};

export function urlPattern(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').filter(Boolean);
  const shape = segs.slice(0, 5).map(shapeSegment);
  if (segs.length > 5) shape.push('…');
  const params = [...new Set(u.searchParams.keys())].sort();
  return `${u.hostname.replace(/^www\./, '')}/${shape.join('/')}${params.length ? `?${params.join('&')}` : ''}`;
}

/**
 * A rougher template: host, first path segment and depth ("goout.net/sk/…3"). Some sites use
 * random-looking words as ids (goout.net/sk/particka/szejfiy), which urlPattern() can't tell from
 * words; this one still groups them, and is used while the exact template has too few visits.
 */
export function coarsePattern(url) {
  let u;
  try { u = new URL(url); } catch { return ''; }
  const segs = u.pathname.split('/').filter(Boolean);
  const host = u.hostname.replace(/^www\./, '');
  return segs.length ? `${host}/${shapeSegment(segs[0])}/…${segs.length}` : `${host}/`;
}
