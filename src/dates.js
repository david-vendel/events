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
export const PARSER_VERSION = 3;

const MONTHS = {
  januar: 1, februar: 2, marec: 3, marca: 3, april: 4, maj: 5, jun: 6, jul: 7, august: 8,
  september: 9, septembra: 9, oktober: 10, oktobra: 10, november: 11, novembra: 11,
  december: 12, decembra: 12, januara: 1, februara: 2, aprila: 4, maja: 5, juna: 6, jula: 7,
  augusta: 8, january: 1, february: 2, march: 3, may: 5, june: 6, july: 7, october: 10,
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
const hhmm = (h, m) => (h === undefined ? undefined : `${pad(h)}:${m}`);

// Listings often pad all-day or open-ended entries with placeholder times: "01.10. 00:00 –
// 05.10. 00:00" is 1–4 October with no time; "17:00 – 23:59" just means "from 17:00".
export function finishDate({ start, end, time, endTime }) {
  if (end && end < start) end = endTime = undefined;
  if (time === '00:00') time = undefined;
  if (endTime === '23:59') endTime = undefined;
  if (endTime === '00:00') {
    if (end && end > start) end = dayBefore(end);
    endTime = undefined;
  }
  if (end === start) end = undefined;
  if (!time) endTime = undefined;
  return { start, end, time, endTime };
}

const DMY = String.raw`(?<![\d.])(0?[1-9]|[12]\d|3[01])\.\s*(0?[1-9]|1[0-2])(?![\d:])\.?\s*(\d{4})?`;
const AT = String.raw`(?:\s*,?\s*(?:o\s*)?([01]?\d|2[0-3]):([0-5]\d))?`;
// (the end may repeat a weekday: "pi 2. 10. 18:00 – ne 4. 10. 20:00")
const DASH = String.raw`\s*(?:h|hod\.?)?\s*[-–—]\s*(?:[a-z]{2,8}\.?,?\s*)?`;
// 02.10.2026 10:00 - 03.10.2026 18:00, 09.10 - 11.10.2026
const DMY_RANGE = new RegExp(`${DMY}${AT}${DASH}${DMY}${AT}`);
// 17:00 - 23:59, 10.00 – 18.00 hod.
const TIME_RE = /(?<!\d)([01]?\d|2[0-3]):([0-5]\d)(?!\d)(?:\s*(?:h|hod\.?)?\s*[-–—]\s*([01]?\d|2[0-3])[:.]([0-5]\d)(?!\d))?/;
const TIME_H_RE = /(?<![\d.])([01]?\d|2[0-3])\.([0-5]\d)(?:\s*[-–—]\s*([01]?\d|2[0-3])\.([0-5]\d))?\s*(?:h\b|hod)/;

/** Parse free-form (mostly Slovak) date text into { start, end?, time?, endTime? } or null. */
export function parseDateText(text, now = new Date()) {
  const t = fold(text);
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

  const rest = m ? t.slice(m.index + m[0].length) + ' ' + t.slice(0, m.index) : t;
  const tm = rest.match(TIME_RE) || rest.match(TIME_H_RE);
  return finishDate({ start, end, time: tm ? hhmm(tm[1], tm[2]) : undefined, endTime: tm ? hhmm(tm[3], tm[4]) : undefined });
}

// ---------------------------------------------------------------- learned formats

export const FORMAT_RECHECK_DAYS = 14;
const RETRY_DAYS = 1; // a format AI couldn't write a working rule for is tried again soon
const MAX_SAMPLES = 5;
const MAX_ANSWERS = 50;

// shape -> { samples, uses, status, rule, unsure, checkedAt, nextCheckAt, checks, history }
//   status: "new" (not checked yet) | "ok" (built-in parser agrees with AI) | "rule" (AI's rule)
//           | "ai" (no working rule: AI's answers for the exact texts it saw)
let formats = {};
/** Use (and fill) this object for learned formats: state.dateFormats. */
export function useDateFormats(obj) { formats = obj; }

const WEEKDAYS = /\b(pondelok|utorok|streda|stvrtok|piatok|sobota|nedela|pondelka|utorka|stredy|stvrtka|piatku|soboty|nedele|stredu|sobotu|nedelu|po|ut|st|stv|pi|so|ne|monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun)\b\.?/g;
const MONTH_WORD = new RegExp(`\\b(${MONTH_RE})\\b`, 'g');

/** "02.10.2026 10:00 - 03.10.2026 18:00" -> "N.N.Y N:N - N.N.Y N:N" */
export function dateShape(text) {
  return fold(text).replace(MONTH_WORD, 'M').replace(WEEKDAYS, 'W').replace(/\d{4}/g, 'Y').replace(/\d{1,2}/g, 'N')
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
  const f = (formats[shape] ??= { shape, samples: [], uses: 0, status: 'new', firstSeenAt: new Date().toISOString() });
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
  return null;
}

/** Formats due for an AI check: new ones (unsure first), then ones due for a re-check. */
export function formatsDue(limit) {
  const now = Date.now();
  return Object.values(formats)
    .filter((f) => f.samples.length && (f.status === 'new' || Date.parse(f.nextCheckAt || 0) <= now))
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
  if (f.status === 'rule' && ruleOk(f.rule)) {
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
  f.nextCheckAt = new Date(at.getTime() + (f.status === 'ai' ? RETRY_DAYS : FORMAT_RECHECK_DAYS) * 864e5).toISOString();
  const said = {
    ok: 'built-in parser agrees',
    rule: before === 'rule' ? 'learned rule still agrees' : 'built-in parser was wrong: AI rule saved, used from now on',
    ai: 'built-in parser was wrong and AI rule did not reproduce its answers: using AI answers, will retry',
  }[f.status];
  f.history = [{ at: f.checkedAt, from: before, to: f.status, unsure: f.unsure }, ...(f.history || [])].slice(0, 5);
  delete f.unsure;
  return { changed: before !== f.status || f.status === 'ai', said };
}
