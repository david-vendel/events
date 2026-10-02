// Events and their "net of sources". An event is seen in one or more places (sightings):
// the site we found it on, its detail page, the Facebook event it links to, another site
// that lists the same thing… Each sighting keeps its own date so the UI can show whether
// sources agree. sources[0] is the primary source; the event's top-level fields mirror it.
import { eventId, facebookEvent } from './extract.js';
import { findSameEvent } from './match.js';

const iso = () => new Date().toISOString();

/** Stable key for a sighting row: its URL, or listing URL + event id when it has no own page. */
export function rowKey(s) {
  const fb = facebookEvent(s.url);
  if (fb && fb !== 'short') return `fb:${fb}`;
  return s.url && s.url !== s.via ? s.url : `${s.via || s.url}#${eventId(s.title, s.start)}`;
}

export function siteOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

const PRIMARY_FIELDS = ['title', 'start', 'end', 'time', 'location', 'description', 'url'];

function syncFromPrimary(ev) {
  const p = ev.sources[0];
  for (const f of PRIMARY_FIELDS) if (p[f] !== undefined) ev[f] = p[f];
  ev.source = p.via || p.url;
}

/** Older data had no sources[]; give every event one row built from its own fields. */
export function migrate(state) {
  for (const ev of Object.values(state.events)) {
    if (ev.sources) continue;
    ev.sources = [{
      kind: 'web', site: siteOf(ev.url), url: ev.url, via: ev.source,
      title: ev.title, start: ev.start, end: ev.end, time: ev.time, location: ev.location,
      description: ev.description, status: 'ok', seenAt: ev.lastSeenAt,
    }];
  }
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
    return this.byKey.get(rowKey(s)) || this.byId.get(eventId(s.title, s.start))
      || findSameEvent(Object.values(this.state.events), s);
  }

  /**
   * Record a sighting. `linkedTo` attaches it to a known event without matching (used for
   * pages the event itself links to). Returns { event, isNew }.
   */
  add(s, linkedTo = null) {
    s = { ...s, site: siteOf(s.url), seenAt: iso() };
    let ev = linkedTo || this.find(s);
    if (!ev) {
      const id = eventId(s.title, s.start);
      ev = this.state.events[id] = { id, sources: [s], firstSeenAt: iso(), lastSeenAt: iso() };
      syncFromPrimary(ev);
      this.#indexEvent(ev);
      return { event: ev, isNew: true };
    }
    const key = rowKey(s);
    const i = ev.sources.findIndex((r) => rowKey(r) === key);
    if (i >= 0) ev.sources[i] = { ...ev.sources[i], ...s };
    else ev.sources.push(s);
    if (i === 0) syncFromPrimary(ev);
    ev.lastSeenAt = iso();

    // The same row (e.g. one Facebook event) already belongs to a different event:
    // both are the same thing, found in two separate places. Merge into the older one.
    const other = this.byKey.get(key);
    if (other && other !== ev && this.state.events[other.id]) {
      return { event: this.merge(other, ev), isNew: false };
    }
    this.byKey.set(key, ev);
    return { event: ev, isNew: false };
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
    delete this.state.events[b.id];
    console.log(`  ⇄ merged "${b.title}" (${b.sources[0]?.site}) into "${a.title}" (${a.sources[0]?.site})`);
    return a;
  }
}
