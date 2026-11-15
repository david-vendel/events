// Unit tests for the pure parts of src/geo.js: splitting locations, venue keys, whether an event is
// in Slovakia, and the venue-cache repair. Nothing here geocodes (no network), and nothing reads or
// writes data/: every `state` is a small hand-built object.
//
// Importing geo.js reads src/sk-places.json and src/sk-border.json (via slovakia.js) and, via
// fetcher.js, installs a process-wide 'uncaughtException' handler. Neither touches data/.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  eventCountry, knownTown, locateEvents, locationCountry, onlineOnly, parseLocation, placeFor, purgeDoubtfulVenues, venueKey, withoutTowns,
} from '../src/geo.js';
import { patternKeys } from '../src/learn.js';

// The smallest state eventCountry/placeFor need. state.patterns is a Records instance (SQLite) in the
// crawler; regionAt (learn.js) only calls state.patterns.get(key), so a plain object stands in.
function fakeState({ venues = {}, hosts = {}, sources = {}, patterns = {} } = {}) {
  return { venues, hosts, sources, events: {}, patterns: { get: (k) => patterns[k] } };
}

describe('parseLocation', () => {
  test('Eventbrite\'s "Town · Venue": the town is the location\'s own, not the site\'s', () => {
    const p = parseLocation('Dallas · Johnny Cabron\u2019s', 'Trnava');
    assert.equal(p.city, 'Dallas'); // not a town we know, but a location in English: shown as written
    assert.equal(p.name, 'Johnny Cabron\u2019s');
    assert.equal(parseLocation('Bratislava · KC Dunaj').city, 'Bratislava');
    assert.equal(eventCountry(fakeState(), { location: 'Bratislava · KC Dunaj' }), 'sk');
    assert.notEqual(venueKey('Dallas · Johnny Cabron\u2019s', 'Trnava'), venueKey('Johnny Cabron\u2019s', 'Trnava'));
  });
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
      name: 'CINEMAX', street: 'Moldavská cesta 32', postcode: '040 11', city: 'Košice', district: undefined, cityText: 'Košice',
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

  test('a place looked up without a town and found in Slovakia is a guess: the AI or the language beat it', () => {
    const venues = { 'las vegas|': { status: 'ok', lat: 48.15, lon: 17.17, precision: 'venue', country: 'sk', text: 'Las Vegas' } };
    const ev = { title: 'Jazz night', location: 'Las Vegas', source: 'https://www.vicslasvegas.com/event/x' };
    assert.equal(eventCountry(fakeState({ venues }), { ...ev, country: 'United States' }), 'abroad');
    assert.equal(eventCountry(fakeState({ venues }), { ...ev, description: 'Join us for a night of jazz with your friends at the club.' }), 'abroad');
    // Nothing else known: the lookup still counts.
    assert.equal(eventCountry(fakeState({ venues }), ev), 'sk');
  });

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

// The place/town/pin fixes of 15 Nov 2026, from strings of the live data.
describe('towns from real locations', () => {
  test('Tatra resorts that are not municipalities still show as the town', () => {
    assert.equal(parseLocation('Grand Hotel, Nový Smokovec').city, 'Nový Smokovec');
    assert.equal(parseLocation('Hotel Hutník, Tatranské Matliare').city, 'Tatranské Matliare');
    assert.equal(parseLocation('Hotel, Podbanské').city, 'Podbanské');
  });
  test('"ČR" as a word of its own is the Czech Republic', () => {
    assert.equal(locationCountry('ČR, Bílovec'), 'abroad');
    assert.equal(locationCountry('ČRS klub, Košice'), 'sk');
  });
  const city = (text, hint) => parseLocation(text, hint).city;

  test('a village, then the region\'s town: the village', () => {
    assert.equal(city('Trnovec nad Váhom, Trnovec nad Váhom, Nitra'), 'Trnovec nad Váhom');
    assert.equal(city('Horné Saliby, Horné Saliby, Senec'), 'Horné Saliby');
    assert.equal(city('Terchová, Malá Fatra a okolie, Terchová, Zilina'), 'Terchová');
    assert.equal(city('HYGGE, Bojnická cesta 590,Kanianka, Trencin'), 'Kanianka');
    const p = parseLocation('Kalná nad Hronom, Nitra');
    assert.equal(p.city, 'Kalná nad Hronom');
    assert.equal(p.name, undefined); // "Nitra" is no venue
    // Not a lower-case word that happens to be a village ("rybník" = pond), nor a town before a village.
    assert.equal(city('rybník, Levice'), 'Levice');
    assert.equal(city('Zvolen, Pobočka Inter Cars, Kováčová'), 'Zvolen');
    assert.equal(city('Bory Mall, Lozorno, Bory, Slovakia'), 'Lozorno');
  });

  test('a town in the locative', () => {
    assert.equal(city('Hornonitrianske múzeum v Prievidzi'), 'Prievidza');
    assert.equal(city('Tatranská galéria v Poprade'), 'Poprad');
    assert.equal(city('Krajská knižnica v Prešove'), 'Prešov');
    assert.equal(city('Divadlo Jána Palárika v Trnave'), 'Trnava');
    assert.equal(city('FF UKF v Nitre, Štefánikova 67, miestnosť ST121'), 'Nitra');
    // "pri X" is near X, not in it.
    assert.notEqual(city('Village Resort HANULIAK, Belá pri Žiline'), 'Žilina');
    // Before the site's town.
    assert.equal(city('Tatranská galéria v Poprade', 'Košice'), 'Poprad');
  });

  test('a town that is also a word or a name, as the last word after a venue word', () => {
    assert.equal(city('ZŠ Martin'), 'Martin');
    assert.equal(city('ZŠ Detva'), 'Detva');
    assert.equal(city('Slovenské komorné divadlo - Martin'), 'Martin');
    assert.equal(city('koncert na Martina'), undefined);
    assert.equal(city('Kostol sv. Martin'), undefined);
    assert.equal(city('Kino Sála'), undefined);
    assert.equal(city('Školský dvor ZŠ Martin nad Žitavou, Martin nad Žitavou'), 'Martin nad Žitavou');
  });

  test('well-known venues without a town', () => {
    assert.equal(city('Slovenské národné divadlo'), 'Bratislava');
    assert.equal(city('Slovenská filharmónia'), 'Bratislava');
    assert.equal(city('Staré Lýceum'), 'Bratislava');
    assert.equal(city('FNsP NZ – Zasadačka'), 'Nové Zámky');
  });

  test('Gúta is Kolárovo; "Obec X" is X', () => {
    assert.equal(city('AA VMK, Templom tér 4, Gúta'), 'Kolárovo');
    assert.equal(knownTown('AA VMK, Templom tér 4, Gúta'), 'Kolárovo');
    assert.equal(city('Obec Marianka, futbalové ihrisko'), 'Marianka');
  });

  test('parts that are no town', () => {
    assert.equal(city('MsÚ Lučenec, Námestie republiky 26, kanc.č.107 a 111'), 'Lučenec');
    assert.equal(city('Slovensko, Európa, celý svet (Zahraničie - Európa/Svet)'), undefined);
    assert.equal(city('Kategória: Pre deti • Dátum a čas: 11:00 • Staré divadlo Karola Spišáka, Ul. 7. pešieho pluku'), undefined);
    const xmas = parseLocation('Vianočný koncert o 16:00h, Jezuitský kostol, info tel: 034 664 53 41, vstupenky v sieti predpredaj.sk');
    assert.equal(xmas.city, undefined);
    assert.equal(xmas.cityText, 'Jezuitský kostol'); // not the phone number nor the ticket shop
    assert.equal(parseLocation('Miesto konania Crowne Plaza, Hodžovo nám. 2, papiernikova@cp.sk').cityText, undefined);
    assert.equal(parseLocation('Fitlates Akadémia, Na Riviére 2, Pilates s.r.o.)').cityText, undefined);
    // "Predajná" is a village, not ticket sales.
    assert.equal(city('Námestie Juraja Pejku, Predajná'), 'Predajná');
  });

  test('a Slovak location\'s last part that is no municipality is not shown as its town', () => {
    // A category glued to the town ("Námestovo Duchovné"): the town in it.
    assert.equal(city('Dom kultúry, Štefánikova 208/7, Námestovo Duchovné, Kultúra, Rodina'), 'Námestovo');
    assert.equal(city('Tipsport Aréna, Banská Bystrica Chvály, Duchovné, Mládež'), 'Banská Bystrica');
    for (const text of ['NATEEVA - kaviareň, čajovňa', 'DPH, DzP, účtovníctvo', 'Hôtel Hermitage Monte-Carlo, Sq. Beaumarchais, Monaco',
      'UTEP Campus: Tomás Rivera Conference Center, Union Bldg. East - Room 308, El Paso', 'META bar, Čakovec']) {
      assert.equal(city(text), undefined, text);
    }
    // Still looked up by it, and the cache key is unchanged.
    assert.equal(parseLocation('META bar, Čakovec').cityText, 'Čakovec');
    assert.equal(venueKey('NATEEVA - kaviareň, čajovňa'), 'nateeva - kaviaren|cajovna');
    // A town abroad in a location that isn't Slovak is shown as written.
    assert.equal(city('Klub, Barnaul'), 'Barnaul');
    assert.equal(city('Hotel Galant, Mlýnská 739, Mikulov'), 'Mikulov');
  });
});

describe('online locations', () => {
  test('what Slovak sites write for online', () => {
    for (const text of ['Forma/on-line', 'Virtuálna miestnosť (Microsoft Teams)', 'dištančná forma', 'Online seminár (LIVE)',
      'ONLINE cez aplikáciu ZOOM', 'online (EduPage)', 'ONLINE @ Inviton.TV, ONLINE @ Inviton.TV', 'Online, Slovensko, Online, Slovensko']) {
      assert.equal(onlineOnly(text), true, text);
      assert.deepEqual({ ...parseLocation(text) }, { online: true }, text);
      assert.equal(placeFor(fakeState(), { location: text }), undefined, text);
      assert.equal(knownTown(text), undefined, text);
    }
  });
  test('a place and online too is a place', () => {
    assert.equal(onlineOnly('Tatranská Lomnica + ONLINE live stream'), false);
    assert.equal(onlineOnly('Vienna House Bratislava + online'), false);
    assert.equal(onlineOnly('História Kolonádového mosta vo virtuálnej realite'), false);
    assert.equal(parseLocation('Tatranská Lomnica + ONLINE live stream').city, 'Tatranská Lomnica');
  });
});

describe('pins', () => {
  test('a cached pin beyond the town\'s radius falls back to the town centre', () => {
    // starlib's "Karadžičova 1" (Bratislava) was pinned 22 km off, near Senec.
    const key = venueKey('Karadžičova 1', 'Bratislava');
    const venues = { [key]: { status: 'ok', text: 'Karadžičova 1', lat: 48.22, lon: 17.40, precision: 'address', country: 'sk' } };
    const sources = { 'https://www.starlib.sk': { origin: 'https://www.starlib.sk', siteKind: 'venue', city: 'Bratislava' } };
    const p = placeFor(fakeState({ venues, sources }), { location: 'Karadžičova 1', source: 'https://www.starlib.sk/akcie' });
    assert.equal(p.precision, 'city');
    assert.equal(p.city, 'Bratislava');
    // Within it: kept (Čunovo is 16 km from the centre of Bratislava).
    venues[key] = { ...venues[key], lat: 48.032, lon: 17.20 };
    assert.equal(placeFor(fakeState({ venues, sources }), { location: 'Karadžičova 1', source: 'https://www.starlib.sk/akcie' }).precision, 'address');
  });

  test('a village name several share: the namesake near the site\'s town, else no pin', () => {
    // kulthund's "Poproč, Poproč" was pinned in okres Rimavská Sobota.
    const rs = { status: 'ok', text: 'Poproč, Poproč', lat: 48.5831, lon: 20.0336, precision: 'city', country: 'sk' };
    const venues = { [venueKey('Poproč, Poproč')]: rs };
    assert.equal(placeFor(fakeState({ venues }), { location: 'Poproč, Poproč', source: 'https://kulthund.sk/podujatie/x' }), undefined);
    assert.equal(parseLocation('Poproč, Poproč').city, 'Poproč'); // the town is still shown
    const sources = { 'https://www.kosice-tickets.sk': { origin: 'https://www.kosice-tickets.sk', siteKind: 'venue', city: 'Košice' } };
    const p = placeFor(fakeState({ venues, sources }), { location: 'Poproč, Poproč', source: 'https://www.kosice-tickets.sk/e/1' });
    assert.ok(Math.abs(p.lat - 48.71) < 0.01 && Math.abs(p.lon - 20.98) < 0.01, `${p.lat},${p.lon}`); // okres Košice-okolie
    // The okres named in the location decides.
    const q = placeFor(fakeState(), { location: 'Ostrov, okres Sobrance' });
    assert.ok(q.lon > 22, `${q.lon}`);
    assert.equal(placeFor(fakeState(), { location: 'Ostrov, Ostrov' }), undefined);
  });
});

// The lookups, against a stand-in for OpenStreetMap: what it answered for these places (Nov 2026).
describe('lookups (fake Nominatim)', () => {
  const report = { start: () => ({}), end: () => {} };
  const hit = (display_name, lat, lon, addresstype, country_code = 'sk') => [{ display_name, lat, lon, addresstype, osm_type: 'node', osm_id: 1, address: { country_code } }];
  async function lookUp(location, answer) {
    const asked = [];
    const realFetch = globalThis.fetch;
    process.env.EVENTS_NOMINATIM_GAP_MS = '1';
    globalThis.fetch = async (url) => {
      const q = Object.fromEntries(new URL(url).searchParams);
      asked.push(q);
      return new Response(JSON.stringify(answer(q) || []), { status: 200, headers: { 'content-type': 'application/json' } });
    };
    try {
      const state = fakeState();
      state.events = { a: { id: 'a', start: '2099-01-01', location, source: 'https://example.sk/e' } };
      await locateEvents(state, '2026-01-01', 10, report);
      return { place: state.events.a.place, venue: state.venues[venueKey(location)], asked };
    } finally {
      globalThis.fetch = realFetch;
      delete process.env.EVENTS_NOMINATIM_GAP_MS;
    }
  }

  test('a generic venue found in another village of the okres is not in the town', async () => {
    const levice = await lookUp('ZŠ Levice', () => hit('Zs. Móricza, Homok, Šahy, okres Levice, Nitriansky kraj, 936 01, Slovensko', 48.07, 18.95, 'amenity'));
    assert.equal(levice.place.precision, 'city');
    assert.ok(Math.abs(levice.place.lat - 48.2) < 0.05, `${levice.place.lat}`); // Levice, not Šahy
    const komarno = await lookUp('Mestská športová hala, Komárno', () => hit('Mestská športová hala, Školská, Kolárovo, okres Komárno, Nitriansky kraj, 946 03, Slovensko', 47.915, 17.997, 'amenity'));
    assert.equal(komarno.place.precision, 'city');
    const kosice = await lookUp('Základná škola, Juhoslovanská, Košice', () => hit('Základná škola, Ružínska, Kysak, okres Košice-okolie, Košický kraj, 044 81, Slovensko', 48.854, 21.221, 'amenity'));
    assert.equal(kosice.place.precision, 'city');
    // In the town itself: kept.
    const ok = await lookUp('Dom umenia, Košice', () => hit('Dom umenia, Moyzesova, Staré Mesto, Košice, okres Košice I, Košický kraj, Slovensko', 48.72, 21.26, 'amenity'));
    assert.equal(ok.place.precision, 'venue');
  });

  test('a town abroad is looked for anywhere first, and a Slovak hamlet or building of its name doesn\'t count', async () => {
    const policka = await lookUp('Divadelní klub Polička, Vrchlického 53, Polička',
      () => hit('Políčka, Bašovce, okres Piešťany, Trnavský kraj, 916 23, Slovensko', 48.6, 17.85, 'hamlet'));
    assert.equal(policka.place, undefined);
    assert.equal(policka.venue.status, 'not_found');
    assert.equal(policka.asked[0].countrycodes, undefined); // anywhere first
    const mikulov = await lookUp('Hotel Galant, Mlýnská 739, Mikulov', () => hit('Mikulov, Čierna Lehota, okres Bánovce nad Bebravou, Trenčiansky kraj, 956 43, Slovensko', 48.8, 18.3, 'locality'));
    assert.equal(mikulov.place, undefined);
    const monaco = await lookUp('Hôtel Hermitage Monte-Carlo, Sq. Beaumarchais, Monaco', () => hit('MONACO, 3411/6, Slovinská, Trnávka, Bratislava, okres Bratislava II, Bratislava, Slovensko', 48.16, 17.18, 'building'));
    assert.equal(monaco.place, undefined);
    const rodina = await lookUp('Centrum pre rodinu - Sigord, Sigord 134, Zlatá Baňa Duchovné, Rodina', () => hit('Rodina, Rovnice, Bratislava, okres Bratislava IV, Bratislava, Slovensko', 48.2, 17.0, 'shop'));
    assert.equal(rodina.place, undefined);
    // Found abroad: abroad.
    const real = await lookUp('Divadelní klub Polička, Vrchlického 53, Polička', (q) => (q.countrycodes ? [] : hit('53, Vrchlického, Polička, okres Svitavy, Pardubický kraj, Česko', 49.71, 16.26, 'building', 'cz')));
    assert.equal(real.venue.country, 'cz');
    // A Slovak resort that is no municipality, written in Slovak: found.
    const jasna = await lookUp('Hotel Družba, Jasná', () => hit('Hotel Družba, Flow trail, Jasná, Demänovská Dolina, okres Liptovský Mikuláš, Žilinský kraj, Slovensko', 48.97, 19.58, 'tourism'));
    assert.equal(jasna.place.precision, 'venue');
  });
});
