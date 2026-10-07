// How much of what's on we probably have, per town and kind of event: a capture-recapture estimate.
//
// Every site that lists events is a separate "catch". An upcoming event found on two or more sites
// independently has been "recaptured"; one found on only one site has not. If most events in a group
// turn up on several sites, a new site would mostly bring events we already have: the group is
// covered. If most were seen only once, there are likely many more that no site we know lists.
// Chao1 turns that into a number: estimated total = seen + f1² / (2·f2), where f1 = events on
// exactly one site and f2 = on exactly two. Sites aren't equally likely to list an event (a club's
// own page lists only its own shows), so the estimate is a lower bound on the total and the coverage
// an upper bound: a low figure is a sure gap, a high one is likely but not certain.
//
// Used to aim the AI web search (discovery) at the weakest places and kinds, and to search less
// often when everything known is well covered. Crawling itself isn't throttled by this: fetching
// pages costs nothing but time, AI calls cost money.
import { townOf } from './events.js';

const MIN_EVENTS = 8; // fewer upcoming events than this: too few to estimate anything
const RECENT = 7 * 864e5;

/** Independent listings of an event: the distinct sites it was found on (not pages it links to). */
export const listingSites = (ev) => new Set(ev.sources.filter((r) => !r.linked && r.site).map((r) => r.site));

// Estimated total, from events seen (s), seen on one site (f1) and on two (f2).
export function chao1(s, f1, f2) {
  return f2 > 0 ? s + (f1 * f1) / (2 * f2) : s + (f1 * (f1 - 1)) / 2;
}

function summarize(key, evs, now) {
  const counts = evs.map((ev) => listingSites(ev).size || 1);
  const f1 = counts.filter((n) => n === 1).length;
  const f2 = counts.filter((n) => n === 2).length;
  const sites = new Set(evs.flatMap((ev) => [...listingSites(ev)]));
  const estimate = Math.max(evs.length, Math.round(chao1(evs.length, f1, f2)));
  const enough = evs.length >= MIN_EVENTS;
  return {
    ...key,
    events: evs.length,
    once: f1,
    twice: f2,
    more: evs.length - f1 - f2,
    sites: sites.size,
    estimate: enough ? estimate : undefined,
    coverage: enough ? evs.length / estimate : undefined,
    newLastWeek: evs.filter((ev) => now - Date.parse(ev.firstSeenAt || 0) < RECENT).length,
  };
}

/**
 * Coverage of upcoming events: overall, per town, per kind, and per town × kind.
 * { overall, towns: [...], tags: [...], cells: [...] }, each row a summary (see summarize).
 */
export function coverageReport(state, today = new Date().toISOString().slice(0, 10), now = Date.now()) {
  const upcoming = Object.values(state.events).filter((e) => (e.end || e.start) >= today && e.sources?.length);
  const towns = new Map(), tags = new Map(), cells = new Map();
  const push = (m, k, ev) => m.set(k, [...(m.get(k) || []), ev]);
  for (const ev of upcoming) {
    const town = townOf(state, ev) || '?';
    push(towns, town, ev);
    for (const tag of ev.tags?.length ? ev.tags : ['other']) {
      push(tags, tag, ev);
      push(cells, `${town}|${tag}`, ev);
    }
  }
  const rows = (m, keyOf) => [...m].map(([k, evs]) => summarize(keyOf(k), evs, now)).sort((a, b) => b.events - a.events);
  return {
    overall: summarize({}, upcoming, now),
    towns: rows(towns, (town) => ({ town })),
    tags: rows(tags, (tag) => ({ tag })),
    cells: rows(cells, (k) => { const [town, tag] = k.split('|'); return { town, tag }; }),
  };
}

// ---------------------------------------------------------------- aiming the discovery search

// Discovery covers Slovakia town by town: each search is one kind of event in one place. Regions
// and the whole country catch what town searches miss (festivals, sport, tours).
export const DISCOVERY_TOWNS = [
  'Košice', 'Bratislava', 'Žilina', 'Prešov', 'Banská Bystrica', 'Nitra', 'Trnava', 'Trenčín', 'Poprad', 'Martin',
  'Michalovce', 'Spišská Nová Ves', 'Bardejov', 'Humenné', 'Levice', 'Komárno', 'Piešťany', 'Zvolen', 'Ružomberok',
  'Liptovský Mikuláš', 'Vysoké Tatry', 'Prievidza', 'Lučenec', 'Rožňava', 'Trebišov', 'Nové Zámky', 'Senec', 'Pezinok',
];
const DISCOVERY_REGIONS = [
  'Košický kraj', 'Prešovský kraj', 'Žilinský kraj', 'Banskobystrický kraj', 'Nitriansky kraj', 'Trnavský kraj',
  'Trenčiansky kraj', 'Bratislavský kraj', 'Slovensko',
];
// What to search for, per kind of event (null: events of every kind).
const KIND_QUERY = {
  null: 'podujatia kalendár akcií program', concert: 'koncerty program', theatre: 'divadlo program',
  exhibition: 'výstavy galéria múzeum', festival: 'festival', kids: 'akcie pre deti', sport: 'športové podujatia beh',
  workshop: 'workshop kurz tvorivá dielňa', talk: 'prednáška beseda', party: 'párty klub program',
  market: 'trhy jarmok', cinema: 'kino program',
};
const KINDS = Object.keys(KIND_QUERY).map((k) => (k === 'null' ? null : k));
const RETRY_AFTER = 7 * 864e5; // the same search again at the earliest, doubled after each that found nothing
const JUDGE_AFTER = 2 * 864e5; // a search's links have been explored by then (they're queued high)
const MAX_HISTORY = 300;

const targetKey = (t) => `${t.place}|${t.tag || ''}`;

/** Did an earlier search pay off? 'yes' (a new event source), 'no', or 'pending' (too early to say). */
export function searchResult(state, d, now = Date.now()) {
  if ((d.origins || []).some((o) => state.sources[o]?.kind === 'events')) return 'yes';
  return now - Date.parse(d.at) < JUDGE_AFTER ? 'pending' : 'no';
}

/**
 * Candidate searches, best first: { place, tag, query, score, why }. The score is how big the gap
 * is (1 - coverage; a town or kind with too few events to judge counts as a big gap) times how big
 * the place is (earlier in DISCOVERY_TOWNS = bigger). Searches done lately are skipped, for longer
 * each time one found no new event source, so a gap no search can fill stops costing AI calls.
 */
export function discoveryTargets(state, report = coverageReport(state), now = Date.now()) {
  const cell = new Map(report.cells.map((c) => [`${c.town}|${c.tag}`, c]));
  const town = new Map(report.towns.map((t) => [t.town, t]));
  const tag = new Map(report.tags.map((t) => [t.tag, t]));
  const past = new Map(); // target -> its searches, oldest first
  for (const d of state.meta.discoveries || []) past.set(targetKey(d), [...(past.get(targetKey(d)) || []), d]);

  const gapOf = (row) => (row?.coverage === undefined ? 0.9 : 1 - row.coverage);
  const describe = (row, what) => (row?.coverage === undefined
    ? `${what}: ${row?.events || 0} upcoming events, too few to judge`
    : `${what}: ${row.events} events, about ${Math.round(row.coverage * 100)} % covered (${row.once} seen on one site only)`);
  const out = [];
  const consider = (place, t, size, row, what) => {
    const searches = past.get(targetKey({ place, tag: t })) || [];
    const last = searches[searches.length - 1];
    let fruitless = 0;
    for (const d of searches) fruitless = searchResult(state, d, now) === 'no' ? fruitless + 1 : 0;
    const wait = RETRY_AFTER * 2 ** Math.min(fruitless, 3);
    if (last && now - Date.parse(last.at) < wait) return;
    out.push({ place, tag: t, query: `${place} ${KIND_QUERY[t]}`, score: gapOf(row) * size, why: describe(row, what), fruitless });
  };
  DISCOVERY_TOWNS.forEach((place, i) => {
    const size = 1 / Math.sqrt(i + 1);
    for (const t of KINDS) {
      consider(place, t, size, t ? cell.get(`${place}|${t}`) : town.get(place), t ? `${t} in ${place}` : place);
    }
  });
  // Regions and the whole country: one kind everywhere, for kinds that are poorly covered overall.
  for (const place of DISCOVERY_REGIONS) {
    for (const t of KINDS) if (t) consider(place, t, 0.3, tag.get(t), `${t} overall`);
  }
  return out.sort((a, b) => b.score - a.score);
}

/** The next search: a weighted pick among the best few, so close candidates take turns. */
export function pickDiscoveryTarget(state, report) {
  const top = discoveryTargets(state, report).slice(0, 5);
  if (!top.length) return null;
  let r = Math.random() * top.reduce((t, c) => t + c.score, 0);
  return top.find((c) => (r -= c.score) <= 0) || top[0];
}

/** Hours until the next discovery search: less often once everything known is well covered. */
export function discoveryEveryHours(report, base = 6) {
  const c = report.overall.coverage;
  return c !== undefined && c >= 0.8 ? base * 4 : base;
}

/** Remember a search, with the sites of the links it queued (to judge later whether it paid off). */
export function noteDiscovery(state, target, urls, queued) {
  // Only sites that weren't event sources yet: finding a known one again is no payoff.
  const origins = [...new Set(urls.map((u) => { try { return new URL(u).origin; } catch { return null; } }).filter(Boolean))]
    .filter((o) => state.sources[o]?.kind !== 'events');
  const list = (state.meta.discoveries ??= []);
  list.push({ at: new Date().toISOString(), place: target.place, tag: target.tag, query: target.query, why: target.why,
    urls: urls.length, queued, origins });
  if (list.length > MAX_HISTORY) list.splice(0, list.length - MAX_HISTORY);
}
