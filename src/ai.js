// The only place that talks to Claude. AI does four jobs, each switchable in the admin panel
// (AI tab) with its own model:
//  - analyze:  first look at a promising page -> what the site is, and a CSS "recipe" so future
//              visits are parsed with zero AI;
//  - tag:      give a kind (cinema, concert…) to events the rules couldn't tag;
//  - discover: web search for new event sources, a different Slovak town and kind each time;
//  - dates:    check date formats the parser hasn't confirmed (and write rules for them), and read
//              schedules written as prose ("v piatok od 10.00 do 17.00, v sobotu…").
// Calls go through the Claude Agent SDK, which runs on your Claude Code login, so they count
// against your Claude subscription's usage limits instead of being billed per token. Usage is
// shared with your own Claude Code use. With AI off the crawler runs on rules only.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import fs from 'node:fs';
import path from 'node:path';
import { TAGS } from './tags.js';
import { scoreLink } from './extract.js';
import { DATA_DIR } from './store.js';

export const AI_JOBS = {
  analyze: {
    label: 'Read new listing pages',
    what: 'Reads a promising page once: what the site is, whether it lists events (and in which city), and a recipe '
      + '(CSS selectors) so later visits need no AI.',
    model: 'sonnet', // Opus wrote no better recipes; Haiku's were worse (eval, 2 Oct 2026)
  },
  triage: {
    label: 'Pre-check pages',
    what: 'A quick look at a page found while exploring (its text only) before the page reader sees it: does it '
      + 'list upcoming events? Pages that do not are skipped, which spares most of the bigger model\'s calls.',
    model: 'haiku',
  },
  tag: {
    label: 'Tag & locate events',
    what: 'Gives a kind (cinema, concert…) to events the rules could not tag, and a city to events without a '
      + 'location. Its tags become rules for the same venue, page or title words.',
    model: 'haiku',
  },
  discover: {
    label: 'Find new sources',
    what: 'Web search for pages that list events in Slovak towns (a different town and kind each time), every 6 hours.',
    model: 'haiku', // found as many new event sites as Sonnet (eval, 2 Oct 2026)
  },
  dates: {
    label: 'Check dates',
    what: 'Reads date formats the parser has not confirmed yet and writes a rule for each, so later dates in that '
      + 'format need no AI; re-checks every format now and then. Also reads schedules written as sentences.',
    model: 'haiku',
  },
};
// "default" = whatever model your Claude Code uses; the others are Claude Code model aliases.
export const AI_MODELS = ['default', 'haiku', 'sonnet', 'opus'];

// Set from the admin panel (state.settings.ai). Before anything is saved, AI is on unless EVENTS_AI=off.
let config = defaultAiConfig();
export function defaultAiConfig() {
  return {
    enabled: process.env.EVENTS_AI !== 'off',
    jobs: Object.fromEntries(Object.entries(AI_JOBS).map(([k, j]) => [k, { on: true, model: j.model }])),
  };
}
/** Merge a (partial, untrusted) config over the current one; returns the clean result. */
export function setAiConfig(patch = {}) {
  const next = structuredClone(config);
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled;
  for (const [k, j] of Object.entries(patch.jobs || {})) {
    if (!next.jobs[k]) continue;
    if (typeof j.on === 'boolean') next.jobs[k].on = j.on;
    if (AI_MODELS.includes(j.model)) next.jobs[k].model = j.model;
  }
  config = next;
  return structuredClone(config);
}
export const aiConfig = () => structuredClone(config);

/** Is AI on (at all, or for one job)? */
export function aiAvailable(job) {
  return config.enabled && (!job || config.jobs[job]?.on !== false);
}
// ---------------------------------------------------------------- your Claude plan

// What your Claude Code login's plan reports (same data as Claude Code's /usage): plan type,
// share of the 5-hour and weekly windows used, and usage credits. Plans have no fixed token
// allowance, so this is the only real "how much is left". The SDK marks this call experimental,
// so every failure is caught and the dashboard just says it's unavailable.
let plan = null; // { at, subscription, windows: [{ name, used, resetsAt }], credits, error }
let planFetch = null;
const WINDOW_NAMES = { five_hour: '5-hour window', seven_day: 'Weekly', seven_day_sonnet: 'Weekly (Sonnet)', seven_day_opus: 'Weekly (Opus)' };

export function planUsage({ refresh = false, maxAgeMs = 120e3 } = {}) {
  if (!refresh && plan && Date.now() - plan.at < maxAgeMs) return Promise.resolve(plan);
  planFetch ??= readPlanUsage().finally(() => { planFetch = null; });
  return planFetch;
}
export const lastPlanUsage = () => plan;

async function readPlanUsage() {
  let done;
  const finished = new Promise((r) => { done = r; });
  // A session that never sends a message: enough to ask for /usage data without a model call.
  const q = query({ prompt: (async function* idle() { await finished; })(), options: { tools: [], settingSources: [], persistSession: false, env: subscriptionEnv() } });
  try {
    const u = await q.usage_EXPERIMENTAL_MAY_CHANGE_DO_NOT_RELY_ON_THIS_API_YET({ skipBehaviors: true });
    const rl = u.rate_limits || {};
    const windows = Object.entries(WINDOW_NAMES).filter(([k]) => rl[k]?.utilization != null)
      .map(([k, name]) => ({ name, used: rl[k].utilization, resetsAt: rl[k].resets_at }));
    for (const m of rl.model_scoped || []) if (m.utilization != null) windows.push({ name: `Weekly (${m.display_name})`, used: m.utilization, resetsAt: m.resets_at });
    const x = rl.extra_usage;
    const credits = x?.is_enabled && x.monthly_limit ? {
      used: x.used_credits / 10 ** (x.decimal_places ?? 2), limit: x.monthly_limit / 10 ** (x.decimal_places ?? 2),
      percent: x.utilization, currency: x.currency || 'USD',
    } : null;
    plan = { at: Date.now(), subscription: u.subscription_type, available: u.rate_limits_available, windows, credits };
  } catch (err) {
    plan = { at: Date.now(), error: err.message };
  } finally {
    done();
    for await (const _ of q) { /* let the session close */ }
  }
  return plan;
}

// Rate-limit news that arrives during normal calls (e.g. "weekly window 80 % used").
function notePlanEvent(info) {
  if (!info || info.utilization == null || !info.rateLimitType) return;
  plan ??= { at: Date.now(), windows: [] };
  const name = WINDOW_NAMES[info.rateLimitType] || info.rateLimitType;
  plan.windows = [...(plan.windows || []).filter((w) => w.name !== name),
    { name, used: info.utilization * (info.utilization <= 1 ? 100 : 1), resetsAt: info.resetsAt && new Date(info.resetsAt * 1000).toISOString() }];
  plan.status = info.status;
}

// Use the subscription login, never a stray API key from the environment (that would bill it).
function subscriptionEnv() {
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  return env;
}

const modelFor = (job) => (config.jobs[job]?.model === 'default' ? undefined : config.jobs[job]?.model);

// AI calls run strictly one at a time, even when the crawler fetches pages in parallel:
// callers queue here in order. aiStatus() tells the dashboard what's running and what's waiting.
let chain = Promise.resolve();
let busy = null;
let waiting = 0;
function oneAtATime(info, onStart, fn) {
  waiting++;
  const run = chain.then(() => {
    waiting--;
    busy = { ...info, startedAt: Date.now() };
    onStart?.();
    return fn();
  }).finally(() => { busy = null; });
  chain = run.catch(() => {});
  return run;
}
export const aiStatus = () => ({ busy, waiting });

const Recipe = z.object({
  item: z.string().describe('CSS selector matching one element per event in the listing'),
  title: z.string().describe('selector, relative to item, for the event title'),
  date: z.string().describe('selector, relative to item, whose text contains the date'),
  time: z.string().nullable().describe('selector, relative to item, for the start time, if separate'),
  location: z.string().nullable(),
  description: z.string().nullable(),
  link: z.string().nullable().describe('selector, relative to item, of the <a> linking to event detail'),
});

const Tag = z.enum(TAGS);

export const Analysis = z.object({
  siteKind: z.enum(['event_listing', 'venue', 'municipality', 'tourism', 'news', 'ticketing', 'shopping_center', 'other']),
  summary: z.string().describe('one sentence: what this website is'),
  publishesEvents: z.boolean().describe('does this site regularly publish upcoming events (any place)?'),
  listingCity: z.string().nullable().describe('the city ALL events on this page take place in, e.g. "Košice"; null if several cities or unknown'),
  pageListsEvents: z.boolean().describe('does THIS page contain a list of multiple events?'),
  recipe: Recipe.nullable().describe('null if this page shows no event (one event on a detail page still gets a recipe)'),
  eventListUrls: z.array(z.string()).describe('other URLs on this site (from the given link list) that likely list events'),
  checkEveryHours: z.number().describe('how often to re-check this source, 12-168'),
  venue: z.object({ name: z.string(), address: z.string().nullable() }).nullable()
    .describe('if this website belongs to ONE venue (club, theatre, gallery, cinema): its name and street address with city'),
  pageTags: z.array(Tag).describe('kinds that fit EVERY event this page lists, e.g. ["cinema"] for a cinema programme, ' +
    '["theatre"] for a theatre repertoire; empty if the page mixes kinds'),
  events: z.array(z.object({
    title: z.string(),
    start: z.string().describe('YYYY-MM-DD'),
    end: z.string().nullable().describe('YYYY-MM-DD of the last day, if the event runs over several days'),
    time: z.string().nullable().describe('HH:MM start'),
    endTime: z.string().nullable().describe('HH:MM end, if given'),
    location: z.string().nullable(),
    url: z.string().nullable(),
    tags: z.array(Tag).describe('what kind of event this is (film screening = cinema)'),
  })).describe('upcoming events on this page ONLY when recipe is null (e.g. events written as prose)'),
});

export const ANALYZE_SYSTEM = `You help a crawler that collects events (concerts, markets, festivals, exhibitions, sport, \
workshops, kids' programs…) anywhere, Slovakia first. You get one web page as simplified HTML \
(scripts/images/navigation/most attributes removed; long runs of look-alike elements are cut to the \
first few, marked "[… N more like this]") plus a list of its links. Classify the site and, if the page \
lists events, write CSS selectors (cheerio-compatible, no :contains, no positional selectors that depend on the \
specific events) so the crawler can parse future versions of this page without you. The recipe is also used on \
other pages of the site with the same URL structure, so if this page shows ONE event (a detail page), still give \
a recipe whose item selector matches the single element that wraps that event (e.g. its article or main block), \
with title and date selectors inside it. Prefer stable class names over auto-generated ones. Only list \
eventListUrls that appear in the given links.`;

// Claude Code's schema validator doesn't accept zod's "$schema" draft header; the rest is fine.
function jsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

/**
 * One isolated, single-purpose Claude call: no Claude Code tools unless listed, none of your
 * settings/CLAUDE.md/hooks, and no saved session. Returns the final result message.
 */
export async function ask({ prompt, systemPrompt, schema, tools = [], maxTurns = 2, model }) {
  // Without this, Claude Code also sends the whole prompt to Haiku in a side call we don't need
  // (as many input tokens as the call itself).
  const env = { ...subscriptionEnv(), CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' };
  let result;
  for await (const msg of query({
    prompt,
    options: {
      model,
      effort: 'low',
      systemPrompt,
      tools,
      allowedTools: tools,
      settingSources: [],
      persistSession: false,
      maxTurns,
      env,
      ...(schema && { outputFormat: { type: 'json_schema', schema: jsonSchema(schema) } }),
    },
  })) {
    if (msg.type === 'result') result = msg;
    if (msg.type === 'rate_limit_event') notePlanEvent(msg.rate_limit_info);
  }
  if (!result) throw new Error('no result from Claude');
  if (result.subtype !== 'success' || result.is_error) {
    const err = new Error(result.subtype === 'success' ? result.result : result.subtype);
    err.result = result;
    throw err;
  }
  return result;
}

/**
 * @returns {{ analysis, call }}: the parsed Analysis (or null on failure) and the usage record.
 * `onStart` fires when this call's turn comes (calls queue behind each other).
 */
export function analyzePage({ url, title, html, truncated, links, today, onStart }) {
  if (!aiAvailable('analyze')) return Promise.resolve({ analysis: null, call: null });
  const linkList = analyzeLinks(url, links).map(([href, text]) => `${href} ${text}`).join('\n');
  const content = `URL: ${url}\nTitle: ${title}\nToday: ${today}\n` +
    (truncated ? 'Note: HTML was cut off at the size limit.\n' : '') +
    `\n<links>\n${linkList}\n</links>\n\n<html>\n${html}\n</html>`;
  return oneAtATime({ kind: 'analyze', target: url }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt: content, systemPrompt: ANALYZE_SYSTEM, schema: Analysis, maxTurns: 3, model: modelFor('analyze') });
      const parsed = Analysis.safeParse(res.structured_output);
      const call = record({ kind: 'analyze', target: url, started, res, input: { system: ANALYZE_SYSTEM, prompt: content }, result: res.structured_output,
        error: parsed.success ? undefined : 'answer did not match the schema' });
      return { analysis: parsed.success ? parsed.data : null, call };
    } catch (err) {
      return { analysis: null, call: record({ kind: 'analyze', target: url, started, res: err.result, input: { system: ANALYZE_SYSTEM, prompt: content }, error: err.message }) };
    }
  });
}

const Triage = z.object({
  listsEvents: z.boolean().describe('the page itself lists upcoming events, each with a date'),
  reason: z.string().describe('a few words'),
});
const TRIAGE_SYSTEM = `You help a crawler that collects public events (concerts, theatre, cinema, exhibitions, \
markets, festivals, sport, talks, workshops) in Slovakia and nearby. You get the text of one web page. Say \
whether the page itself lists upcoming events, each with its own date (a programme, a calendar, a list of \
events or screenings, one event's own page). It also counts when such a list is only part of the page: a \
homepage section of upcoming events, or an article that is a guide to what's on ("where to go this week") \
with some days still ahead. News articles about one thing, opening hours, archives of past events, \
contacts, shops, real estate, job ads and documents are not. Today is given; past events don't count.`;

/** Quick yes/no: does this page list upcoming events? { listsEvents, reason, call } (listsEvents null: no answer). */
export function triagePage({ url, title, text, today, onStart }) {
  if (!aiAvailable('triage')) return Promise.resolve({ listsEvents: null, call: null });
  const prompt = `URL: ${url}\nTitle: ${title}\nToday: ${today}\n\n<text>\n${text}\n</text>`;
  return oneAtATime({ kind: 'triage', target: url }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt, systemPrompt: TRIAGE_SYSTEM, schema: Triage, maxTurns: 2, model: modelFor('triage') });
      const parsed = Triage.safeParse(res.structured_output);
      const call = record({ kind: 'triage', target: url, started, res, input: { system: TRIAGE_SYSTEM, prompt },
        result: res.structured_output, error: parsed.success ? undefined : 'answer did not match the schema',
        outcome: parsed.success ? `${parsed.data.listsEvents ? 'lists events' : 'no events'}: ${parsed.data.reason}` : undefined });
      return { listsEvents: parsed.success ? parsed.data.listsEvents : null, reason: parsed.data?.reason, call };
    } catch (err) {
      return { listsEvents: null, call: record({ kind: 'triage', target: url, started, res: err.result, input: { system: TRIAGE_SYSTEM, prompt }, error: err.message }) };
    }
  });
}

// The answer's eventListUrls are only used when they are on this site (and only the first few),
// so the AI sees same-site links that could lead to events, best first.
const MAX_LINKS = 100;
function analyzeLinks(url, links) {
  let origin;
  try { origin = new URL(url).origin; } catch { return []; }
  return [...links]
    .filter(([href]) => { try { return new URL(href).origin === origin; } catch { return false; } })
    .map(([href, text]) => [href, text, scoreLink(href, text)])
    .filter(([, , score]) => score >= 0)
    .sort((a, b) => b[2] - a[2])
    .slice(0, MAX_LINKS);
}

const Classified = z.object({
  events: z.array(z.object({
    i: z.number(),
    tags: z.array(Tag),
    city: z.string().nullable().describe('only for events sent without a venue'),
    country: z.string().nullable(),
  })),
});

const CLASSIFY_SYSTEM = `You tag events by kind and, when the venue is missing, say where they happen. Tags: ${TAGS.join(', ')}. \
cinema = a film screening (also film clubs, film festivals). concert = live music. talk = lectures, discussions, \
readings, literature. party = parties, clubs, dancing, quizzes. market = markets, fairs, food and wine tastings. \
Give every tag that fits, usually one or two; give none if nothing fits. Use the page title and venue as hints: \
a film title on a cinema programme is cinema. For an event with no venue, give "city" (and "country") if the \
title, description or page make it clear; otherwise null. Never guess a city.`;

/**
 * Tag events the keyword rules couldn't place, and give a city to events with no location, in one call.
 * `events`: [{ title, location, description, page }].
 * Returns { tags: per event (or null), places: per event { city, country } (or null), call }.
 */
export function classifyEvents(events, { onStart } = {}) {
  if (!aiAvailable('tag') || !events.length) return Promise.resolve({ tags: events.map(() => null), places: events.map(() => null), call: null });
  const lines = events.map((e, i) => JSON.stringify({
    i, title: e.title, venue: e.location, page: e.page, about: e.description?.slice(0, 200),
  }));
  const prompt = `Tag each event. Answer with {"events": [{"i": <number>, "tags": [...]}, …]} for every i.\n\n${lines.join('\n')}`;
  const target = `${events.length} event${events.length === 1 ? '' : 's'}`;
  return oneAtATime({ kind: 'tag', target }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt, systemPrompt: CLASSIFY_SYSTEM, schema: Classified, model: modelFor('tag'), maxTurns: 2 });
      const parsed = Classified.safeParse(res.structured_output);
      const tags = events.map(() => null);
      const places = events.map(() => null);
      if (parsed.success) {
        for (const r of parsed.data.events) {
          if (!(r.i >= 0 && r.i < tags.length)) continue;
          tags[r.i] = r.tags;
          if (r.city && !events[r.i].location) places[r.i] = { city: r.city, country: r.country || undefined };
        }
      }
      const outcome = events.map((e, i) => `${e.title} → ${tags[i] ? (tags[i].join(', ') || 'no tag') : 'no answer'}`
        + (places[i] ? `; in ${[places[i].city, places[i].country].filter(Boolean).join(', ')}` : '')).join('\n');
      const call = record({ kind: 'tag', target, started, res, input: { system: CLASSIFY_SYSTEM, prompt }, result: res.structured_output, outcome,
        error: parsed.success ? undefined : 'answer did not match the schema' });
      return { tags, places, call };
    } catch (err) {
      return { tags: events.map(() => null), places: events.map(() => null), call: record({ kind: 'tag', target, started, res: err.result, input: { system: CLASSIFY_SYSTEM, prompt }, error: err.message }) };
    }
  });
}

const Group = z.number().nullable();
const DateAnswer = {
  start: z.string().nullable().describe('YYYY-MM-DD; null if the text gives no date'),
  end: z.string().nullable().describe('YYYY-MM-DD of the last day if it runs over several days, else null'),
  time: z.string().nullable().describe('HH:MM start, null if none (or only a 00:00 placeholder)'),
  endTime: z.string().nullable().describe('HH:MM end, null if none (or only a 23:59 / 00:00 placeholder)'),
};
const DatesRead = z.object({
  formats: z.array(z.object({
    f: z.number(),
    samples: z.array(z.object({ s: z.number(), ...DateAnswer })),
    rule: z.object({
      pattern: z.string().describe('JavaScript regex source, run on the text exactly as given (lowercase, no diacritics)'),
      groups: z.object({
        startDay: Group, startMonth: Group, startYear: Group, startHour: Group, startMinute: Group,
        endDay: Group, endMonth: Group, endYear: Group, endHour: Group, endMinute: Group,
      }).describe('capture group number for each part, null if the format has no such part'),
    }).nullable().describe('one regex that reads every sample of this format; null if impossible'),
  })),
  prose: z.array(z.object({
    p: z.number(),
    ...DateAnswer,
    schedule: z.array(z.object({ date: z.string(), time: z.string().nullable(), endTime: z.string().nullable() }))
      .describe('one entry per day with its own hours, in order; empty if the text gives no per-day hours'),
  })),
});

const DATES_SYSTEM = `You read event dates for a crawler in Slovakia. Texts are lowercase without diacritics \
(Slovak: piatok = Friday, sobota = Saturday, od/do = from/to, hod = o'clock; 10.00 can be a time). \
For each FORMAT you get a few samples of the same pattern, each with the built-in parser's reading: give each \
sample's start, end, time and endTime. Only if the parser's reading is wrong for some sample, also write ONE \
JavaScript regex (no flags, no lookbehind needed) with numbered capture groups that reads every sample, mapping \
groups to date parts (months may capture a number or a month name); when the parser is right, rule is null. \
Text that holds no event date (a byline, an e-mail, a headline, when an article was posted such as "pred 1 \
tyzdnom") gets start null and rule null. Conventions: a start \
time of 00:00 means no time; an end time of 23:59 means no end time; an end at 00:00 means the event ends \
the day before with no end time; if the year is missing, it is the next upcoming such date from today. \
For each PROSE text (an event description), give the event's first day, last day, start and end time, and \
a per-day schedule when the days have their own hours. Only use what the text says; never guess.`;

/**
 * One call for date formats to check and prose schedules to read.
 * `formats`: [{ samples: [text] }], `prose`: [{ title, text }]. Returns { formats, prose, call }
 * with AI's answers by index (null where it gave none).
 */
export function readDates({ formats = [], prose = [], today }, { onStart } = {}) {
  const none = { formats: formats.map(() => null), prose: prose.map(() => null), call: null };
  if (!aiAvailable('dates') || (!formats.length && !prose.length)) return Promise.resolve(none);
  const lines = [`Today: ${today}`];
  const reading = (r) => (r ? [r.start, r.end && `to ${r.end}`, r.time, r.endTime && `to ${r.endTime}`].filter(Boolean).join(' ') : 'no date');
  formats.forEach((f, i) => lines.push(`FORMAT f=${i}`,
    ...f.samples.map((t, s) => `  s=${s}: ${t}${f.parsed ? `   [parser: ${reading(f.parsed[s])}]` : ''}`)));
  prose.forEach((p, i) => lines.push(`PROSE p=${i} (event "${p.title}")`, `  ${p.text}`));
  const prompt = lines.join('\n');
  const target = [formats.length && `${formats.length} date format${formats.length === 1 ? '' : 's'}`,
    prose.length && `${prose.length} schedule${prose.length === 1 ? '' : 's'}`].filter(Boolean).join(', ');
  return oneAtATime({ kind: 'dates', target }, onStart, async () => {
    const started = Date.now();
    const input = { system: DATES_SYSTEM, prompt };
    try {
      const res = await ask({ prompt, systemPrompt: DATES_SYSTEM, schema: DatesRead, model: modelFor('dates'), maxTurns: 2 });
      const parsed = DatesRead.safeParse(res.structured_output);
      const out = { formats: formats.map(() => null), prose: prose.map(() => null) };
      if (parsed.success) {
        for (const f of parsed.data.formats) if (f.f >= 0 && f.f < formats.length) out.formats[f.f] = f;
        for (const p of parsed.data.prose) if (p.p >= 0 && p.p < prose.length) out.prose[p.p] = p;
      }
      const call = record({ kind: 'dates', target, started, res, input, result: res.structured_output,
        error: parsed.success ? undefined : 'answer did not match the schema' });
      return { ...out, call };
    } catch (err) {
      return { ...none, call: record({ kind: 'dates', target, started, res: err.result, input, error: err.message }) };
    }
  });
}

// Discovery covers Slovakia town by town: each search is one kind of event in one place.
const DISCOVERY_PLACES = [
  'Košice', 'Bratislava', 'Žilina', 'Prešov', 'Banská Bystrica', 'Nitra', 'Trnava', 'Trenčín', 'Poprad', 'Martin',
  'Michalovce', 'Spišská Nová Ves', 'Bardejov', 'Humenné', 'Levice', 'Komárno', 'Piešťany', 'Zvolen', 'Ružomberok',
  'Liptovský Mikuláš', 'Vysoké Tatry', 'Prievidza', 'Lučenec', 'Rožňava', 'Trebišov', 'Nové Zámky', 'Senec', 'Pezinok',
  'Košický kraj', 'Prešovský kraj', 'Žilinský kraj', 'Banskobystrický kraj', 'Nitriansky kraj', 'Trnavský kraj',
  'Trenčiansky kraj', 'Bratislavský kraj', 'Slovensko',
];
const DISCOVERY_KINDS = [
  'podujatia kalendár akcií', 'kultúrne podujatia program', 'koncerty program', 'divadlo program', 'výstavy galéria',
  'festival', 'akcie pre deti', 'trhy jarmok', 'kino program', 'workshop prednáška', 'športové podujatia beh',
  'mestské kultúrne stredisko program', 'kam ísť tento víkend',
];

/** Use web search to find pages that list events in some Slovak town. Returns { urls, call }. */
export function discoverUrls(known = [], { onStart } = {}) {
  if (!aiAvailable('discover')) return Promise.resolve({ urls: [], call: null });
  const pick = (list) => list[Math.floor(Math.random() * list.length)];
  const place = pick(DISCOVERY_PLACES);
  const q = `${place} ${pick(DISCOVERY_KINDS)}`;
  const month = new Date().toLocaleString('sk-SK', { month: 'long', year: 'numeric' });
  const prompt = `Search the web for: "${q}" (it is ${month}). Find web pages that list upcoming events ` +
    `in ${place}, Slovakia: event calendars of the town and its cultural centre, venues (theatres, clubs, galleries, ` +
    `cinemas, museums), shopping centres, tourist boards, ticket shops and community groups. Prefer pages that list ` +
    `many events. Skip these already-known sites: ${known.slice(0, 120).join(', ') || 'none'}. ` +
    `Answer with one URL per line, nothing else.`;
  return oneAtATime({ kind: 'discover', target: q }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt, tools: ['WebSearch'], maxTurns: 8, model: modelFor('discover') });
      const urls = [...new Set(res.result.match(/https?:\/\/[^\s)<>\]"']+/g) || [])];
      return { urls, call: record({ kind: 'discover', target: q, started, res, input: { prompt, tools: ['WebSearch'] }, result: { query: q, urls, answer: res.result } }) };
    } catch (err) {
      return { urls: [], call: record({ kind: 'discover', target: q, started, res: err.result, input: { prompt, tools: ['WebSearch'] }, error: err.message }) };
    }
  });
}

// ---------------------------------------------------------------- usage tracking

let recorder = (rec) => {
  const u = rec.usage;
  console.log(`  [AI ${rec.kind}] ${rec.target}: ${rec.error || `${u.input + u.cacheRead + u.cacheWrite} in / ${u.output} out tokens`}`);
};
/** Receive every AI call record (the server stores them for the dashboard). */
export function setAiRecorder(fn) { recorder = fn; }

let seq = 0;
/**
 * Store one AI call. `outcome` is a plain-words line of what came of it ("recipe saved, finds 19
 * events"); callers may fill it in later on the returned record, once they know.
 */
function record({ kind, target, started, res, input, result, error, outcome }) {
  const inputChars = input ? (input.system?.length || 0) + input.prompt.length : undefined;
  // modelUsage covers every model call the request made (it can use more than one model).
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0, costUsd: res?.total_cost_usd || 0 };
  for (const m of Object.values(res?.modelUsage || {})) {
    usage.input += m.inputTokens;
    usage.output += m.outputTokens;
    usage.cacheRead += m.cacheReadInputTokens;
    usage.cacheWrite += m.cacheCreationInputTokens;
    usage.webSearches += m.webSearchRequests;
  }
  const rec = {
    id: `${Date.now().toString(36)}-${(seq++).toString(36)}`,
    at: new Date(started).toISOString(),
    ms: Date.now() - started,
    kind, target, inputChars, usage,
    model: Object.keys(res?.modelUsage || {}).join(', ') || config.jobs[kind]?.model || 'default',
    job: AI_JOBS[kind]?.label,
    outcome,
    turns: res?.num_turns,
    stopReason: res?.stop_reason,
    ok: !error,
    error,
    result,
  };
  if (input) saveInput(rec.id, input);
  recorder(rec);
  return rec;
}

// What each call was sent (instructions + page), for the admin panel's call details. A page can be
// ~60 KB, so these live in their own files and only the newest MAX_INPUTS are kept.
const INPUT_DIR = path.join(DATA_DIR, 'ai-inputs');
const MAX_INPUTS = 300;
function saveInput(id, input) {
  try {
    fs.mkdirSync(INPUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(INPUT_DIR, `${id}.json`), JSON.stringify(input));
    const files = fs.readdirSync(INPUT_DIR).sort(); // ids start with a base-36 timestamp: oldest first
    for (const f of files.slice(0, Math.max(0, files.length - MAX_INPUTS))) fs.rmSync(path.join(INPUT_DIR, f));
  } catch {
    // Details are a convenience; never fail a crawl over them.
  }
}

/** The input of one call, if it's still kept. */
export function aiInput(id) {
  if (!/^[\w-]+$/.test(id)) return undefined;
  try { return JSON.parse(fs.readFileSync(path.join(INPUT_DIR, `${id}.json`), 'utf8')); } catch { return undefined; }
}
