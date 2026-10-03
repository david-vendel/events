// Dates: a built-in parser for the usual (mostly Slovak) formats, plus formats learned from AI.
//
// Every free-form date text is reduced to a "shape" ("02.10.2026 10:00 - 03.10.2026 18:00" ->
// "N.N.Y N:N - N.N.Y N:N"). A shape seen for the first time is sent to AI once (cheap model, in
// batches): AI says what the samples mean and writes a regex rule for the format. If the built-in
// parser already agrees, nothing changes; if not, AI's rule is kept when it reproduces AI's own
// answers, and that shape is parsed with the rule from then on, without AI. Every format is
// re-checked with a fresh sample now and then, so a parser that is quietly wrong doesn't stay so.
const fold = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');

// ---------------------------------------------------------------- dates

// Bump when date parsing changes: listing pages are then re-read even if unchanged, so events
// already stored get the corrected dates.
export const PARSER_VERSION = 7;

const MONTHS = {
  januar: 1, februar: 2, marec: 3, marca: 3, april: 4, maj: 5, jun: 6, jul: 7, august: 8,
  september: 9, septembra: 9, oktober: 10, oktobra: 10, november: 11, novembra: 11,
  december: 12, decembra: 12, januara: 1, februara: 2, aprila: 4, maja: 5, juna: 6, jula: 7,
  augusta: 8, january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10,
  // Czech (folded), nominative and genitive: "27 říjen", "27. října"
  leden: 1, ledna: 1, unor: 2, unora: 2, brezen: 3, brezna: 3, duben: 4, dubna: 4, kveten: 5, kvetna: 5,
  cerven: 6, cervna: 6, cervenec: 7, cervence: 7, srpen: 8, srpna: 8, zari: 9, rijen: 10, rijna: 10,
  listopad: 11, listopadu: 11, prosinec: 12, prosince: 12,
};
export const MONTH_RE = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join('|');
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

const dayBefore = (iso) => new Date(Date.parse(`${iso}T12:00Z`) - 864e5).toISOString().slice(0, 10);
const dayAfter = (iso) => new Date(Date.parse(`${iso}T12:00Z`) + 864e5).toISOString().slice(0, 10);
const hhmm = (h, m) => (h === undefined ? undefined : `${pad(h)}:${m}`);

// An end years after the start ("2.1.2026 – 31.12.9999 00:59") is a site's way of saying "no end".
const MAX_RUN_DAYS = 2 * 366;
export const placeholderEnd = (start, end) => Boolean(end && start) && (Date.parse(end) - Date.parse(start)) / 864e5 > MAX_RUN_DAYS;

// Listings rarely go more than a year ahead; starts beyond that are generated repeats ("every
// 19 September" up to 2038), test entries or typos ("13.11.2058").
const MAX_AHEAD_DAYS = 400;
export const tooFarAhead = (start, now = new Date()) => (Date.parse(start) - now.getTime()) / 864e5 > MAX_AHEAD_DAYS;

// Listings often pad all-day or open-ended entries with placeholder times: "01.10. 00:00 –
// 05.10. 00:00" is 1–4 October with no time; "17:00 – 23:59" just means "from 17:00".
export function finishDate({ start, end, time, endTime }) {
  if (end && (end < start || placeholderEnd(start, end))) end = endTime = undefined;
  if (time === '00:00') time = undefined;
  if (endTime === '23:59') endTime = undefined;
  if (endTime === '00:00') {
    if (end && end > start) end = dayBefore(end);
    endTime = undefined;
  }
  // "Fri 22:00 – Sat 04:00" is one night out, not two days.
  if (end && time && endTime && endTime <= '06:00' && end === dayAfter(start)) end = undefined;
  if (end === start) end = undefined;
  if (!time || (!end && endTime === time)) endTime = undefined; // "08:00 08:00" is a start time, twice
  return { start, end, time, endTime };
}

const DMY = String.raw`(?<![\d.])(0?[1-9]|[12]\d|3[01])\.\s*(0?[1-9]|1[0-2])(?![\d:])\.?\s*(\d{4})?`;
const AT = String.raw`(?:\s*,?\s*(?:o\s*)?([01]?\d|2[0-3]):([0-5]\d))?`;
// (the end may repeat a weekday: "pi 2. 10. 18:00 – ne 4. 10. 20:00")
// ("od 1.9.2026 08:00 do 31.10.2026 18:00": "do" is a dash too)
const DASH = String.raw`\s*(?:h|hod\.?)?\s*(?:[-–—]|\bdo\b)\s*(?:[a-z]{2,8}\.?,?\s*)?`;
// 02.10.2026 10:00 - 03.10.2026 18:00, 09.10 - 11.10.2026
const DMY_RANGE = new RegExp(`${DMY}${AT}${DASH}${DMY}${AT}`);
// 5. októbra – 9. decembra, 1. augusta 2023 0:00 - 6. septembra 2023 0:00 (no weekday after the dash:
// "– nám. 29. augusta" is a street)
const DMONTH = String.raw`(?<![\d.])(0?[1-9]|[12]\d|3[01])\.?\s*\b(${MONTH_RE})\b\.?\s*(\d{4})?`;
const DMONTH_RANGE = new RegExp(`${DMONTH}${AT}\\s*(?:h|hod\\.?)?\\s*(?:[-–—]|\\bdo\\b)\\s*${DMONTH}${AT}`);
// 17:00 - 23:59, 10.00 – 18.00 hod.
const TIME_RE = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?:\s*(?:h|hod\.?)?\s*(?:[-–—]|\bdo\b)\s*([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d))?/;
// "27 říjen Út | 19.00", "piatok o 19.30": a dotted time after "|" or "o" (at); not after a comma,
// where it's as likely a price or another part's time ("Vernisáž: 28. 10. 2026, 18.00 … Trvanie: …")
const TIME_AFTER_SEP = /(?:\||\bo|\bod)\s*([01]?\d|2[0-3])\.([0-5]\d)(?![\d.,])(?:\s*(?:[-–—]|\bdo\b)\s*([01]?\d|2[0-3])\.([0-5]\d)(?![\d.,]))?/;
const TIME_H_RE = /(?<![\d.])([01]?\d|2[0-3])\.([0-5]\d)(?:\s*[-–—]\s*([01]?\d|2[0-3])\.([0-5]\d))?\s*(?:h\b|hod)/;

// Relative dates are read against today every time, never stored as a day: the format "dnes N:N" is
// learned once (the parser reads it), and "dnes 19:00" is a different day tomorrow.
const DAY_WORDS = { dnes: 0, today: 0, zajtra: 1, zitra: 1, tomorrow: 1, pozajtra: 2, pozitri: 2, vcera: -1,
  yesterday: -1, predvcerom: -2, predevcirem: -2 };
const UNIT_DAYS = [[/^(min|hod|sek)/, 0], [/^(den|dn|dni|day)/, 1], [/^(tyzd|tydn|tyden|week)/, 7], [/^(mesia|mesic|month)/, 30], [/^(rok|let|year)/, 365]];
const NUMBER_WORDS = { jednym: 1, jednou: 1, jeden: 1, jedna: 1, dvoma: 2, dvomi: 2, dvema: 2, dva: 2, dve: 2, tromi: 3, troma: 3, tri: 3, a: 1, an: 1 };
// Full weekday names only: two-letter ones ("so", "ne") are everyday words.
const WEEKDAY_NUM = { nedela: 0, nedelu: 0, nedele: 0, sunday: 0, pondelok: 1, pondeli: 1, monday: 1, utorok: 2, utery: 2,
  tuesday: 2, streda: 3, stredu: 3, wednesday: 3, stvrtok: 4, ctvrtek: 4, thursday: 4, piatok: 5, patek: 5, friday: 5,
  sobota: 6, sobotu: 6, saturday: 6 };

/** Days from today that a relative text means, or undefined. */
function relativeDays(t, now) {
  for (const [w, d] of Object.entries(DAY_WORDS)) if (new RegExp(`\\b${w}\\b`).test(t)) return d;
  // "pred 2 dnami", "pred tyzdnom", "2 days ago"; "o 3 dni", "za tyzden", "in 3 days"
  const m = t.match(/\b(pred|pred|o|za|in)\s+(\d+|[a-z]+\s+)?\s*([a-z]+)|\b(\d+|a|an)\s+([a-z]+)\s+ago\b/);
  if (m) {
    const [num, unit, back] = m[4] ? [m[4], m[5], true] : [m[2]?.trim(), m[3], m[1] === 'pred'];
    const per = UNIT_DAYS.find(([re]) => re.test(unit))?.[1];
    const n = num === undefined ? 1 : /^\d+$/.test(num) ? +num : NUMBER_WORDS[num];
    if (per !== undefined && n !== undefined) return (back ? -1 : 1) * n * per;
  }
  // "v piatok 19:00": the next such day (today counts)
  for (const [w, d] of Object.entries(WEEKDAY_NUM)) if (new RegExp(`\\b${w}\\b`).test(t)) return (d - now.getDay() + 7) % 7;
  return undefined;
}

// A date or a time ("23.10.2026", "20:00"), and text after one that is a place, not more of the date:
// "23.10.2026 20:00 - Kesta Bistro, Ul. 29. augusta 645, Martin" (where "29. augusta" is a street).
const WHEN_TOKEN = /\d{1,2}\.\s*\d{1,2}\.\s*\d{4}|\d{1,2}:\d{2}(?::\d{2})?/g;
/** The folded text without a place written after its date and time. */
export function withoutPlace(t) {
  for (const m of t.matchAll(WHEN_TOKEN)) {
    const tail = t.slice(m.index + m[0].length);
    if (/^\s*(?:[-–—,|]|\bv\b)\s*[a-z]/.test(tail) && !/\d{1,2}:\d{2}/.test(tail)) return t.slice(0, m.index + m[0].length);
  }
  return t;
}

/** Parse free-form (mostly Slovak) date text into { start, end?, time?, endTime? } or null. */
export function parseDateText(text, now = new Date()) {
  const t = withoutPlace(fold(text));
  let start, end;
  let m;

  if ((m = t.match(/(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/))) {
    start = `${m[1]}-${m[2]}-${m[3]}`;
    const e = t.slice(m.index + m[0].length).match(/(\d{4})-(\d{2})-(\d{2})(?:[t ](\d{2}):(\d{2}))?/);
    if (e) end = `${e[1]}-${e[2]}-${e[3]}`;
    if (m[4]) return finishDate({ start, end, time: hhmm(m[4], m[5]), endTime: hhmm(e?.[4], e?.[5]) });
  } else if ((m = t.match(DMY_RANGE))) {
    const y = m[3] || m[8];
    start = makeDate(m[1], m[2], y, now);
    end = makeDate(m[6], m[7], m[8] || y, now);
    if (start && m[4]) return finishDate({ start, end, time: hhmm(m[4], m[5]), endTime: hhmm(m[9], m[10]) });
    // "09.10 - 11.10.2026 19:00": a time only after the last day is each day's start
    if (start && m[9]) {
      const to = t.slice(m.index + m[0].length).match(/^\s*(?:h|hod\.?)?\s*[-–—]\s*([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d)/);
      return finishDate({ start, end, time: hhmm(m[9], m[10]), endTime: to ? hhmm(to[1], to[2]) : undefined });
    }
  } else if ((m = t.match(DMONTH_RANGE))) {
    const y = m[3] || m[8];
    start = makeDate(m[1], MONTHS[m[2]], y, now);
    // No year: the end is in the start's year, or the next one ("20. júla – 24. augusta", "5. dec – 9. jan").
    end = !y && start ? makeDate(m[6], MONTHS[m[7]], start.slice(0, 4), now) : makeDate(m[6], MONTHS[m[7]], m[8] || y, now);
    if (!y && end && end < start) end = makeDate(m[6], MONTHS[m[7]], String(+start.slice(0, 4) + 1), now);
    if (start && m[4]) return finishDate({ start, end, time: hhmm(m[4], m[5]), endTime: hhmm(m[9], m[10]) });
    if (start && m[9]) return finishDate({ start, end, time: hhmm(m[9], m[10]) });
  } else if ((m = t.match(/(\d{1,2})\.\s*[-–—]\s*(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})?/))) {
    // 9. - 11. 10. 2026
    start = makeDate(m[1], m[3], m[4], now);
    end = makeDate(m[2], m[3], m[4], now);
  } else {
    // A single date, written one of three ways; the one that comes first in the text counts (a later
    // one may be part of an address: "ul. 29. augusta").
    const ways = [
      // 3. októbra 2026, 9. – 11. októbra
      [new RegExp(`(\\d{1,2})\\.?\\s*(?:[-–—]\\s*(\\d{1,2})\\.?\\s*)?\\b(${MONTH_RE})\\b\\s*(\\d{4})?`), (x) => {
        start = makeDate(x[1], MONTHS[x[3]], x[4], now);
        if (x[2]) end = makeDate(x[2], MONTHS[x[3]], x[4], now);
      }],
      // október 7 2026 (Facebook), October 7, 2026
      [new RegExp(`\\b(${MONTH_RE})\\s+(\\d{1,2}),?\\s+(\\d{4})`), (x) => { start = makeDate(x[2], MONTHS[x[1]], x[3], now); }],
      // 3.10.2026, 3. 10.
      [/(?<![\d.])(\d{1,2})\.\s*(\d{1,2})\.(?:\s*(\d{4}))?/, (x) => { start = makeDate(x[1], x[2], x[3], now); }],
    ].map(([re, use]) => [t.match(re), use]).filter(([x]) => x).sort((a, b) => a[0].index - b[0].index);
    if (ways.length) {
      m = ways[0][0];
      ways[0][1](m);
    }
  }
  if (!start) {
    // No date written out: maybe one relative to today ("dnes 19:00", "pred 1 tyzdnom").
    const days = relativeDays(t, now);
    if (days === undefined) return null;
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + days);
    start = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    m = null;
  }

  const rest = m ? t.slice(m.index + m[0].length) + ' ' + t.slice(0, m.index) : t;
  const tm = rest.match(TIME_RE) || rest.match(TIME_H_RE) || rest.match(TIME_AFTER_SEP);
  return finishDate({ start, end, time: tm ? hhmm(tm[1], tm[2]) : undefined, endTime: tm ? hhmm(tm[3], tm[4]) : undefined });
}

// ---------------------------------------------------------------- learned formats

export const FORMAT_RECHECK_DAYS = 14;
const RETRY_DAYS = 1; // a format AI couldn't write a working rule for is tried again soon, then less often
const MAX_RETRY_DAYS = 30;
const NOT_DATE_RECHECK_DAYS = 60; // text AI said holds no date (a byline, an e-mail, a headline)
const OK_RECHECK_DAYS = 60; // the built-in parser reads it: it only changes with PARSER_VERSION
const MAX_SAMPLES = 5;
const MAX_ANSWERS = 50;

// shape -> { samples, uses, status, rule, unsure, checkedAt, nextCheckAt, checks, history }
//   status: "new" (not checked yet) | "ok" (built-in parser agrees with AI) | "rule" (AI's rule)
//           | "ai" (no working rule: AI's answers for the exact texts it saw)
//           | "none" (not a date at all: recipes sometimes point at a byline or an e-mail)
let formats = {};
/** Use (and fill) this object for learned formats: state.dateFormats. */
export function useDateFormats(obj) {
  formats = obj;
  for (const [shape, f] of Object.entries(formats)) {
    // Answers cached before relative dates were understood ("dnes 09:54" stored as one fixed day):
    // asked again, and now the parser reads them against today.
    if (f.status === 'ai' && RELATIVE.test(shape)) { delete formats[shape]; continue; }
    // Stored before "none" existed: AI found no date in any sample, and it was asked again daily.
    if (f.status === 'ai' && !Object.values(f.answers || {}).some(Boolean)) {
      f.status = 'none';
      delete f.answers;
      f.nextCheckAt = new Date(Date.now() + NOT_DATE_RECHECK_DAYS * 864e5).toISOString();
    }
  }
}
const RELATIVE = /\b(dnes|zajtra|vcera|pred|today|tomorrow|yesterday)\b/;

/** Text that can't hold a date: no digit and no month name ("Termín konania", "Zdroj: TASR"). */
const dateless = (text) => !/\d/.test(text) && !new RegExp(`\\b(${MONTH_RE})\\b`).test(fold(text));

const WEEKDAYS = /\b(pondelok|utorok|streda|stvrtok|piatok|sobota|nedela|pondelka|utorka|stredy|stvrtka|piatku|soboty|nedele|stredu|sobotu|nedelu|po|ut|st|stv|pi|so|ne|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b\.?/g;
const MONTH_WORD = new RegExp(`\\b(${MONTH_RE})\\b`, 'g');

/** "02.10.2026 10:00 - 03.10.2026 18:00" -> "N.N.Y N:N - N.N.Y N:N" */
export function dateShape(text) {
  return withoutPlace(fold(text)).replace(MONTH_WORD, 'M').replace(WEEKDAYS, 'W').replace(/\d{4}/g, 'Y').replace(/\d{1,2}/g, 'N')
    .replace(/[a-z]+/g, 'w').replace(/(w\s*)+/g, 'w ').replace(/\s+/g, ' ').trim();
}

// Signs that the built-in reading left something out: more dates or times than it used, or a
// weekday-by-weekday schedule. Returns a reason, or undefined.
export function unsureReason(text, r) {
  const t = fold(text);
  if (!r) return /\d/.test(t) ? 'no date found' : undefined;
  const times = countTimes(t);
  const dates = (t.match(/(?<![\d.])\d{1,2}\.\s*\d{1,2}\.|\d{4}-\d{2}-\d{2}/g) || []).length
    + (t.match(MONTH_WORD) || []).length;
  const weekdays = (t.match(WEEKDAYS) || []).length;
  if (times >= 2 && !r.endTime && !(r.time && /23:59|00:00/.test(t))) return 'more times than it read';
  if (dates >= 2 && !r.end) return 'more dates than it read';
  if (weekdays >= 2 && times >= 2) return 'a schedule by weekday';
  if (dates === 0 && !/\d{4}-\d{2}-\d{2}/.test(t) && !(t.match(MONTH_WORD))) return 'date without day and month';
  return undefined;
}

const TIMES = /(?<!\d)([01]?\d|2[0-3]):[0-5]\d(?!\d)|(?<![\d.])([01]?\d|2[0-3])\.[0-5]\d\s*(?:h\b|hod)|\b(?:od|do|o)\s+([01]?\d|2[0-3])\.[0-5]\d(?!\d)/g;
// Only clock times and words ("Dóm sv. Alžbety, Košice 18:00 – 19:30"): a recipe's date points at the
// place-and-time line. Each place name makes a new shape, so these are settled here, not by AI.
const timesOnly = (text) => !/\d/.test(fold(text).replace(TIMES, ''));
export const countTimes = (t) => (fold(t).match(TIMES) || []).length;
export const countWeekdays = (t) => (fold(t).match(WEEKDAYS) || []).length;

/**
 * An AI-written rule: { pattern, groups: { startDay, startMonth, startYear, startHour, startMinute,
 * endDay, endMonth, endYear, endHour, endMinute } } with capture group numbers (months may capture
 * a month name). Run on the folded text (lowercase, no diacritics). Returns a date or null.
 */
export function applyRule(rule, text, now = new Date()) {
  const t = fold(text);
  if (!rule?.pattern || t.length > 300) return null;
  let m;
  try { m = t.match(new RegExp(rule.pattern)); } catch { return null; }
  if (!m) return null;
  const g = (k) => (rule.groups?.[k] ? m[rule.groups[k]] : undefined);
  const month = (k) => { const v = g(k); return v === undefined ? undefined : /^\d+$/.test(v) ? +v : MONTHS[v]; };
  const start = makeDate(g('startDay'), month('startMonth'), g('startYear'), now);
  if (!start) return null;
  const end = g('endDay') ? makeDate(g('endDay'), month('endMonth') ?? month('startMonth'), g('endYear') ?? g('startYear'), now) : undefined;
  const time = g('startHour') !== undefined ? hhmm(g('startHour'), pad(g('startMinute') ?? '00')) : undefined;
  const endTime = g('endHour') !== undefined ? hhmm(g('endHour'), pad(g('endMinute') ?? '00')) : undefined;
  return finishDate({ start, end: end || undefined, time, endTime });
}

/** The same date reading, ignoring missing fields. */
export const sameDate = (a, b) => Boolean(a && b) && ['start', 'end', 'time', 'endTime'].every((k) => (a[k] || null) === (b[k] || null));

/**
 * Read free-form date text from a listing, using what was learned for its format. Records the
 * text as a sample of its format, so new formats get checked by AI. Returns { start, … } or null.
 */
export function readDateText(text, now = new Date(), { note = true } = {}) {
  const builtin = parseDateText(text, now);
  if (!text || text.length > 160) return builtin; // prose: read on the detail page instead
  const shape = dateShape(text);
  if (!note) return readKnown(formats[shape], text, now) || builtin;
  const f = (formats[shape] ??= { shape, samples: [], uses: 0, status: dateless(text) || (!builtin && timesOnly(text)) ? 'none' : 'new', firstSeenAt: new Date().toISOString() });
  f.uses++;
  f.lastSeenAt = new Date().toISOString();
  if (!f.samples.includes(text)) f.samples = [text, ...f.samples].slice(0, MAX_SAMPLES);
  if (f.status === 'new') f.unsure ??= unsureReason(text, builtin);
  if (f.status === 'ai' && !f.answers?.[text]) f.unsure ??= 'new text, no rule yet';
  return readKnown(f, text, now) || builtin;
}

function readKnown(f, text, now) {
  if (f?.status === 'rule') return applyRule(f.rule, text, now);
  if (f?.status === 'ai') return f.answers?.[text] || null;
  return null; // "none": not a date; "new"/"ok": the built-in parser's reading is used
}

// A new format the parser reads without any sign of trouble is checked by AI only once it's common:
// most are one-off sentences ("v pondelok 10. augusta o 17.00 h sa kona…") the parser gets right.
const SPOT_CHECK_USES = 10;

/** Formats due for an AI check: new ones (unsure first), then ones due for a re-check. */
export function formatsDue(limit) {
  const now = Date.now();
  return Object.values(formats)
    .filter((f) => f.samples.length && (f.status === 'new'
      ? f.unsure || f.uses >= SPOT_CHECK_USES
      : (f.status !== 'none' || f.nextCheckAt) && Date.parse(f.nextCheckAt || 0) <= now))
    .sort((a, b) => (a.status === 'new') - (b.status === 'new') || Boolean(a.unsure) - Boolean(b.unsure) || b.uses - a.uses)
    .reverse()
    .slice(0, limit);
}

/**
 * Take AI's reading of a format's samples ({ text -> answer }) and its rule, and decide how the
 * format is read from now on. Returns a plain-words line for the AI call log.
 */
export function learnFormat(f, answers, rule, now = new Date()) {
  const texts = Object.keys(answers);
  const norm = Object.fromEntries(texts.map((t) => [t, answers[t] && finishDate(answers[t])]));
  const builtinOk = texts.every((t) => sameDate(parseDateText(t, now), norm[t]));
  const ruleOk = (r) => r && texts.every((t) => sameDate(applyRule(r, t, now), norm[t]));
  const before = f.status;
  if (texts.every((t) => !norm[t]) && texts.every((t) => !parseDateText(t, now))) {
    f.status = 'none'; // neither AI nor the parser finds a date in any sample
    delete f.rule;
  } else if (f.status === 'rule' && ruleOk(f.rule)) {
    // the rule still holds
  } else if (builtinOk) {
    f.status = 'ok';
    delete f.rule;
  } else if (ruleOk(rule)) {
    f.status = 'rule';
    f.rule = rule;
  } else {
    f.status = 'ai';
    delete f.rule;
  }
  if (f.status === 'ai') {
    f.answers = Object.fromEntries(Object.entries({ ...f.answers, ...norm }).filter(([, a]) => a).slice(-MAX_ANSWERS));
  } else {
    delete f.answers;
  }
  const at = new Date();
  f.checks = (f.checks || 0) + 1;
  f.checkedAt = at.toISOString();
  // A format still without a working rule is retried after 1, 2, 4… days (its answers are used meanwhile).
  const days = { ai: Math.min(MAX_RETRY_DAYS, RETRY_DAYS * 2 ** ((f.fails = before === 'ai' ? (f.fails || 0) + 1 : 0))),
    none: NOT_DATE_RECHECK_DAYS, ok: OK_RECHECK_DAYS }[f.status] ?? FORMAT_RECHECK_DAYS;
  f.nextCheckAt = new Date(at.getTime() + days * 864e5).toISOString();
  const said = {
    ok: 'built-in parser agrees',
    rule: before === 'rule' ? 'learned rule still agrees' : 'built-in parser was wrong: AI rule saved, used from now on',
    ai: 'built-in parser was wrong and AI rule did not reproduce its answers: using AI answers, will retry',
    none: 'not a date (the recipe points at other text); not asked again for 60 days',
  }[f.status];
  f.history = [{ at: f.checkedAt, from: before, to: f.status, unsure: f.unsure }, ...(f.history || [])].slice(0, 5);
  delete f.unsure;
  return { changed: before !== f.status || f.status === 'ai', said };
}
