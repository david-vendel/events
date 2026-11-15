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
  // No SocialEvent → party: Eventbrite calls every event a SocialEvent ("Bosch Best Practices", yoga classes).
  LiteraryEvent: 'talk', DanceEvent: 'party', FoodEvent: 'market', SaleEvent: 'market',
  ComedyEvent: 'theatre',
};

export const tagsFromSchemaTypes = (types) => [...new Set(types.map((t) => SCHEMA_TYPES[t]).filter(Boolean))];

const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

// A film screening: cinema venue, cinema programme page, or "2D/3D" in the title. Film titles
// would trip the keyword rules ("Zápas storočia" is not a sports match), so these get only "cinema".
// "3D prehliadky" are virtual tours of flats for sale, not films.
const CINEMA_PLACE = /\bkin[oa]\b|cinemax|cinema ?city|\bsterio\b|program-kina|\/kin[oa]\//;
const DIMENSION = /\b[234]d\b(?! ?(prehliadk|tlac|pero|pasta|model|tour))/;
const CINEMA_TITLE = new RegExp(`${DIMENSION.source}|\\b(dabing|titulky)\\b|\\bimax\\b|\\bfilm(ov[ya]?)?\\b|projekci|\\bkino\\b`);
// A live show at a cinema venue (a concert, a play) is not a screening, unless the title says it is
// one ("MET Opera – záznam", "Balet 2D").
const LIVE_TITLE = /koncert|concert|divad(l|eln)|predstaveni|inscenac|\bopera\b|\bopern|balet|muzikal|stand.{0,3}up|recital|\bshow\b|talk ?show|comedy|komedi|\bturne\b|beseda|prednask|kabaret/;
const SCREENED = new RegExp(`${DIMENSION.source}|\\b(dabing|titulky)\\b|\\bimax\\b|projekci|zaznam|prenos|live in hd|\\bmet\\b`);
const isLiveShow = (name) => LIVE_TITLE.test(name) && !SCREENED.test(name);

// The only keyword tags a screening keeps: a kids' film, a film festival.
const FILM_EXTRA = ['kids', 'festival'];

// Each rule: `re` matches the title and the description, `title` the title only, `desc` the
// description only (a description says "v rámci festivalu", "wellness pre rodiny s deťmi"...).
const RULES = [
  ['concert', {
    re: /koncert|concert|(?<!(food|wine|guided|walking|city|bike|boat|bus|walk|ghost|pub|beer) )\btour\b|\bturne\b|\bband\b|orchest|recital|filharmon|symfon|jazz|\brock\b|\brock(ov|en|k)|metal\b|hip.?hop|\brap\b|\bdj\b|\bspev(?!n)|\bzbor\b|\bpiano\b|\bkapel(a|y|ou|e)\b|gospel|\bunplugged|hudob\w* (vecer|show)/,
  }],
  // Not "operný": "operné árie", "sólisti operných domov" are concerts.
  ['theatre', {
    re: /divad(l|eln)|predstaveni|inscenac|\bopera\b|\bopery\b|\bopere(ta|ty)|balet|muzikal|theat|stand.{0,3}up|kabaret|tanecn\w* (predstaven|divadl|inscenac)/,
  }],
  ['exhibition', { re: /vystav|vernisaz|exhibit|expozic|(?<!oc )galeri[ae]\b|\bmuze(um|a|i|u|om|jn)/ }],
  ['festival', { title: /festival|\bfest\b|majales|biela noc|dni mesta/, desc: /\d+\. rocnik\w* (\w+ )?festival/ }],
  ['kids', {
    title: /\bdeti\b|detsk|pre najmensich|rozpravk|\bkids\b|rodin(y|ne|u)\b/,
    desc: /pre (deti|rodiny|najmensich|skolak)|detsk\w* (predstaven|divadl|program|dieln|tvoriv)|rozpravk|\bod ([1-9]|10) rokov/,
  }],
  ['sport', {
    re: /\bbeh(u|y)?\b|maraton|turnaj|hokej|futbal|basketbal|volejbal|\bsport|\bcyklo|\brun\b|\bjog[ay]\b|plavan|\bpretek|\bkros\b|\btenis|\bsach\b|\blyz|korculov|\bsplav|pilates|zumba|aerobik|turistick\w* (pochod|vylet|tras|akci|prechadz|zraz)/,
    title: /fitness/,
  }],
  ['workshop', { re: /workshop|\bkurz|dielni|tvoriv|kreativn|masterclass|seminar/ }],
  ['talk', {
    re: /prednask|beseda|diskusi|\btalk\b|talk ?show|konferenc|\bcitani|krst knihy|podcast|literarn\w* (vecer|kaviaren)|stretnutie s autor|autogramiad|prezentaci\w* knih|autorsk\w* (citani|stretnuti|vecer|beseda)/,
  }],
  ['party', {
    re: /party|clubb|\bdisco(?!ver|unt|rd)|diskotek|kviz|quiz|tanecn\w* (zabav|vecer|party)|tancovack|tanciaren|\bples\b|(salsa|tango|bachata|kizomba)\w* (night|vecer|noc)|milong|(katarinsk|fasiangov|hasicsk|silvestrovsk|vinobran|oberackov)\w* zabav/,
    title: /\w{2,}a zabava\b|-zabava\b/, // Katarínska zábava, Labko-zábava (not "Opera nás zabáva")
  }],
  ['market', {
    re: /\btrh|jarmok|\bmarkets?\b|burza|ochutnavk|degustac|\bfood (market|festival|truck)|wine|gastro|bazar|street food|(slavnost|festival|trh|pivnic)\w* vin|otvoren\w* pivnic/,
    title: /\bvin(o|a)\b/,
  }],
];

const keywordTags = (name, desc) => RULES.filter(([, r]) => (r.re && (r.re.test(name) || r.re.test(desc)))
  || r.title?.test(name) || r.desc?.test(desc)).map(([tag]) => tag);

// Places named in a description say where, not what: "Východoslovenská galéria", "Múzeum Spiša",
// "v Mestskom divadle", "Športová hala", "kultúrno-kreatívne centrum". Removed before the keyword
// rules. "Divadlo Artynas uvádza" names who plays, so a theatre's name is removed only after "v", "do"…
const UP = 'A-ZÁÄČĎÉÍĹĽŇÓÔŔŠŤÚÝŽ';
const PLACE_NOUN = '(?:[Gg]al[ée]ri|[Mm][úu]ze|Museum|Gallery)\\p{L}*';
const NAMED_PLACE = [
  new RegExp(`(?:\\b[${UP}][\\p{L}-]*\\s+){1,3}${PLACE_NOUN}`, 'gu'), // Mestské divadlo, Východoslovenská galéria
  new RegExp(`\\b${PLACE_NOUN}(?:\\s+[${UP}][\\p{L}.]*){1,4}`, 'gu'), // Divadlo Jána Palárika, Múzeum Spiša
];
// "v Mestskom divadle", "do Slovenskej národnej galérie", "pred divadlom" (not "v podaní divadla Komédie").
const PLACE_PHRASE = /\b(v|vo|pri) ((\w+(om|ej) ){0,2})(divadle|galerii|muzeu)\b|\b(do|z|zo|od) ((\w+(eho|ej) ){0,2})(divadla|galerie|muzea)\b|\bpred ((\w+(ym|ou) ){0,2})(divadlom|galeriou|muzeom)\b|\bsportov\w* (hal|areal|centr)\w*|\bkulturn\w*.kreativn\w* centr\w*/g;
const describe = (description) => {
  let d = description || '';
  for (const re of NAMED_PLACE) d = d.replace(re, ' ');
  return fold(d).replace(PLACE_PHRASE, ' ');
};

// kulthund.sk titles: "Title — koncert, 20.11.2026 20:30, Venue, Town." The part after " — "
// names the kind; the venue there must not trip keyword rules ("Mestské divadlo" at a concert).
const CATEGORY_TITLE = /^(.*?) — ([^,—]+), (\d{1,2}\.\d{1,2}\.\d{4}|prebieha)/;
const CATEGORIES = {
  koncert: 'concert', 'vazna hudba': 'concert', divadlo: 'theatre', tanec: 'theatre', vystava: 'exhibition',
  prednaska: 'talk', diskusia: 'talk', citacka: 'talk', workshop: 'workshop', 'podujatie pre rodiny': 'kids',
  film: 'cinema', party: 'party', festival: 'festival', gastro: 'market',
};

/** Tags for one sighting or event, from its text and URLs. */
export function guessTags({ title, description, location, url, via, source }) {
  // The venue's name says where, not what: "Športové námestie" hosts cabaret, "(bývalé kino Slovan)" plays.
  const venue = fold(location).replace(/\([^)]*\)/g, ' ').replace(/\bbyval\S* kin\S*/g, ' ');
  const place = `${venue} ${fold(`${url} ${via || source}`)}`;
  let name = fold(title);
  const m = name.match(CATEGORY_TITLE);
  if (m) name = m[1];
  const desc = describe(description);
  const tags = keywordTags(name, desc);
  // "tanec" is mostly stage dance (Luskáčik, Nu Dance Fest), but also "Latino party" and dance classes.
  const kind = m && m[2].trim();
  const category = kind === 'tanec' && tags.some((t) => t === 'party' || t === 'workshop') ? undefined : m && CATEGORIES[kind];
  const titleTags = () => keywordTags(name, '');
  const merge = (...lists) => TAGS.filter((t) => lists.some((l) => l.includes(t)));
  if (category === 'cinema') return ['cinema', ...tags.filter((t) => FILM_EXTRA.includes(t))];
  // A live show (or a kulthund concert, play…) at a cinema: its descriptions are written for films,
  // trust only its title. A title that names no kind still says it is a film ("The Truman Show").
  if (category || isLiveShow(name)) {
    if (!CINEMA_PLACE.test(place)) return merge(category ? [category] : [], tags);
    if (category || titleTags().length) return merge(category ? [category] : [], titleTags());
  }
  if (CINEMA_PLACE.test(place) || CINEMA_TITLE.test(name)) return ['cinema', ...tags.filter((t) => FILM_EXTRA.includes(t))];
  return tags;
}

/** Tags from a listing page's own heading ("Program kina CINEMAX Košice" → cinema). Only one clear kind counts. */
export function headingTags(text) {
  const t = fold(text);
  if (CINEMA_PLACE.test(t) || CINEMA_TITLE.test(t)) return ['cinema'];
  const tags = keywordTags(t, '');
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
  // What the sources' own data says (schema.org TheaterEvent…) beats a cinema guessed from words.
  const own = (ev.sources || []).flatMap((s) => s.tags || []);
  const guessed = guessTags(ev);
  put(own.length && !own.includes('cinema') ? guessed.filter((t) => t !== 'cinema') : guessed, 'rules');
  for (const s of ev.sources || []) put(s.tags, 'rules');
  // Learned rules and AI only fill in events the page and keyword rules couldn't place: a venue
  // that hosts mostly concerts mustn't add "concert" to its workshops.
  if (!Object.keys(from).length) put(learnedTags(rules, ev), 'learned');
  if (!Object.keys(from).length) put(ev.aiTags, 'ai');
  // Something a source calls cinema is a screening; drop tags the film's title happened to match.
  // A live show on a cinema's programme is the exception.
  if (from.cinema && isLiveShow(fold(ev.title))) delete from.cinema;
  else if (from.cinema) for (const t of Object.keys(from)) if (t !== 'cinema' && !FILM_EXTRA.includes(t)) delete from[t];
  return Object.fromEntries(TAGS.filter((t) => from[t]).map((t) => [t, from[t]]));
}

/** All tags of an event, in TAGS order (see tagSources). */
export const eventTags = (ev, rules) => Object.keys(tagSources(ev, rules));
