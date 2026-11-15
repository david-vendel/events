// Everything that turns HTML into structured data without AI:
// schema.org Event JSON-LD, learned CSS "recipes", links and page scoring. Dates: dates.js.
import * as cheerio from 'cheerio';
import { sha1 } from './fetcher.js';
import { coarsePattern, normalizeUrl, urlKey } from './urls.js';
import { TAGS, tagsFromSchemaTypes } from './tags.js';
import { MONTH_RE, finishDate, parseDateText, readDateText, tooFarAhead } from './dates.js';
import { foreignHost, namesSkTown } from './slovakia.js';

export { PARSER_VERSION, parseDateText } from './dates.js';

export const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
// Words for screen readers that some sites put in link text: "(otvorí sa na novej karte)".
const SCREEN_READER = /\s*\(?\s*(otvorí sa (na|v) nov(ej|om) (karte|okne|záložke)|opens? in a new (tab|window)|otevře se v nov(é|ém) (záložce|okně|okne))\s*\)?/gi;
// Plain text from strings that may contain (possibly entity-escaped) HTML, as JSON-LD often does.
export function plain(s) {
  let t = String(s || '');
  for (let i = 0; i < 2 && /[<&]/.test(t); i++) t = cheerio.load(t, null, false).text();
  return clean(t.replace(/\\[nrt]/g, ' ').replace(SCREEN_READER, ' ')).replace(/\s*(Read More|Čítať viac|Viac)\s*(…|\.\.\.)?$/i, '');
}
/**
 * A location as a place: without the date and the labels some sites put in the same box
 * ("Termín: 03.10.2026 a ďalšie Mesto: Badín" → "Badín").
 */
export function cleanLocation(s) {
  let t = plain(s);
  // "Kategória: Koncert • Dátum a čas: od 19:00 • PKO Nitra, J. Kráľa 4" (nitra.eu): the labelled parts go.
  if (/•/.test(t)) t = t.split(/\s*•\s*/).filter((p) => !/^(kategória|dátum a čas|dátum|čas|cena|vstupné)\s*:/i.test(p)).join(', ');
  // Not a place: the organizing club ("Org. MBK Handlová Academy"), "to be added".
  if (/^org\.\s/i.test(t) || /^(bude doplnen[éá]|bude upresnen[éá]|upresníme|doplníme|tba|tbd|n\/a)\.?$/i.test(t)) return '';
  t = t
    .replace(/^\s*kde\s*\??\s*:\s*/i, '') // "Kde: Dom kultúry, Snina"
    .replace(/(termín|dátum|kedy|začiatok)\s*:.*?(?=(mesto|miesto konania|miesto podujatia|miesto|adresa|lokalita)\s*:|$)/gi, '')
    .replace(/(miesto konania podujatia|miesto konania|miesto podujatia|miesto udalosti|mesto|miesto|adresa|lokalita|venue|location)\s*:\s*/gi, '')
    .replace(/(?<![\d.])\d{1,2}\.\s*\d{1,2}\.\s*(\d{4})?(\s*,?\s*\d{1,2}[:.]\d{2})?\s*[|,–-]?\s*/g, '') // "04.10.2026 10:30 | BDNR"
    .replace(/\s*"?kategória\s+"?[a-z][+?]?"?\s*$/i, '') // a floorball hall's grade: "Multihala Košice "kategória A+""
    .replace(/\s*[·|,–-]?\s*\d[\d\s]*(?:[.,]\d+)?\s*(€|eur)\.?\s*$/i, '') // a price: "Kino PALACE, Nitra 6 €"
    .replace(/\s*\d{1,3}\s*(minút|min\.?)\s*$/i, '') // a length: "Kultúrny dom 120 minút"
    .replace(/\s*\(SR\s*-\s*[^)]*\)\s*$/i, '') // "Martin (SR - Žilinský kraj)"
    .replace(/\s+—\s+/g, ', ') // "Dom umenia — Bratislava"
    .replace(/\s+,(?!,)\s*/g, ', ') // "O~art centrum , Skalica", "Odbojárov 9 ,Bratislava"
    .replace(/\s+/g, ' ')
    .replace(/^[\s/—–\-|·•,;:@]+|[\s/—–\-|·•,;:@]+$/g, ''); // "// Trnava", "— Galéria Artotéka", "Rožňava, Slovenská republika /", a lone "," or "@"
  return t;
}
const fold = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// ---------------------------------------------------------------- titles

/**
 * A title and the facts a listing wrote after it (kulthund.sk): "FSS Radosť – Spomienky pri mladom
 * víne — folklór, 28.11.2026 18:00, Dom kultúry Pezinok, Pezinok." → { title: "FSS Radosť – Spomienky
 * pri mladom víne", category: "folklór", location: "Dom kultúry Pezinok, Pezinok" }. Only when a date
 * follows the category, so "Hamlet — Shakespeare" stays as it is (null).
 */
export function splitTitleMeta(title) {
  const m = /^(.+?) — ([^,—]{2,40}), ((?:prebieha do |od |do )?\d{1,2}\.\s?\d{1,2}\.\s?\d{4}(?: \d{1,2}:\d{2})?), (.+?)\.?$/.exec(clean(title));
  if (!m) return null;
  const parts = m[4].split(/\s*,\s*/).filter(Boolean);
  if (parts.length > 1 && parts.at(-1) === parts.at(-2)) parts.pop(); // "Bratislava, Bratislava"
  return { title: m[1].trim(), category: m[2].trim(), location: parts.join(', ') };
}

const validTime = (h, m) => Number(h) <= 23 && Number(m) <= 59;

/**
 * A title as text, without what isn't the name: screen-reader words, a showtime glued to it
 * ("VŠETCI FOTRI SÚ LOTRI18:30"), a separator left at the end ("SLÁVIA Banská Bystrica – BKM Žilina -").
 */
export function cleanTitle(s) {
  let t = plain(s);
  // A time glued to a letter or ")" / "!" ("Film (ČD)19:30"), or after the " – " that blockText puts
  // between blocks; not "7-8:30" nor "Party 2:00".
  t = t.replace(/(?<=[\p{L})!?.])(\d{1,2}):(\d{2})$/u, (all, h, m) => (validTime(h, m) ? '' : all))
    .replace(/(?<!\d:\d\d)\s+–\s+(\d{1,2}):(\d{2})$/u, (all, h, m) => (validTime(h, m) ? '' : all));
  // A score after the teams ("BC Slovan Bratislava – Slávia ŠKP Banská Bystrica – 36 - 67").
  t = t.replace(/(?<!\d:\d\d)\s+–\s+\d{1,3}\s*[-:–]\s*\d{1,3}(\s+(pp|pn|sn|pr|p\.\s?p\.))?$/iu, '');
  return t.replace(/(\s+[-–—|:,]+)+$/u, '').trim();
}

const WEEKDAY = /^(pondelok|utorok|streda|štvrtok|piatok|sobota|nedeľa|pondelí|úterý|čtvrtek|pátek|neděle|po|ut|út|st|št|čt|pi|pá|so|ne|mon|tue|wed|thu|fri|sat|sun)\.?,?\s*/iu;
const NOT_A_NAME = /^(pozvánka|pozvanka|pozvánky|viac|viac info|viac informácií|info|detail|detaily|podrobnosti|more|more info|read more|program|kúpiť|kupit|vstupenky|lístky|listky|tickets?|rezervácia|rezervovať|registrácia)[\s.!:…»>]*$/iu;
/**
 * A title that names nothing: only a date ("19.11.2026", "27. 1.", "So 21. 11."), only a number
 * ("14"; a year such as "1970" may be a film's name), only a weekday, or a word from a button
 * ("Pozvánka", "Viac info", "Detail").
 */
export function junkTitle(title) {
  const t = clean(title);
  if (!t) return true;
  if (/^\d{4}$/.test(t)) return false;
  const rest = t.replace(WEEKDAY, '');
  if (/^[\d\s./:–-]*$/.test(rest) && (rest !== t || /\d/.test(rest))) return true;
  return NOT_A_NAME.test(t);
}

const NOT_EVENTS = [
  // Waste collection: "Vývoz komunálneho odpadu", "Odvoz ZKO 14 d", "zber plastov a nápojových obalov",
  // "Vývoz papiera". Not "Zber gaštanov pre deti".
  ['waste collection', /^(plánovaný\s+)?(vývoz|odvoz|zber|zvoz)\b\s*:?\s*.{0,40}\b(odpad\p{L}*|zko|kuka|plast\p{L}*|papier\p{L}*|sklo|skla|bio|kov\p{L}*|tetrapak\p{L}*|elektro\p{L}*|nápojových obalov|separovan\p{L}*|triedené\p{L}*|veľkoobjemov\p{L}*)/iu],
  ['waste collection', /^(komunálny|zmesový|separovaný|triedený|kuchynský|bio|biologicky rozložiteľný|veľkoobjemový|nebezpečný|elektro)\s+odpad$/iu],
  // Cancelled: "ZRUŠENÉ: Jazz for sale", "Držím ti miesto - ZRUŠENÉ", "(zrušené)"; not "Zrušenie oddlženia".
  ['cancelled', /(^|[\s(\-–—:|,])zrušen[éáýa](?=$|[\s)!:.,\-–—])/iu],
  ['cancelled', /(^|[\s(\-–—:|,])(cancelled|canceled|odwołane|zrušeno)(?=$|[\s)!:.,\-–—])/iu],
  ['bye', /^voľno$/iu], // a league round a team doesn't play
  ['outage', /^(plánovan[éáý]\s+)?(prerušenie\s+(distribúcie|dodávky)\s+(elektriny|elektrickej energie|vody|plynu|tepla)|odstávka\b|výluka\b)/iu],
  ['road closure', /^((dočasná|úplná|čiastočná|plánovaná)\s+)?uzávierka\b(?!\s+(prihlášok|príspevkov|súťaže))/iu],
  ['office hours', /^(úradné|stránkové|ordinačné)\s+hodiny\b/iu],
  ['timetable', /^rozvrh(\s|$)/iu],
];
/** Why a row is not a public event ("waste collection", "cancelled"…), or null. Judged by its title. */
export function notAnEvent(ev) {
  const t = clean(ev?.title);
  for (const [why, re] of NOT_EVENTS) if (re.test(t)) return why;
  return null;
}

// ---------------------------------------------------------------- event URLs

const FILE_URL = /\.(pdf|jpe?g|png|gif|webp|svg|bmp|tiff?|heic|docx?|xlsx?|pptx?|odt|rtf|zip|rar)$/i;
const MAPS_URL = /^(maps\.google\.[a-z.]+|www\.google\.[a-z.]+\/maps|google\.[a-z.]+\/maps|maps\.app\.goo\.gl|goo\.gl\/maps|(www\.)?mapy\.(cz|com)|(www\.)?waze\.com|(www\.)?openstreetmap\.org|maps\.apple\.com)(\/|$)/i;
/**
 * An address that can be an event's own page: not "javascript:NPerformance_load(…)", mailto: or tel:,
 * a picture, PDF or document, a map, a site's front page or the listing page itself. Else undefined.
 */
export function eventUrl(url, listingUrl) {
  const u = clean(url);
  if (!u || /^(javascript|mailto|tel|data|sms|callto):/i.test(u)) return undefined;
  let parsed;
  try { parsed = new URL(u); } catch { return undefined; }
  if (!/^https?:$/.test(parsed.protocol)) return undefined;
  if (FILE_URL.test(parsed.pathname)) return undefined;
  if (MAPS_URL.test(`${parsed.host}${parsed.pathname}`)) return undefined;
  if ((parsed.pathname === '/' || parsed.pathname === '') && !parsed.search) return undefined; // a front page
  if (listingUrl) { try { if (urlKey(u) === urlKey(listingUrl)) return undefined; } catch {} }
  return u;
}

/**
 * The parts of a stored row this file would now read differently: { title, location, url }, or null
 * when the row is no event ("Pozvánka", "Vývoz komunálneho odpadu", "ZRUŠENÉ: …"). `url` undefined
 * means the row has no page of its own (its listing page, row.via, stands in).
 */
export function repairRow(row) {
  let title = cleanTitle(row.title);
  let location = cleanLocation(row.location);
  const meta = splitTitleMeta(title);
  if (meta) {
    title = meta.title;
    if (meta.location && (!location || meta.location.endsWith(location))) location = meta.location;
  }
  if (junkTitle(title) || notAnEvent({ title })) return null;
  return { title: title.slice(0, 200), location: location.slice(0, 200) || undefined, url: eventUrl(row.url) };
}

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

// The year of a date in a URL with the same month and day as `iso`: "2026-08-19", "2026/08/19", "19-08-2026".
function yearInUrl(url, iso) {
  const [, m, d] = iso.split('-');
  const re = new RegExp(`(?<!\\d)(20\\d\\d)[-/._]${m}[-/._]${d}(?!\\d)|(?<!\\d)${d}[-._]${m}[-._](20\\d\\d)(?!\\d)`);
  const hit = re.exec(String(url || ''));
  return hit && (hit[1] || hit[2]);
}

export function makeEvent(raw, sourceUrl, now = new Date()) {
  let title = cleanTitle(raw.title);
  let location = cleanLocation(raw.location);
  // "Title — category, date, venue, town." (kulthund.sk): the title, and the place when none is given.
  const meta = splitTitleMeta(title);
  if (meta) {
    title = meta.title;
    if (meta.location && (!location || meta.location.endsWith(location))) location = meta.location;
  }
  if (!title || junkTitle(title) || notAnEvent({ title })) return null;
  // Free-form text (from a recipe) goes through the learned formats; structured dates don't need to.
  let date = raw.start ? structuredDate(raw.start, now) : readDateText(clean(raw.dateText), now);
  if (!date) return null;
  // A date written without its year, whose own page address has the full date ("…/2026-08-19-…"):
  // that year, not the one guessed.
  if (!raw.start && !/\d{4}/.test(raw.dateText || '')) {
    const y = yearInUrl(raw.url, date.start);
    if (y && !date.start.startsWith(y)) date = { ...date, start: `${y}${date.start.slice(4)}`, end: undefined };
  }
  if (tooFarAhead(date.start, now)) return null;
  const endDate = raw.end ? structuredDate(raw.end, now) : null;
  const url = eventUrl(/^[a-z][a-z\d+.-]*:/i.test(clean(raw.url)) ? raw.url : raw.url && absolutize(raw.url, sourceUrl));
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
    location: location.slice(0, 200) || undefined,
    description: plain(raw.description).replace(/^(popis( udalosti| podujatia)?|o podujatí|description)\s*:\s*/i, '').slice(0, 500) || undefined,
    url: url || sourceUrl,
    ...(url ? {} : { listingUrl: true }), // no page of its own: the listing stands in
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

// schema.org addressCountry: "SK", "Slovakia", { name: "United States" }.
const pageCountry = (c) => clean(typeof c === 'string' ? c : c?.name || c?.['@id'] || '') || undefined;
/**
 * A start with a time zone no Slovak event has: the Americas' (-05:00) or Asia's (+03:00 and more).
 * "+00:00"/"Z" says nothing (sites write local time so); +01:00 and +02:00 are Central Europe's.
 */
function zoneCountry(start) {
  const m = /T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?([+-])(\d{2}):?(\d{2})$/.exec(String(start || '').trim());
  if (!m || (m[2] === '00' && m[3] === '00')) return undefined;
  const h = (m[1] === '-' ? -1 : 1) * Number(m[2]);
  return h < 0 || h > 2 ? 'abroad' : undefined;
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
      const locs = [].concat(n.location || []);
      const loc = locs.find((l) => !/VirtualLocation/.test(l?.['@type'])) || {};
      const addr = typeof loc.address === 'string' ? loc.address
        : [loc.address?.streetAddress, loc.address?.addressLocality].filter(Boolean).join(', ');
      // Online only (a webinar on Zoom): no place to look up.
      const online = !addr && !loc.name && (locs.length > 0 || /OnlineEventAttendanceMode/.test(n.eventAttendanceMode || ''));
      const ev = makeEvent({
        title: n.name,
        start: n.startDate,
        end: n.endDate,
        location: online ? 'Online' : [loc.name, addr].filter(Boolean).join(', '),
        description: n.description,
        url: n.url || n.URL ? absolutize(n.url || n.URL, pageUrl) : undefined, // some sites write "URL"
        tags: tagsFromSchemaTypes(types),
      }, pageUrl);
      // Coordinates, when the page gives them (Place.geo): the best location there is.
      const lat = Number(loc.geo?.latitude), lon = Number(loc.geo?.longitude);
      if (ev && Number.isFinite(lat) && Number.isFinite(lon) && (lat || lon)) ev.geo = { lat, lon };
      // The country the page gives (geo.js: eventCountry), from the address or the start's time zone.
      const country = ev && (pageCountry(loc.address?.addressCountry) || zoneCountry(n.startDate));
      if (country) ev.pageCountry = country;
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

// First link inside an item that stays on the same site and can be an event's page (skips map,
// share and "javascript:" links, pictures and documents).
function sameSiteLink($, $el, pageUrl) {
  const host = new URL(pageUrl).host;
  return $el.find('a[href]').toArray().map((a) => $(a).attr('href'))
    .find((h) => { try { const u = new URL(h, pageUrl); return u.host === host && Boolean(eventUrl(u.href)); } catch { return false; } });
}

const BLOCK_TAGS = new Set(['address', 'article', 'aside', 'blockquote', 'br', 'dd', 'div', 'dl', 'dt', 'figcaption', 'figure', 'footer',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'section', 'table', 'tbody', 'td', 'tfoot', 'th',
  'thead', 'tr', 'ul']);
const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);
// Text only screen readers or phones get: "(otvorí sa na novej karte)", a team's three-letter code.
const HIDDEN_CLASS = /(^|\s)(sr-only|screen-reader-text|visually-hidden|visuallyhidden|hidden-visually|visible-xs(-inline|-block)?)(\s|$)/;
/**
 * The text of an element as a reader sees it: blocks and line breaks that touch without a space
 * between them are told apart ("<td>Royale Union SG<br>Lech Poznaň</td>" → "Royale Union SG – Lech
 * Poznaň", where .text() gives "Royale Union SGLech Poznaň"); text for screen readers left out.
 */
export function blockText($, el, sep = ' – ') {
  const out = [];
  const walk = (node) => {
    if (node.type === 'text') { out.push(node.data); return; }
    if (node.type !== 'tag' && node.type !== 'root') return;
    const name = (node.name || '').toLowerCase();
    if (SKIP_TAGS.has(name) || HIDDEN_CLASS.test(node.attribs?.class || '') || node.attribs?.hidden !== undefined) return;
    const block = BLOCK_TAGS.has(name);
    if (block) out.push('\u0001');
    for (const c of node.children || []) walk(c);
    if (block) out.push('\u0001');
  };
  const nodes = el?.type ? [el] : $(el).toArray();
  for (const n of nodes) walk(n);
  const text = out.join('').replace(/([^\s\u0001])\u0001+(?=[^\s\u0001])/g, `$1${sep}`).replace(/\u0001/g, ' ');
  return clean(text) || clean(nodes.map((n) => $(n).text()).join(' '));
}

// "Viac", "Kúpiť vstupenky": a button, not part of a title.
const BUTTON_TEXT = /^(viac|more|detail|info|kúpiť|kupit|vstupenk|listky|lístky|tickets?|rezerv)/i;
const firstClass = (x) => String(x.attribs?.class || '').trim().split(/\s+/)[0] || '';

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
    const pickBlocks = (sel) => {
      if (!sel) return '';
      try {
        const first = $el.find(sel).first();
        return (first.length ? blockText($, first[0]) : '') || ($el.is(sel) ? blockText($, el) : '');
      } catch { return ''; }
    };
    // A title in two or three cells of one item is a match: "BK DSG Dunajská Streda – BK Iskra
    // Partizánske" (the first cell alone named only the home team).
    const pickTitle = (sel) => {
      try {
        // Scores ("6", "2", "36 - 67") are not names.
        const cells = $el.find(sel).toArray().map((x) => ({ x, t: blockText($, x) })).filter((c) => c.t && !/^[\d\s:–-]+$/.test(c.t));
        const parts = [...new Set(cells.map((c) => c.t))];
        const names = parts.every((t) => t.length <= 60 && !BUTTON_TEXT.test(t));
        const sameTag = cells.every((c) => c.x.tagName === cells[0].x.tagName);
        // Cells alike (same tag and class), not a title and a "more" link.
        const alike = sameTag && cells.every((c) => $(c.x).attr('class') === $(cells[0].x).attr('class'));
        // Two teams whose cells differ by a modifier: "team team--home" and "team team--away".
        const pair = sameTag && parts.length === 2 && cells.every((c) => firstClass(c.x) === firstClass(cells[0].x));
        if (names && ((alike && parts.length >= 2 && parts.length <= 3) || pair)) return parts.join(' – ');
        // The first cell empty (a team not yet known): the one that names something.
        return pickBlocks(sel) || (parts.length === 1 ? parts[0] : '');
      } catch {}
      return pickBlocks(sel);
    };
    // The home team in the title, the away team in a cell of the same name with "away"
    // (stolnytenis.info: ".mtchr__home" and ".mtchr__away"): the match.
    const awayOf = (sel) => {
      if (!sel || !/home|domac/i.test(sel)) return '';
      const other = sel.replace(/home/g, 'away').replace(/Home/g, 'Away').replace(/domaci/g, 'hostia');
      try { return blockText($, $el.find(other).first()[0]) || ''; } catch { return ''; }
    };
    let href;
    try {
      href = recipe.link
        ? $el.find(recipe.link).first().attr('href') || ($el.is('a') ? $el.attr('href') : undefined)
        : $el.is('a') ? $el.attr('href') : sameSiteLink($, $el, pageUrl);
    } catch {}
    // "javascript:NPerformance_load(1451230, …)" (ticketportal.sk): the item's own link to the event.
    if (href && /^\s*javascript:/i.test(href)) href = sameSiteLink($, $el, pageUrl);
    const dateText = [pick(recipe.date), pick(recipe.time)].join(' ');
    let title = recipe.title ? pickTitle(recipe.title) : '';
    let description = pick(recipe.description);
    const away = title && awayOf(recipe.title);
    if (away && away !== title && away.length <= 60 && !title.includes(' – ')) {
      title = `${title} – ${away}`;
      if (clean(description) === away) description = '';
    }
    const abs = href && !/^\s*(javascript|mailto|tel):/i.test(href) ? absolutize(href, pageUrl) : undefined;
    const ev = makeEvent({
      title,
      dateText,
      location: pick(recipe.location),
      description,
      url: abs && eventUrl(abs, pageUrl) ? abs : undefined,
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
// Slovak regions (towns: namesSkTown, every Slovak town).
const SK_REGIONS = /liptov|tatr|spissk|spisk[aeyo]|orav[ays]|kysuc|zahori|zemplin|sarisk|gemer|hontian|turiec|turciansk|horehron|novohrad|zitn[yeo][^a-z]*ostrov/;
// Links that name another country or a town abroad (eventbrite's
// "/d/germany--berlin/", "…/festivals/hamburg"): we collect events in Slovakia only.
const FOREIGN_PLACES = /(^|[^a-z])(germany|deutschland|austria|osterreich|czech|czechia|cesko|ceska-republika|hungary|magyarorszag|poland|polska|united-states|united-kingdom|usa|australia|canada|singapore|praha|prague|brno|ostrava|olomouc|wien|vienna|budapest|krakow|warszawa|berlin|hamburg|munchen|muenchen|munich|koln|frankfurt|stuttgart|dusseldorf|leipzig|dresden|hannover|bremen|london|paris|amsterdam|nashville|brisbane|sydney|melbourne|auckland|toronto)([^a-z]|$)/;
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
 * A page that is never a list of events, from its address alone: logins and carts, terms, privacy,
 * contacts, galleries, jobs, shops and press pages ("…/vseobecne-obchodne-podmienky", "…/shop").
 */
export function boringUrl(url) {
  let u;
  try { u = new URL(url); } catch { return true; }
  if (/login|signin|register|cart|kosik|wp-admin|secret=|token=|api\/|live-preview|\/tag\/|\/author\/|print=|share=|mailto:|cdn-cgi|\/(prihlasenie|registracia|cookies?|gdpr|ochrana-osobnych-udajov|privacy|kontakt|contact)(\/|$)/i.test(url)) return true;
  return /\/((vseobecne-)?obchodn[eiy]-podmienky|(vseobecne-)?obchodni-podminky|vop|reklamac\w*|kontakty?|o-nas|about(-us)?|kariera|jobs?|faq|galeri[ae]|fotogaleri[ae]|gallery|cennik|pravidla|zasady-\w+-osobnych-udajov|ochrana-sukromia|e-?shop|shop|obchod|produkty?|products?|press|tlacove-spravy)(\/|\.html?|$)/i.test(u.pathname);
}

/**
 * Priority for exploring a link, from the link alone: higher = more likely to lead to upcoming
 * events in Slovakia (links to other countries' sites and towns rank low). (What the crawler has learned about the link's template and host is added
 * when it picks from the frontier; see learn.js.)
 */
export function scoreLink(url, anchorText) {
  let u;
  try { u = new URL(url); } catch { return -1; }
  if (!/^https?:$/.test(u.protocol) || SKIP_EXT.test(u.pathname) || SKIP_HOSTS.test(u.hostname)) return -1;
  if (boringUrl(url)) return -1;
  // Calendar exports, feeds, and e-mail addresses written as links: never a page to read.
  if (/[?&](ical|outlook-ical|ics)=|\/(feed|rss|ical)\/?$|@/i.test(u.pathname + u.search)) return -1;
  let path;
  try { path = decodeURIComponent(u.pathname + u.search); } catch { path = u.pathname + u.search; }
  path = fold(path);
  const hay = fold(`${u.hostname} ${path} ${anchorText}`);
  let score = 1;
  if (EVENT_WORDS.test(hay)) score += 3;
  if (KOSICE_WORDS.test(hay)) score += 1;
  if (namesSkTown(hay) || SK_REGIONS.test(hay)) score += 1;
  if (u.hostname.endsWith('.sk')) score += 1;
  else if (foreignHost(u.hostname)) score -= 3;
  if (FOREIGN_PLACES.test(path) || FOREIGN_PLACES.test(fold(anchorText))) score -= 4;
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
