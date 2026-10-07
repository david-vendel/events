// Deciding whether two sightings (from different websites) are the same event.
// Heuristic: dates must be close, titles must share most of their meaningful words, and the towns
// must not differ (one film plays in many towns the same day). Words count by how rare they are
// among all event titles: "TOSCA" and "Giacomo Puccini: TOSCA" share the word that matters, while
// "Kino pre deti: HLAVIČKA" and "Kino pre deti: ZABUDNUTÝ OSTROV" share only words many titles have.
import { knownTown, withoutTowns } from './geo.js';

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

const tokenCache = new Map();
/** A title's meaningful words: no grammar words, towns, years or day/month numbers. */
export function titleTokens(title) {
  let set = tokenCache.get(title);
  if (set) return set;
  const words = (text) => text.split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^(\d\d?|(19|20)\d\d)$/.test(t));
  const bare = bareTitle(title);
  const list = words(withoutTowns(bare));
  set = new Set(list.length ? list : words(bare)); // a title that is only a town ("Košice") keeps it
  if (tokenCache.size > 50000) tokenCache.clear();
  tokenCache.set(title, set);
  return set;
}

// How much each word tells events apart: log(titles / titles with the word), from all events'
// titles (useTitleWeights, once per cycle). Without it every word weighs 1.
let weights = null;
export function useTitleWeights(titles) {
  const df = new Map();
  for (const t of titles) for (const w of titleTokens(t)) df.set(w, (df.get(w) || 0) + 1);
  const n = titles.length + 1;
  // A title found whole inside another must hold a word at most ~5 titles have ("TOSCA"), not
  // only common ones ("KONCERT", "Halloween party").
  weights = { df, n, rare: Math.log(n / 6) };
}
const weight = (w) => (weights ? Math.log(weights.n / ((weights.df.get(w) || 0) + 1)) : 1);

/**
 * { sim, jaccard }: sim is the weighted share of words two titles have in common, or, when the
 * shorter title is found whole in the longer one ("Biela noc" in "Biela noc Košice 2026 – festival
 * svetla"), 0.9 times that containment.
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
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return { sim: 0, jaccard: 0 };
  let wa = 0, wb = 0, common = 0;
  for (const t of A) { const w = weight(t); wa += w; if (B.has(t)) common += w; }
  for (const t of B) wb += weight(t);
  const jaccard = common / (wa + wb - common);
  const small = Math.min(wa, wb);
  const enough = weights ? small >= weights.rare : Math.min(A.size, B.size) >= 2;
  return { sim: Math.max(jaccard, enough && small > 0 ? (common / small) * 0.9 : 0), jaccard };
}

export const titleSimilarity = (a, b) => titleMatch(a, b).sim;

const dayDiff = (a, b) => Math.round((Date.parse(a) - Date.parse(b)) / 864e5);

/** How far apart two date ranges are in days (0 = overlapping). */
export function dateDistance(a, b) {
  const aEnd = a.end || a.start, bEnd = b.end || b.start;
  if (a.start <= bEnd && b.start <= aEnd) return 0;
  return Math.min(Math.abs(dayDiff(a.start, bEnd)), Math.abs(dayDiff(b.start, aEnd)));
}

/** Both places are known and they're different towns. */
export const differentTowns = (a, b) => {
  const x = knownTown(a.location), y = knownTown(b.location);
  return Boolean(x && y && x !== y);
};

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
  if (dist > (sameSite ? 1 : 3) || differentTowns(a, b)) return 0;
  const sim = titlesAgree(a, b, dist);
  return sim && sim - dist * 0.05;
}

/**
 * Could two events (or an event and a sighting) be the same thing? Sharing a URL is not enough:
 * detail pages link to generic pages ("/program?institutionId=7") and to other events, and listings
 * may give many events one link.
 */
export const couldBeSame = (a, b) => {
  const dist = dateDistance(a, b);
  return dist <= 3 && !differentTowns(a, b) && titlesAgree(a, b, 0) > 0;
};
