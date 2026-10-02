// What kind of event something is: a fixed set of tags the website can filter by.
// Programmatic first, AI only when that is unsure, and the AI's answers become new rules:
//   1. schema.org @type (ScreeningEvent → cinema…) and tags of the listing page (its heading says
//      "Program kina", or the page AI said it's a cinema programme),
//   2. the keyword rules below (venue, URL, title),
//   3. learned rules (state.tagRules): every event the cheap AI model tags is counted per venue,
//      per listing page and per title word. Once a venue / page / word has been tagged the same way
//      often enough, that tag is applied without AI ("Kino Úsmev" → cinema), but only to events
//      steps 1–2 left without a tag,
//   4. only events still without a tag are sent to the AI (crawler.js → tagUncertainEvents).
import { venueKey } from './geo.js';
export const TAGS = ['cinema', 'concert', 'theatre', 'exhibition', 'festival', 'kids', 'sport', 'workshop', 'talk', 'party', 'market'];

const SCHEMA_TYPES = {
  ScreeningEvent: 'cinema', MusicEvent: 'concert', TheaterEvent: 'theatre', ExhibitionEvent: 'exhibition',
  Festival: 'festival', ChildrensEvent: 'kids', SportsEvent: 'sport', EducationEvent: 'workshop',
  LiteraryEvent: 'talk', DanceEvent: 'party', SocialEvent: 'party', FoodEvent: 'market', SaleEvent: 'market',
  ComedyEvent: 'theatre',
};

export const tagsFromSchemaTypes = (types) => [...new Set(types.map((t) => SCHEMA_TYPES[t]).filter(Boolean))];

const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// A film screening: cinema venue, cinema programme page, or "2D/3D" in the title. Film titles
// would trip the keyword rules ("Zápas storočia" is not a sports match), so these get only "cinema".
const CINEMA_PLACE = /\bkin[oa]\b|cinemax|cinema ?city|\bsterio\b|program-kina|\/kin[oa]\//;
const CINEMA_TITLE = /\b[234]d\b|\b(dabing|titulky)\b|\bimax\b|\bfilm(ov[ya]?)?\b|projekci/;

// The only keyword tags a screening keeps: a kids' film, a film festival.
const FILM_EXTRA = ['kids', 'festival'];

const RULES = [
  ['concert', /koncert|concert|\btour\b|\bband\b|orchest|recital|filharmon|symfon|jazz|\brock|metal\b|hip.?hop|\brap\b|\bdj\b|\bspev|zbor\b|\blive\b/],
  ['theatre', /divadl|predstaveni|inscenac|\bopera|balet|muzikal|theat|stand.?up/],
  ['exhibition', /vystav|vernisaz|exhibit|expozic|(?<!oc )galeri[ae]\b|\bmuze/],
  ['festival', /festival|\bfest\b|majales|biela noc|dni mesta/],
  ['kids', /\bdeti\b|\bdeti |detsk|pre najmensich|rozpravk|\bkids\b|rodin(y|ne|u)\b|\bjunior/],
  ['sport', /\bbeh\b|maraton|turnaj|hokej|futbal|basketbal|volejbal|\bsport|cyklo|\brun\b|fitness|\bjog[ay]\b|plavan/],
  ['workshop', /workshop|\bkurz|dielni|tvoriv|kreativn|masterclass|seminar/],
  ['talk', /prednask|beseda|diskusi|\btalk\b|konferenc|literatur|\bcitani|autorsk|krst knihy|podcast/],
  ['party', /party|\bparty|disco|clubb|salsa|tango|tanec|tancovani|\bples\b|kviz|quiz/],
  ['market', /\btrh|jarmok|market|burza|ochutnavk|degustac|\bfood|\bvin(o|a)\b|wine|gastro|bazar|street food/],
];

/** Tags for one sighting or event, from its text and URLs. */
export function guessTags({ title, description, location, url, via, source }) {
  const place = fold(`${location} ${url} ${via || source}`);
  const name = fold(title);
  const text = fold(`${title} ${description} ${location}`);
  const tags = RULES.filter(([, re]) => re.test(text)).map(([tag]) => tag);
  if (CINEMA_PLACE.test(place) || CINEMA_TITLE.test(name)) return ['cinema', ...tags.filter((t) => FILM_EXTRA.includes(t))];
  return tags;
}

/** Tags from a listing page's own heading ("Program kina CINEMAX Košice" → cinema). Only one clear kind counts. */
export function headingTags(text) {
  const t = fold(text);
  if (CINEMA_PLACE.test(t) || CINEMA_TITLE.test(t)) return ['cinema'];
  const tags = RULES.filter(([, re]) => re.test(t)).map(([tag]) => tag);
  return tags.length === 1 ? tags : [];
}

// ---------------------------------------------------------------- learned rules

// A venue or listing page needs this many AI-tagged events, this share of them agreeing;
// a title word needs more, because words are weaker evidence.
const LEARN = { venue: [2, 0.8], page: [3, 0.8], word: [4, 0.9] };
const STOP = new Set(['kosice', 'kosiciach', 'pre', 'the', 'and', 'with', 'koncert', 'tour', 'live', 'program',
  'podujatie', 'event', 'jesenny', 'jarny', 'letny', 'zimny', 'novy', 'nova', 'velky', 'velka', 'night', 'noc']);

export const emptyRules = () => ({ venues: {}, pages: {}, words: {} });

const titleWords = (title) => [...new Set(fold(title).split(/[^a-z0-9]+/).filter((w) => w.length >= 4 && !STOP.has(w) && !/^\d+$/.test(w)))];

function evidence(ev) {
  return {
    venues: ev.location ? [venueKey(ev.location)] : [],
    pages: [...new Set((ev.sources || []).map((s) => s.via).filter(Boolean))],
    words: titleWords(ev.title),
  };
}

/**
 * Count one AI verdict. Returns the rules that just became active, e.g. ["venue kino usmev|kosice → cinema"].
 */
export function learnTags(rules, ev, tags) {
  const activated = [];
  for (const [kind, keys] of Object.entries(evidence(ev))) {
    const [min, share] = LEARN[kind.slice(0, -1)];
    for (const key of keys) {
      const r = (rules[kind][key] ??= { n: 0, counts: {} });
      // Count distinct events: a weekly "MEET & GREET FRIDAYS" is one piece of evidence, not four.
      const title = fold(ev.title).slice(0, 80);
      r.titles ??= [];
      if (r.titles.includes(title)) continue;
      if (r.titles.length < 100) r.titles.push(title);
      const before = ruleTags(r, min, share);
      r.n++;
      for (const t of tags) r.counts[t] = (r.counts[t] || 0) + 1;
      for (const t of ruleTags(r, min, share)) if (!before.includes(t)) activated.push(`${kind.slice(0, -1)} "${key}" → ${t}`);
    }
  }
  return activated;
}

const ruleTags = (r, min, share) => (r && r.n >= min
  ? Object.entries(r.counts).filter(([, c]) => c / r.n >= share).map(([t]) => t) : []);

/** How many learned rules are active (venue / page / word with a tag it now applies on its own). */
export function activeRuleCount(rules) {
  let n = 0;
  for (const [kind, group] of Object.entries(rules || {})) {
    const [min, share] = LEARN[kind.slice(0, -1)];
    for (const r of Object.values(group)) n += ruleTags(r, min, share).length;
  }
  return n;
}

/** Tags the learned rules give this event. */
export function learnedTags(rules, ev) {
  if (!rules) return [];
  const out = new Set();
  for (const [kind, keys] of Object.entries(evidence(ev))) {
    const [min, share] = LEARN[kind.slice(0, -1)];
    for (const key of keys) for (const t of ruleTags(rules[kind]?.[key], min, share)) out.add(t);
  }
  return [...out];
}

/**
 * All tags of an event and where each came from: { tag: 'rules' | 'learned' | 'ai' }.
 * rules = the page's own data or the keyword rules; learned = a rule learned from earlier AI
 * answers; ai = the AI's verdict for this very event. `rules` is state.tagRules.
 */
export function tagSources(ev, rules) {
  const from = {};
  const put = (tags, why) => { for (const t of tags || []) from[t] ??= why; };
  put(guessTags(ev), 'rules');
  for (const s of ev.sources || []) put(s.tags, 'rules');
  // Learned rules and AI only fill in events the page and keyword rules couldn't place: a venue
  // that hosts mostly concerts mustn't add "concert" to its workshops.
  if (!Object.keys(from).length) put(learnedTags(rules, ev), 'learned');
  if (!Object.keys(from).length) put(ev.aiTags, 'ai');
  // Something a source calls cinema is a screening; drop tags the film's title happened to match.
  if (from.cinema) for (const t of Object.keys(from)) if (t !== 'cinema' && !FILM_EXTRA.includes(t)) delete from[t];
  return Object.fromEntries(TAGS.filter((t) => from[t]).map((t) => [t, from[t]]));
}

/** All tags of an event, in TAGS order (see tagSources). */
export const eventTags = (ev, rules) => Object.keys(tagSources(ev, rules));
