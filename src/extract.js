// Everything that turns HTML into structured data without AI:
// schema.org Event JSON-LD, learned CSS "recipes", links and page scoring. Dates: dates.js.
import * as cheerio from 'cheerio';
import { sha1 } from './fetcher.js';
import { coarsePattern, normalizeUrl, urlKey } from './urls.js';
import { TAGS, tagsFromSchemaTypes } from './tags.js';
import { MONTH_RE, finishDate, parseDateText, readDateText, tooFarAhead } from './dates.js';

export { PARSER_VERSION, parseDateText } from './dates.js';

export const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Plain text from strings that may contain (possibly entity-escaped) HTML, as JSON-LD often does.
export function plain(s) {
  let t = String(s || '');
  for (let i = 0; i < 2 && /[<&]/.test(t); i++) t = cheerio.load(t, null, false).text();
  return clean(t.replace(/\\[nrt]/g, ' ')).replace(/\s*(Read More|Čítať viac|Viac)\s*(…|\.\.\.)?$/i, '');
}
/**
 * A location as a place: without the date and the labels some sites put in the same box
 * ("Termín: 03.10.2026 a ďalšie Mesto: Badín" → "Badín").
 */
export function cleanLocation(s) {
  return plain(s)
    .replace(/(termín|dátum|kedy|začiatok)\s*:.*?(?=(mesto|miesto konania|miesto|adresa)\s*:|$)/gi, '')
    .replace(/(miesto konania|mesto|miesto|adresa)\s*:\s*/gi, '')
    .replace(/(?<![\d.])\d{1,2}\.\s*\d{1,2}\.\s*(\d{4})?(\s*,?\s*\d{1,2}[:.]\d{2})?\s*[|,–-]?\s*/g, '') // "04.10.2026 10:30 | BDNR"
    .replace(/\s+/g, ' ').trim();
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
  if (!title || !date || tooFarAhead(date.start, now)) return null;
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
    location: cleanLocation(raw.location).slice(0, 200) || undefined,
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
        url: n.url || n.URL ? absolutize(n.url || n.URL, pageUrl) : undefined, // some sites write "URL"
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

/**
 * Events of an EventON calendar (WordPress plugin; gemercan.sk), once Chrome has filled it in. Each
 * row carries its start and end as Unix seconds (data-time="1789653600-1801436340"); the dates it
 * shows ("17sep(sep 17)16:00") have no year. An all-day event runs from midnight to midnight, and an
 * end at 23:59 means "until that day": both give dates without times.
 */
export function eventOnEvents($, pageUrl) {
  const out = [];
  const seen = new Set();
  $('.eventon_list_event[data-time]').each((_, el) => {
    const $el = $(el);
    const [s, e] = String($el.attr('data-time')).split('-').map((n) => Number(n) * 1000);
    if (!Number.isFinite(s) || !s) return;
    const [startDay, startTime] = LOCAL.format(new Date(s)).split(' ');
    const [endDay, endTime] = Number.isFinite(e) && e > s ? LOCAL.format(new Date(e)).split(' ') : [];
    const allDay = startTime === '00:00' && (!endTime || endTime === '00:00' || endTime === '23:59');
    // Venue and address when given (this site gives only the town), else the "Kde?" (where?) box.
    const place = ['.evo_location_name', '.evo_location_address'].map((sel) => clean($el.find(sel).first().text()));
    if (!place[0]) place[0] = clean($el.find('.evocard_box.location').first().text()).replace(/^Kde\s*\?\s*/i, '');
    const href = $el.find('.evo_event_schema a[href]').attr('href') || $el.find('a[href*="/events/"]').attr('href');
    const ev = makeEvent({
      title: $el.find('.evcal_event_title').first().text(),
      start: allDay ? startDay : `${startDay}T${startTime}`,
      end: endDay && (endDay !== startDay || !allDay)
        ? (allDay || endTime === '23:59' ? endDay : `${endDay}T${endTime}`) : undefined,
      location: [...new Set(place.filter(Boolean))].join(', '),
      url: href ? absolutize(href, pageUrl) : undefined,
    }, pageUrl);
    if (ev && !seen.has(ev.id)) {
      seen.add(ev.id);
      out.push(ev);
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
// (Plugin and CMS sites are linked from event sites' footers: "Powered by Events Manager".)
const SKIP_HOSTS = /(^|\.)(google\.[a-z.]+|goo\.gl|apple\.com|microsoft\.com|wikipedia\.org|gstatic\.com|doubleclick\.net|cookiebot\.com|wa\.me|t\.me|wordpress\.(org|com)|wp-events-plugin\.com|theeventscalendar\.com|wix\.com|webnode\.\w+|zendesk\.com|bazos\.sk|topreality\.sk|nehnutelnosti\.sk)$/i;
const EVENT_WORDS = /podujat|akci[ae]|event|kalendar|program|festival|koncert|vystav|divadl|trh|jarmok|kino|predstaven|workshop|prednask|kultur|zabav|vikend|tickets?|vstupenk|listky|majales|beh\b|maraton/;
const KOSICE_WORDS = /kosic|kosice|cassovia|kassa|kaschau/;
// Slovak towns and regions: the crawler covers all of Slovakia first.
const SK_PLACES = /kosic|bratislav|zilin|presov|banska.?bystric|nitr[ae]|trnav|trencin|poprad|martin|michalovc|spisska|bardejov|humenn|levic|komarn|piestan|zvolen|ruzomberok|liptov|tatr|senec|pezinok|prievidz|lucenec|roznav|trebisov|dunajska|nove.?zamky|topolcan|skalic|senic|sabinov|kezmarok|stara.?lubovn|vranov/;
// News and discussion pages rarely list events; archives and other-language copies repeat what we have.
const NEWSY = /\/(clanky|clanok|spravy|sprava|news|novinky|article|articles|blog|diskusia|debata|komentare|forum|magazin|tlacove-spravy)(\/|$)/;
const ARCHIVE = /archiv|archive|historia\b|history\b|vysledky|results|eventdisplay=past|past-events|minule-(podujatia|akcie)|probehle/;
const OTHER_LANG_PATH = /^\/(en|pl|hu|de|uk|ua|ru|fr|it|es|cs)(\/|$)/i;
const OTHER_LANG_QUERY = /[?&](lang|language|locale|hl)=(en|pl|hu|de|uk|ua|ru|fr|it|es|cs)\b/i;

/** A page of past events ("…/archiv-podujati/", "?eventDisplay=past"). */
export const isArchiveUrl = (url) => ARCHIVE.test(fold(url));

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

/** Does the text carry only years well ahead (a calendar paged to "…/oktober-2031/")? */
export function farDated(text, now = new Date()) {
  const years = [...text.matchAll(/(?<!\d)(20\d{2})(?!\d)/g)].map((m) => +m[1]);
  return years.length > 0 && years.every((y) => y > now.getFullYear() + 1);
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
  // Terms, contacts, galleries, jobs…: never a list of events.
  if (/\/(obchodn[eiy]-podmienky|obchodni-podminky|vop|reklamac\w*|kontakty?|o-nas|about(-us)?|kariera|jobs?|faq|galeri[ae]|fotogaleri[ae]|gallery|cennik|pravidla)(\/|\.html?|$)/i.test(u.pathname)) return -1;
  // Calendar exports, feeds, and e-mail addresses written as links: never a page to read.
  if (/[?&](ical|outlook-ical|ics)=|\/(feed|rss|ical)\/?$|@/i.test(u.pathname + u.search)) return -1;
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
  if (pastDated(`${path} ${fold(anchorText)}`) || farDated(`${path} ${fold(anchorText)}`)) score -= 3;
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

/**
 * Does the page's structured data cover only some of its events ("4 of 20 films today")? Judged by
 * the links: the page links to many more pages like the structured events' own pages
 * (…/film/<name>/) than it has structured events.
 */
export function partialStructured(events, links, pageUrl) {
  const page = urlKey(pageUrl);
  const own = events.filter((e) => e.url && urlKey(e.url) !== page);
  if (!own.length) return false;
  const shapes = new Set(own.map((e) => coarsePattern(e.url)));
  const like = new Set([...links.keys()].filter((h) => urlKey(h) !== page && shapes.has(coarsePattern(h))).map(urlKey));
  for (const e of own) like.add(urlKey(e.url));
  return like.size >= 2 * new Set(own.map((e) => urlKey(e.url))).size + 3;
}

// Calendar plugins whose events a script loads after the page arrives: the HTML has only an empty
// calendar, so rules and AI both see no events (gemercan.sk's EventON calendar). Such pages are
// read in Chrome instead.
// `root` is the calendar's element, whose text is what a quick look needs (the page's own header
// and teasers can fill the start of its text).
const SCRIPT_CALENDARS = [
  { name: 'EventON', test: /ajde_evcal_calendar/, root: '.ajde_evcal_calendar' },
  { name: 'FullCalendar', test: /fullcalendar(\.min)?\.js|new FullCalendar\.Calendar/, root: '.fc' },
];

/** The calendar plugin that fills this page by script, if any: { name, root }. */
export const scriptCalendar = (html) => SCRIPT_CALENDARS.find((c) => c.test.test(html || ''));

/** A page's visible text (no scripts, menus or footers), for a quick AI look; `root` narrows it to a part. */
export function pageText($, maxChars = 6000, root = 'body') {
  const $b = ($(root).length ? $(root) : $('body')).clone();
  $b.find('script, style, noscript, svg, iframe, template, nav, footer, [role=navigation], [id*=cookie i], [class*=cookie i]').remove();
  return clean($b.text()).slice(0, maxChars);
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
  collapseRepeats($);
  let out = ($('body').html() || '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/\s+/g, ' ')
    .replace(/<(div|span)>\s*<\/\1>/g, '');
  const truncated = out.length > maxChars;
  if (truncated) out = out.slice(0, maxChars);
  return { html: out, truncated, title: clean($('title').text()) };
}

// A listing repeats one card (or table row) per event; a few are enough to write a recipe, and
// the rest is most of the page's tokens. Runs of same tag + class siblings keep their first few.
const KEEP_REPEATS = 8;
function collapseRepeats($) {
  const sig = (el) => `${el.tagName}.${el.attribs?.class || ''}`;
  $('body *').each((_, el) => {
    const kids = $(el).children().toArray();
    if (kids.length <= KEEP_REPEATS + 2) return;
    const total = {};
    for (const k of kids) total[sig(k)] = (total[sig(k)] || 0) + 1;
    const seen = {};
    for (const k of kids) {
      const s = sig(k);
      if (total[s] <= KEEP_REPEATS + 2) continue;
      seen[s] = (seen[s] || 0) + 1;
      if (seen[s] === KEEP_REPEATS) $(k).after(`<p>[… ${total[s] - KEEP_REPEATS} more like this]</p>`);
      else if (seen[s] > KEEP_REPEATS) $(k).remove();
    }
  });
}
