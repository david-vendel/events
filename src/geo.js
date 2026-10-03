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

// Towns, to find the one in "Dom umenia Košice" or "Košice-Staré Mesto, Collosseum klub": Slovak
// towns and spa/tourist places, plus nearby big cities. Folded name -> name as written.
const TOWN_NAMES = [
  'Bratislava', 'Košice', 'Prešov', 'Žilina', 'Banská Bystrica', 'Nitra', 'Trnava', 'Trenčín', 'Martin', 'Poprad',
  'Prievidza', 'Zvolen', 'Považská Bystrica', 'Michalovce', 'Nové Zámky', 'Spišská Nová Ves', 'Komárno', 'Levice',
  'Humenné', 'Bardejov', 'Liptovský Mikuláš', 'Lučenec', 'Piešťany', 'Ružomberok', 'Topoľčany', 'Trebišov', 'Čadca',
  'Dubnica nad Váhom', 'Rimavská Sobota', 'Partizánske', 'Šaľa', 'Dunajská Streda', 'Vranov nad Topľou', 'Pezinok',
  'Hlohovec', 'Brezno', 'Senica', 'Nové Mesto nad Váhom', 'Snina', 'Malacky', 'Senec', 'Dolný Kubín', 'Rožňava',
  'Púchov', 'Žiar nad Hronom', 'Stará Ľubovňa', 'Bánovce nad Bebravou', 'Sereď', 'Kežmarok', 'Skalica', 'Galanta',
  'Handlová', 'Kysucké Nové Mesto', 'Levoča', 'Detva', 'Šamorín', 'Stupava', 'Sabinov', 'Zlaté Moravce', 'Revúca',
  'Bytča', 'Holíč', 'Veľký Krtíš', 'Myjava', 'Nová Dubnica', 'Svidník', 'Moldava nad Bodvou', 'Stropkov',
  'Medzilaborce', 'Sobrance', 'Gelnica', 'Krompachy', 'Spišská Belá', 'Vysoké Tatry', 'Štrbské Pleso',
  'Tatranská Lomnica', 'Starý Smokovec', 'Kremnica', 'Banská Štiavnica', 'Krupina', 'Turčianske Teplice', 'Bojnice',
  'Trenčianske Teplice', 'Rajecké Teplice', 'Bardejovské Kúpele', 'Veľké Kapušany', 'Kráľovský Chlmec',
  'Čierna nad Tisou', 'Sečovce', 'Spišské Podhradie', 'Smižany', 'Jasov', 'Medzev', 'Šaca', 'Tvrdošín', 'Námestovo',
  'Liptovský Hrádok', 'Svit', 'Vrútky', 'Turany', 'Rajec', 'Kolárovo', 'Štúrovo', 'Hurbanovo', 'Želiezovce',
  'Šahy', 'Vráble', 'Šurany', 'Nesvady', 'Modra', 'Svätý Jur', 'Vrbové', 'Leopoldov', 'Trstená', 'Hriňová',
  'Poltár', 'Tornaľa', 'Hnúšťa', 'Dobšiná', 'Fiľakovo', 'Giraltovce', 'Lipany', 'Vysoké Tatry',
  'Praha', 'Brno', 'Ostrava', 'Olomouc', 'Budapest', 'Budapešť', 'Wien', 'Viedeň', 'Vienna', 'Kraków', 'Krakov',
  'Miskolc', 'Užhorod', 'Uzhhorod',
];
const TOWNS = new Map(TOWN_NAMES.map((n) => [fold(n), n]));
// Town names that are also everyday words or first names ("sála" = hall, "svit" = light, Martin):
// they count only as a whole part of the location ("…, Martin"), never inside a venue's name.
const AMBIGUOUS = new Set(['sala', 'svit', 'modra', 'martin', 'turany', 'rajec', 'sahy', 'sered', 'detva', 'holic',
  'vrable', 'medzev', 'jasov', 'saca', 'lipany', 'senec', 'svidnik', 'myjava', 'krupina', 'vrbove', 'leopoldov']);
const byLength = (keys) => [...keys].sort((a, b) => b.length - a.length).join('|');
const TOWN_RE = new RegExp(`(?:^|[^a-z])(${byLength([...TOWNS.keys()].filter((k) => !AMBIGUOUS.has(k)))})(?=$|[^a-z])`, 'g');
const WHOLE_TOWN_RE = new RegExp(`^(${byLength(TOWNS.keys())})(?:\\s*[-–—]\\s*(.+))?$`);

// A part that IS a town, maybe with its district: "Košice", "Košice-Staré Mesto", "Košice – Krásna".
function wholeTown(part) {
  const m = fold(part).match(WHOLE_TOWN_RE);
  if (!m) return null;
  const district = m[2] ? part.slice(part.length - m[2].length).trim() : undefined;
  return { city: TOWNS.get(m[1]), district };
}

// The last town named anywhere in a text ("Dom umenia Košice" → Košice).
function townIn(text) {
  const all = [...fold(text).matchAll(TOWN_RE)];
  return all.length ? TOWNS.get(all[all.length - 1][1]) : undefined;
}

/**
 * Split a location string: { name, street, postcode, city, district }. `cityHint` (the city the
 * source site covers, when known) fills in a missing city. A list of towns ("Košice, Prešov,
 * Poprad": a tour) has no single place: { multi: [towns] }.
 */
export function parseLocation(text, cityHint) {
  const parts = (text || '').split(/\s*[,|;]\s*/).map((p) => p.trim()).filter(Boolean);
  let name, street, postcode, city, district;
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
  const whole = rest.map((r) => wholeTown(r.p));
  const towns = [...new Set(whole.filter(Boolean).map((t) => t.city))];
  if (towns.length >= 2 && !street) return { multi: towns };
  const at = whole.findIndex(Boolean);
  if (at >= 0) {
    ({ city, district } = whole[at]);
    rest.splice(at, 1);
  } else {
    // Otherwise the city is the last plain part after the street (or the last part, when there's
    // no street), unless that part is a venue that merely names its town ("Miestny úrad Košice").
    const cityPart = [...rest].reverse().find((r) => r.afterStreet || !street);
    if (cityPart && (rest.length > 1 || street)) {
      const named = townIn(cityPart.p);
      city = named || cityPart.p;
      if (!named || rest.length > 1) rest.splice(rest.indexOf(cityPart), 1);
    }
  }
  name = rest.find((r) => !r.afterStreet)?.p ?? rest[0]?.p;
  city ??= townIn(text); // "Dom umenia Košice", "Národné divadlo Košice"
  return { name, street, postcode, city: city || cityHint || undefined, district };
}

const townCache = new Map();
/**
 * The town a location is in, only when it's a known town ("Štátna filharmónia Košice, Dom umenia" →
 * Košice); undefined when unsure or when it names several. For telling events apart, so it never
 * guesses.
 */
export function knownTown(text) {
  if (!text) return undefined;
  if (townCache.has(text)) return townCache.get(text);
  const p = parseLocation(text);
  const town = p.multi ? undefined : TOWNS.has(fold(p.city)) ? TOWNS.get(fold(p.city)) : townIn(text);
  if (townCache.size > 20000) townCache.clear();
  townCache.set(text, town);
  return town;
}

/** Cache key for a place: its street (or name) and city, so spelling variants share one lookup. */
export function venueKey(text, cityHint) {
  const p = parseLocation(text, cityHint);
  if (p.multi) return null; // several towns: no one place to look up
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

// Words of a venue name worth comparing ("DKC Veritas" → dkc, veritas); towns and filler words don't count.
const FILLER = new Set(['the', 'and', 'pre', 'pri', 'nad', 'pod', 'mesto', 'stare', 'nove', 'mestska', 'mestsky', 'mestske', 'cast']);
const nameWords = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w) && !TOWNS.has(w));

/**
 * Is a venue-name hit really that venue? Free-text search falls back to whatever matches part of the
 * query: "Yama Event Place, Košice" finds the railway station called "Košice", "Sobášna sieň, Košice"
 * finds a hall of that name in Bratislava. The hit's own name must share a word with the venue's,
 * and its address must be in the town we expect.
 */
function plausible(hit, p, { town = true, name = true } = {}) {
  const label = fold(hit.label);
  if (town && p.city && TOWNS.has(fold(p.city)) && !label.includes(fold(p.city))) return false;
  if (!name) return true;
  const words = nameWords(p.name || '');
  if (!words.length || hit.area) return true;
  const own = fold(hit.label.split(',')[0]);
  return words.some((w) => own.includes(w));
}

// How a hit is checked: the town and the venue's name, the town only, or (when the town is only
// the site's guess) the name only.
const CHECKS = { venue: {}, town: { name: false }, name: { town: false } };

/** Look one place up: street address, then venue name, then the city. */
async function geocode(text, cityHint) {
  const p = parseLocation(text, cityHint);
  if (p.multi) return null;
  const city = p.city;
  // The town came from the site, not from the location: the location may name another place
  // ("Stará Hora - Sebechleby" on a site about Banská Bystrica).
  const hinted = Boolean(city) && !parseLocation(text).city;
  const tries = []; // [precision, query, check (see CHECKS; none: any hit)]
  if (p.street && city) {
    tries.push(['address', { street: p.street, city, ...(p.postcode && { postalcode: p.postcode }) }, 'town']);
    if (p.postcode) tries.push(['address', { street: p.street, city }, 'town']); // postcodes are often wrong
  } else if (p.street && p.postcode) {
    tries.push(['address', { q: `${p.street}, ${p.postcode}` }]);
  }
  if (p.name) tries.push(['venue', { q: [p.name, city].filter(Boolean).join(', ') }, 'venue']);
  if (p.name && hinted) tries.push(['venue', { q: p.name }, 'name']);
  // A location that's only a name ("Výmenník Važecká Košice") may be a venue or a city: ask as is;
  // last of all, the town itself (the map then shows the town centre, marked as approximate).
  if (city) {
    if (fold(text) !== fold(city)) tries.push(['venue', { q: text }, 'venue']);
    tries.push(['city', { q: [p.district, city].filter(Boolean).join(', ') }]);
  }
  for (const [kind, params, check] of tries) {
    const hit = await nominatim(params);
    if (!hit || (check && !plausible(hit, p, CHECKS[check]))) continue;
    // Precision from what OpenStreetMap found: a town or district only gives the area's centre
    // (and asking for just the town counts as that, even if the best hit is a building named after it).
    return { ...hit, precision: hit.area || kind === 'city' ? 'city' : kind };
  }
  return null;
}

// The city the event's source site covers (from the AI's look at the site), as a hint.
function cityHint(state, ev) {
  try { return state.sources[new URL(ev.source || ev.sources?.[0]?.via).origin]?.city; } catch { return undefined; }
}

function venueFor(state, ev) {
  const key = venueKey(ev.location, cityHint(state, ev));
  return [key, key ? state.venues[key] : undefined];
}

/** Coordinates written on the event's pages (schema.org geo), if any source had them. */
function pageGeo(ev) {
  return ev.sources?.find((s) => Number.isFinite(s.geo?.lat) && Number.isFinite(s.geo?.lon))?.geo;
}

/** A cached lookup whose address isn't in the town its location names. */
function outOfTown(v) {
  const city = parseLocation(v.text).city;
  return Boolean(city && TOWNS.has(fold(city)) && v.label && !fold(v.label).includes(fold(city)));
}

/**
 * Where an event is: { lat, lon, precision, name, address, km } or undefined if not known (yet).
 * precision: "page" (the event page said so), "address", "venue", "city" (only the city centre),
 * or "manual".
 */
export function placeFor(state, ev) {
  if (!ev.location) return undefined;
  const p = parseLocation(ev.location, cityHint(state, ev));
  if (p.multi) return undefined;
  const base = { name: p.name, address: [p.street, p.district, p.city].filter(Boolean).join(', '), city: p.city };
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
    if (geo && key && v?.status !== 'manual' && v?.precision !== 'page') {
      state.venues[key] = { ...v, text: ev.location, lat: geo.lat, lon: geo.lon, precision: 'page', status: 'ok',
        km: distanceKm(KOSICE, geo), checkedAt: now };
    }
  }

  // One lookup per distinct place, places with the most events first.
  const todo = new Map();
  for (const ev of upcoming) {
    if (pageGeo(ev)) continue;
    const [key, v] = venueFor(state, ev);
    if (!key) continue;
    const due = !v || (v.status === 'not_found' && Date.now() - Date.parse(v.checkedAt) > RETRY_NOT_FOUND)
      || (v.status === 'ok' && v.precision !== 'page' && outOfTown(v)); // found before lookups checked the town
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
