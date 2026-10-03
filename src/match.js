// Deciding whether two sightings (from different websites) are the same event.
// Heuristic: dates must be close, titles must share most of their meaningful words, and the towns
// must not differ (one film plays in many towns the same day).
import { knownTown } from './geo.js';

const STOPWORDS = new Set(`a i o u v vo na do od po pri pre s so z zo za k ku je sa si to aj ale
  alebo ako the of and in at on for with to by an kosice kosiciach kosic event podujatie`.split(/\s+/));

const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

export function titleTokens(title) {
  return new Set(fold(title).split(/[^a-z0-9]+/)
    .filter((t) => t.length > 1 && !STOPWORDS.has(t) && !/^(19|20)\d\d$/.test(t)));
}

export function titleSimilarity(a, b) {
  const A = titleTokens(a), B = titleTokens(b);
  if (!A.size || !B.size) return 0;
  let common = 0;
  for (const t of A) if (B.has(t)) common++;
  const jaccard = common / (A.size + B.size - common);
  const containment = common / Math.min(A.size, B.size);
  // "Biela noc" vs "Biela noc Košice 2026 – festival svetla": containment catches it.
  return Math.max(jaccard, Math.min(A.size, B.size) >= 2 ? containment * 0.9 : 0);
}

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
    const dist = dateDistance(ev, s);
    if (dist > (s.site && ev.sources?.[0]?.site === s.site ? 1 : 3)) continue;
    const sim = titleSimilarity(ev.title, s.title);
    const ok = dist === 0 ? sim >= 0.5 : sim >= 0.85;
    const score = sim - dist * 0.05;
    if (ok && score > bestScore && !differentTowns(ev, s)) { best = ev; bestScore = score; }
  }
  return best;
}

/**
 * Could two events (or an event and a sighting) be the same thing? Sharing a URL is not enough:
 * detail pages link to generic pages ("/program?institutionId=7") and to other events, and listings
 * may give many events one link.
 */
export const couldBeSame = (a, b) => titleSimilarity(a.title, b.title) >= 0.5 && dateDistance(a, b) <= 3 && !differentTowns(a, b);
