// Events and their "net of sources". An event is seen in one or more places (sightings):
// the site we found it on, its detail page, the Facebook event it links to, another site
// that lists the same thing… Each sighting keeps its own date so the UI can show whether
// sources agree. sources[0] is the primary source; the event's top-level fields mirror it.
import { cleanLocation, eventId, facebookEvent } from './extract.js';
import { couldBeSame, dateDistance, differentTowns, findSameEvent, titleSimilarity } from './match.js';
import { finishDate, tooFarAhead } from './dates.js';
import { eventTags } from './tags.js';
import { knownTown } from './geo.js';

const iso = () => new Date().toISOString();

/** Stable key for a sighting row: its URL, or listing URL + event id when it has no own page. */
export function rowKey(s) {
  const fb = facebookEvent(s.url);
  if (fb && fb !== 'short') return `fb:${fb}`;
  return s.url && s.url !== s.via ? s.url : `${s.via || s.url}#${eventId(s.title, s.start)}`;
}

/**
 * A new event's id: from its title and start, unless an event of the same title and day already has
 * that id (the same film in another town): then its town, and if need be a number, tell them apart.
 */
function newEventId(state, s) {
  let id = eventId(s.title, s.start);
  for (let n = 1; state.events[id]; n++) id = eventId(s.title, `${s.start}|${knownTown(s.location) || ''}|${n}`);
  return id;
}

export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const PRIMARY_FIELDS = ['title', 'start', 'location', 'description', 'url'];
// Copied even when missing, so a corrected reading ("all day", no end) replaces a wrong one.
const WHEN_FIELDS = ['end', 'time', 'endTime'];

/** Rows of the primary's site with the primary's title on other days: days of one run. */
export const runRows = (ev) => {
  const p = ev.sources[0];
  return ev.sources.filter((r) => r === p
    || (!r.linked && r.start && r.site === p.site && titleSimilarity(r.title, p.title) >= 0.85 && !differentTowns(r, p)));
};

function syncFromPrimary(ev, rules) {
  const p = ev.sources[0];
  for (const f of PRIMARY_FIELDS) if (p[f] !== undefined) ev[f] = p[f];
  for (const f of WHEN_FIELDS) if (p[f] !== undefined) ev[f] = p[f]; else delete ev[f];
  // A run listed day by day spans all its days.
  const run = runRows(ev);
  if (run.length > 1) {
    const first = run.reduce((d, r) => (r.start < d ? r.start : d), ev.start);
    const last = run.reduce((d, r) => ((r.end || r.start) > d ? r.end || r.start : d), ev.end || ev.start);
    ev.start = first;
    if (last > first) ev.end = last;
  }
  // The range the detail page states under its heading ("03.10.2026 – 31.10.2026").
  if (ev.pageRange?.end > (ev.end || ev.start)) ev.end = ev.pageRange.end;
  // A per-day schedule read from the detail page's text (by AI) fills in what the listing left out.
  const sch = ev.schedule;
  if (sch?.length) {
    const last = sch[sch.length - 1].date;
    if (last > (ev.end || ev.start)) ev.end = last;
    if (!ev.time && sch[0].date === ev.start && sch[0].time) {
      ev.time = sch[0].time;
      if (sch[0].endTime) ev.endTime = sch[0].endTime;
    }
  }
  ev.source = p.via || p.url;
  ev.tags = eventTags(ev, rules);
}

/** Older data had no sources[] or tags; fill them in. Tags are recomputed as the rules improve. */
export function migrate(state) {
  // Sites judged "irrelevant" back when only Košice events counted get judged again.
  for (const s of Object.values(state.sources)) {
    if (s.kind === 'irrelevant' && s.judgedFor !== 'any place') s.kind = 'unknown';
    delete s.kosiceOnly;
  }
  for (const ev of Object.values(state.events)) {
    ev.sources ??= [{
      kind: 'web', site: siteOf(ev.url), url: ev.url, via: ev.source,
      title: ev.title, start: ev.start, end: ev.end, time: ev.time, endTime: ev.endTime, location: ev.location,
      description: ev.description, status: 'ok', seenAt: ev.lastSeenAt,
    }];
    tidyRows(ev);
    if (!ev.sources.some((r) => !r.linked) || tooFarAhead(ev.start)) delete state.events[ev.id];
  }
  for (const ev of Object.values(state.events)) splitUnrelated(state, ev);
  for (const ev of Object.values(state.events)) syncFromPrimary(ev, state.tagRules);
  joinRuns(state);
}

/**
 * Days of one run that were stored as separate events (listed day by day, they used to be
 * grouped only within 3 days of the first): same site, same title, back to back. Joined into
 * the earliest.
 */
function joinRuns(state) {
  const byRun = new Map();
  for (const ev of Object.values(state.events)) {
    const key = `${ev.sources[0].site}|${ev.title.trim().toLowerCase()}|${knownTown(ev.location) || ''}`;
    byRun.set(key, [...(byRun.get(key) || []), ev]);
  }
  for (const evs of byRun.values()) {
    if (evs.length < 2) continue;
    evs.sort((a, b) => a.start.localeCompare(b.start));
    let run = evs[0];
    for (const ev of evs.slice(1)) {
      if (dateDistance(run, ev) > 1) { run = ev; continue; }
      for (const s of ev.sources) if (!run.sources.some((r) => rowKey(r) === rowKey(s))) run.sources.push(s);
      run.aliases = [...new Set([...(run.aliases || []), ev.id, ...(ev.aliases || [])])];
      if (ev.firstSeenAt < run.firstSeenAt) run.firstSeenAt = ev.firstSeenAt;
      delete state.events[ev.id];
      syncFromPrimary(run, state.tagRules);
    }
  }
}

/**
 * Rows read before a fix get the fix: dates go through today's rules (placeholder ends, overnight
 * events); linked pages that never confirmed the event are dropped (and not fetched again), and so
 * are rows read with the wrong text encoding (the listing gives them again, readable).
 */
function tidyRows(ev) {
  ev.sources = ev.sources.filter((r) => {
    if (/\uFFFD/.test(r.title || '')) return false;
    if (r.linked && r.kind === 'web' && r.status !== 'ok') {
      if (r.status === 'no_date') ev.unconfirmed = [...new Set([...(ev.unconfirmed || []), r.url])].slice(-20);
      return false;
    }
    return true;
  });
  const first = ev.sources.findIndex((r) => !r.linked); // the primary must be a listing row
  if (first > 0) ev.sources.unshift(...ev.sources.splice(first, 1));
  for (const r of ev.sources) {
    if (r.location) r.location = cleanLocation(r.location) || undefined;
    if (!r.start) continue;
    const d = finishDate(r);
    for (const k of ['end', 'time', 'endTime']) if (d[k] === undefined) delete r[k]; else r[k] = d[k];
  }
}

/** Would matching put these two rows in one event today? (See findSameEvent.) */
const sameEventRows = (a, b) => titleSimilarity(a.title, b.title) >= 0.5 && !differentTowns(a, b)
  && (!a.start || !b.start || dateDistance(a, b) <= (a.site === b.site ? 1 : 3));

/**
 * Undo merges that matching no longer makes: through a URL that different events share (rows whose
 * titles have nothing in common), of one title in different towns (a film's screenings all over
 * Slovakia), and of one site's dates further apart than a run (a weekly screening). Rows are grouped
 * the way matching joins them; each group becomes an event. A linked row goes with the event whose
 * detail page linked to it.
 */
function splitUnrelated(state, ev) {
  const rows = ev.sources.filter((r) => !r.linked);
  const group = rows.map((_, i) => i);
  const town = rows.map((r) => knownTown(r.location)); // per group, once known
  const root = (i) => (group[i] === i ? i : (group[i] = root(group[i])));
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = root(i), b = root(j);
      // a row whose town isn't known must not bridge two towns
      if (a === b || (town[a] && town[b] && town[a] !== town[b]) || !sameEventRows(rows[i], rows[j])) continue;
      group[b] = a;
      town[a] ??= town[b];
    }
  }
  const byRoot = new Map();
  rows.forEach((r, i) => byRoot.set(root(i), [...(byRoot.get(root(i)) || []), r]));
  const groups = [...byRoot.values()]; // the primary's group first: rows[0] is the primary
  if (groups.length < 2) return;
  const urls = groups.map((g) => new Set(g.map((r) => r.url)));
  for (const r of ev.sources.filter((x) => x.linked)) {
    const i = urls.findIndex((u) => u.has(r.via));
    if (i >= 0) groups[i].push(r);
  }
  ev.sources = groups[0];
  const split = [];
  for (const rows of groups.slice(1)) {
    const same = state.events[eventId(rows[0].title, rows[0].start)];
    if (same && same !== ev && couldBeSame(same, rows[0])) {
      for (const r of rows) if (!same.sources.some((x) => rowKey(x) === rowKey(r))) same.sources.push(r);
      split.push(same.id);
      continue;
    }
    const id = newEventId(state, rows[0]);
    state.events[id] = { id, sources: rows, firstSeenAt: ev.firstSeenAt, lastSeenAt: ev.lastSeenAt };
    split.push(id);
  }
  if (ev.aliases) ev.aliases = ev.aliases.filter((a) => !split.includes(a));
  console.log(`  ⇆ split "${ev.title}" from ${split.length} unrelated event(s)`);
}

/** Lookup structure over state.events, rebuilt once per cycle and kept up to date. */
export class EventIndex {
  constructor(state) {
    this.state = state;
    this.byId = new Map(); // event id or alias -> event
    this.byKey = new Map(); // sighting row key -> event
    for (const ev of Object.values(state.events)) this.#indexEvent(ev);
  }

  #indexEvent(ev) {
    this.byId.set(ev.id, ev);
    for (const a of ev.aliases || []) this.byId.set(a, ev);
    for (const s of ev.sources || []) this.byKey.set(rowKey(s), ev);
  }

  find(s) {
    // The same row seen again, unless it's a URL that several events share (a film's page, for
    // its screenings in every town).
    const known = this.byKey.get(rowKey(s));
    if (known && titleSimilarity(known.title, s.title) >= 0.5 && !differentTowns(known, s)) return known;
    const same = this.byId.get(eventId(s.title, s.start));
    if (same && !differentTowns(same, s)) return same;
    return findSameEvent(Object.values(this.state.events), s);
  }

  /**
   * Record a sighting. `linkedTo` attaches it to a known event without matching (used for
   * pages the event itself links to). Returns { event, isNew }.
   */
  add(s, linkedTo = null) {
    s = { ...s, site: siteOf(s.url), seenAt: iso() };
    let ev = linkedTo || this.find(s);
    if (!ev) {
      const id = newEventId(this.state, s);
      ev = this.state.events[id] = { id, sources: [s], firstSeenAt: iso(), lastSeenAt: iso() };
      syncFromPrimary(ev, this.state.tagRules);
      this.#indexEvent(ev);
      return { event: ev, isNew: true };
    }
    const key = rowKey(s);
    const i = ev.sources.findIndex((r) => rowKey(r) === key);
    if (i >= 0) ev.sources[i] = { ...ev.sources[i], ...s };
    else ev.sources.push(s);
    syncFromPrimary(ev, this.state.tagRules);
    ev.lastSeenAt = iso();

    // The same row (e.g. one Facebook event) already belongs to a different event:
    // both are the same thing, found in two separate places. Merge into the older one.
    const other = this.byKey.get(key);
    if (other && other !== ev && this.state.events[other.id]) {
      if (couldBeSame(other, ev)) return { event: this.merge(other, ev), isNew: false };
      return { event: ev, isNew: false }; // a URL shared by different events: the row stays in both
    }
    this.byKey.set(key, ev);
    return { event: ev, isNew: false };
  }

  /** Take an event's fields from its primary source again (after its rows were changed in place). */
  refresh(ev) {
    syncFromPrimary(ev, this.state.tagRules);
  }

  /** Move b's sources into a and delete b. */
  merge(a, b) {
    if (a === b) return a;
    for (const s of b.sources) {
      const key = rowKey(s);
      if (!a.sources.some((r) => rowKey(r) === key)) a.sources.push(s);
      this.byKey.set(key, a);
    }
    a.aliases = [...new Set([...(a.aliases || []), b.id, ...(b.aliases || [])])];
    for (const id of a.aliases) this.byId.set(id, a);
    a.firstSeenAt = a.firstSeenAt < b.firstSeenAt ? a.firstSeenAt : b.firstSeenAt;
    a.tags = eventTags(a, this.state.tagRules);
    delete this.state.events[b.id];
    console.log(`  ⇄ merged "${b.title}" (${b.sources[0]?.site}) into "${a.title}" (${a.sources[0]?.site})`);
    return a;
  }
}
