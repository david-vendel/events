// Deciding whether two sightings (from different websites) are the same event.
// Heuristic: dates must be close, titles must share most of their meaningful words, and the towns
// must not differ (one film plays in many towns the same day). Words count by how rare they are
// among all event titles: "TOSCA" and "Giacomo Puccini: TOSCA" share the word that matters, while
// "Kino pre deti: HLAVIČKA" and "Kino pre deti: ZABUDNUTÝ OSTROV" share only words many titles have.
import { knownTown, parseLocation, withoutTowns } from './geo.js';
import { SK_PLACES, isTown, skPlace } from './slovakia.js';

// Words that say nothing about which event it is: grammar, and ticket-shop notes ("VYPREDANÉ").
const STOPWORDS = new Set(`a i o u v vo na do od po pri pre s so z zo za k ku je sa si to aj ale
  alebo ako the of and in at on for with to by an event podujatie vypredane pridane zrusene presunute
  novy termin`.split(/\s+/));

const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// Cinema listings tag the format and language: "Odysea 2D ATMOS (ČT)" is the film "Odysea". A part
// in brackets is often the original title ("Nádej (Håp)").
// (Language codes count only right after a format: "Divadlo ST" is a theatre's name.)
const FILM_TAGS = /\b(2d|3d|4dx|imax|hfr)(\s+(atmos|dolby))*(\s+(ct|st|sd|ov|cz))?\b|\b(atmos|titulky|dabing)\b/g;
const bareTitle = (t) => {
  const f = fold(t).replace(FILM_TAGS, ' ')
    .replace(/\b[a-z](?: [a-z]){2,}\b/g, (m) => m.replace(/ /g, '')); // "C A R M E N" is "carmen"
  const out = f.replace(/\s\([^)]*\)/g, ' '); // "(Ne)viditeľní" keeps its bracket
  return /[a-z0-9]/.test(out) ? out : f;
};

// A title's words: letters of any script ("Никита Шевчук. Stand Up" is not just "stand up").
const splitWords = (text) => text.split(/[^\p{L}\p{N}]+/u);

const infoCache = new Map();
/**
 * What matching reads from a title: its meaningful words (tokens; compared by their stems), the towns it names (as 4-letter
 * stems, so "Prešov", "v Prešove" and "Prešovské" agree) and, for a match ("Trenčín vs. Slovan"), its
 * two sides.
 */
function titleInfo(title) {
  let info = infoCache.get(title);
  if (info) return info;
  const words = (text) => splitWords(text)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^(\d\d?|(19|20)\d\d)$/.test(t));
  const bare = bareTitle(title);
  const all = words(bare), list = words(withoutTowns(bare));
  const kept = new Set(list);
  const towns = new Set(all.filter((w) => !kept.has(w) && !/^\d/.test(w)).map((w) => w.slice(0, 4)));
  const sides = fold(title).split(/\s(?:vs\.?|versus)\s/);
  const tokens = new Set(list.length ? list : all); // a title that is only a town ("Košice") keeps it
  info = {
    tokens,
    stems: new Set([...tokens].map(stem)),
    towns,
    teams: sides.length === 2 && sides.every((x) => teamWords(x).size) ? sides.map(teamWords) : null,
  };
  if (infoCache.size > 50000) infoCache.clear();
  infoCache.set(title, info);
  return info;
}
// A team's name by its words' stems, without the club's kind ("HK", "MFK", "ŠK"): "ŠK Slovan" is "slov".
const CLUB_WORDS = new Set(['hk', 'hc', 'sk', 'fk', 'fc', 'mfk', 'mbk', 'bk', 'msk', 'tj', 'fbc', 'fbk', 'hkm', 'mhk', 'mhc', 'osk', 'afc', 'ac', 'as', 'team']);
const teamWords = (side) => new Set(splitWords(side).filter((w) => w.length > 2 && !CLUB_WORDS.has(w) && !/^\d+$/.test(w)).map((w) => w.slice(0, 4)));
const meets = (a, b) => [...a].some((w) => b.has(w));
// Titles are compared by their words' first five letters, so a word's forms agree: "Workshop hry na
// handpan s Milanom Zdvořilým" / "… s Milan Zdvořilým", "vo Viničnom" / "Viničné".
const stem = (w) => (w.length > 5 && !/\d/.test(w) ? w.slice(0, 5) : w);

/** A title's meaningful words: no grammar words, towns, years or day/month numbers. */
export const titleTokens = (title) => titleInfo(title).tokens;

// How much each word tells events apart: log(titles / titles with the word), from all events'
// titles (useTitleWeights, once per pass). Without it every word weighs 1.
let weights = null;
export function useTitleWeights(titles) {
  const df = new Map();
  for (const t of titles) for (const w of titleInfo(t).stems) df.set(w, (df.get(w) || 0) + 1);
  const n = titles.length + 1;
  // A title found whole inside another must hold a word at most ~5 titles have ("TOSCA"), not
  // only common ones ("KONCERT", "Halloween party").
  // Nor is a short title of common words found whole in a longer one ("Vianočné trhy" in
  // "Tradičné mestské vianočné trhy 2026 Modra"): one of its words must be in at most ~40 titles.
  weights = { df, n, rare: Math.log(n / 6), telling: Math.log(n / 41) };
}
const weight = (w) => (weights ? Math.log(weights.n / ((weights.df.get(w) || 0) + 1)) : 1);

/**
 * { sim, jaccard }: sim is the weighted share of words two titles have in common, or, when the
 * shorter title is found (almost) whole in the longer one ("Biela noc" in "Biela noc Košice 2026 –
 * festival svetla"), 0.9 times that containment. Titles that name different towns ("Trenčín vs.
 * Slovan" / "Slovan vs. Žilina"), or matches with another opponent, are different events.
 */
export function titleMatch(a, b) {
  // Two items of one series ("Domáca úroda: LÁSKA", "Domáca úroda: GENERÁL GOLIAN") are told apart
  // by what follows the series name.
  const ia = (a || '').indexOf(':'), ib = (b || '').indexOf(':');
  if (ia > 0 && ib > 0) {
    const pa = titleTokens(a.slice(0, ia)), pb = titleTokens(b.slice(0, ib));
    if (pa.size && pa.size === pb.size && [...pa].every((t) => pb.has(t))) {
      const ra = a.slice(ia + 1), rb = b.slice(ib + 1);
      if (titleTokens(ra).size && titleTokens(rb).size) return titleMatch(ra, rb);
    }
  }
  const NONE = { sim: 0, jaccard: 0 };
  const ta = titleInfo(a || ''), tb = titleInfo(b || '');
  const A = ta.stems, B = tb.stems;
  if (!A.size || !B.size) return NONE;
  if (ta.towns.size && tb.towns.size && !meets(ta.towns, tb.towns)) return NONE;
  if (ta.teams && tb.teams && !ta.teams.every((x) => tb.teams.some((y) => meets(x, y)))) return NONE;
  let wa = 0, wb = 0, common = 0;
  for (const t of A) { const w = weight(t); wa += w; if (B.has(t)) common += w; }
  for (const t of B) wb += weight(t);
  const jaccard = common / (wa + wb - common);
  const small = Math.min(wa, wb);
  const shorter = wa <= wb ? A : B;
  const enough = weights ? small >= weights.rare && [...shorter].some((t) => weight(t) >= weights.telling)
    : Math.min(A.size, B.size) >= 2;
  // Containment counts only when the shorter title is (nearly) all in the longer one: "Deň radosti"
  // and "Čas radosti a veselosti" share one word, "Vianočné koncerty Zuzany Mauréry" and "FRAGILE -
  // Vianočné koncerty" two, and are different events.
  const contained = small > 0 ? common / small : 0;
  return { sim: Math.max(jaccard, enough && contained >= 0.75 ? contained * 0.9 : 0), jaccard };
}

export const titleSimilarity = (a, b) => titleMatch(a, b).sim;

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

/** How far apart two date ranges are in days (0 = overlapping). */
export function dateDistance(a, b) {
  const aEnd = a.end || a.start, bEnd = b.end || b.start;
  if (a.start <= bEnd && b.start <= aEnd) return 0;
  return Math.min(Math.abs(dayDiff(a.start, bEnd)), Math.abs(dayDiff(b.start, aEnd)));
}

/**
 * Both places are known and they're different towns: towns we know in the locations, else any town
 * they name ("Barnaul" / "Kemerovo"), else the town in the sites' addresses (zilina.virtualne.sk /
 * kosice.virtualne.sk listed one band's two concerts a day apart, at street addresses only).
 */
export const differentTowns = (a, b) => {
  const x = knownTown(a.location), y = knownTown(b.location);
  if (x && y) return x !== y;
  const px = a.location && parseLocation(a.location).city, py = b.location && parseLocation(b.location).city;
  if (px && py) return fold(px) !== fold(py);
  const hx = x || hostTown(a.url) || hostTown(a.via || a.source), hy = y || hostTown(b.url) || hostTown(b.via || b.source);
  return Boolean(hx && hy && hx !== hy);
};

// Film screenings: a cinema in the place or in the site's address, or a cinema section of a listing
// ("csfd.sk/kino/…", "kzp.sk/podujatia/kino").
const CINEMA = /(^|[^a-z])(art)?kin[oa]([^a-z]|$)|kinosal|cinema|cine-?max|filmhub|biograf/;
const urlParts = (u) => { try { const x = new URL(u); return `${x.hostname} ${x.pathname}`; } catch { return ''; } };
const isScreening = (r) => CINEMA.test(fold(r.location)) || CINEMA.test(urlParts(r.url)) || CINEMA.test(urlParts(r.via));

// Words that name no particular venue ("Kino", "Dom kultúry", "Cinema City" of Cinema City Eurovea).
const VENUE_FILLER = new Set(['kino', 'kina', 'artkino', 'multikino', 'cinema', 'cinemas', 'city', 'film', 'biograf', 'kinosala',
  'sala', 'dom', 'dk', 'kd', 'kultury', 'kulturny', 'kulturne', 'kulturneho', 'centrum', 'stredisko', 'mestske', 'mestsky', 'mks',
  'msks', 'msk', 'oc', 'nc', 'velka', 'mala', 'divadelna', 'the', 'za', 'na', 'pri', 'nam', 'namestie']);
const venueCache = new Map();
/**
 * Which cinema a row is at: the words of its venue's name (5-letter stems: "Za zrkadlom" and
 * "Zrkadlový háj" agree), the name run together ("cinemacityeurovea") and its street, or else the
 * cinema's own ticket site ("tickets.cinemacity.sk" → "cinemacity"). Null when it doesn't say.
 */
function venueOf(r) {
  const key = `${r.location || ''}|${r.url || ''}|${r.via || ''}`;
  if (venueCache.has(key)) return venueCache.get(key);
  let v = null;
  const p = r.location ? parseLocation(r.location) : {};
  const name = fold(p.name || p.district || '');
  const stems = new Set(splitWords(withoutTowns(name)).filter((w) => w.length > 1 && !VENUE_FILLER.has(w) && !/^\d/.test(w))
    .map((w) => w.slice(0, 5)));
  const street = p.street && fold(p.street).replace(/\b(ulica|ul)\b\.?/g, '').replace(/[^a-z0-9]/g, '');
  let host;
  try {
    const h = new URL(r.url).hostname, via = new URL(r.via || r.url).hostname;
    if (h !== via && CINEMA.test(h)) host = h.replace(/^www\./, '').split('.').slice(-2, -1)[0].replace(/-/g, '');
  } catch { /* no address */ }
  if (stems.size || street || host) v = { stems, joined: name.replace(/[^a-z0-9]/g, ''), street, host };
  if (venueCache.size > 50000) venueCache.clear();
  venueCache.set(key, v);
  return v;
}
const sameVenue = (x, y) => meets(x.stems, y.stems) || Boolean(x.street && x.street === y.street)
  || Boolean(x.host && (x.host === y.host || y.joined.includes(x.host)))
  || Boolean(y.host && x.joined.includes(y.host))
  || Boolean(x.joined && y.joined && (x.joined.includes(y.joined) || y.joined.includes(x.joined)));

const minutes = (t) => { const m = /^(\d\d?):(\d\d)/.exec(t || ''); return m && t !== '00:00' ? +m[1] * 60 + +m[2] : null; };
const oneDay = (r) => r.start && (!r.end || r.end === r.start);

/**
 * Two rows that can't be one event: different towns; on one day at times further apart than doors
 * and start (an hour; a quarter of an hour for a film, which has no doors: those are two
 * screenings); or a film at two different cinemas ("Ja, Rocky – Kino Lúky" / "Ja, Rocky" at Cinema
 * City Eurovea).
 */
export function rowsDiffer(x, y) {
  if (differentTowns(x, y)) return true;
  const fx = isScreening(x), fy = isScreening(y);
  if (oneDay(x) && oneDay(y) && x.start === y.start) {
    const a = minutes(x.time), b = minutes(y.time);
    if (a !== null && b !== null && Math.abs(a - b) > (fx || fy ? 15 : 60)) return true;
  }
  // (Both at a cinema: a play kulthund places in "Kino Úsmev" is in the town's "Mestské divadlo".)
  if (fx && fy) {
    const vx = venueOf(x), vy = venueOf(y);
    if (vx && vy && !sameVenue(vx, vy)) return true;
  }
  return false;
}

/**
 * An event's listing rows (a sighting is its own row). A primary row without a place takes the
 * event's, which may have been found elsewhere (the site's town, or read by AI).
 */
const listingRows = (x) => {
  const rows = x.sources?.filter((r) => !r.linked);
  if (!rows?.length) return [x];
  if (x.location && !rows[0].location && rows[0] === x.sources[0]) return [{ ...rows[0], location: x.location }, ...rows.slice(1)];
  return rows;
};

/**
 * Some listing row of a disagrees with some listing row of b (rowsDiffer): an event's town, times
 * and cinema are what all its rows say, not only its primary row (which may give no town).
 */
export const clash = (a, b) => {
  const ra = listingRows(a), rb = listingRows(b);
  return ra.some((x) => rb.some((y) => rowsDiffer(x, y)));
};

// A Slovak town as the first part of a site's address: "zilina.virtualne.sk" → Žilina, with its
// words run together or hyphenated: "rimavskasobota.virtualne.sk", "banska-bystrica.dnes24.sk".
const hostTowns = new Map();
let joinedTowns; // "rimavskasobota" -> "Rimavská Sobota" (names two towns share are left out)
function hostTown(url) {
  let label;
  try { label = new URL(url).hostname.replace(/^www\./, '').split('.'); } catch { return undefined; }
  if (label.length < 3) return undefined;
  if (!hostTowns.has(label[0])) {
    if (!joinedTowns) {
      joinedTowns = new Map();
      for (const t of SK_PLACES) {
        if (!isTown(t) || t.partOf) continue;
        const k = fold(t.name).replace(/[^a-z]/g, '');
        joinedTowns.set(k, joinedTowns.has(k) ? null : t.name);
      }
    }
    const p = skPlace(label[0].replace(/-/g, ' '));
    if (hostTowns.size > 5000) hostTowns.clear();
    hostTowns.set(label[0], (p && isTown(p) && !p.partOf ? p.name : undefined)
      || joinedTowns.get(label[0].replace(/-/g, '')) || undefined);
  }
  return hostTowns.get(label[0]);
}

const isRun = (x) => Boolean(x.end && x.end > x.start);

/**
 * Do two titles name one event, at this distance in days? Same or overlapping dates need a
 * moderately similar title (min, 0.5 by default); further apart needs a near-identical one. A title
 * that matches only by being found inside the other is not enough between a single day and a run of
 * days: that's a festival and one show of it ("BASSFEST+ 2026" / "Orchester BassFest+ 2026 - Puškár").
 */
function titlesAgree(a, b, dist, min = 0.5) {
  const { sim, jaccard } = titleMatch(a.title, b.title);
  if (!(dist === 0 ? sim >= min : sim >= 0.85)) return 0;
  if (jaccard < min && a.start && b.start && isRun(a) !== isRun(b)) return 0;
  return sim;
}

/**
 * Find the existing event a sighting belongs to, or null.
 * Same/overlapping dates need a moderately similar title; up to 3 days apart needs a near-identical
 * title (that's a date mismatch between sources, shown in red). Recurring events with the same title
 * (e.g. every first Wednesday) are further apart than that, so they stay separate.
 * One site listing the same title on the next day is another day of a run ("Október v knižnici",
 * listed once per day): it joins the event and widens its dates. Two or three days apart on the
 * same site are separate performances, not a mismatch.
 */
export function findSameEvent(events, s) {
  let best = null, bestScore = 0;
  for (const ev of events) {
    const score = sameEventScore(ev, s, Boolean(s.site && ev.sources?.[0]?.site === s.site));
    if (score > bestScore) { best = ev; bestScore = score; }
  }
  return best;
}

/** How sure we are that a and b are one event (0 = they aren't); `sameSite`: both from one site. */
export function sameEventScore(a, b, sameSite = false) {
  const dist = dateDistance(a, b);
  if (dist > (sameSite ? 1 : 3)) return 0;
  const sim = titlesAgree(a, b, dist);
  return sim && !clash(a, b) ? sim - dist * 0.05 : 0;
}

/**
 * Could two events (or an event and a sighting) be the same thing? Sharing a URL is not enough:
 * detail pages link to generic pages ("/program?institutionId=7") and to other events, and listings
 * may give many events one link.
 */
export const couldBeSame = (a, b) => {
  const dist = dateDistance(a, b);
  return dist <= 3 && titlesAgree(a, b, 0) > 0 && !clash(a, b);
};
