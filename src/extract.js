// Everything that turns HTML into structured data without AI:
// dates, schema.org Event JSON-LD, learned CSS "recipes", links and page scoring.
import * as cheerio from 'cheerio';
import { sha1 } from './fetcher.js';

export const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Plain text from strings that may contain (possibly entity-escaped) HTML, as JSON-LD often does.
export function plain(s) {
  let t = String(s || '');
  for (let i = 0; i < 2 && /[<&]/.test(t); i++) t = cheerio.load(t, null, false).text();
  return clean(t.replace(/\\[nrt]/g, ' ')).replace(/\s*(Read More|Čítať viac|Viac)\s*(…|\.\.\.)?$/i, '');
}
const fold = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------- dates

const MONTHS = {
  januar: 1, februar: 2, marec: 3, marca: 3, april: 4, maj: 5, jun: 6, jul: 7, august: 8,
  september: 9, septembra: 9, oktober: 10, oktobra: 10, november: 11, novembra: 11,
  december: 12, decembra: 12, januara: 1, februara: 2, aprila: 4, maja: 5, juna: 6, jula: 7,
  augusta: 8, january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10,
};
const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
const pad = (n) => String(n).padStart(2, '0');

function makeDate(d, m, y, now) {
  d = +d; m = +m;
  if (!(d >= 1 && d <= 31 && m >= 1 && m <= 12)) return null;
  if (!y) {
    // No year given: assume the nearest upcoming occurrence (allowing ~2 months back
    // for things that are still running or listings that lag behind).
    y = now.getFullYear();
    if (new Date(y, m - 1, d) < new Date(now.getTime() - 60 * 864e5)) y += 1;
  }
  y = +y;
  if (y < 100) y += 2000;
  return `${y}-${pad(m)}-${pad(d)}`;
}

/** Parse free-form (mostly Slovak) date text into { start, end?, time? } or null. */
export function parseDateText(text, now = new Date()) {
  const t = fold(text);
  let start, end;
  let m;

  if ((m = t.match(/(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/))) {
    start = `${m[1]}-${m[2]}-${m[3]}`;
    const e = t.slice(m.index + m[0].length).match(/(\d{4})-(\d{2})-(\d{2})/);
    if (e) end = `${e[1]}-${e[2]}-${e[3]}`;
    if (m[4]) return { start, end, time: `${m[4]}:${m[5]}` };
  } else if ((m = t.match(/(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4})?\s*[-–—]\s*(\d{1,2})\.\s*(\d{1,2})\.?\s*(\d{4})?/))) {
    // 09.10 - 11.10.2026
    const y = m[3] || m[6];
    start = makeDate(m[1], m[2], y, now);
    end = makeDate(m[4], m[5], m[6] || y, now);
  } else if ((m = t.match(/(\d{1,2})\.\s*[-–—]\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/))) {
    // 9. - 11. 10. 2026
    start = makeDate(m[1], m[3], m[4], now);
    end = makeDate(m[2], m[3], m[4], now);
  } else if ((m = t.match(new RegExp(`(\\d{1,2})\\.?\\s*(?:[-–—]\\s*(\\d{1,2})\\.?\\s*)?(${MONTH_RE})\\s*(\\d{4})?`)))) {
    // 3. októbra 2026, 9. – 11. októbra
    start = makeDate(m[1], MONTHS[m[3]], m[4], now);
    if (m[2]) end = makeDate(m[2], MONTHS[m[3]], m[4], now);
  } else if ((m = t.match(new RegExp(`(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})`)))) {
    // október 7 2026 (Facebook), October 7, 2026
    start = makeDate(m[2], MONTHS[m[1]], m[3], now);
  } else if ((m = t.match(/(?<![\d.])(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/))) {
    // 3.10.2026, 3. 10.
    start = makeDate(m[1], m[2], m[3], now);
  }
  if (!start) return null;
  if (end && end < start) end = undefined;

  const rest = m ? t.slice(m.index + m[0].length) + ' ' + t.slice(0, m.index) : t;
  const tm = rest.match(/(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/) || rest.match(/(?<![\d.])([01]?\d|2[0-3])\.([0-5]\d)\s*(?:h\b|hod)/);
  return { start, end, time: tm ? `${pad(tm[1])}:${tm[2]}` : undefined };
}

// ---------------------------------------------------------------- events

export function eventId(title, start) {
  return sha1(`${fold(title).replace(/[^a-z0-9]+/g, ' ').trim()}|${start}`).slice(0, 16);
}

export function makeEvent(raw, sourceUrl, now = new Date()) {
  const title = plain(raw.title);
  const date = raw.start ? parseDateText(raw.start, now) : parseDateText(raw.dateText || '', now);
  if (!title || !date) return null;
  const end = raw.end ? parseDateText(raw.end, now)?.start : date.end;
  return {
    id: eventId(title, date.start),
    title: title.slice(0, 200),
    start: date.start,
    end: end || undefined,
    time: raw.time || date.time,
    location: plain(raw.location).slice(0, 200) || undefined,
    description: plain(raw.description).slice(0, 500) || undefined,
    url: raw.url || sourceUrl,
    source: sourceUrl,
  };
}

function* walkJsonLd(node) {
  if (Array.isArray(node)) for (const n of node) yield* walkJsonLd(n);
  else if (node && typeof node === 'object') {
    yield node;
    if (node['@graph']) yield* walkJsonLd(node['@graph']);
    if (node.subEvent) yield* walkJsonLd(node.subEvent);
  }
}

/** schema.org Event objects embedded as JSON-LD. Free, exact, and fairly common. */
export function jsonLdEvents($, pageUrl) {
  const out = [];
  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try { data = JSON.parse($(el).text()); } catch { return; }
    for (const n of walkJsonLd(data)) {
      const types = [].concat(n['@type'] || []);
      if (!types.some((t) => /Event$/.test(t))) continue;
      const loc = [].concat(n.location || [])[0] || {};
      const addr = typeof loc.address === 'string' ? loc.address
        : [loc.address?.streetAddress, loc.address?.addressLocality].filter(Boolean).join(', ');
      const ev = makeEvent({
        title: n.name,
        start: n.startDate,
        end: n.endDate,
        location: [loc.name, addr].filter(Boolean).join(', '),
        description: n.description,
        url: n.url ? absolutize(n.url, pageUrl) : undefined,
      }, pageUrl);
      if (ev) out.push(ev);
    }
  });
  return out;
}

// First link inside an item that stays on the same site (skips map/share links).
function sameSiteLink($, $el, pageUrl) {
  const host = new URL(pageUrl).host;
  return $el.find('a[href]').toArray().map((a) => $(a).attr('href'))
    .find((h) => { try { return new URL(h, pageUrl).host === host; } catch { return false; } });
}

/**
 * Apply a learned recipe: { item, title, date, time?, location?, description?, link? }
 * where every field except `item` is a CSS selector relative to one item.
 */
export function applyRecipe($, recipe, pageUrl) {
  const out = [];
  let items;
  try { items = $(recipe.item); } catch { return out; } // invalid selector
  items.each((_, el) => {
    const $el = $(el);
    const pick = (sel) => {
      if (!sel) return '';
      try { return clean($el.find(sel).first().text()) || ($el.is(sel) ? clean($el.text()) : ''); }
      catch { return ''; }
    };
    let href;
    try {
      href = recipe.link
        ? $el.find(recipe.link).first().attr('href') || ($el.is('a') ? $el.attr('href') : undefined)
        : $el.is('a') ? $el.attr('href') : sameSiteLink($, $el, pageUrl);
    } catch {}
    const dateText = [pick(recipe.date), pick(recipe.time)].join(' ');
    const ev = makeEvent({
      title: pick(recipe.title),
      dateText,
      location: pick(recipe.location),
      description: pick(recipe.description),
      url: href ? absolutize(href, pageUrl) : undefined,
    }, pageUrl);
    if (ev) out.push(ev);
  });
  return out;
}

// ---------------------------------------------------------------- links & scoring

export function absolutize(href, base) {
  try {
    const u = new URL(href, base);
    u.hash = '';
    return u.href;
  } catch {
    return undefined;
  }
}

const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|linkedin\.com|threads\.net)$/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp[34]|avi|mov|ics)$/i;
const SKIP_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|apple\.com|microsoft\.com|wikipedia\.org|gstatic\.com|doubleclick\.net|cookiebot\.com|wa\.me|t\.me)$/i;
const EVENT_WORDS = /podujat|akci[ae]|event|kalendar|program|festival|koncert|vystav|divadl|trh|jarmok|kino|predstaven|workshop|prednask|kultur|zabav|vikend|tickets?|vstupenk|majales|beh\b|maraton/;
const KOSICE_WORDS = /kosic|kosice|cassovia|kassa|kaschau/;

/** Facebook event id from a facebook.com/events/<id> URL, or 'short' for fb.me/e/… links. */
export function facebookEvent(url) {
  try {
    const u = new URL(url);
    if (/(^|\.)fb\.me$/.test(u.hostname) && u.pathname.startsWith('/e/')) return 'short';
    if (!/(^|\.)facebook\.com$/.test(u.hostname)) return null;
    return u.pathname.match(/\/events\/(?:[^/]+\/)*?(\d{8,})/)?.[1] || null;
  } catch {
    return null;
  }
}

export function isSocial(url) {
  try { return SOCIAL.test(new URL(url).hostname); } catch { return false; }
}

/** Priority for exploring a link: higher = more likely to lead to Košice events. */
export function scoreLink(url, anchorText) {
  let u;
  try { u = new URL(url); } catch { return -1; }
  if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname) || SKIP_HOSTS.test(u.hostname)) return -1;
  if (/login|signin|register|cart|kosik|wp-admin|secret=|token=|api\/|live-preview|\/tag\/|\/author\/|print=|share=|mailto:/i.test(url)) return -1;
  const hay = fold(`${decodeURIComponent(u.hostname + u.pathname)} ${anchorText}`);
  let score = 1;
  if (EVENT_WORDS.test(hay)) score += 3;
  if (KOSICE_WORDS.test(hay)) score += 2;
  if (u.hostname.endsWith('.sk')) score += 1;
  if (u.pathname.split('/').filter(Boolean).length > 4) score -= 1; // deep pages are rarely hubs
  if (u.search.length > 60) score -= 1;
  return score;
}

export function extractLinks($, pageUrl) {
  const links = new Map();
  $('a[href]').each((_, el) => {
    const href = absolutize($(el).attr('href'), pageUrl);
    if (href && !links.has(href)) links.set(href, clean($(el).text()).slice(0, 100));
  });
  return links;
}

/** Rough "does this page list Košice events?" score, used to decide when AI is worth it. */
export function pageSignals($) {
  const text = fold($('body').text()).slice(0, 200_000);
  const dates = (text.match(/\b\d{1,2}\.\s?\d{1,2}\.(\s?\d{4})?/g) || []).length
    + (text.match(new RegExp(`\\b\\d{1,2}\\.\\s?(${MONTH_RE})`, 'g')) || []).length;
  const eventWords = (text.match(new RegExp(EVENT_WORDS.source, 'g')) || []).length;
  const kosice = (text.match(new RegExp(KOSICE_WORDS.source, 'g')) || []).length;
  return { dates, eventWords, kosice, looksLikeListing: dates >= 5 && eventWords >= 3 && kosice >= 1 };
}

/** Strip a page down to structure + text so the AI sees the DOM cheaply. */
export function simplifyHtml(html, maxChars = 60_000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, img, picture, source, video, form, template').remove();
  $('*').each((_, el) => {
    for (const name of Object.keys(el.attribs || {})) {
      if (!['class', 'id', 'href', 'datetime'].includes(name)) $(el).removeAttr(name);
    }
  });
  let out = ($('body').html() || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<(div|span)>\s*<\/\1>/g, '');
  const truncated = out.length > maxChars;
  if (truncated) out = out.slice(0, maxChars);
  return { html: out, truncated, title: clean($('title').text()) };
}
