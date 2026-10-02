// Everything that turns HTML into structured data without AI:
// schema.org Event JSON-LD, learned CSS "recipes", links and page scoring. Dates: dates.js.
import * as cheerio from 'cheerio';
import { sha1 } from './fetcher.js';
import { normalizeUrl } from './urls.js';
import { TAGS, tagsFromSchemaTypes } from './tags.js';
import { MONTH_RE, finishDate, parseDateText, readDateText } from './dates.js';

export { PARSER_VERSION, parseDateText } from './dates.js';

export const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Plain text from strings that may contain (possibly entity-escaped) HTML, as JSON-LD often does.
export function plain(s) {
  let t = String(s || '');
  for (let i = 0; i < 2 && /[<&]/.test(t); i++) t = cheerio.load(t, null, false).text();
  return clean(t.replace(/\\[nrt]/g, ' ')).replace(/\s*(Read More|Čítať viac|Viac)\s*(…|\.\.\.)?$/i, '');
}
const fold = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------- events

export function eventId(title, start) {
  return sha1(`${fold(title).replace(/[^a-z0-9]+/g, ' ').trim()}|${start}`).slice(0, 16);
}

// Slovak local date and time of an instant.
const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

/**
 * A structured (schema.org) date: ISO "2026-10-07" / "2026-10-07T18:00" are taken as written; a
 * JavaScript date string with a zone ("Mon Apr 13 2026 10:00:01 GMT+0000", GoOut) is an instant
 * and is turned into Slovak local time.
 */
function structuredDate(text, now) {
  const parsed = parseDateText(text, now);
  if (parsed) return parsed;
  const t = Date.parse(text);
  if (Number.isNaN(t) || !/\d{4}/.test(text)) return null;
  const [start, time] = LOCAL.format(new Date(t)).split(' ');
  return finishDate({ start, time });
}

export function makeEvent(raw, sourceUrl, now = new Date()) {
  const title = plain(raw.title);
  // Free-form text (from a recipe) goes through the learned formats; structured dates don't need to.
  const date = raw.start ? structuredDate(raw.start, now) : readDateText(clean(raw.dateText), now);
  if (!title || !date) return null;
  const endDate = raw.end ? structuredDate(raw.end, now) : null;
  const time = raw.time || date.time;
  const fin = finishDate({
    start: date.start,
    end: endDate ? endDate.start : date.end,
    time,
    endTime: raw.endTime || (endDate ? endDate.time : date.endTime),
  });
  return {
    id: eventId(title, date.start),
    title: title.slice(0, 200),
    start: fin.start,
    end: fin.end,
    time: fin.time,
    endTime: fin.endTime,
    dateText: raw.start ? undefined : clean(raw.dateText), // kept so the date can be read again when a format is learned
    location: plain(raw.location).slice(0, 200) || undefined,
    description: plain(raw.description).slice(0, 500) || undefined,
    url: raw.url || sourceUrl,
    source: sourceUrl,
    tags: raw.tags?.filter((t) => TAGS.includes(t)).length ? raw.tags.filter((t) => TAGS.includes(t)) : undefined,
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
        tags: tagsFromSchemaTypes(types),
      }, pageUrl);
      // Coordinates, when the page gives them (Place.geo): the best location there is.
      const lat = Number(loc.geo?.latitude), lon = Number(loc.geo?.longitude);
      if (ev && Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) ev.geo = { lat, lon };
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

// Absolute URL without #fragment, tracking parameters or session id (see urls.js).
export const absolutize = (href, base) => normalizeUrl(href, base);

const SOCIAL = /(^|\.)(facebook\.com|fb\.com|instagram\.com|tiktok\.com|x\.com|twitter\.com|youtube\.com|linkedin\.com|threads\.net)$/i;
const SKIP_EXT = /\.(pdf|jpe?g|png|gif|webp|svg|zip|rar|docx?|xlsx?|pptx?|mp[34]|avi|mov|ics)$/i;
const SKIP_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|apple\.com|microsoft\.com|wikipedia\.org|gstatic\.com|doubleclick\.net|cookiebot\.com|wa\.me|t\.me)$/i;
const EVENT_WORDS = /podujat|akci[ae]|event|kalendar|program|festival|koncert|vystav|divadl|trh|jarmok|kino|predstaven|workshop|prednask|kultur|zabav|vikend|tickets?|vstupenk|listky|majales|beh\b|maraton/;
const KOSICE_WORDS = /kosic|kosice|cassovia|kassa|kaschau/;
// Slovak towns and regions: the crawler covers all of Slovakia first.
const SK_PLACES = /kosic|bratislav|zilin|presov|banska.?bystric|nitr[ae]|trnav|trencin|poprad|martin|michalovc|spisska|bardejov|humenn|levic|komarn|piestan|zvolen|ruzomberok|liptov|tatr|senec|pezinok|prievidz|lucenec|roznav|trebisov|dunajska|nove.?zamky|topolcan|skalic|senic|sabinov|kezmarok|stara.?lubovn|vranov/;
// News and discussion pages rarely list events; archives and other-language copies repeat what we have.
const NEWSY = /\/(clanky|clanok|spravy|sprava|news|novinky|article|articles|blog|diskusia|debata|komentare|forum|magazin|tlacove-spravy)(\/|$)/;
const ARCHIVE = /archiv|archive|historia\b|history\b|vysledky|results/;
const OTHER_LANG_PATH = /^\/(en|pl|hu|de|uk|ua|ru|fr|it|es|cs)(\/|$)/i;
const OTHER_LANG_QUERY = /[?&](lang|language|locale|hl)=(en|pl|hu|de|uk|ua|ru|fr|it|es|cs)\b/i;

/** Does the text carry only dates in the past ("…/2023/…", "rok=2009", "2026-09-14" before today)? */
export function pastDated(text, now = new Date()) {
  const today = now.toISOString().slice(0, 10);
  let future = false, past = false;
  for (const m of text.matchAll(/(?<!\d)(20\d{2})-(\d{2})(?:-(\d{2}))?(?!\d)/g)) {
    if (`${m[1]}-${m[2]}-${m[3] || '31'}` < today) past = true; else future = true;
  }
  for (const m of text.replace(/(20\d{2})-(\d{2})(-\d{2})?/g, ' ').matchAll(/(?<!\d)(19\d{2}|20\d{2})(?!\d)/g)) {
    if (+m[1] < now.getFullYear()) past = true; else future = true;
  }
  return past && !future;
}

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

/**
 * Priority for exploring a link, from the link alone: higher = more likely to lead to upcoming
 * events in Slovakia. (What the crawler has learned about the link's template and host is added
 * when it picks from the frontier; see learn.js.)
 */
export function scoreLink(url, anchorText) {
  let u;
  try { u = new URL(url); } catch { return -1; }
  if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname) || SKIP_HOSTS.test(u.hostname)) return -1;
  if (/login|signin|register|cart|kosik|wp-admin|secret=|token=|api\/|live-preview|\/tag\/|\/author\/|print=|share=|mailto:|cdn-cgi|\/(prihlasenie|registracia|cookies?|gdpr|ochrana-osobnych-udajov|privacy|kontakt|contact)(\/|$)/i.test(url)) return -1;
  let path;
  try { path = decodeURIComponent(u.pathname + u.search); } catch { path = u.pathname + u.search; }
  path = fold(path);
  const hay = fold(`${u.hostname} ${path} ${anchorText}`);
  let score = 1;
  if (EVENT_WORDS.test(hay)) score += 3;
  if (KOSICE_WORDS.test(hay)) score += 1;
  if (SK_PLACES.test(hay)) score += 1;
  if (u.hostname.endsWith('.sk')) score += 1;
  if (u.pathname.split('/').filter(Boolean).length > 4) score -= 1; // deep pages are rarely hubs
  if (u.search.length > 60) score -= 1;
  if (NEWSY.test(path)) score -= 2;
  if (ARCHIVE.test(hay)) score -= 2;
  if (OTHER_LANG_PATH.test(u.pathname) || OTHER_LANG_QUERY.test(u.search)) score -= 2;
  if (pastDated(`${path} ${fold(anchorText)}`)) score -= 3;
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

/** Rough "does this page list events?" score, used to decide when AI is worth it. */
export function pageSignals($) {
  const text = fold($('body').text()).slice(0, 200_000);
  const dates = (text.match(/\b\d{1,2}\.\s?\d{1,2}\.(\s?\d{4})?/g) || []).length
    + (text.match(new RegExp(`\\b\\d{1,2}\\.\\s?(${MONTH_RE})`, 'g')) || []).length;
  const eventWords = (text.match(new RegExp(EVENT_WORDS.source, 'g')) || []).length;
  const kosice = (text.match(new RegExp(KOSICE_WORDS.source, 'g')) || []).length;
  // A page that declares itself an article (news, blog post) is rarely a listing, even with many dates.
  const article = /article|blog/i.test($('meta[property="og:type"]').attr('content') || '');
  return { dates, eventWords, kosice, article, looksLikeListing: dates >= 5 && eventWords >= 3 && !article };
}

/** Strip a page down to structure + text so the AI sees the DOM cheaply. */
export function simplifyHtml(html, maxChars = 45_000) {
  const $ = cheerio.load(html);
  $('script, style, noscript, svg, iframe, link, meta, img, picture, source, video, form, template').remove();
  // Site navigation, footers and cookie banners: the same on every page, and rarely events.
  $('nav, footer, [role=navigation], [id*=cookie i], [class*=cookie i]').remove();
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
