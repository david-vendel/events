// Unit tests for the pure parts of src/geo.js: splitting locations, venue keys, whether an event is
// in Slovakia, and the venue-cache repair. Nothing here geocodes (no network), and nothing reads or
// writes data/: every `state` is a small hand-built object.
//
// Importing geo.js reads src/sk-places.json and src/sk-border.json (via slovakia.js) and, via
// fetcher.js, installs a process-wide 'uncaughtException' handler. Neither touches data/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventCountry, knownTown, parseLocation, placeFor, purgeDoubtfulVenues, venueKey, withoutTowns,
} from '../src/geo.js';
import { patternKeys } from '../src/learn.js';

// The smallest state eventCountry/placeFor need. state.patterns is a Records instance (SQLite) in the
// crawler; regionAt (learn.js) only calls state.patterns.get(key), so a plain object stands in.
function fakeState({ venues = {}, hosts = {}, sources = {}, patterns = {} } = {}) {
  return { venues, hosts, sources, events: {}, patterns: { get: (k) => patterns[k] } };
}

describe('parseLocation', () => {
  test('venue name with its town inside, then a building name', () => {
    const p = parseLocation('Štátna filharmónia Košice, Dom umenia');
    assert.equal(p.name, 'Štátna filharmónia Košice');
  });
  test('a town inside the venue\'s name, when the last part names none', () => {
    const p = parseLocation('Štátna filharmónia Košice, Dom umenia');
    assert.equal(p.city, 'Košice');
    assert.equal(p.name, 'Štátna filharmónia Košice');
    assert.equal(venueKey('Štátna filharmónia Košice, Dom umenia'), 'statna filharmonia kosice|kosice');
  });
  test('a town in the name does not override a town abroad', () => {
    assert.notEqual(parseLocation('Hotel Bratislava, Wien Mitte').city, 'Bratislava');
  });

  test('venue, street, postcode and town', () => {
    assert.deepEqual({ ...parseLocation('CINEMAX, Moldavská cesta 32., OC OPTIMA, Košice 04011') }, {
      name: 'CINEMAX', street: 'Moldavská cesta 32', postcode: '040 11', city: 'Košice', district: undefined,
    });
  });

  test('street, postcode with a space, and town', () => {
    const p = parseLocation('Hlavná 10, 040 01 Košice');
    assert.equal(p.street, 'Hlavná 10');
    assert.equal(p.postcode, '040 01');
    assert.equal(p.city, 'Košice');
    assert.equal(p.name, undefined);
  });

  test('town with a district', () => {
    const p = parseLocation('Košice - Juh');
    assert.equal(p.city, 'Košice');
    assert.equal(p.district, 'Juh');
    const q = parseLocation('Košice-Staré Mesto, Collosseum klub');
    assert.equal(q.city, 'Košice');
    assert.equal(q.district, 'Staré Mesto');
    assert.equal(q.name, 'Collosseum klub');
  });

  test('a borough on its own is its city\'s district', () => {
    const p = parseLocation('Petržalka');
    assert.equal(p.city, 'Bratislava');
    assert.equal(p.district, 'Petržalka');
  });

  test('a country part is dropped', () => {
    const p = parseLocation('Dom kultúry, Prešov, Slovensko');
    assert.equal(p.name, 'Dom kultúry');
    assert.equal(p.city, 'Prešov');
  });

  test('several towns: a tour, no single place', () => {
    assert.deepEqual(parseLocation('Košice, Prešov, Poprad').multi, ['Košice', 'Prešov', 'Poprad']);
  });

  test('online platforms are no place', () => {
    assert.deepEqual({ ...parseLocation('Online') }, { online: true });
    assert.deepEqual({ ...parseLocation('ZOOM') }, { online: true });
  });

  test('the city hint fills in a missing town only', () => {
    const p = parseLocation('Klub Lúč', 'Banská Bystrica');
    assert.equal(p.name, 'Klub Lúč');
    assert.equal(p.city, 'Banská Bystrica');
    assert.equal(parseLocation('Dom kultúry, Prešov', 'Košice').city, 'Prešov');
    assert.equal(parseLocation('Klub Lúč').city, undefined);
  });

  test('a US state after the town is never taken for the town', () => {
    assert.notEqual(parseLocation('Town Hall, Chester, Pa.').city, 'Pa.');
  });
});

describe('knownTown', () => {
  test('finds the town wherever it is named', () => {
    assert.equal(knownTown('Štátna filharmónia Košice, Dom umenia'), 'Košice');
    assert.equal(knownTown('Dom umenia Košice'), 'Košice');
    assert.equal(knownTown('Hlavná 10, 040 01 Košice'), 'Košice');
  });
  test('a town\'s name in another language counts as the town', () => {
    assert.equal(knownTown('Kassa'), 'Košice');
  });
  test('undefined when unsure, for several towns, online or empty', () => {
    assert.equal(knownTown('Klub X'), undefined);
    assert.equal(knownTown('Košice, Prešov'), undefined);
    assert.equal(knownTown('Online'), undefined);
    assert.equal(knownTown(''), undefined);
    assert.equal(knownTown(undefined), undefined);
  });
});

describe('withoutTowns', () => {
  test('drops towns from a folded title', () => {
    assert.equal(withoutTowns('donaha! - trnava - vypredane'), 'donaha! -  - vypredane');
  });
  test('drops town adjectives', () => {
    assert.equal(withoutTowns('bratislavske leto').trim(), 'leto');
  });
  test('keeps ambiguous names that are also words or first names', () => {
    assert.equal(withoutTowns('martin a jana'), 'martin a jana');
  });
});

describe('venueKey', () => {
  test('null for online and for several towns', () => {
    assert.equal(venueKey('Online'), null);
    assert.equal(venueKey('ZOOM'), null);
    assert.equal(venueKey('Košice, Prešov, Poprad'), null);
  });
  test('street and town; spelling variants share a key', () => {
    assert.equal(venueKey('Hlavná 10, Košice'), 'hlavna 10|kosice');
    assert.equal(venueKey('Hlavná 10., Košice'), 'hlavna 10|kosice');
    assert.equal(venueKey('Dom umenia, Košice'), venueKey('Dom umenia, Kosice'));
    assert.equal(venueKey('Dom umenia, Košice'), 'dom umenia|kosice');
  });
  test('a town alone, and a name without town', () => {
    assert.equal(venueKey('Košice'), 'city|kosice');
    assert.equal(venueKey('Dom umenia'), 'dom umenia|');
  });
  test('the city hint is part of the key', () => {
    assert.equal(venueKey('Klub Lúč', 'Banská Bystrica'), 'klub luc|banska bystrica');
  });
});

describe('eventCountry', () => {
  const s = fakeState();

  test('the language of the title and description', () => {
    const st = fakeState();
    // Slovak text: Slovakia, wherever the site is.
    assert.equal(eventCountry(st, { title: 'Spoločný koncert', description: 'Srdečne vás pozývame, vstup je voľný pre všetkých.', source: 'https://example.org/e' }), 'sk');
    // Czech text on a site not known to be Slovak: abroad.
    assert.equal(eventCountry(st, { title: 'Koncert', description: 'Srdečně zveme všechny, kteří chtějí přijít.', source: 'https://example.org/e' }), 'abroad');
    // English, outside .sk, naming no Slovak town: abroad.
    assert.equal(eventCountry(st, { title: 'GIS Day', description: 'Join us for a free online event about maps and your community.', source: 'https://gisday.com/e' }), 'abroad');
  });
  test('English is not abroad on a .sk site, on a Slovak site, or when it names a Slovak town', () => {
    const en = 'Join us for a free event about the history of the town and its people.';
    assert.notEqual(eventCountry(fakeState(), { title: 'A journey', description: en, location: 'Sunday / Štrbské Pleso', source: 'https://www.strbskepleso.sk/events' }), 'abroad');
    assert.equal(eventCountry(fakeState(), { title: 'A journey', description: en, location: 'Pódium', source: 'https://www.regionpovazie.sk/en/' }), undefined);
    assert.equal(eventCountry(fakeState(), { title: 'Bratislava Collectors Exchange', description: en, source: 'https://eventland.eu/x' }), undefined);
    assert.equal(eventCountry(fakeState({ hosts: { 'expats.com': { sk: 10, abroad: 0 } } }),
      { title: 'Expat quiz', description: en, location: 'Some Pub', source: 'https://expats.com/e' }), undefined);
  });
  test('a Czech band\'s name in a Slovak town stays in Slovakia', () => {
    assert.equal(eventCountry(fakeState(), { title: 'Zdeněk Vřešťál 70 - NEŘEŽ TRIO', location: 'Synagóga, Nitra', source: 'https://www.ajdnes.sk/x' }), 'sk');
  });

  test('a Slovak town in the location', () => {
    assert.equal(eventCountry(s, { location: 'Dom kultúry, Prešov' }), 'sk');
  });
  test('a country or country code abroad in the location', () => {
    assert.equal(eventCountry(s, { location: 'Kulturní dům, Zlín, Czechia' }), 'abroad');
    assert.equal(eventCountry(s, { location: 'Zlín (CZ)' }), 'abroad');
  });
  test('Cyrillic location', () => {
    assert.equal(eventCountry(s, { location: 'Москва' }), 'abroad');
    assert.equal(eventCountry(s, { location: 'Клуб Москва' }), 'abroad');
  });
  test('a US state after the town', () => {
    assert.equal(eventCountry(s, { location: 'Town Hall, Chester, Pa.' }), 'abroad');
  });
  test('the town the location names beats the page\'s country', () => {
    assert.equal(eventCountry(s, { location: 'Dom kultúry, Prešov', pageCountry: 'United States' }), 'sk');
  });

  test('the country the page gives', () => {
    assert.equal(eventCountry(s, { location: 'Kulturhaus', pageCountry: 'SK' }), 'sk');
    assert.equal(eventCountry(s, { location: 'Kulturhaus', pageCountry: 'United States' }), 'abroad');
    // From a source row; extract.js sets 'abroad' from a time zone of the Americas or Asia.
    assert.equal(eventCountry(s, { location: 'Kulturhaus', sources: [{ via: 'https://x.com/a', pageCountry: 'abroad' }] }), 'abroad');
    // A linked row's page says nothing about this event.
    assert.equal(eventCountry(s, { location: 'Kulturhaus', sources: [{ via: 'https://x.com/a', pageCountry: 'abroad', linked: true }] }), undefined);
  });

  test('coordinates from the event page (schema.org geo on a source row)', () => {
    const at = (lat, lon, location = 'Some Hall') => eventCountry(s, { location, sources: [{ via: 'https://x.com/a', geo: { lat, lon } }] });
    assert.equal(at(48.72, 21.26), 'sk'); // Košice
    assert.equal(at(50.08, 14.43), 'abroad'); // Prague
    assert.equal(eventCountry(s, { sources: [{ via: 'https://x.com/a', geo: { lat: 48.72, lon: 21.26 } }] }), 'sk');
  });

  test('coordinates from the venue cache', () => {
    const v = (lat, lon, country) => ({ 'some hall|': { status: 'ok', lat, lon, precision: 'venue', country, text: 'Some Hall' } });
    assert.equal(eventCountry(fakeState({ venues: v(50.08, 14.43, 'cz') }), { location: 'Some Hall' }), 'abroad');
    assert.equal(eventCountry(fakeState({ venues: v(48.72, 21.26, 'sk') }), { location: 'Some Hall' }), 'sk');
  });

  test('Slovak-only words in the location', () => {
    assert.equal(eventCountry(s, { location: 'Dom kultúry Kanianka' }), 'sk');
    assert.equal(eventCountry(s, { location: 'knižnica v Tvrdošovciach' }), 'sk');
  });

  test('a country code in the title', () => {
    assert.equal(eventCountry(s, { location: 'Klub', title: 'LEVICE (SK)' }), 'sk');
    assert.equal(eventCountry(s, { location: 'Klub', title: 'Band (CZ MiniTour)' }), 'abroad');
    assert.equal(eventCountry(s, { location: 'Klub', title: 'KOLLÁROVCI - CZ TOUR' }), 'abroad');
  });

  test('no location on a .sk site', () => {
    assert.equal(eventCountry(s, { title: 'Film', source: 'https://kino.sk/film/1' }), 'sk');
    assert.equal(eventCountry(s, { title: 'Film', source: 'https://kino.sk/film/1' }, { strong: true }), 'sk');
    assert.equal(eventCountry(s, { title: 'Film', source: 'https://kino.com/film/1' }), undefined);
  });

  test('nothing known', () => {
    assert.equal(eventCountry(s, { location: 'Kulturhaus' }), undefined);
  });

  test('the site\'s learned region decides only when not strong (host record)', () => {
    const st = fakeState({ hosts: { 'site.com': { sk: 10, abroad: 0 } } });
    const ev = { title: 'Event', source: 'https://site.com/events/123' };
    assert.equal(eventCountry(st, ev), 'sk');
    assert.equal(eventCountry(st, ev, { strong: true }), undefined);
  });

  test('the site\'s learned region decides only when not strong (template record)', () => {
    const url = 'https://site.com/events/123';
    const [exact] = patternKeys(url);
    const st = fakeState({ patterns: { [exact]: { sk: 5, abroad: 0 } } });
    assert.equal(eventCountry(st, { title: 'Event', source: url }), 'sk');
    assert.equal(eventCountry(st, { title: 'Event', source: url }, { strong: true }), undefined);
  });

  test('a Slovak village alone on pages whose events are abroad is the Czech one', () => {
    const st = fakeState({ hosts: { 'site.com': { sk: 0, abroad: 10 } } });
    const village = 'Jasov'; // a Slovak village, not a town
    assert.equal(eventCountry(fakeState(), { location: `Kultúrny dom, ${village}` }), 'sk');
    assert.equal(eventCountry(st, { location: `Hall, ${village}`, source: 'https://site.com/events/1' }), 'abroad');
  });
});

describe('purgeDoubtfulVenues', () => {
  const ok = (text, extra = {}) => ({ status: 'ok', text, lat: 48.7, lon: 21.2, precision: 'venue', country: 'sk', ...extra });

  test('forgets doubtful lookups and keeps good and manual ones', () => {
    const venues = {
      // online
      'online|': ok('Online'),
      'zoom|': ok('ZOOM'),
      // a town that isn't Slovak, found in Slovakia
      [venueKey('Town Hall, Boston')]: ok('Town Hall, Boston'),
      // "the town" found as a building named after it
      [venueKey('Martin')]: ok('Martin', { precision: 'city', label: 'Kino Martin, Hlavná, Žilina, okres Žilina, Slovensko' }),
      // one word of a venue's name, no town
      'makerspace|': ok('Makerspace'),
      'москва|': ok('Москва'),
      // good ones
      'hlavna 10|kosice': ok('Hlavná 10, Košice', { precision: 'address', label: '10, Hlavná, Staré Mesto, Košice, okres Košice I, Slovensko' }),
      [venueKey('Košice')]: ok('Košice', { precision: 'city', label: 'Košice, okres Košice I, Košický kraj, Slovensko' }),
      'dom umenia|kosice': ok('Dom umenia, Košice', { label: 'Dom umenia, Moyzesova, Košice, Slovensko' }),
      'kulturny dom obce|': ok('Kultúrny dom obce'),
      // manual, page precision, and not-found entries are never touched
      'manual|': { status: 'manual', text: 'Online', lat: 1, lon: 1 },
      'page|': ok('Makerspace', { precision: 'page' }),
      'manualprec|': ok('Makerspace', { precision: 'manual' }),
      'notfound|': { status: 'not found', text: 'Online' },
    };
    assert.equal(venueKey('Town Hall, Boston'), 'town hall|boston');
    assert.equal(venueKey('Martin'), 'city|martin');
    const state = { venues };
    assert.equal(purgeDoubtfulVenues(state), 6);
    assert.deepEqual(Object.keys(state.venues).sort(), [
      'city|kosice', 'dom umenia|kosice', 'hlavna 10|kosice', 'kulturny dom obce|',
      'manual|', 'manualprec|', 'notfound|', 'page|',
    ].sort());
  });

  test('nothing to forget: returns 0', () => {
    assert.equal(purgeDoubtfulVenues({ venues: {} }), 0);
  });

  // It crashed the crawl pass (15 Nov 2026): the "town" went into a regular expression unescaped.
  test('a "town" with regex characters ("Zámocký hotel****") does not throw', () => {
    const venues = {
      'x|zamocky hotel****': { status: 'ok', precision: 'city', country: 'sk', text: 'X, Zámocký hotel****', label: 'Zámocký hotel, Smolenice' },
      'y|a(b': { status: 'ok', precision: 'city', country: 'sk', text: 'Y, a(b', label: 'a(b, Slovensko' },
    };
    assert.doesNotThrow(() => purgeDoubtfulVenues({ venues }));
  });
});

describe('placeFor', () => {
  test('undefined for online locations and tours', () => {
    const s = fakeState();
    assert.equal(placeFor(s, { location: 'Online' }), undefined);
    assert.equal(placeFor(s, { location: 'ZOOM' }), undefined);
    assert.equal(placeFor(s, { location: 'Košice, Prešov, Poprad' }), undefined);
    assert.equal(placeFor(s, {}), undefined);
  });
  test('a Slovak town alone: its centre, from the list', () => {
    const p = placeFor(fakeState(), { location: 'Košice' });
    assert.equal(p.city, 'Košice');
    assert.equal(p.precision, 'city');
    assert.ok(p.km < 5);
  });
});
