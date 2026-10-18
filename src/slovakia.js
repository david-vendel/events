// What's in Slovakia: the crawler collects events in Slovakia only.
//   - sk-places.json: every municipality (and the boroughs of Bratislava and Košice) with its
//     coordinates, population, district, website and names in other languages, from Wikidata;
//     scripts/build-geo.js rebuilds it.
//   - sk-border.json: the country's outline from OpenStreetMap, to tell whether coordinates are in.
//   - Words that name another country or a well-known town abroad, for location texts like
//     "MS Uferpark, Hamburg" or "Lucerna, Praha" before any lookup.
import fs from 'node:fs';

const read = (f) => JSON.parse(fs.readFileSync(new URL(f, import.meta.url), 'utf8'));
export const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();

/** [{ name, lat, lon, pop, district, town, partOf, web, aka }], biggest first. */
export const SK_PLACES = read('./sk-places.json');
const BORDER = read('./sk-border.json'); // [[lat, lon], …]

// Folded name -> the place. Several villages share a name ("Podhradie" ×3): the biggest wins, which
// is right about the country and close enough for a map of the region.
const byName = new Map();
const shared = new Set(); // names of several municipalities
for (const p of SK_PLACES) {
  if (byName.has(fold(p.name))) shared.add(fold(p.name));
  else byName.set(fold(p.name), p);
}
// Boroughs named like ordinary words ("Juh" = south, "Sever", "Staré Mesto"): only as "Košice-Juh".
const GENERIC_PARTS = new Set(['juh', 'sever', 'zapad', 'stare mesto', 'nove mesto', 'nad jazerom', 'dzungla', 'krasna',
  'sidlisko kvp', 'sidlisko tahanovce', 'dargovskych hrdinov']);

/** The Slovak municipality called this ("Prešov", "Petržalka"); undefined if none. */
export function skPlace(name) {
  const k = fold(name);
  const p = byName.get(k);
  if (!p || (p.partOf && GENERIC_PARTS.has(k))) return undefined;
  return p;
}

// Postcodes of the two cities with boroughs: Bratislava 8xx xx, Košice 040–044 xx.
const CITY_POSTCODE = { Bratislava: /^8/, Košice: /^04[0-4]/ };
/** A borough named like an ordinary word, made certain by the postcode ("040 01 Staré Mesto" → Košice). */
export function boroughOf(name, postcode) {
  if (!postcode) return undefined;
  const k = fold(name);
  const p = SK_PLACES.find((x) => x.partOf && fold(x.name) === k && CITY_POSTCODE[x.partOf]?.test(postcode));
  return p && { city: p.partOf, district: p.name };
}

/** Is this the name of only one Slovak municipality (so its centre is certain)? */
export const uniqueName = (name) => byName.has(fold(name)) && !shared.has(fold(name));

/** A town, not a village: by status, or by size. Text naming one is good evidence of the place. */
export const isTown = (p) => Boolean(p && (p.town || p.pop >= 5000));

/** The town a place belongs to for the website's town filter (Petržalka → Bratislava). */
export const townOfPlace = (p) => (p?.partOf ? byName.get(fold(p.partOf)) : p);

/** Towns and boroughs to recognise in a text: towns by status or size. */
export const SK_TOWN_NAMES = SK_PLACES.filter((p) => isTown(p) && !GENERIC_PARTS.has(fold(p.name))).map((p) => p.name);

// Point in polygon (ray casting), lat/lon as plane coordinates: fine at this scale.
function inside(lat, lon) {
  let inPoly = false;
  for (let i = 0, j = BORDER.length - 1; i < BORDER.length; j = i++) {
    const [ai, oi] = BORDER[i], [aj, oj] = BORDER[j];
    if ((oi > lon) !== (oj > lon) && lat < ((aj - ai) * (lon - oi)) / (oj - oi) + ai) inPoly = !inPoly;
  }
  return inPoly;
}

// Distance in km from a point to the border line (the outline is simplified to ~300 m).
function kmToBorder(lat, lon) {
  const kx = 111.32 * Math.cos((lat * Math.PI) / 180), ky = 110.57;
  let best = Infinity;
  for (let i = 0, j = BORDER.length - 1; i < BORDER.length; j = i++) {
    const ax = (BORDER[j][1] - lon) * kx, ay = (BORDER[j][0] - lat) * ky;
    const bx = (BORDER[i][1] - lon) * kx, by = (BORDER[i][0] - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const BOX = { s: 47.7, n: 49.65, w: 16.8, e: 22.6 };
/** Are these coordinates in Slovakia (or within half a kilometre of its border)? */
export function inSlovakia(at) {
  const { lat, lon } = at || {};
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return undefined;
  if (lat < BOX.s || lat > BOX.n || lon < BOX.w || lon > BOX.e) return false;
  return inside(lat, lon) || kmToBorder(lat, lon) < 0.5;
}

// Other countries, as a location or a URL may name them (in Slovak, Czech, English or their own language).
const COUNTRIES = ['cesko', 'ceska republika', 'czech republic', 'czechia', 'rakusko', 'austria', 'osterreich',
  'oesterreich', 'madarsko', 'hungary', 'magyarorszag', 'polsko', 'poland', 'polska', 'nemecko', 'germany', 'deutschland',
  'ukrajina', 'ukraine', 'chorvatsko', 'croatia', 'hrvatska', 'slovinsko', 'slovenia', 'taliansko', 'italy', 'italia',
  'francuzsko', 'france', 'spanielsko', 'spain', 'espana', 'united kingdom', 'great britain', 'england', 'scotland',
  'ireland', 'netherlands', 'nederland', 'holandsko', 'belgium', 'belgie', 'switzerland', 'schweiz', 'svajciarsko',
  'denmark', 'danmark', 'sweden', 'sverige', 'norway', 'norge', 'finland', 'portugal', 'greece', 'romania', 'serbia',
  'bulgaria', 'usa', 'united states', 'canada', 'australia', 'new zealand', 'argentina', 'singapore', 'hong kong'];
// Towns abroad that events lists name most (neighbours first), in the spellings they're written in.
const FOREIGN_TOWNS = ['praha', 'prague', 'brno', 'ostrava', 'olomouc', 'zlin', 'plzen', 'pardubice', 'hradec kralove',
  'ceske budejovice', 'liberec', 'jihlava', 'opava', 'frydek-mistek', 'novy jicin', 'havirov', 'karvina', 'uherske hradiste',
  'hodonin', 'breclav', 'znojmo', 'kromeriz', 'prerov', 'trinec', 'vsetin', 'valasske mezirici', 'roznov pod radhostem',
  'wien', 'vienna', 'vieden', 'graz', 'linz', 'salzburg', 'innsbruck', 'klagenfurt', 'st. polten', 'eisenstadt',
  'budapest', 'miskolc', 'gyor', 'debrecen', 'szeged', 'pecs', 'sopron', 'esztergom', 'komarom',
  'krakow', 'krakov', 'warszawa', 'warsaw', 'varsava', 'wroclaw', 'katowice', 'gdansk', 'poznan', 'lodz', 'rzeszow',
  'zakopane', 'nowy sacz', 'uzhorod', 'uzhhorod', 'lviv', 'kyiv', 'kiev', 'berlin', 'hamburg', 'munchen', 'muenchen',
  'munich', 'koln', 'cologne', 'frankfurt', 'frankfurt am main', 'stuttgart', 'dusseldorf', 'dortmund', 'essen', 'leipzig',
  'dresden', 'hannover', 'nurnberg', 'nuremberg', 'bremen', 'potsdam', 'london', 'manchester', 'paris', 'amsterdam',
  'rotterdam', 'den haag', 'brussels', 'bruxelles', 'zurich', 'geneve', 'milano', 'milan', 'roma', 'rome', 'madrid',
  'barcelona', 'lisboa', 'lisbon', 'copenhagen', 'kobenhavn', 'stockholm', 'oslo', 'dublin', 'new york', 'los angeles',
  'chicago', 'nashville', 'toronto', 'sydney', 'melbourne', 'brisbane', 'auckland'];
const FOREIGN_TOWN_SET = new Set(FOREIGN_TOWNS);
const words = (list) => list.map((w) => w.replace(/[\s-]+/g, '[\\s-]+')).sort((a, b) => b.length - a.length).join('|');
const COUNTRY_RE = new RegExp(`(?:^|[^a-z])(${words(COUNTRIES)})(?=$|[^a-z])`);
const SLOVAKIA_RE = /(?:^|[^a-z])(cela sr|cele slovensko|slovensko|slovakia|slovak republic|slovenska republika|slowakei)(?=$|[^a-z])/;
// A part of a location without postcodes and district numbers ("110 00 Praha 1" → "praha").
const bare = (part) => fold(part).replace(/\b[a-z]{0,2}-?\d[\d\s]*\b/g, ' ').replace(/\s+/g, ' ').trim();

/** A town abroad as written in a location, without its postcode ("1010 Wien" → "Wien"); undefined if it isn't one. */
export function foreignTown(text) {
  if (!FOREIGN_TOWN_SET.has(bare(text))) return undefined;
  return text.replace(/\b[A-Z]{0,2}-?\d[\d\s]*\b/g, ' ').replace(/\s+/g, ' ').trim();
}

/** A location part that is only a country ("Slovensko", "Czechia", "DE"): 'sk', 'abroad', or undefined. */
export function countryPart(text) {
  const t = (text || '').trim();
  if (/^(SK|SVK)$/.test(t)) return 'sk';
  if (/^(CZ|AT|HU|PL|DE|UA|UK|GB|US|USA|NL|BE|FR|IT|ES|CH|DK|SE|NO|IE|AU|NZ|CA)$/.test(t)) return 'abroad';
  const f = bare(t);
  if (SLOVAKIA_RE.test(f) && f.split(' ').length <= 3 && !f.includes(',')) return SLOVAKIA_RE.exec(f)[0].trim() === f ? 'sk' : undefined;
  return COUNTRIES.includes(f) ? 'abroad' : undefined;
}

/** A country named in a location: "…, Slovensko", "Zlín (CZ)", "(SR - Žilinský kraj)", "…, Germany". */
export function countryNamed(text) {
  const f = fold(text);
  if (!f) return undefined;
  if (SLOVAKIA_RE.test(f) || /\((sr|sk)\b/.test(f)) return 'sk';
  return COUNTRY_RE.test(f) || /\((cz|cr|at|hu|pl|de|ua)\)/.test(f) ? 'abroad' : undefined;
}

// Letters Slovak never uses (Czech ě ř ů, German ß, Spanish ñ, Nordic å ø æ…; not the ö ü ő ű of
// Hungarian names in southern Slovakia), and street words of other languages.
const FOREIGN_LETTERS = /[ěřůßñçèêëàâåøæ]/i;
const GERMAN_STREET = /[a-zäöüß](gasse|strasse|straße|platz|allee)\b/i; // "Lerchengasse", "Hauptstraße"
const FOREIGN_STREET = /(^|[^a-z])(street|st\.|road|rd\.|avenue|ave\.|boulevard|blvd|drive|highway|lane|strasse|straße|gasse|platz|allee|rue|calle|avinguda|avenida|piazza|plein|straat|laan|ulice|namesti|trida)([^a-z]|$)/i;

/**
 * Signs in a location that it's abroad: a town abroad as a whole part ("…, Hamburg", not "Café
 * Paris"), letters Slovak doesn't have ("Hořice"), street words of other languages ("Fraser Highway").
 * Only for a location that names no Slovak municipality.
 */
export function looksAbroad(text) {
  if (!text) return false;
  if (fold(text).split(/\s*[,|;]\s*/).some((p) => FOREIGN_TOWN_SET.has(bare(p)))) return true;
  return FOREIGN_LETTERS.test(text) || FOREIGN_STREET.test(text) || GERMAN_STREET.test(text);
}

const FOREIGN_TOWN_RE = new RegExp(`(?:^|[^a-z])(${words(FOREIGN_TOWNS)})(?=$|[^a-z])`);
/**
 * What a page's address says about the country of its events: 'sk', 'abroad' or undefined
 * ("eventbrite.com/d/united-kingdom/…", "…/d/spain--madrid/", "…/festivals/hamburg", "…/slovakia--bratislava/",
 * "allevents.in/kosice/…").
 */
export function countryInUrl(url) {
  let path;
  try { const u = new URL(url); path = decodeURIComponent(u.pathname + u.search); } catch { return undefined; }
  const f = fold(path).replace(/[^a-z]+/g, ' ');
  if (SLOVAKIA_RE.test(f)) return 'sk';
  if (COUNTRY_RE.test(f) || FOREIGN_TOWN_RE.test(f)) return 'abroad';
  return skTownUrlRe().test(f) ? 'sk' : undefined;
}

// A Slovak town in an address ("allevents.in/bratislava/…", "ticketportal…/Kino-Hviezda-Trencin"):
// towns of 6+ letters, and not those that are also first names or words (Martin, Senica…).
const URL_TOWN_DENY = new Set(['martin', 'senica', 'snina', 'brezno', 'malacky', 'rajec', 'svidnik', 'turany', 'sered']);
let townUrlRe;
const skTownUrlRe = () => (townUrlRe ??= new RegExp(`(?:^|\\s)(${words([...new Set(SK_PLACES
  .filter((p) => isTown(p) && !p.partOf).map((p) => fold(p.name).replace(/[^a-z]+/g, ' ')))]
  .filter((t) => t.length >= 6 && !URL_TOWN_DENY.has(t) && !shared.has(t)))})(?=$|\\s)`));

// Country domains other than Slovakia's: a site there publishes events abroad unless it shows otherwise.
const FOREIGN_TLD = /\.(cz|de|at|hu|pl|ua|uk|nl|be|fr|it|es|pt|ch|dk|se|no|fi|ie|gr|ro|hr|si|rs|bg|us|ca|au|nz|sg|hk|mx|ar|br|in|jp|cn)$/;
/** Is this host on another country's domain ("kinoaero.cz", "eventbrite.co.uk")? */
export const foreignHost = (host) => FOREIGN_TLD.test(host || '');

/** A country as the AI or a geocoder gives it ("Slovakia", "SK", "Česko") → 'sk' / 'abroad'. */
export function countryCode(c) {
  const f = fold(c);
  if (!f) return undefined;
  return /^(sk|svk|slovakia|slovensko|slovak republic|slovenska republika)$/.test(f) ? 'sk' : 'abroad';
}

// ---------------------------------------------------------------- where a page's events are

/**
 * A tally of events by country ({ sk, abroad }: counts of events found on pages of one template,
 * one site…) as a verdict: 'sk', 'abroad', 'mixed', or undefined while fewer than 3 are known.
 */
export function regionOf(c) {
  const known = (c?.sk || 0) + (c?.abroad || 0);
  if (known < 3) return undefined;
  const share = (c.sk || 0) / known;
  return share < 0.15 ? 'abroad' : share > 0.85 ? 'sk' : 'mixed';
}

// ---------------------------------------------------------------- towns' names in other languages

// Hungarian, German, Polish and Czech names of Slovak towns ("Kassa", "Pressburg", "Eperjes",
// "Érsekújvár"): Hungarian and Austrian sites write them so. Only towns' (a village's other name is
// too often a village abroad too), only names of 5+ letters that name one town and no place abroad
// we know, and not these, which are common place names or surnames elsewhere:
const ALIAS_DENY = new Set(['rosenberg', 'konigsberg', 'rosenau', 'landeck', 'altdorf', 'altendorf', 'freistadt',
  'freistadtl', 'sankt georgen', 'waltersdorf', 'wartberg', 'glashutte', 'bad stuben', 'simony', 'solna', 'hradok',
  'vrbica', 'komorn', 'komarom', 'ujhely', 'bries', 'briesen', 'parkan', 'bazin', 'straze', 'brezova', 'nova lehota',
  'zelis', 'csolle', 'lebentz', 'leopoldstadt', 'stara dala', 'hanusovce', 'sastin', 'calovo', 'cela', 'guta']);
// Old German names Wikidata lacks.
const MORE_ALIASES = { Košice: ['Kaschau'], Prešov: ['Preschau'] };

/** [[other name, Slovak name]] of towns. */
export const SK_ALIASES = (() => {
  const seen = new Map(); // folded alias -> town, or null when two towns share it
  for (const p of SK_PLACES) {
    if (!isTown(p) || p.partOf) continue;
    for (const a of [...(p.aka || []), ...(MORE_ALIASES[p.name] || [])]) {
      const k = fold(a);
      if (k.length < 5 || !/^\p{Lu}/u.test(a) || ALIAS_DENY.has(k) || byName.has(k) || FOREIGN_TOWN_SET.has(k)) continue;
      seen.set(k, seen.has(k) && seen.get(k)?.p !== p ? null : { a, p });
    }
  }
  const out = [];
  for (const [k, v] of seen) {
    if (!v) continue;
    byName.set(k, v.p); // skPlace("Kassa") is Košice
    out.push([v.a, v.p.name]);
  }
  return out;
})();

// ---------------------------------------------------------------- a mixed site's Slovak pages

// Biggest towns first: the Slovak pages to try on a site that has a page per place.
const VARIANT_TOWNS = SK_PLACES.filter((p) => isTown(p) && !p.partOf).slice(0, 8).map((p) => p.name);
const slug = (s) => fold(s).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
const COUNTRY_SLUGS = new Set(COUNTRIES.map(slug).concat(['united-states', 'uk', 'us']));

/**
 * The same page for Slovak towns, for an address with a place in it: "eventbrite.com/d/germany--
 * hamburg/networking" → ".../d/slovakia--bratislava/networking", "allevents.in/vienna/concerts" →
 * "allevents.in/bratislava/concerts". [] when the address has no place we can swap.
 */
export function slovakVariants(url, towns = VARIANT_TOWNS) {
  let u;
  try { u = new URL(url); } catch { return []; }
  if (u.hostname.endsWith('.sk')) return [];
  const parts = u.pathname.split('/');
  for (let i = 0; i < parts.length; i++) {
    let seg;
    try { seg = fold(decodeURIComponent(parts[i])); } catch { continue; }
    const m = seg.match(/^([a-z-]+?)--/);
    let make;
    if (m && COUNTRY_SLUGS.has(m[1])) make = (t) => `slovakia--${slug(t)}`; // country--town(--id)
    else if (FOREIGN_TOWN_SET.has(seg.replace(/-/g, ' '))) make = slug; // a town
    else continue;
    return towns.map((t) => {
      const v = new URL(u);
      v.pathname = parts.map((p, j) => (j === i ? make(t) : p)).join('/');
      v.search = '';
      return v.href;
    });
  }
  return [];
}

/**
 * Does a (folded) text name a Slovak town: its name or, for names of 6+ letters, a form of it
 * ("bratislavske", "kosicky", "v-trencine"), or its name in another language ("kassa")? For link
 * priorities; not names that are also first names or words (Martin, Senica…).
 */
export function namesSkTown(folded) {
  textTownRe ??= new RegExp(`(?:^|[^a-z])(${words([...new Set(SK_PLACES.filter((p) => isTown(p) && !p.partOf)
    .map((p) => fold(p.name).replace(/[^a-z]+/g, ' ')).filter((t) => t.length >= 5 && !URL_TOWN_DENY.has(t))
    .map((t) => (t.length >= 6 ? t.slice(0, -1) : t))
    .concat(SK_ALIASES.map(([a]) => fold(a).replace(/[^a-z]+/g, ' ')).filter((a) => a.length >= 5)))])})`);
  return textTownRe.test(folded);
}
let textTownRe;

// ---------------------------------------------------------------- Slovak or Czech, from the words

// Letters only Slovak has (not Czech), and venue words spelt so only in Slovak ("Dom kultúry" is
// "Dům kultury" in Czech, "námestie" "náměstí", "kostol" "kostel", "knižnica" "knihovna").
const SLOVAK_LETTERS = /[äľĺŕô]/i;
const SLOVAK_WORDS = /(^|[^a-z])(dom (kultury|umenia|hudby|matice|odborov|techniky|seniorov|mladeze|kniznice)|namestie|namestia|ulica|ulici|kulturny|kulturne|kulturneho|obecny|obecna|obecne|obecnom|kostol|kostole|kniznica|kniznici|kniznice|zamok|zamku|galeria|galerii|amfiteater|amfiteatri|sala kultury|mestsky urad|obecny urad|pod holym nebom)([^a-z]|$)/;
// Letters only Czech has, among those Slovak lacks.
const CZECH_LETTER = /[ěřů]/i;

/**
 * A Slovak town in the locative ("Divadlo Jána Palárika v Trnave", "knižnica v Tvrdošovciach",
 * "v Košiciach"): the town's name less its last letter or two, plus a short ending. Its name, or undefined.
 */
export function locativeTown(text) {
  if (!text || CZECH_LETTER.test(text)) return undefined;
  for (const m of fold(text).matchAll(/(?:^|[^a-z])(?:vo?|na|pri) ([a-z]{4,})/g)) {
    const word = m[1];
    const town = locativeStems().find(({ stem }) => word.startsWith(stem) && word.length <= stem.length + 4);
    if (town) return town.name;
  }
  return undefined;
}
// One-word towns of 5+ letters with their stems ("trnava" → "trnav", "tvrdosovce" → "tvrdosov").
let stems;
const locativeStems = () => (stems ??= SK_PLACES.filter((p) => isTown(p) && !p.partOf)
  .map((p) => ({ name: p.name, f: fold(p.name) })).filter(({ f }) => /^[a-z]+$/.test(f) && f.length >= 5 && !URL_TOWN_DENY.has(f))
  .map(({ name, f }) => ({ name, stem: f.slice(0, f.length - (/[aeiouy]$/.test(f.slice(0, -1)) ? 2 : 1)) }))
  .filter((p) => p.stem.length >= 4));

/** Is this location written in Slovak (letters or venue words only Slovak has, or a town in the locative)? */
export function slovakWords(text) {
  if (!text) return false;
  return SLOVAK_LETTERS.test(text) || SLOVAK_WORDS.test(fold(text)) || Boolean(locativeTown(text));
}

/** Is this text Czech (two or more letters only Czech has: "Městské divadlo", "Třemošnice")? */
export function czechWords(text) {
  return ((text || '').match(/[ěřů]/gi) || []).length >= 2;
}
