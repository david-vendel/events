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
import { fetchBody } from './fetcher.js';
import { regionAt } from './learn.js';
import { hostOf } from './urls.js';
import { languageOf } from './language.js';
import {
  SK_ALIASES, SK_PLACES, SK_TOWN_NAMES, boroughOf, countryCode, countryInUrl, countryNamed, countryPart, foreignTown, inSlovakia, isOnline,
  isTown, locativeTown, looksAbroad, skPlace, slovakWords, townOfPlace, uniqueName, usState,
} from './slovakia.js';

const NOMINATIM = process.env.EVENTS_NOMINATIM_URL || 'https://nominatim.openstreetmap.org/search';
const USER_AGENT = 'KosiceEventsBot/0.1 (+https://github.com/david-vendel/events)';
const KOSICE = { lat: 48.7164, lon: 21.2611 };
const RETRY_NOT_FOUND = 30 * 864e5;
const MIN_GAP_MS = 1100; // EVENTS_NOMINATIM_GAP_MS overrides it (tests, a local Nominatim)

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
  // Resorts that aren't municipalities but are where people say an event is ("Jasná" is also a word).
  'Nový Smokovec', 'Tatranské Matliare', 'Podbanské', 'Ľubovnianske Kúpele', 'Tatranská Kotlina', 'Ždiar',
  'Praha', 'Brno', 'Ostrava', 'Olomouc', 'Budapest', 'Budapešť', 'Wien', 'Viedeň', 'Vienna', 'Kraków', 'Krakov',
  'Miskolc', 'Užhorod', 'Uzhhorod',
];
// Plus every Slovak town by status or size (sk-places.json). Villages count only as a whole part of
// a location ("…, Jasov"; see wholeTown), never inside a venue's name.
// Their names in other languages ("Kassa", "Pressburg") count only as a whole part, like villages.
const TOWNS = new Map([...TOWN_NAMES, ...SK_TOWN_NAMES].map((n) => [fold(n), n]));
// Names slovakia.js leaves out of its aliases (they're words or places elsewhere too), but which a
// whole part of a location means: adamis.sk writes Kolárovo in Hungarian, "AA VMK, Templom tér 4, Gúta".
const MORE_ALIASES = [['Gúta', 'Kolárovo']];
const ALIASES = new Set([...SK_ALIASES, ...MORE_ALIASES].map(([a]) => fold(a)));
for (const [a, name] of [...SK_ALIASES, ...MORE_ALIASES]) TOWNS.set(fold(a), name);
// The towns outside Slovakia, by country; lookups for a known town search only its country, so
// "Športová hala, Martin" can't land in Martin County, Texas.
const ABROAD = { cz: ['praha', 'brno', 'ostrava', 'olomouc'], hu: ['budapest', 'miskolc'], at: ['wien', 'vieden', 'vienna'],
  pl: ['krakow', 'krakov'], ua: ['uzhorod', 'uzhhorod'] };
const COUNTRY = new Map(Object.entries(ABROAD).flatMap(([cc, towns]) => towns.map((t) => [t, cc])));
// The country to look a town up in: its own; null for a town abroad or a location that doesn't read as
// Slovak (look anywhere: searching Slovakia first found "KINO Moskva" in Martin for Москва, a shop
// called "Boston" in Senica for Boston, Nov 2026); 'any' for any other town that isn't a Slovak
// municipality (anywhere first, then Slovakia, where a hamlet or a building merely named like it
// doesn't count: "Polička" found Políčka by Piešťany, "Dubai" a building in Košice, "Rodina" a shop);
// undefined when there's no town (Slovakia first, then anywhere).
function countryOf(city, text = '') {
  if (!city) return undefined;
  if (COUNTRY.has(fold(city))) return COUNTRY.get(fold(city));
  const sk = skPlace(city);
  if (foreignTown(city) && !isTown(sk)) return null;
  if (sk || TOWNS.has(fold(city))) return 'sk';
  return slovakLooking(text) ? 'any' : null;
}
// Words only Czech writes so (Slovak: divadelný, zámok, mlynská, ulica, námestie…), and "ČR".
const CZECH_WORDS = /(^|[^\p{L}])(divadeln[íi]|z[áa]mek|zámku|ml[ýy]nsk[áa]|ulice|n[áa]m[ěe]st[íi]|kulturn[íi]|d[ůu]m|amfite[áa]tr|sokolovna|hrad[ěe]|kostel|knihovna|společensk[ýá]|městsk[ýáé]|ČR|Česko)(?=$|[^\p{L}])/iu;
const czechLooking = (text) => CZECH_WORDS.test(text || '');
// Letters and words of Slovak (not Czech: a location with Czech-only words is abroad).
const slovakLooking = (text) => (/[áäčďéíĺľňóôŕšťúýž]/i.test(text) || slovakWords(text)) && !czechLooking(text);
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
  name = name.replace(/^(obec|mesto)\s+(?=\p{Lu})/iu, ''); // "Obec Marianka", "Mesto Šamorín"
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
  // The same strings come up again and again (every event, every source row, every pass and every
  // build of the public list): kept, since splitting them was a good part of building that list.
  const key = `${text || ''}\u0000${cityHint || ''}`;
  let p = parsed.get(key);
  if (!p) {
    if (parsed.size >= 100_000) parsed.clear();
    parsed.set(key, (p = Object.freeze(splitLocation(text, cityHint))));
  }
  return p;
}
const parsed = new Map();

function splitLocation(text, cityHint) {
  // "Online", "ZOOM", "Virtual": no place at all (looked up, they found a tyre shop "Pneu Online" in
  // Košice and "Bistro Zoom" in Nové Zámky for thousands of American webinars, Nov 2026).
  if (onlineOnly(text)) return { online: true };
  // Eventbrite's "Town · Venue" ("Dallas · Johnny Cabron's", "Staré Mesto · KC Dunaj"): the venue,
  // then its town, so the town is the location's own and not the listing's (a Dallas bar was looked
  // up in Trnava, the town of eventbrite's "/d/slovakia--trnava/" that lists American events too).
  const dot = /^([^·,|;]+?)\s+·\s+(.+)$/.exec(text || '');
  if (dot) text = `${dot[2]}, ${dot[1]}`;
  // A country on its own ("…, Slovensko", "…, Czechia", "ČR") is no part of the address.
  const parts = (text || '').split(/\s*[,|;]\s*/).map((p) => p.trim()).filter((p) => p && !countryPart(p) && !/^(ČR|CR|SR)$/i.test(p));
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
  // A village, then the region's town last: "Trnovec nad Váhom, Trnovec nad Váhom, Nitra", "Kalná nad
  // Hronom, Nitra", "HYGGE, Bojnická cesta 590,Kanianka, Trencin" are in the village (the town is the
  // listing's region, 20–40 km off). Not a borough of that town, nor a lower-case word ("rybník, Levice").
  if (at >= 0 && at === rest.length - 1) {
    const v = whole.findIndex((t, i) => i < at && t?.village && /^\p{Lu}/u.test(rest[i].p)
      && skPlace(t.city)?.partOf !== whole[at].city);
    if (v >= 0) { rest.splice(at, 1); whole.splice(at, 1); at = v; } // the region's town is no venue either
  }
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
    // no street), unless that part is a venue that merely names its town ("Miestny úrad Košice"), or
    // can't be a town at all ("kanc.č.107 a 111", "miestnosť ST121", an e-mail address).
    const cityPart = [...rest].reverse().find((r) => (r.afterStreet || !street) && !notATown(r.p));
    // A Slovak town named inside another part, when the city part names none: "Štátna filharmónia
    // Košice, Dom umenia" is in Košice, not in a town called "Dom umenia"; "Dom kultúry, Štefánikova
    // 208/7, Námestovo Duchovné, Kultúra, Rodina" in Námestovo, not in "Rodina".
    const pool = street ? rest.filter((r) => r.afterStreet).reverse() : rest;
    const inName = !looksAbroad(text) && cityPart && !townOfPart(cityPart.p)
      && pool.map((r) => townOfPart(r.p)).find(Boolean);
    if (inName) city = inName;
    else if (cityPart && (rest.length > 1 || street)) {
      const named = townOfPart(cityPart.p);
      city = named || cityPart.p;
      if (!named || rest.length > 1) rest.splice(rest.indexOf(cityPart), 1);
    }
  }
  name = rest.find((r) => !r.afterStreet)?.p ?? rest[0]?.p;
  // "Dom umenia Košice", "Tatranská galéria v Poprade", "ZŠ Martin", "Slovenské národné divadlo".
  city ??= townIn(text) || townOfPart(text) || venueTown(text);
  // The town to look the place up in (and to key the venue cache by): as written, so a town abroad
  // nobody listed is found ("Mikulov", "Barnaul"). The town shown: only a real one. A Slovak-written
  // location's last part that is no municipality is a category or a room ("…, Kultúra, Rodina").
  const cityText = city || cityHint || undefined;
  const shown = cityText && (realTown(cityText) || !slovakLooking(text)) ? cityText : undefined;
  return { name, street, postcode, city: shown, district, cityText };
}

// A Slovak town, a town in our lists or a known town abroad.
const realTown = (city) => Boolean(skPlace(city) || TOWNS.has(fold(city)) || foreignTown(city) || COUNTRY.has(fold(city)));

// The town one part names: by name ("Dom umenia Košice"), in the locative ("Hornonitrianske múzeum v
// Prievidzi"), or a town that is also a word or a first name as the last word after a venue's kind
// ("ZŠ Martin", "Slovenské komorné divadlo - Martin"; not "na Martina", "Kostol sv. Martin").
function townOfPart(part) {
  // Not "pri X" (= near X): "Village Resort HANULIAK, Belá pri Žiline" is in Belá, not in Žilina.
  return townIn(part) || locativeTown(part.replace(/(^|\s)pri\s+\S+/giu, ' ')) || afterVenueWord(part);
}
const VENUE_WORDS = 'zs|zus|ss|sos|ms|gym|gymnazium|skola|dk|kd|msks|mks|ks|sh|msh|hala|haly|divadlo|kino|stadion|stadium|arena|stadio|kostol|kniznica|muzeum|galeria|amfiteater|klub|centrum|dom kultury|kulturny dom|kupalisko|ihrisko';
const AFTER_VENUE = new Set([...AMBIGUOUS].filter((t) => !['sala', 'svit', 'modra', 'cana', 'raca', 'rakova'].includes(t)));
const AFTER_VENUE_RE = new RegExp(`(?:^|[^a-z])(?:${VENUE_WORDS})(?:[^a-z]+[a-z]+)*?[^a-z]+([a-z]+)$`);
function afterVenueWord(part) {
  const f = fold(part).replace(/[.\s]+$/, '');
  const m = AFTER_VENUE_RE.exec(f);
  if (!m || !AFTER_VENUE.has(m[1]) || /(^|[^a-z])(sv|svat[a-z]*)[.\s]+[a-z]+$/.test(f)) return undefined;
  return TOWNS.get(m[1]) || skPlace(m[1])?.name;
}
// Venues known well enough that their location gives no town.
const VENUE_TOWNS = [
  [/^(slovenske narodne divadlo|historicka budova snd|nova budova snd|snd)\b/, 'Bratislava'],
  [/^(slovenska filharmonia|koncertna sien sf|reduta bratislava)\b/, 'Bratislava'],
  [/^stare lyceum$/, 'Bratislava'],
  [/^slovenske narodne muzeum$/, 'Bratislava'],
  [/^velke koncertne studio slov/, 'Bratislava'],
  [/^zimny stadion vladimira dzurillu/, 'Bratislava'],
  [/^slovenske komorne divadlo\b/, 'Martin'],
  [/^divadlo jana palarika\b/, 'Trnava'],
  [/^divadlo andreja bagara\b/, 'Nitra'],
  [/^fnsp nz\b/, 'Nové Zámky'],
];
const venueTown = (text) => VENUE_TOWNS.find(([re]) => re.test(fold(text)))?.[1];

// Online only: isOnline (slovakia.js), and what Slovak sites write ("Forma/on-line", "Virtuálna
// miestnosť (Microsoft Teams)", "dištančná forma", "ONLINE cez aplikáciu ZOOM", "online (EduPage)",
// "ONLINE @ Inviton.TV", "Online, Slovensko"): every word one of these, one of them an online one.
const ONLINE_KEY = /^(online|zoom|teams|webinar|webinare|virtualna|virtualne|virtualny|virtualnej|distancna|distancne|distancnou|edupage|inviton|livestream|stream)$/;
const ONLINE_FILLER = new Set(['forma', 'formou', 'cez', 'aplikaciu', 'aplikacie', 'platformu', 'platformy', 'prostrednictvom',
  'seminar', 'live', 'miestnost', 'microsoft', 'ms', 'google', 'meet', 'via', 'na', 'v', 'a', 'tv', 'slovensko', 'youtube', 'kurz']);
export function onlineOnly(text) {
  if (!text) return false;
  if (isOnline(text)) return true;
  const words = fold(text).replace(/(^|[^a-z])on[\s-]?line(?=$|[^a-z])/g, '$1online').split(/[^a-z0-9]+/).filter(Boolean);
  return words.some((w) => ONLINE_KEY.test(w)) && words.every((w) => ONLINE_KEY.test(w) || ONLINE_FILLER.has(w));
}

// A part that can't be a town: a number ("…, 38", the house number), one or two letters, a US state
// ("…, Pa.", "…, MD": looked up in Slovakia they found a building "PA" in Žilina, Línia MD in Bratislava),
// a room or an office ("kanc.č.107 a 111", "miestnosť ST121", "č. 5"), an e-mail address, a company
// ("… s.r.o.)"), "celý svet (…)", a phone number, a street ("Ul. 7. pešieho pluku"), or ticket sales ("vstupenky v sieti …").
const JUNK_PART = /^(kanc\.|kancel|miestnost|ul\.\s|cely svet|europa$|zahranicie)|(^|[^a-z])(tel[.:]|c\.\s?\d|s\.\s?r\.\s?o\.|predpredaj|predaj|vstupenk[a-z]*|listky|tickets?|kategori[a-z]*|bude doplnene)([^a-z]|$)|@/;
const notATown = (part) => /^\d/.test(part) || fold(part).replace(/[^\p{L}]/gu, '').length <= 2 || usState(`x, ${part}`)
  || JUNK_PART.test(fold(part));

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
  const town = p.multi ? undefined : TOWNS.has(fold(p.cityText)) ? TOWNS.get(fold(p.cityText)) : skPlace(p.cityText)?.name || townIn(text);
  if (townCache.size > 20000) townCache.clear();
  townCache.set(text, town);
  return town;
}

/** Cache key for a place: its street (or name) and city, so spelling variants share one lookup. */
export function venueKey(text, cityHint) {
  const p = parseLocation(text, cityHint);
  if (p.multi || p.online) return null; // several towns, or online: no one place to look up
  const what = p.street ? fold(p.street).replace(/\.$/, '') : fold(p.name);
  return what ? `${what}|${fold(p.cityText)}` : `city|${fold(p.cityText)}`;
}

const AREA_TYPES = /^(city|town|village|municipality|hamlet|suburb|quarter|neighbourhood|city_district|borough|county|state|region|province|country|postcode)$/;

let lastRequest = 0;
let pausedUntil = 0; // after "too many requests", leave OpenStreetMap alone for a while
const PAUSE_MS = 3600e3;
async function nominatim(params) {
  if (Date.now() < pausedUntil) throw new Error('OpenStreetMap asked us to slow down; lookups resume later');
  const wait = lastRequest + Number(process.env.EVENTS_NOMINATIM_GAP_MS || MIN_GAP_MS) - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastRequest = Date.now();
  const url = `${NOMINATIM}?${new URLSearchParams({
    format: 'jsonv2', limit: '1', 'accept-language': 'sk,en', addressdetails: '1', ...params,
  })}`;
  // A hard deadline (fetcher.js): with AbortSignal.timeout alone, one lookup stayed pending for two
  // days (10 Nov 2026) and held the Run in "Locating events" with it.
  const [hit] = await fetchBody(url, { headers: { 'User-Agent': USER_AGENT } }, 15000, (res) => {
    if (!res.ok) res.body?.cancel().catch(() => {}); // release the connection
    if (res.status === 429 || res.status === 403) {
      pausedUntil = Date.now() + PAUSE_MS;
      throw new Error(`OpenStreetMap HTTP ${res.status}: too many requests, pausing lookups for an hour`);
    }
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    return res.json();
  });
  return hit ? {
    lat: Number(hit.lat), lon: Number(hit.lon), label: hit.display_name, osm: `${hit.osm_type}/${hit.osm_id}`,
    country: hit.address?.country_code,
    area: AREA_TYPES.test(hit.addresstype || ''), // matched a whole town/district, not a building or street
    type: hit.addresstype,
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
  // Escaped: a "town" taken from a location can be anything ("Zámocký hotel****").
  const names = townNames(fold(city)).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  // The okres counts only for a village (its okres is named after its town, never after itself).
  // For a town it's any village around: "ZŠ Levice" was found in Šahy ("okres Levice"), "Základná
  // škola, Košice" in Kysak ("okres Košice-okolie"), Nov 2026.
  const okres = skPlace(city) && !isTown(skPlace(city)) ? '(okres )?' : '';
  return fold(label).split(/\s*,\s*/).some((part) => names.some((t) => part === t
    || new RegExp(`^${okres}${t}( ?[-–]|$| [ivx]+$)`).test(part)));
}

/** A hit that can't be the known town it's meant to be in: wrong town, or far from all of ours. */
const awayFrom = (hit, city) => Boolean(city && ((TOWNS.has(fold(city))
  && ((hit.label && !inTown(hit.label, city)) || distanceKm(KOSICE, hit) > MAX_KM)) || farFromTown(hit, city)));

// A Slovak town's area: coordinates farther than this from its centre aren't in it. 30 km let a
// venue be pinned in another village of the okres ("Dom kultúry, Pezinok" in Slovenský Grob,
// "Karadžičova 1" 22 km off by Senec). Bratislava reaches 16 km (Čunovo), Vysoké Tatry is a string
// of settlements under the mountains.
const TOWN_KM = 8;
const BIG_TOWN_KM = { Bratislava: 18, Košice: 15, 'Vysoké Tatry': 16 };
/**
 * Coordinates that can't be in the Slovak town named: farther from its centre than its radius
 * ("Senec" found as a village of that name in Bohemia; a ticket page giving its organiser's address).
 * A town abroad named like a Slovak village ("Praha") isn't checked.
 */
function farFromTown(at, city) {
  const p = city && uniqueName(city) && countryOf(city) === 'sk' && skPlace(city);
  if (!p) return false;
  const town = townOfPlace(p);
  return distanceKm(town, at) > (BIG_TOWN_KM[town.name] ?? TOWN_KM);
}

// Several Slovak villages share a name ("Poproč" in okres Košice-okolie and Rimavská Sobota): the one
// the location's "okres …" names, else the one nearest a town it names or the listing covers; undefined when
// neither is known (then no pin: a map in the wrong end of the country is worse than none).
function namesake(city, text, near) {
  const all = SK_PLACES.filter((p) => !p.partOf && fold(p.name) === fold(city));
  if (all.length < 2) return all[0];
  const okres = /okres ([^,;|()]+)/.exec(fold(text || ''))?.[1]?.trim();
  if (okres) return all.find((p) => fold(p.district) === okres);
  // A town the location names too ("Krpáčovo (Banská Bystrica), …, Horná Lehota"), else the site's.
  const at = skPlace(townIn(text || '') || '') || (near && skPlace(near));
  if (!at) return undefined;
  const from = townOfPlace(at);
  return all.reduce((a, b) => (distanceKm(from, a) <= distanceKm(from, b) ? a : b));
}
// A shared village name: { place } as above, or null when no namesake can be told; undefined if not shared.
function sharedVillage(city, text, near) {
  if (!city || uniqueName(city) || !skPlace(city) || isTown(skPlace(city)) || countryOf(city) !== 'sk') return undefined;
  if (!SK_PLACES.some((p) => p !== skPlace(city) && !p.partOf && fold(p.name) === fold(city))) return undefined;
  return { place: namesake(city, text, near) || null };
}

// A hit in Slovakia for a town that is no Slovak municipality ('any'): not a building or a shop named
// like it ("MONACO" in Bratislava, "Rodina", "Čajovňa"), nor a hamlet or locality of that name when
// the name is spelt otherwise ("Políčka" for Polička, "Čákovec" for Čakovec) or the location is Czech
// ("Zámek Blatná", "Hotel Galant, Mlýnská 739, Mikulov"). Tatra resorts ("Hotel Družba, Jasná") stay.
const PLACE_TYPES = /^(hamlet|locality|isolated_dwelling|neighbourhood|quarter|suburb|village|town|city|farm|square|place)$/;
function slovakHitOk(hit, city, text) {
  if (hit.country !== 'sk') return true;
  const own = (hit.label || '').split(',')[0].trim();
  if (fold(own) !== fold(city)) return true;
  if (!(hit.area || PLACE_TYPES.test(hit.type || ''))) return false;
  return own.toLowerCase() === city.trim().toLowerCase() && slovakLooking(text) && !looksAbroad(text);
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
function townCentre(p, text, near) {
  const borough = p.district && skPlace(p.district);
  const shared = sharedVillage(p.city, text, near);
  const at = borough?.partOf === p.city ? borough : shared ? shared.place : skPlace(p.city);
  return at && { lat: at.lat, lon: at.lon, label: `${at.name}${at.partOf ? `, ${at.partOf}` : ''}${at.district ? `, okres ${at.district}` : ''}, Slovensko`,
    country: 'sk', precision: 'city', area: true };
}

/**
 * Look one place up: street address, then venue name, then the city. A place whose country isn't
 * known from its town is looked for in Slovakia first, then anywhere (to learn it's abroad).
 */
async function geocode(text, cityHint) {
  const parsed = parseLocation(text, cityHint);
  if (parsed.multi || parsed.online) return null;
  // Looked up by the town as written (a town abroad nobody listed is shown as none but found).
  const p = { ...parsed, city: parsed.cityText };
  const city = p.city;
  // A village name several share, with no way to tell which: its centre would be a guess.
  const shared = sharedVillage(city, text, cityHint);
  if (shared && !shared.place) return null;
  // A venue's name alone, of one word ("Makerspace", "Štúdio", "Wash"): any place of that name anywhere.
  if (!city && !p.street && nameWords(p.name || '').length < 2) return null;
  // Just a Slovak town ("Prešov", "Košice - Juh"): its centre, from the list.
  if (!p.street && !p.name && townCentre(p, text, cityHint)) return townCentre(p, text, cityHint);
  // The town came from the site, not from the location: the location may name another place
  // ("Stará Hora - Sebechleby" on a site about Banská Bystrica).
  const hinted = Boolean(city) && !parseLocation(text).cityText;
  const country = countryOf(city, text);
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
  const passes = country === undefined ? ['sk', null] : country === 'any' ? [null, 'sk'] : [country];
  for (const where of passes) {
    for (const [kind, params, check] of tries) {
      if (kind === 'city' && where === 'sk' && townCentre(p, text, cityHint)) return townCentre(p, text, cityHint);
      const hit = await nominatim(where ? { ...params, countrycodes: where } : params);
      if (!hit || (check && !plausible(hit, p, CHECKS[check]))) continue;
      if ((country === 'any' || country === null) && !slovakHitOk(hit, city, text)) continue;
      // The namesake meant, not another village of that name.
      if (shared && distanceKm(shared.place, hit) > TOWN_KM) continue;
      // Asking for the town must find the town, not a shop or a cinema named after it.
      if (kind === 'city' && !(hit.area && inTown(hit.label, city))) continue;
      // Precision from what OpenStreetMap found: a town or district only gives the area's centre
      // (and asking for just the town counts as that, even if the best hit is a building named after it).
      return { ...hit, precision: hit.area || kind === 'city' ? 'city' : kind };
    }
  }
  return null;
}

// Sites that are one place: their events are in its town (a town hall's calendar, a theatre's programme).
const ONE_PLACE = new Set(['municipality', 'venue', 'shopping_center']);
/**
 * The town a site's events are in, when that can be trusted. A site that is one place: its town. A
 * listing of many places (event_listing, ticketing, news…): only the town the AI gave for this very
 * page, and only on a Slovak site ("kosice.virtualne.sk/akcie…"). A whole site's town from one or two
 * pages the AI read put every event of hapsy.co in Košice, eventbrite.com's in Trnava, sportnet's in
 * Liptovský Mikuláš (Nov 2026).
 */
export function trustedCity(source, url) {
  if (!source) return undefined;
  const page = source.pages?.[url]?.city || undefined;
  if (ONE_PLACE.has(source.siteKind)) return page || source.city;
  const host = hostOf(url || '') || '';
  if (page && host.endsWith('.sk')) return page;
  // A site named after its town: "bratislava.codnes.sk", "nasekosice.sk", "visitbardejov.sk".
  return source.city && namedInHost(host, source.city) ? source.city : undefined;
}
const namedInHost = (host, city) => {
  const town = fold(city).replace(/[^a-z]/g, '');
  return town.length >= 4 && fold(host).replace(/[^a-z]/g, '').includes(town);
};
/** A site's venue, only when the site is that venue's own (a ticket shop's address is no venue). */
export const trustedVenue = (source) => (['venue', 'shopping_center'].includes(source?.siteKind) ? source.venue : undefined);

// The town the event's listing page or site covers, as a hint (trustedCity).
function cityHint(state, ev) {
  const via = ev.source || ev.sources?.[0]?.via;
  return trustedCity(sourceOf(state, ev), via);
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
  return Number.isFinite(v.lat) && awayFrom(v, parseLocation(v.text).cityText);
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
    const towns = p.multi || [p.cityText].filter(Boolean);
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
 * as the town of venues like "Shoreditch · Basing House" (parseLocation now reads "Town · Venue" itself). A site's city that most of its events'
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
 * Repair, once (15 Nov 2026): forget the places looked up under rules that put most of an American or
 * Russian event list on Slovak shops and cinemas ("Москва" at KINO Moskva in Martin, "Online" at a
 * tyre shop in Košice, "Pa." at a building in Žilina), so they're looked up again with today's.
 * Returns how many were forgotten.
 */
export function purgeDoubtfulVenues(state) {
  let n = 0;
  for (const [key, v] of Object.entries(state.venues)) {
    if (v.status !== 'ok' || v.status === 'manual' || v.precision === 'page' || v.precision === 'manual') continue;
    const city = key.slice(key.lastIndexOf('|') + 1);
    const p = parseLocation(v.text || '');
    const doubtful = p.online
      // a town that isn't Slovak, found in Slovakia
      || (city && v.country === 'sk' && (notATown(city) || countryOf(city, v.text || '') === null))
      // "the town" that is a building or a shop of that name
      || (v.precision === 'city' && city && v.label && !inTown(v.label, city))
      // one word of a venue's name, with no town
      || (!city && !p.street && nameWords(p.name || '').length < 2);
    if (doubtful) { delete state.venues[key]; n++; }
  }
  return n;
}

/**
 * Is an event in Slovakia? 'sk', 'abroad', or undefined while that isn't known. Best first: the
 * town or country its location names, the coordinates its page gives or where its place was found
 * (venues.json), the location's language, the country the AI gave, a country code in the title,
 * the listing's address, the city of its site or venue, and last what's known of its site.
 */
export function eventCountry(state, ev, { strong = false } = {}) {
  for (const { c, weak } of countrySignals(state, ev)) {
    if (weak && strong) return undefined;
    if (c) return c;
  }
  return undefined;
}

/**
 * Every clue to where an event is, best first, as { step, c } (c: 'sk' / 'abroad'). Lazy: eventCountry
 * takes the first. `weak` ones come from what's learned about the event's pages, which mustn't count
 * towards that very record (crawler.js: inSlovakiaOnly). A clue with no c ends the list (no host).
 */
export function* countrySignals(state, ev) {
  // The location's own words first: a Slovak town it names beats coordinates that disagree (a page's
  // organiser address, a same-named village abroad), a town or country abroad is abroad. A village
  // alone, on pages whose events are abroad, is the Czech one of that name.
  const via = ev.sources?.find((r) => !r.linked)?.via || ev.source;
  const own = ev.location && locationEvidence(ev.location);
  if (own === 'village') yield { step: 'village', c: via && regionAt(state, via) === 'abroad' ? 'abroad' : 'sk' };
  else if (own) yield { step: 'location', c: own };
  // What the event's page says in its schema.org data: addressCountry, or a time zone of the Americas
  // or Asia ("…T19:00:00-05:00"; extract.js: jsonLdEvents).
  const page = ev.pageCountry || ev.sources?.find((r) => r.pageCountry && !r.linked)?.pageCountry;
  if (page) yield { step: 'page', c: countryCode(page) };
  const at = coordsFor(state, ev);
  // A place looked up without any town that was found in Slovakia (Slovakia is searched first) is a
  // guess: "Las Vegas" found a bar of that name in Bratislava. It comes after what the AI, the
  // address and the language say.
  const guess = at && !['page', 'manual'].includes(at.precision) && inSlovakia(at)
    && !parseLocation(ev.location || '', cityHint(state, ev)).cityText;
  if (at && !guess) yield { step: 'coords', c: inSlovakia(at) ? 'sk' : 'abroad' };
  if (ev.location) {
    const said = locationCountry(ev.location, cityHint(state, ev));
    if (said) yield { step: 'location+hint', c: said };
    // Written in Slovak: "Dom kultúry Kanianka", "Evanjelický kostol", "Divadlo J. Palárika v Trnave".
    if (slovakWords(ev.location)) yield { step: 'slovak words', c: 'sk' };
  }
  if (ev.country) yield { step: 'ai', c: countryCode(ev.country) };
  // A country code in the title: "LEVICE (SK)", "BRUNTÁL (CZ)", "KOLLÁROVCI - CZ TOUR".
  if (/\((sk|sr)\)/i.test(ev.title || '')) yield { step: 'title code', c: 'sk' };
  if (/\((cz|čr|at|hu|pl|de|ua)\b|\bcz (mini)?tour\b/i.test(ev.title || '')) yield { step: 'title code', c: 'abroad' };
  // The listing's address: "eventbrite.com/d/united-kingdom/…", "…/Kino-Hviezda-Trencin". That it
  // names Slovakia says less on a site abroad: eventbrite's "/d/slovakia--trnava/" lists Vienna too,
  // so there it counts only for an event without a location (one with is looked up).
  const inUrl = via && countryInUrl(via);
  if (inUrl === 'abroad' || (inUrl === 'sk' && (!ev.location || hostOf(via).endsWith('.sk')))) yield { step: 'url', c: inUrl };
  // The city its listing page or site covers, or its venue's (a theatre's own site), when the
  // location says nothing we know ("Kategória: Pre deti • … • Staré divadlo" on nitra.eu).
  const src = sourceOf(state, ev);
  const venue = trustedVenue(src);
  const hint = cityHint(state, ev) || (venue && knownTown(venue));
  if (hint && locationCountry(hint)) yield { step: 'site city', c: locationCountry(hint) };
  // A site the AI judged to list events in several countries, or abroad (crawler.js: judgeSites):
  // its domain and what's learned about its pages say nothing (hockey-live.sk lists NHL games).
  const judgedAway = ['mixed', 'abroad'].includes(src?.siteVerdict?.where);
  let host;
  try { host = new URL(via).hostname; } catch { if (guess) yield { step: 'coords (no town)', c: 'sk' }; yield { step: 'no host' }; return; }
  // No place at all on a Slovak site (a cinema's coming films, a festival's own pages).
  if (!ev.location && host.endsWith('.sk') && !judgedAway) yield { step: '.sk site', c: 'sk' };
  // The language its title and description are written in (language.js). Slovak is Slovakia; Czech,
  // on a site not known to have its events in Slovakia, is abroad. English is abroad on a site
  // outside .sk when nothing in it names a Slovak town: of 7,392 such events whose country wasn't
  // known (Nov 2026) all were American or worldwide but 2, both on .sk sites.
  const text = `${ev.title || ''} ${ev.description || ''}`;
  const lang = languageOf(text);
  if (lang === 'sk') yield { step: 'slovak text', c: 'sk' };
  else if (lang === 'cz' && regionAt(state, via) !== 'sk') yield { step: 'czech text', c: 'abroad' };
  else if (lang === 'en' && (judgedAway || (!host.endsWith('.sk') && regionAt(state, via) !== 'sk'))
    && !/slovak|slovensk|bratislav/i.test(`${text} ${ev.location || ''}`) && !townIn(`${text} ${ev.location || ''}`)) {
    yield { step: 'english text', c: 'abroad' };
  }
  if (guess) yield { step: 'coords (no town)', c: 'sk' };
  if (!ev.location && !judgedAway && regionAt(state, via) === 'sk') yield { step: 'site region', c: 'sk', weak: true };
  else yield { step: 'none', weak: true };
}

// A place without a town looked up worldwide, before lookups tried Slovakia first (18 Oct 2026): a hit
// abroad says little ("Staré Mesto" found in Prague, "Klub Lúč" in Poland). It's looked up again.
const stale = (key, v) => key?.startsWith('city|') === false && key.endsWith('|') && !v.country
  && v.status === 'ok' && v.precision !== 'manual' && inSlovakia(v) === false;

// The event's coordinates, from its page or its venue's lookup: unless they're far from the Slovak town
// its location names (then they're wrong, and the venue is looked up again).
function coordsFor(state, ev, city = parseLocation(ev.location || '', cityHint(state, ev)).cityText) {
  // A village name several share: only near the namesake meant, and none when that can't be told.
  const shared = sharedVillage(city, ev.location, cityHint(state, ev));
  const off = (at) => farFromTown(at, city) || (shared && (!shared.place || distanceKm(shared.place, at) > TOWN_KM));
  const geo = pageGeo(ev);
  if (geo && !off(geo)) return { ...geo, precision: 'page' };
  if (!ev.location) return undefined;
  const [key, v] = venueFor(state, ev);
  if (!Number.isFinite(v?.lat) || off(v) || stale(key, v)) return undefined;
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
  if (p.multi || p.online) return undefined;
  const base = { name: p.name, address: [p.street, p.district, p.city].filter(Boolean).join(', '), city: p.city };
  const at = coordsFor(state, ev, p.cityText);
  if (at) return { ...base, lat: at.lat, lon: at.lon, precision: at.precision, km: at.km ?? distanceKm(KOSICE, at) };
  // None yet (or they were wrong): a Slovak town's centre, from the list.
  const centre = townCentre({ ...p, city: p.cityText }, ev.location, cityHint(state, ev));
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
      && !farFromTown(geo, parseLocation(ev.location, cityHint(state, ev)).cityText)) {
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
