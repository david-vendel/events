// Builds each event's net of sources: opens the event's own detail page, follows the links it
// gives to the same event elsewhere (Facebook event, ticket shops) and records the date each
// source states, so the UI can show whether they agree.
import * as cheerio from 'cheerio';
import { fetchPage, sha1 } from './fetcher.js';
import { countTimes, countWeekdays } from './dates.js';
import { clean, extractLinks, facebookEvent, jsonLdEvents, parseDateText } from './extract.js';
import { dateDistance, titleSimilarity } from './match.js';
import { renderPage } from './browser.js';

const VERIFY_EVERY = 3 * 864e5;
const MAX_LINKED = 4;
const TICKET_SITES = /(^|\.)(ticketportal\.sk|predpredaj\.sk|goout\.net|vstupenky\.sk|eventim\.sk|tootoot\.fm|ticketlive\.sk|navstevnik\.sk|kupvstupenku\.sk|showroom\.sk|ticketstream\.cz)$/i;

// Facebook's robots.txt disallows all crawlers and its terms forbid automated collection
// without permission, so reading Facebook pages is opt-in. Without it, Facebook links are
// still listed as sources, just with the date "not checked".
export const facebookEnabled = () => process.env.EVENTS_FACEBOOK === 'on';

const host = (u) => { try { return new URL(u).hostname; } catch { return ''; } };

// Local date and time in Košice for a Unix timestamp.
const LOCAL = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Europe/Bratislava', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});
const localParts = (unix) => {
  const [date, time] = LOCAL.format(new Date(unix * 1000)).split(' ');
  return { date, time };
};
const unescapeJson = (s) => { try { return JSON.parse(`"${s}"`); } catch { return s; } };

/**
 * Read a public Facebook event (no login). The page metadata has only the date; the time is in
 * the event data that Facebook sends to browsers, so the page is rendered in headless Chrome when
 * available. Without Chrome we fall back to a plain fetch and get the date only.
 */
async function readFacebook(url) {
  let id = facebookEvent(url);
  if (id === 'short') {
    // fb.me/e/… redirects to the full event URL.
    const res = await fetchPage(url, {}, { ignoreRobots: true });
    id = res.url && facebookEvent(res.url);
    if (!id || id === 'short') return { status: 'error', note: res.error || 'could not resolve link' };
  }
  const canonical = `https://www.facebook.com/events/${id}/`; // no tracking params

  let html = await renderPage(canonical);
  const rendered = Boolean(html);
  if (!html) {
    const res = await fetchPage(canonical, {}, { ignoreRobots: true });
    if (res.error) return { url: canonical, status: 'error', note: `${res.status} ${res.error}` };
    html = res.html;
  }
  const $ = cheerio.load(html);
  const title = clean($('meta[property="og:title"]').attr('content'));
  const desc = clean($('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content'));
  const metaDate = parseDateText(desc);
  if (!title || !metaDate) return { url: canonical, status: 'no_date', note: 'Facebook page had no readable date' };

  // The event itself is the only one on the page with a start+end timestamp pair (suggested
  // events have just a start). Accept it only if it agrees with the metadata date.
  const out = { url: canonical, title, start: metaDate.start, status: 'ok' };
  const ts = html.match(/\\?"start_timestamp\\?":(\d{9,11}),\\?"end_timestamp\\?":(\d{9,11})/);
  if (ts && localParts(+ts[1]).date === metaDate.start) {
    const s = localParts(+ts[1]), e = localParts(+ts[2]);
    Object.assign(out, { time: s.time, endTime: e.time, end: e.date !== s.date ? e.date : undefined });
  } else {
    out.note = rendered ? 'Facebook showed no time' : 'date only: install Chrome (or set EVENTS_CHROME) to read the time';
  }
  const place = html.match(/\\?"event_place\\?":\{\\?"__typename\\?":\\?"\w+\\?",\\?"name\\?":\\?"((?:[^"\\]|\\u[0-9a-f]{4})+)/i)?.[1];
  out.location = place ? unescapeJson(place) : desc.match(/(?:v meste|in) ([^,]+?)(?: by|,)/)?.[1];
  return out;
}

/** Read a linked non-Facebook page (e.g. a ticket shop) via its schema.org Event data. */
async function readWeb(url, event) {
  const res = await fetchPage(url, {});
  if (res.error) return { status: 'error', note: `${res.status || ''} ${res.error}`.trim() };
  const $ = cheerio.load(res.html);
  const best = bestMatch(jsonLdEvents($, res.url), event);
  if (!best) return { status: 'no_date', note: 'no structured date for this event on page' };
  return { title: best.title, start: best.start, end: best.end, time: best.time, endTime: best.endTime, location: best.location, status: 'ok' };
}

// The page's event that is this event: a similar title, or the page's only event if its dates fit
// (a ticket shop may title it differently, but a page about another event must not count).
function bestMatch(candidates, ev) {
  let best = null, score = 0;
  for (const c of candidates) {
    const s = titleSimilarity(c.title, ev.title);
    if (s > score) { best = c; score = s; }
  }
  if (score >= 0.3) return best;
  return candidates.length === 1 && dateDistance(candidates[0], ev) <= 3 ? candidates[0] : null;
}

const PROSE_CHARS = 1500;
const foldText = (s) => clean(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

/**
 * The event's description on its detail page, if it reads like a schedule ("v piatok od 10.00 do
 * 17.00 … v sobotu od 10.00 do 18.00"): several times, and several weekdays or dates. AI reads it.
 */
export function proseSchedule($, title) {
  const $c = $('main, article').first().length ? $('main, article').first().clone() : $('body').clone();
  $c.find('script, style, nav, header, footer, form, aside').remove();
  const text = clean($c.text());
  const folded = foldText(text);
  const head = foldText(title).slice(0, 40);
  // folding keeps the length, so an index in the folded text is also one in the original
  const at = Math.max(0, head ? folded.indexOf(head) : 0);
  const part = text.slice(at, at + PROSE_CHARS);
  const dates = (foldText(part).match(/(?<![\d.])\d{1,2}\.\s*\d{1,2}\.|\d{1,2}\.\s*(januara|februara|marca|aprila|maja|juna|jula|augusta|septembra|oktobra|novembra|decembra)/g) || []).length;
  if (countTimes(part) < 2 || (countWeekdays(part) < 2 && dates < 2)) return null;
  return { text: part, hash: sha1(part).slice(0, 16) };
}

/**
 * The date range a detail page states right under the event's heading ("03.10.2026 – 31.10.2026"),
 * when it has no structured data. Only a range is taken, and only one close to the event's dates;
 * it can only make the event run longer (see syncFromPrimary).
 */
export function headingRange($, ev) {
  const h = $('h1').toArray().find((el) => titleSimilarity(clean($(el).text()), ev.title) >= 0.5);
  if (!h) return null;
  // Text that comes after the heading, in page order (its later siblings and those of its parents).
  let text = '';
  for (let el = h; el && el.type !== 'root' && text.length < 200; el = el.parent) {
    text += ` ${$(el).nextAll().not('script, style').text()}`;
  }
  const r = parseDateText(clean(text).slice(0, 120));
  if (!r?.end || dateDistance(r, ev) > 3) return null;
  return { start: r.start, end: r.end };
}

/**
 * Links on a detail page that point to the same event elsewhere. Links within the page's own site
 * are its other events (a ticket shop's "you may also like"), not this one elsewhere.
 */
function linkedSources($, pageUrl) {
  const out = new Map();
  const own = host(pageUrl).replace(/^www\./, '');
  for (const [href] of extractLinks($, pageUrl)) {
    const fb = facebookEvent(href);
    if (fb) out.set(fb === 'short' ? href : `https://www.facebook.com/events/${fb}/`, 'facebook');
    else if (TICKET_SITES.test(host(href)) && host(href).replace(/^www\./, '') !== own && new URL(href).pathname.length > 1) out.set(href, 'web');
    if (out.size >= MAX_LINKED) break;
  }
  return out;
}

/** Upcoming events due for re-verification, soonest first. */
export function dueForVerification(state, today, budget) {
  return Object.values(state.events)
    .filter((ev) => (ev.end || ev.start) >= today && Date.now() - Date.parse(ev.verifiedAt || 0) > VERIFY_EVERY)
    .sort((a, b) => a.start.localeCompare(b.start))
    .slice(0, budget);
}

/**
 * Re-read an event's detail page and check every linked source; results are recorded as
 * sightings through the index.
 */
export async function verifyEvent(index, ev, report) {
  const primary = ev.sources[0];
  const job = report.start('verify', primary.url, ev.title);
  const linked = new Map(ev.sources.slice(1).filter((s) => s.linked).map((s) => [s.url, s.kind]));
  const notes = [];

  // 1. The event's own detail page (if it has one separate from the listing).
  if (primary.url && primary.url !== primary.via && primary.kind === 'web') {
    // Fresh cache: a 304 would hide the links we came for.
    const res = await fetchPage(primary.url, {});
    if (res.html) {
      const $ = cheerio.load(res.html);
      const own = bestMatch(jsonLdEvents($, res.url), ev);
      if (own) ({ event: ev } = index.add({ ...primary, start: own.start, end: own.end, time: own.time || primary.time, endTime: own.endTime || primary.endTime }, ev));
      const range = own ? null : headingRange($, ev);
      if (range) ev.pageRange = { url: res.url, ...range }; else delete ev.pageRange;
      index.refresh(ev);
      // No structured dates: a schedule in the text is read by AI in the "Check dates" step.
      const prose = own ? null : proseSchedule($, ev.title);
      if (prose && prose.hash !== ev.prose?.hash) ev.prose = { url: res.url, ...prose };
      else if (!prose && !own) { delete ev.prose; delete ev.schedule; }
      for (const [url, kind] of linkedSources($, res.url)) {
        // Skip short links we've already resolved to a canonical row, and pages that didn't confirm it.
        if (!ev.sources.some((s) => s.from === url) && !ev.unconfirmed?.includes(url)) linked.set(url, kind);
      }
    } else if (res.error) {
      notes.push(`detail page: ${res.status || ''} ${res.error}`.trim());
    }
  }

  // 2. Every linked source.
  let agree = 0, disagree = 0;
  for (const [url, kind] of linked) {
    report.update?.(job, { note: `checking ${host(url)}…` });
    let found;
    if (kind === 'facebook') {
      found = facebookEnabled()
        ? await readFacebook(url)
        : { status: 'not_checked', note: 'Facebook disallows crawlers; set EVENTS_FACEBOOK=on to read it' };
    } else {
      found = await readWeb(url, ev);
      // A page that doesn't confirm the event (usually a link to a different one) isn't listed as a
      // source; it's remembered so it isn't fetched again on every verification (an unreachable
      // one is tried again next time).
      if (found.status !== 'ok') {
        if (found.status === 'no_date') ev.unconfirmed = [...new Set([...(ev.unconfirmed || []), url])].slice(-20);
        ev.sources = ev.sources.filter((s) => s.url !== url);
        notes.push(`${host(url).replace(/^www\./, '')}: ${found.status}`);
        continue;
      }
    }
    const row = { kind, linked: true, via: primary.url, url, title: ev.title, ...found };
    // A resolved fb.me short link replaces its placeholder row.
    if (row.url !== url) {
      row.from = url;
      ev.sources = ev.sources.filter((s) => s.url !== url);
    }
    // Sources without their own date must not look like they agree: keep date fields empty.
    if (found.status !== 'ok') Object.assign(row, { start: undefined, end: undefined, time: undefined, endTime: undefined });
    ({ event: ev } = index.add(row, ev));
    if (found.status === 'ok') {
      const p = ev.sources[0];
      if (found.start === p.start && (!found.time || !p.time || found.time === p.time)) agree++;
      else disagree++;
    }
    notes.push(`${host(row.url).replace(/^www\./, '')}: ${found.status === 'ok' ? [found.start, found.time].filter(Boolean).join(' ') : found.status}`);
  }
  ev.verifiedAt = new Date().toISOString();
  report.end(job, {
    status: linked.size ? 'ok' : 'nothing',
    sources: ev.sources.length, agree, disagree,
    note: notes.join('; ') || 'no linked sources',
  });
}
