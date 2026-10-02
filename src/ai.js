// The only place that talks to Claude. Used sparingly:
//  - analyzePage(): first look at a promising page -> what the site is, and a CSS "recipe" so
//    future visits are parsed with zero AI;
//  - discoverUrls(): occasional web search for new Košice event sources.
// Calls go through the Claude Agent SDK, which runs on your Claude Code login, so they count
// against your Claude subscription's usage limits instead of being billed per token. Usage is
// shared with your own Claude Code use. EVENTS_AI=off disables AI; the crawler then runs on
// heuristics only.
import { query } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

const MODEL = process.env.EVENTS_AI_MODEL || undefined; // undefined = your Claude Code default model

export function aiAvailable() {
  return process.env.EVENTS_AI !== 'off';
}

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

const Analysis = z.object({
  siteKind: z.enum(['event_listing', 'venue', 'municipality', 'tourism', 'news', 'ticketing', 'shopping_center', 'other']),
  summary: z.string().describe('one sentence: what this website is'),
  publishesKosiceEvents: z.boolean().describe('does this site regularly publish events taking place in or near Košice?'),
  listingIsKosiceOnly: z.boolean().describe('are all events on this page in Košice (vs. a national/multi-city list)?'),
  pageListsEvents: z.boolean().describe('does THIS page contain a list of multiple events?'),
  recipe: Recipe.nullable().describe('null if this page has no repeated event elements'),
  eventListUrls: z.array(z.string()).describe('other URLs on this site (from the given link list) that likely list events'),
  checkEveryHours: z.number().describe('how often to re-check this source, 12-168'),
  events: z.array(z.object({
    title: z.string(),
    start: z.string().describe('YYYY-MM-DD'),
    end: z.string().nullable(),
    time: z.string().nullable().describe('HH:MM'),
    location: z.string().nullable(),
    url: z.string().nullable(),
  })).describe('upcoming Košice events on this page ONLY when recipe is null (e.g. events written as prose)'),
});

const ANALYZE_SYSTEM = `You help a crawler that collects events (concerts, markets, festivals, exhibitions, sport, \
workshops, kids' programs…) happening in Košice, Slovakia. You get one web page as simplified HTML \
(scripts/images/most attributes removed) plus a list of its links. Classify the site and, if the page lists \
events, write CSS selectors (cheerio-compatible, no :contains, no positional selectors that depend on the \
specific events) so the crawler can parse future versions of this page without you. Prefer stable class \
names over auto-generated ones. Only list eventListUrls that appear in the given links.`;

// Claude Code's schema validator doesn't accept zod's "$schema" draft header; the rest is fine.
function jsonSchema(schema) {
  const { $schema, ...rest } = z.toJSONSchema(schema);
  return rest;
}

/**
 * One isolated, single-purpose Claude call: no Claude Code tools unless listed, none of your
 * settings/CLAUDE.md/hooks, and no saved session. Returns the final result message.
 */
async function ask({ prompt, systemPrompt, schema, tools = [], maxTurns = 2 }) {
  // Use the subscription login, never a stray API key from the environment (that would bill it).
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  let result;
  for await (const msg of query({
    prompt,
    options: {
      model: MODEL,
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
  if (!aiAvailable()) return Promise.resolve({ analysis: null, call: null });
  const linkList = [...links].slice(0, 300).map(([href, text]) => `${href} ${text}`).join('\n');
  const content = `URL: ${url}\nTitle: ${title}\nToday: ${today}\n` +
    (truncated ? 'Note: HTML was cut off at the size limit.\n' : '') +
    `\n<links>\n${linkList}\n</links>\n\n<html>\n${html}\n</html>`;
  return oneAtATime({ kind: 'analyze', target: url }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt: content, systemPrompt: ANALYZE_SYSTEM, schema: Analysis, maxTurns: 3 });
      const parsed = Analysis.safeParse(res.structured_output);
      const call = record({ kind: 'analyze', target: url, started, res, inputChars: content.length, result: res.structured_output,
        error: parsed.success ? undefined : 'answer did not match the schema' });
      return { analysis: parsed.success ? parsed.data : null, call };
    } catch (err) {
      return { analysis: null, call: record({ kind: 'analyze', target: url, started, res: err.result, inputChars: content.length, error: err.message }) };
    }
  });
}

const DISCOVERY_QUERIES = [
  'Košice podujatia tento víkend',
  'Košice kalendár akcií',
  'Košice farmársky trh',
  'Košice koncerty program',
  'Košice výstavy galérie program',
  'Košice festival 2026',
  'Košice divadlo program',
  'Košice akcie pre deti',
  'Košice jarmok trh',
  'Košice workshop prednáška',
  'Košice nákupné centrum podujatia',
  'Košice mestská časť kultúrne podujatia',
  'events in Košice this month',
];

/** Use web search to find pages that list Košice events. Returns { urls, call }. */
export function discoverUrls(known = [], { onStart } = {}) {
  if (!aiAvailable()) return Promise.resolve({ urls: [], call: null });
  const q = DISCOVERY_QUERIES[Math.floor(Math.random() * DISCOVERY_QUERIES.length)];
  const month = new Date().toLocaleString('sk-SK', { month: 'long', year: 'numeric' });
  const prompt = `Search the web for: "${q}" (it is ${month}). Find web pages that list upcoming events ` +
    `in Košice, Slovakia — especially smaller sources (venues, shopping centers, city districts, ` +
    `community groups, markets). Skip these already-known sites: ${known.slice(0, 80).join(', ') || 'none'}. ` +
    `Answer with one URL per line, nothing else.`;
  return oneAtATime({ kind: 'discover', target: q }, onStart, async () => {
    const started = Date.now();
    try {
      const res = await ask({ prompt, tools: ['WebSearch'], maxTurns: 6 });
      const urls = [...new Set(res.result.match(/https?:\/\/[^\s)<>\]"']+/g) || [])];
      return { urls, call: record({ kind: 'discover', target: q, started, res, result: { query: q, urls } }) };
    } catch (err) {
      return { urls: [], call: record({ kind: 'discover', target: q, started, res: err.result, error: err.message }) };
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
function record({ kind, target, started, res, inputChars, result, error }) {
  // modelUsage covers every model call the request made (it can use more than one model).
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, webSearches: 0 };
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
    model: Object.keys(res?.modelUsage || {}).join(', ') || MODEL || 'default',
    turns: res?.num_turns,
    stopReason: res?.stop_reason,
    ok: !error,
    error,
    result,
  };
  recorder(rec);
  return rec;
}
