// Where each event takes place, as coordinates for a map, and whether that's in Slovakia (the
// crawler keeps only events in Slovakia; see eventCountry). `km` is the distance from Košice,
// where the project started.
// Event locations are free text ("CINEMAX, Moldavská cesta 32., OC OPTIMA, Košice 04011"). We split
// them into venue name / street / postcode / city, and every distinct place is looked up once and
// cached in state.venues (data/venues.json). Where coordinates come from, best first:
//   1. the event page itself (schema.org Place.geo),
//   2. the venue cache, filled by OpenStreetMap's Nominatim geocoder: the street address, else
//      the venue name, else the city centre (precision "city", so a map can treat it as rough).
// Nominatim's usage policy: at most 1 request per second, an identifying User-Agent, and cache
// results. We send a few dozen requests per pass at most, and every answer (also "not found") is
// cached. Set a venue's status to "manual" in data/venues.json to pin coordinates by hand.
// EVENTS_GEOCODER=off disables lookups. A location that is just a Slovak town or village needs no
// lookup: its coordinates come from the list of municipalities (slovakia.js).
import { regionAt } from './learn.js';
import { hostOf } from './urls.js';
import {
  SK_ALIASES, SK_TOWN_NAMES, boroughOf, countryCode, countryInUrl, countryNamed, countryPart, czechWords, foreignTown, inSlovakia, isTown, looksAbroad, skPlace, slovakWords, townOfPlace, uniqueName,
} from './slovakia.js';

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
// Plus every Slovak town by status or size (sk-places.json). Villages count only as a whole part of
// a location ("…, Jasov"; see wholeTown), never inside a venue's name.
// Their names in other languages ("Kassa", "Pressburg") count only as a whole part, like villages.
const TOWNS = new Map([...TOWN_NAMES, ...SK_TOWN_NAMES].map((n) => [fold(n), n]));
const ALIASES = new Set(SK_ALIASES.map(([a]) => fold(a)));
for (const [a, name] of SK_ALIASES) TOWNS.set(fold(a), name);
// The towns outside Slovakia, by country; lookups for a known town search only its country, so
// "Športová hala, Martin" can't land in Martin County, Texas.
const ABROAD = { cz: ['praha', 'brno', 'ostrava', 'olomouc'], hu: ['budapest', 'miskolc'], at: ['wien', 'vieden', 'vienna'],
  pl: ['krakow', 'krakov'], ua: ['uzhorod', 'uzhhorod'] };
const COUNTRY = new Map(Object.entries(ABROAD).flatMap(([cc, towns]) => towns.map((t) => [t, cc])));
// The country to look a town up in: its own, null for a town abroad we don't know (look anywhere),
// undefined when the town says nothing (Slovakia first, then anywhere).
function countryOf(city) {
  if (COUNTRY.has(fold(city))) return COUNTRY.get(fold(city));
  const sk = skPlace(city);
  if (foreignTown(city || '') && !isTown(sk)) return null;
  return sk ? 'sk' : undefined;
}
// One town's names in other languages, as OpenStreetMap may write it in an address ("Wien" → "Viedeň").
const SAME_TOWN = [['wien', 'vieden', 'vienna'], ['krakow', 'krakov'], ['uzhorod', 'uzhhorod']];
const townNames = (town) => SAME_TOWN.find((names) => names.includes(town)) || [town];
// All our known towns are this close to Košice; a hit for one of them farther away is another place.
const MAX_KM = 800;
// Town names that are also everyday words or first names ("sála" = hall, "svit" = light, Martin):
// they count only as a whole part of the location ("…, Martin"), never inside a venue's name.
const AMBIGUOUS = new Set(['sala', 'svit', 'modra', 'martin', 'turany', 'rajec', 'sahy', 'sered', 'detva', 'holic',
  'vrable', 'medzev', 'jasov', 'saca', 'lipany', 'senec', 'svidnik', 'myjava', 'krupina', 'vrbove', 'leopoldov',
  'raca', 'rakova', 'skalite', 'novaky', 'sliac', 'gbely', 'ilava', 'lendak', 'belusa', 'cana', 'rabca', 'tisovec']);
const byLength = (keys) => [...keys].sort((a, b) => b.length - a.length).join('|');
const TOWN_RE = new RegExp(`(?:^|[^a-z])(${byLength([...TOWNS.keys()].filter((k) => !AMBIGUOUS.has(k) && !ALIASES.has(k)))})(?=$|[^a-z])`, 'g');

// Adjectives of the bigger towns ("bratislavské", "košický", "žilinská"): the town's name less its
// last letter, plus an ending. Only names of 6+ letters, so short ones don't eat ordinary words.
const TOWN_ADJ_RE = new RegExp(`(?:^|[^a-z])(${byLength([...TOWNS.keys()]
  .filter((k) => !AMBIGUOUS.has(k) && !ALIASES.has(k) && !k.includes(' ') && k.length >= 6).map((k) => k.slice(0, -1)))})[a-z]*(?=$|[^a-z])`, 'g');

/** A folded title without the towns it names ("donaha! - trnava - vypredane" → "donaha! - - vypredane"). */
export const withoutTowns = (folded) => folded.replace(TOWN_RE, ' ').replace(TOWN_ADJ_RE, ' ');

// A town as written: one of ours, any Slovak municipality, or a town abroad. A borough on its own
// is its city's district ("Petržalka" → Bratislava, Petržalka). A village is marked as one: two
// villages in a location aren't a tour ("Bory Mall, Lozorno, Bory").
function townNamed(name) {
  const f = fold(name);
  const sk = skPlace(f);
  if (sk?.partOf) return { city: sk.partOf, district: sk.name };
  if (TOWNS.has(f)) return { city: TOWNS.get(f) };
  // Slovakia has villages called Praha, Opava and Kyjov: the town abroad is meant far more often.
  const abroad = foreignTown(name);
  if (sk && !(abroad && !isTown(sk))) return { city: sk.name, village: !isTown(sk) };
  return abroad ? { city: abroad } : null;
}

// A part that IS a town, maybe with its district: "Košice", "Košice-Staré Mesto", "Košice – Krásna",
// "Belá-Dulice" (a village with a dash in its name), "Petržalka".
function wholeTown(part) {
  const whole = townNamed(part);
  if (whole) return whole;
  const m = part.match(/^(.+?)\s*[-–—]\s*(.+)$/);
  const town = m && townNamed(m[1]);
  return town && !town.district ? { ...town, district: m[2].trim() } : null;
}

// The last town named anywhere in a text ("Dom umenia Košice" → Košice).
function townIn(text) {
  const all = [...fold(text).matchAll(TOWN_RE)];
  if (!all.length) return undefined;
  const town = TOWNS.get(all[all.length - 1][1]);
  return skPlace(town)?.partOf || town; // "DK Ružinov" → Bratislava
}

/**
 * Split a location string: { name, street, postcode, city, district }. `cityHint` (the city the
 * source site covers, when known) fills in a missing city. A list of towns ("Košice, Prešov,
 * Poprad": a tour) has no single place: { multi: [towns] }.
 */
export function parseLocation(text, cityHint) {
  // A country on its own ("…, Slovensko", "…, Czechia") is no part of the address.
  const parts = (text || '').split(/\s*[,|;]\s*/).map((p) => p.trim()).filter((p) => p && !countryPart(p));
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
  const towns = [...new Set(whole.filter((t) => t && !t.village).map((t) => t.city))];
  if (towns.length >= 2 && !street) return { multi: towns };
  let at = whole.findIndex((t) => t && !t.village);
  if (at < 0) at = whole.findIndex(Boolean);
  if (at < 0) { // "040 01 Staré Mesto": a borough, by the postcode
    at = rest.findIndex((r) => boroughOf(r.p, postcode));
    if (at >= 0) whole[at] = boroughOf(rest[at].p, postcode);
  }
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
  const town = p.multi ? undefined : TOWNS.has(fold(p.city)) ? TOWNS.get(fold(p.city)) : skPlace(p.city)?.name || townIn(text);
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
    format: 'jsonv2', limit: '1', 'accept-language': 'sk,en', addressdetails: '1', ...params,
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
    country: hit.address?.country_code,
    area: AREA_TYPES.test(hit.addresstype || ''), // matched a whole town/district, not a building or street
  } : null;
}

// Words of a venue name worth comparing ("DKC Veritas" → dkc, veritas); towns and filler words don't count.
const FILLER = new Set(['the', 'and', 'pre', 'pri', 'nad', 'pod', 'mesto', 'stare', 'nove', 'mestska', 'mestsky', 'mestske', 'cast']);
const nameWords = (s) => fold(s).split(/[^a-z0-9]+/).filter((w) => w.length >= 3 && !FILLER.has(w) && !TOWNS.has(w));

/**
 * Is an address in this town? One of its parts must be the town ("…, Podháj, Martin, okres Martin,
 * …"), the town and its district ("Košice-Juh"), or the town's okres (a village "near Košice" is in
 * "okres Košice-okolie"). "Martin County, Texas" is not Martin.
 */
function inTown(label, city) {
  const names = townNames(fold(city));
  return fold(label).split(/\s*,\s*/).some((part) => names.some((t) => part === t
    || new RegExp(`^(okres )?${t}( ?[-–]|$| [ivx]+$)`).test(part)));
}

/** A hit that can't be the known town it's meant to be in: wrong town, or far from all of ours. */
const awayFrom = (hit, city) => Boolean(city && ((TOWNS.has(fold(city))
  && ((hit.label && !inTown(hit.label, city)) || distanceKm(KOSICE, hit) > MAX_KM)) || farFromTown(hit, city)));

// A Slovak town's area: coordinates farther than this from its centre aren't in it.
const TOWN_KM = 30;
/**
 * Coordinates that can't be in the Slovak town named: more than 30 km from its centre ("Senec"
 * found as a village of that name in Bohemia; a ticket page giving its organiser's address).
 */
function farFromTown(at, city) {
  const p = city && uniqueName(city) && skPlace(city);
  return Boolean(p) && distanceKm(townOfPlace(p), at) > TOWN_KM;
}

/**
 * Is a venue-name hit really that venue? Free-text search falls back to whatever matches part of the
 * query: "Yama Event Place, Košice" finds the railway station called "Košice", "Sobášna sieň, Košice"
 * finds a hall of that name in Bratislava. The hit's own name must share a word with the venue's,
 * and its address must be in the town we expect.
 */
function plausible(hit, p, { town = true, name = true } = {}) {
  if (town && awayFrom(hit, p.city)) return false;
  if (p.city && TOWNS.has(fold(p.city)) && distanceKm(KOSICE, hit) > MAX_KM) return false;
  if (!name) return true;
  const words = nameWords(p.name || '');
  if (!words.length || hit.area) return true;
  const own = fold(hit.label.split(',')[0]);
  return words.some((w) => own.includes(w));
}

// How a hit is checked: the town and the venue's name, the town only, or (when the town is only
// the site's guess) the name only.
const CHECKS = { venue: {}, town: { name: false }, name: { town: false } };

// A Slovak town or borough from the list of municipalities: no lookup needed for its centre.
function townCentre(p) {
  const borough = p.district && skPlace(p.district);
  const at = borough?.partOf === p.city ? borough : skPlace(p.city);
  return at && { lat: at.lat, lon: at.lon, label: `${at.name}${at.partOf ? `, ${at.partOf}` : ''}${at.district ? `, okres ${at.district}` : ''}, Slovensko`,
    country: 'sk', precision: 'city', area: true };
}

/**
 * Look one place up: street address, then venue name, then the city. A place whose country isn't
 * known from its town is looked for in Slovakia first, then anywhere (to learn it's abroad).
 */
async function geocode(text, cityHint) {
  const p = parseLocation(text, cityHint);
  if (p.multi) return null;
  const city = p.city;
  // Just a Slovak town ("Prešov", "Košice - Juh"): its centre, from the list.
  if (!p.street && !p.name && townCentre(p)) return townCentre(p);
  // The town came from the site, not from the location: the location may name another place
  // ("Stará Hora - Sebechleby" on a site about Banská Bystrica).
  const hinted = Boolean(city) && !parseLocation(text).city;
  const country = countryOf(city);
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
    tries.push(['city', { q: [p.district, city].filter(Boolean).join(', ') }, 'town']);
  }
  for (const where of country !== undefined ? [country] : ['sk', null]) {
    for (const [kind, params, check] of tries) {
      if (kind === 'city' && where === 'sk' && townCentre(p)) return townCentre(p);
      const hit = await nominatim(where ? { ...params, countrycodes: where } : params);
      if (!hit || (check && !plausible(hit, p, CHECKS[check]))) continue;
      // Precision from what OpenStreetMap found: a town or district only gives the area's centre
      // (and asking for just the town counts as that, even if the best hit is a building named after it).
      return { ...hit, precision: hit.area || kind === 'city' ? 'city' : kind };
    }
  }
  return null;
}

// The city the event's listing page covers (from the AI's look at it), or else the one its whole site
// covers (only set while every page the AI read named the same city), as a hint.
function cityHint(state, ev) {
  const via = ev.source || ev.sources?.[0]?.via;
  const src = sourceOf(state, ev);
  return src?.pages?.[via]?.city || src?.city;
}

// The source site an event was read from.
function sourceOf(state, ev) {
  try { return state.sources[new URL(ev.source || ev.sources?.[0]?.via).origin]; } catch { return undefined; }
}

function venueFor(state, ev) {
  const key = venueKey(ev.location, cityHint(state, ev));
  return [key, key ? state.venues[key] : undefined];
}

/** Coordinates written on the event's pages (schema.org geo), if any source had them. */
function pageGeo(ev) {
  return ev.sources?.find((s) => Number.isFinite(s.geo?.lat) && Number.isFinite(s.geo?.lon))?.geo;
}

/** A cached lookup that isn't in the town its location names (found before lookups checked that). */
function outOfTown(v) {
  return Number.isFinite(v.lat) && awayFrom(v, parseLocation(v.text).city);
}

/**
 * What a location text says about the country: 'sk', 'abroad' or undefined. A country named in it
 * ("…, Czechia", "Slovensko"), else the towns it names (any Slovak municipality, or towns abroad),
 * else signs of another language (looksAbroad).
 */
export const locationCountry = (text, hint) => {
  const c = locationEvidence(text, hint);
  return c === 'village' ? 'sk' : c;
};

// locationCountry, telling a Slovak village apart ('village'): Czech villages share many of their
// names (Dolany, Lipník…), so a village alone is weaker evidence than a town.
const countryCache = new Map();
function locationEvidence(text, hint) {
  const key = `${text}|${hint || ''}`;
  if (countryCache.has(key)) return countryCache.get(key);
  let c = countryNamed(text);
  if (!c) {
    const p = parseLocation(text, hint);
    const towns = p.multi || [p.city].filter(Boolean);
    // A Slovak town is sure; a village is, unless the text looks foreign (a Czech village of the same name).
    if (towns.some((t) => isTown(skPlace(t)))) c = 'sk';
    else if ((towns.length && towns.every((t) => foreignTown(t))) || looksAbroad(text)) c = 'abroad';
    else if (towns.some((t) => skPlace(t))) c = 'village';
  }
  if (countryCache.size > 50000) countryCache.clear();
  countryCache.set(key, c);
  return c;
}

/**
 * Repair, once (18 Oct 2026): the city the AI gave for one listing page used to become its whole
 * site's (eventbrite.com: "Trnava"), and was given to every event of the site without a place, and
 * as the town of venues like "Shoreditch · Basing House". A site's city that most of its events'
 * own locations disagree with is dropped, with the locations it filled in. Places learned from a
 * page's coordinates for a venue without a town are forgotten (they mixed up same-named venues).
 * Returns { sites, events, venues } repaired.
 */
export function repairSiteCities(state) {
  const out = { sites: 0, events: 0, venues: 0 };
  const byOrigin = new Map();
  for (const ev of Object.values(state.events)) {
    try { const o = new URL(ev.source || ev.sources?.[0]?.via).origin; byOrigin.set(o, [...(byOrigin.get(o) || []), ev]); } catch {}
  }
  for (const src of Object.values(state.sources)) {
    if (!src.city) continue;
    const evs = byOrigin.get(src.origin) || [];
    // Towns the events' own locations name (known ones only: "Sála činohry, Titulky: en" names none).
    const towns = evs.map((e) => e.location && e.location !== src.city
      && (knownTown(e.location) || (locationCountry(e.location) === 'abroad' && 'abroad'))).filter(Boolean);
    const same = towns.filter((t) => fold(t) === fold(src.city)).length;
    if (towns.length < 5 || same / towns.length >= 0.6) continue;
    for (const ev of evs) {
      if (ev.location !== src.city) continue;
      delete ev.location;
      delete ev.place;
      out.events++;
    }
    delete src.city;
    out.sites++;
  }
  for (const [key, v] of Object.entries(state.venues)) {
    if (key.endsWith('|') && v.precision === 'page' && v.status !== 'manual') { delete state.venues[key]; out.venues++; }
  }
  return out;
}

/**
 * Is an event in Slovakia? 'sk', 'abroad', or undefined while that isn't known. Best first: the
 * town or country its location names, the coordinates its page gives or where its place was found
 * (venues.json), the location's language, the country the AI gave, a country code in the title,
 * the listing's address, the city of its site or venue, and last what's known of its site.
 */
export function eventCountry(state, ev) {
  // The location's own words first: a Slovak town it names beats coordinates that disagree (a page's
  // organiser address, a same-named village abroad), a town or country abroad is abroad. A village
  // alone, on pages whose events are abroad, is the Czech one of that name.
  const via = ev.sources?.find((r) => !r.linked)?.via || ev.source;
  const own = ev.location && locationEvidence(ev.location);
  if (own === 'village') return via && regionAt(state, via) === 'abroad' ? 'abroad' : 'sk';
  if (own) return own;
  const at = coordsFor(state, ev);
  if (at) return inSlovakia(at) ? 'sk' : 'abroad';
  if (ev.location) {
    const said = locationCountry(ev.location, cityHint(state, ev));
    if (said) return said;
    // Written in Slovak: "Dom kultúry Kanianka", "Evanjelický kostol", "Divadlo J. Palárika v Trnave".
    if (slovakWords(ev.location)) return 'sk';
  }
  if (ev.country) return countryCode(ev.country);
  // A country code in the title: "LEVICE (SK)", "BRUNTÁL (CZ)", "KOLLÁROVCI - CZ TOUR".
  if (/\((sk|sr)\)/i.test(ev.title || '')) return 'sk';
  if (/\((cz|čr|at|hu|pl|de|ua)\)|\bcz tour\b/i.test(ev.title || '')) return 'abroad';
  // The listing's address: "eventbrite.com/d/united-kingdom/…", "…/Kino-Hviezda-Trencin". That it
  // names Slovakia says less on a site abroad: eventbrite's "/d/slovakia--trnava/" lists Vienna too,
  // so there it counts only for an event without a location (one with is looked up).
  const inUrl = via && countryInUrl(via);
  if (inUrl === 'abroad' || (inUrl === 'sk' && (!ev.location || hostOf(via).endsWith('.sk')))) return inUrl;
  // The city its listing page or site covers, or its venue's (a theatre's own site), when the
  // location says nothing we know ("Kategória: Pre deti • … • Staré divadlo" on nitra.eu).
  const src = sourceOf(state, ev);
  const hint = cityHint(state, ev) || (src?.venue && knownTown(src.venue));
  if (hint && locationCountry(hint)) return locationCountry(hint);
  let host;
  try { host = new URL(via).hostname; } catch { return undefined; }
  // No place at all on a Slovak site (a cinema's coming films, a festival's own pages).
  if (!ev.location && host.endsWith('.sk')) return 'sk';
  // Czech words ("Městské divadlo", "Třemošnice") on a site not known to have its events in Slovakia.
  if (czechWords(`${ev.title} ${ev.location || ''} ${ev.description || ''}`) && regionAt(state, via) !== 'sk') return 'abroad';
  if (!ev.location && regionAt(state, via) === 'sk') return 'sk';
  return undefined;
}

// A place without a town looked up worldwide, before lookups tried Slovakia first (18 Oct 2026): a hit
// abroad says little ("Staré Mesto" found in Prague, "Klub Lúč" in Poland). It's looked up again.
const stale = (key, v) => key?.startsWith('city|') === false && key.endsWith('|') && !v.country
  && v.status === 'ok' && v.precision !== 'manual' && inSlovakia(v) === false;

// The event's coordinates, from its page or its venue's lookup: unless they're far from the Slovak town
// its location names (then they're wrong, and the venue is looked up again).
function coordsFor(state, ev, city = parseLocation(ev.location || '', cityHint(state, ev)).city) {
  const geo = pageGeo(ev);
  if (geo && !farFromTown(geo, city)) return { ...geo, precision: 'page' };
  if (!ev.location) return undefined;
  const [key, v] = venueFor(state, ev);
  if (!Number.isFinite(v?.lat) || farFromTown(v, city) || stale(key, v)) return undefined;
  return { lat: v.lat, lon: v.lon, precision: v.status === 'manual' ? 'manual' : v.precision, km: v.km };
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
  const at = coordsFor(state, ev, p.city);
  if (at) return { ...base, lat: at.lat, lon: at.lon, precision: at.precision, km: at.km ?? distanceKm(KOSICE, at) };
  // None yet (or they were wrong): a Slovak town's centre, from the list.
  const centre = townCentre(p);
  return centre ? { ...base, lat: centre.lat, lon: centre.lon, precision: 'city', km: distanceKm(KOSICE, centre) } : undefined;
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
    // (Not for a place without a town: "Kino Lucerna" in Košice isn't the one in Prague.)
    if (geo && key && !key.endsWith('|') && v?.status !== 'manual' && v?.precision !== 'page'
      && !farFromTown(geo, parseLocation(ev.location, cityHint(state, ev)).city)) {
      state.venues[key] = { ...v, text: ev.location, lat: geo.lat, lon: geo.lon, precision: 'page', status: 'ok',
        km: distanceKm(KOSICE, geo), checkedAt: now };
    }
  }

  // One lookup per distinct place, places with the most events first.
  const todo = new Map();
  // Each event's place, and the other places its sources give (a film at several cinemas in town).
  const spots = upcoming.flatMap((ev) => [ev, ...new Set((ev.sources || [])
    .filter((r) => !r.linked && r.location && r.location !== ev.location).map((r) => r.location))]
    .map((x) => (typeof x === 'string' ? { location: x, source: ev.source, sources: [] } : x)));
  for (const ev of spots) {
    if (pageGeo(ev)) continue;
    const [key, v] = venueFor(state, ev);
    if (!key) continue;
    const due = !v || (v.status === 'not_found' && Date.now() - Date.parse(v.checkedAt) > RETRY_NOT_FOUND)
      || (v.status === 'ok' && v.precision !== 'page' && outOfTown(v)) // found before lookups checked the town well
      || stale(key, v);
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
        ? { text, lat: hit.lat, lon: hit.lon, precision: hit.precision, label: hit.label, osm: hit.osm, country: hit.country,
          km: distanceKm(KOSICE, hit), status: 'ok', checkedAt: now }
        : { text, status: 'not_found', checkedAt: now };
      if (hit) found++;
      report.end(job, hit
        ? { status: 'ok', note: `${hit.precision}: ${hit.label}${hit.precision === 'city' ? ' (city centre only)' : ''}` }
        : { status: 'nothing', note: 'not found' });
    } catch (err) {
      // Network or rate-limit trouble: leave it uncached so the next pass tries again.
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
