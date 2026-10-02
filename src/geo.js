// Where each event takes place, as coordinates for a map. Any place in the world; `km` is the
// distance from Košice, where the project started.
// Event locations are free text ("CINEMAX, Moldavská cesta 32., OC OPTIMA, Košice 04011"). We split
// them into venue name / street / postcode / city, and every distinct place is looked up once and
// cached in state.venues (data/venues.json). Where coordinates come from, best first:
//   1. the event page itself (schema.org Place.geo),
//   2. the venue cache, filled by OpenStreetMap's Nominatim geocoder: the street address, else
//      the venue name, else the city centre (precision "city", so a map can treat it as rough).
// Nominatim's usage policy: at most 1 request per second, an identifying User-Agent, and cache
// results. We send a few dozen requests per cycle at most, and every answer (also "not found") is
// cached. Set a venue's status to "manual" in data/venues.json to pin coordinates by hand.
// EVENTS_GEOCODER=off disables lookups.

const NOMINATIM = process.env.EVENTS_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'KosiceEventsBot/0.1 (+https://github.com/david-vendel/events)';
const KOSICE = { lat: 48.7164, lon: 21.2611 };
const RETRY_NOT_FOUND = 30 * 864e5;
const MIN_GAP_MS = 1100;

export const geocoderEnabled = () => process.env.EVENTS_GEOCODER !== 'off';

const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const h = Math.sin(rad(b.lat - a.lat) / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(rad(b.lon - a.lon) / 2) ** 2;
  return Math.round(2 * 6371 * Math.asin(Math.sqrt(h)) * 10) / 10;
}

const STREET = /^\p{L}[\p{L}\s.'-]*?\s\d+[a-z]?(\/\d+[a-z]?)?\.?$/iu;
const POSTCODE = /\b(\d{3})\s?(\d{2})\b/;

/**
 * Split a location string: { name, street, postcode, city }. `cityHint` (the city the source site
 * covers, when known) fills in a missing city.
 */
export function parseLocation(text, cityHint) {
  const parts = (text || '').split(/\s*[,|;]\s*/).map((p) => p.trim()).filter(Boolean);
  let name, street, postcode, city;
  const rest = [];
  for (let p of parts) {
    const pc = p.match(POSTCODE);
    if (pc) {
      postcode ??= `${pc[1]} ${pc[2]}`;
      p = p.replace(POSTCODE, '').trim();
      if (!p) continue;
    }
    if (!street && STREET.test(p)) street = p.replace(/\.$/, '');
    else if (STREET.test(p)) continue; // a second address (e.g. a building with two entrances)
    else rest.push({ p, afterStreet: Boolean(street) });
  }
  // The city is the last plain part after the street (or the last part, when there's no street).
  const cityPart = [...rest].reverse().find((r) => r.afterStreet || !street);
  if (cityPart && (rest.length > 1 || street)) {
    city = /kosic/.test(fold(cityPart.p)) ? 'Košice' : cityPart.p;
    rest.splice(rest.indexOf(cityPart), 1);
  }
  name = rest.find((r) => !r.afterStreet)?.p;
  if (!name && !street && !city && rest.length) name = rest[0].p;
  // A location that is just one word or name with no street ("Košice", "Bratislava") is a city.
  if (name && !street && !postcode && parts.length === 1) { city = /^kosice$/.test(fold(name)) ? 'Košice' : name; name = undefined; }
  return { name, street, postcode, city: city || cityHint || undefined };
}

/** Cache key for a place: its street (or name) and city, so spelling variants share one lookup. */
export function venueKey(text, cityHint) {
  const p = parseLocation(text, cityHint);
  const what = p.street ? fold(p.street).replace(/\.$/, '') : fold(p.name);
  return what ? `${what}|${fold(p.city)}` : `city|${fold(p.city)}`;
}

const AREA_TYPES = /^(city|town|village|municipality|hamlet|suburb|quarter|neighbourhood|city_district|borough|county|state|region|province|country|postcode)$/;

let lastRequest = 0;
let pausedUntil = 0; // after "too many requests", leave OpenStreetMap alone for a while
const PAUSE_MS = 3600e3;
async function nominatim(params) {
  if (Date.now() < pausedUntil) throw new Error('OpenStreetMap asked us to slow down; lookups resume later');
  const wait = lastRequest + MIN_GAP_MS - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const url = `${NOMINATIM}?${new URLSearchParams({
    format: 'jsonv2', limit: '1', 'accept-language': 'sk,en', ...params,
  })}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15000) });
  if (res.status === 429 || res.status === 403) {
    pausedUntil = Date.now() + PAUSE_MS;
    throw new Error(`OpenStreetMap HTTP ${res.status}: too many requests, pausing lookups for an hour`);
  }
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  return hit ? {
    lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name, osm: `${hit.osm_type}/${hit.osm_id}`,
    area: AREA_TYPES.test(hit.addresstype || ''), // matched a whole town/district, not a building or street
  } : null;
}

/** Look one place up: street address, then venue name, then the city. */
async function geocode(text, cityHint) {
  const p = parseLocation(text, cityHint);
  const city = p.city;
  const tries = [];
  if (p.street && city) {
    tries.push(['address', { street: p.street, city, ...(p.postcode && { postalcode: p.postcode }) }]);
    if (p.postcode) tries.push(['address', { street: p.street, city }]); // postcodes are often wrong
  } else if (p.street && p.postcode) {
    tries.push(['address', { q: `${p.street}, ${p.postcode}` }]);
  }
  if (p.name) tries.push(['venue', { q: [p.name, city].filter(Boolean).join(', ') }]);
  // A location that's only a name ("Výmenník Važecká Košice") may be a venue or a city: ask as is.
  if (city) tries.push(['venue', { q: text.length > city.length ? text : city }]);
  for (const [kind, params] of tries) {
    const hit = await nominatim(params);
    // Precision from what OpenStreetMap found: a town or district only gives the area's centre.
    if (hit) return { ...hit, precision: hit.area ? 'city' : kind };
  }
  return null;
}

// The city the event's source site covers (from the AI's look at the site), as a hint.
function cityHint(state, ev) {
  try { return state.sources[new URL(ev.source || ev.sources?.[0]?.via).origin]?.city; } catch { return undefined; }
}

function venueFor(state, ev) {
  const key = venueKey(ev.location, cityHint(state, ev));
  return [key, state.venues[key]];
}

/** Coordinates written on the event's pages (schema.org geo), if any source had them. */
function pageGeo(ev) {
  return ev.sources?.find((s) => Number.isFinite(s.geo?.lat) && Number.isFinite(s.geo?.lon))?.geo;
}

/**
 * Where an event is: { lat, lon, precision, name, address, km } or undefined if not known (yet).
 * precision: "page" (the event page said so), "address", "venue", "city" (only the city centre),
 * or "manual".
 */
export function placeFor(state, ev) {
  if (!ev.location) return undefined;
  const p = parseLocation(ev.location, cityHint(state, ev));
  const base = { name: p.name, address: [p.street, p.city].filter(Boolean).join(', ') };
  const geo = pageGeo(ev);
  if (geo) return { ...base, lat: geo.lat, lon: geo.lon, precision: 'page', km: distanceKm(KOSICE, geo) };
  const [, v] = venueFor(state, ev);
  if (!v || !Number.isFinite(v.lat)) return undefined;
  return { ...base, lat: v.lat, lon: v.lon, precision: v.status === 'manual' ? 'manual' : v.precision, km: v.km };
}

/**
 * Fill in coordinates for upcoming events: learn venues from page geo data, look up places we
 * haven't seen (at most `budget` lookups), then store ev.place on every upcoming event.
 */
export async function locateEvents(state, today, budget, report) {
  const upcoming = Object.values(state.events).filter((e) => (e.end || e.start) >= today && e.location);
  const now = new Date().toISOString();

  // Pages that publish coordinates teach us the venue for other events held there.
  for (const ev of upcoming) {
    const geo = pageGeo(ev);
    const [key, v] = venueFor(state, ev);
    if (geo && v?.status !== 'manual' && v?.precision !== 'page') {
      state.venues[key] = { ...v, text: ev.location, lat: geo.lat, lon: geo.lon, precision: 'page', status: 'ok',
        km: distanceKm(KOSICE, geo), checkedAt: now };
    }
  }

  // One lookup per distinct place, places with the most events first.
  const todo = new Map();
  for (const ev of upcoming) {
    if (pageGeo(ev)) continue;
    const [key, v] = venueFor(state, ev);
    const due = !v || (v.status === 'not_found' && Date.now() - Date.parse(v.checkedAt) > RETRY_NOT_FOUND);
    if (!due) continue;
    const t = todo.get(key) || { text: ev.location, hint: cityHint(state, ev), events: 0 };
    t.events++;
    todo.set(key, t);
  }
  const queue = [...todo].sort((a, b) => b[1].events - a[1].events).slice(0, geocoderEnabled() ? budget : 0);
  let found = 0;
  for (const [key, { text, hint, events }] of queue) {
    const job = report.start('locate', text, `${events} event${events === 1 ? '' : 's'}`);
    try {
      const hit = await geocode(text, hint);
      state.venues[key] = hit
        ? { text, lat: hit.lat, lon: hit.lon, precision: hit.precision, label: hit.label, osm: hit.osm,
          km: distanceKm(KOSICE, hit), status: 'ok', checkedAt: now }
        : { text, status: 'not_found', checkedAt: now };
      if (hit) found++;
      report.end(job, hit
        ? { status: 'ok', note: `${hit.precision}: ${hit.label}${hit.precision === 'city' ? ' (city centre only)' : ''}` }
        : { status: 'nothing', note: 'not found' });
    } catch (err) {
      // Network or rate-limit trouble: leave it uncached so the next cycle tries again.
      report.end(job, { status: 'error', note: err.message });
      if (Date.now() < pausedUntil) break;
    }
  }

  let located = 0;
  for (const ev of upcoming) {
    ev.place = placeFor(state, ev);
    if (ev.place) located++;
  }
  return { looked: queue.length, found, located, total: upcoming.length };
}
