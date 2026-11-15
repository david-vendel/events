// Unit tests for src/slovakia.js: deciding from free-text locations, hosts and URLs whether an event
// is in Slovakia. Examples come from the module's comments and the README ("only events in Slovakia").
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fold, skPlace, boroughOf, uniqueName, isTown, townOfPlace, inSlovakia, foreignTown, countryPart,
  countryNamed, looksAbroad, usState, isOnline, countryInUrl, foreignHost, countryCode, regionOf,
  slovakVariants, namesSkTown, locativeTown, slovakWords, slovakPage,
} from '../src/slovakia.js';

describe('fold', () => {
  test('lower-cases, strips diacritics and squeezes spaces', () => {
    assert.equal(fold('  Košice   Juh '), 'kosice juh');
    assert.equal(fold(null), '');
  });
});

describe('isOnline', () => {
  test('an online platform alone is no place', () => {
    for (const t of ['Online', 'ZOOM', 'Virtual', 'Webinar (MS Teams)', 'online (zoom)', 'Webinár', 'Live stream']) {
      assert.equal(isOnline(t), true, t);
    }
  });
  test('a real place, even one with "online" in its name, is not online', () => {
    assert.equal(isOnline('Online Café, Košice'), false);
    assert.equal(isOnline('Hlavná 12, Košice'), false);
  });
  test('an empty location is not online', () => {
    assert.equal(isOnline(''), false);
    assert.equal(isOnline(undefined), false);
  });
  test('"On-line" is online', () => assert.equal(isOnline('On-line'), true));
});

describe('usState', () => {
  test('a US state or Canadian province after the town', () => {
    assert.equal(usState('Chester, Pa.'), true);
    assert.equal(usState('Arlington, Va.'), true);
    assert.equal(usState('Wilmington, DE 19801'), true);
    assert.equal(usState('Wilmington, DE 19801-1234'), true);
    assert.equal(usState('Toronto, ON'), true);
  });
  test('only parts after the first count', () => {
    assert.equal(usState('PA, Chester'), false);
    // By the documented rule a state code after the town counts, even after a Slovak town's name.
    assert.equal(usState('Bratislava, MD'), true);
  });
  test('Slovak addresses are no US state', () => {
    assert.equal(usState('Hlavná 12, Košice'), false);
    assert.equal(usState('Košice, SK'), false);
    assert.equal(usState(''), false);
  });
});

describe('looksAbroad', () => {
  test('other scripts', () => {
    assert.equal(looksAbroad('Россия, Москва'), true);
    assert.equal(looksAbroad('東京'), true);
  });
  test('American address and US state', () => {
    assert.equal(looksAbroad('350 Bulldogger Rd'), true);
    assert.equal(looksAbroad('Chester, Pa.'), true);
  });
  test('letters Slovak does not have (Czech ě ř ů, German ß)', () => {
    assert.equal(looksAbroad('Hořice'), true);
    assert.equal(looksAbroad('Großer Saal'), true);
  });
  test('street words of other languages', () => {
    assert.equal(looksAbroad('Fraser Highway'), true);
    assert.equal(looksAbroad('Lerchengasse 5'), true);
    assert.equal(looksAbroad('Rue de Rivoli'), true);
  });
  test('a town abroad as a whole part, with or without postcode, but not inside a name', () => {
    assert.equal(looksAbroad('MS Uferpark, Hamburg'), true);
    assert.equal(looksAbroad('1010 Wien'), true);
    assert.equal(looksAbroad('110 00 Praha 1'), true);
    assert.equal(looksAbroad('Café Paris'), false);
  });
  test('Slovak addresses do not look abroad', () => {
    for (const t of ['Hlavná 12, Košice', 'Hlavné námestie 1, Trnava', 'Namestie SNP 1, Bratislava',
      'Dom kultúry, Štúrova 3, Nitra', 'Mierová 8, Bratislava']) {
      assert.equal(looksAbroad(t), false, t);
    }
    assert.equal(looksAbroad(''), false);
  });
});

describe('foreignTown', () => {
  test('a town abroad without its postcode', () => {
    assert.equal(foreignTown('1010 Wien'), 'Wien');
    assert.equal(foreignTown('110 00 Praha 1'), 'Praha');
  });
  test('not a town abroad', () => {
    assert.equal(foreignTown('Café Paris'), undefined);
    assert.equal(foreignTown('Bratislava'), undefined);
  });
});

describe('foreignHost', () => {
  test("hosts on another country's domain", () => {
    for (const h of ['kinoaero.cz', 'eventbrite.co.uk', 'krs.kassir.ru', 'andes.org.pe']) assert.equal(foreignHost(h), true, h);
  });
  test('Slovak, generic and global domains are not foreign', () => {
    for (const h of ['x.sk', 'www.ticketportal.sk', 'foo.io', 'foo.co', 'bar.eu', 'example.com', '']) {
      assert.equal(foreignHost(h), false, h);
    }
  });
});

describe('countryCode', () => {
  test('Slovakia in its spellings', () => {
    for (const c of ['Slovakia', 'SK', 'svk', 'slovenská republika']) assert.equal(countryCode(c), 'sk', c);
  });
  test('any other country is abroad; nothing is unknown', () => {
    assert.equal(countryCode('Česko'), 'abroad');
    assert.equal(countryCode('Austria'), 'abroad');
    assert.equal(countryCode(''), undefined);
    assert.equal(countryCode(null), undefined);
  });
});

describe('countryPart', () => {
  test('a part that is only Slovakia', () => {
    for (const t of ['Slovensko', 'SK', 'SVK', 'Slovenská republika', 'Celé Slovensko']) assert.equal(countryPart(t), 'sk', t);
  });
  test('a part that is only another country', () => {
    for (const t of ['Czechia', 'DE', 'Česká republika', 'Germany', 'Hungary ']) assert.equal(countryPart(t), 'abroad', t);
  });
  test('a part that is more than a country says nothing', () => {
    assert.equal(countryPart('Bratislava'), undefined);
    assert.equal(countryPart('Slovensko, Bratislava'), undefined);
  });
});

describe('countryNamed', () => {
  test('Slovakia named in a location', () => {
    assert.equal(countryNamed('Hlavná 1, Košice, Slovensko'), 'sk');
    assert.equal(countryNamed('(SR - Žilinský kraj)'), 'sk');
  });
  test('another country named in a location', () => {
    assert.equal(countryNamed('Zlín (CZ)'), 'abroad');
    assert.equal(countryNamed('MS Uferpark, Hamburg, Germany'), 'abroad');
    assert.equal(countryNamed('Wien, Österreich'), 'abroad');
    assert.equal(countryNamed('Ljubljana, Slovenia'), 'abroad'); // Slovenia is not Slovakia
  });
  test('no country named', () => {
    assert.equal(countryNamed('Bratislava'), undefined);
    assert.equal(countryNamed(''), undefined);
  });
});

describe('skPlace / isTown / uniqueName / townOfPlace / boroughOf', () => {
  test('municipalities and boroughs by name', () => {
    assert.equal(skPlace('Prešov').name, 'Prešov');
    assert.equal(skPlace('presov').name, 'Prešov');
    const p = skPlace('Petržalka');
    assert.equal(p.partOf, 'Bratislava');
    assert.equal(townOfPlace(p).name, 'Bratislava');
    assert.equal(skPlace('Hamburg'), undefined);
  });
  test('boroughs named like ordinary words are not places alone', () => {
    assert.equal(skPlace('Juh'), undefined);
    assert.equal(skPlace('Staré Mesto'), undefined);
  });
  test("towns' names in other languages", () => {
    assert.equal(skPlace('Kassa').name, 'Košice');
    assert.equal(skPlace('Pressburg').name, 'Bratislava');
  });
  test('towns vs villages', () => {
    assert.equal(isTown(skPlace('Bratislava')), true);
    assert.equal(isTown(skPlace('Podhradie')), false);
    assert.equal(isTown({ pop: 5000 }), true);
    assert.equal(isTown({ town: true, pop: 100 }), true);
    assert.equal(isTown(undefined), false);
  });
  test('uniqueName: a name shared by several villages is not unique', () => {
    assert.equal(uniqueName('Prešov'), true);
    assert.equal(uniqueName('Podhradie'), false);
    assert.equal(uniqueName('Hamburg'), false);
  });
  test('boroughOf: the postcode settles which city', () => {
    assert.deepEqual(boroughOf('Staré Mesto', '040 01'), { city: 'Košice', district: 'Staré Mesto' });
    assert.deepEqual(boroughOf('Staré Mesto', '811 01'), { city: 'Bratislava', district: 'Staré Mesto' });
    assert.equal(boroughOf('Staré Mesto', '900 01'), undefined);
    assert.equal(boroughOf('Staré Mesto'), undefined);
  });
});

describe('inSlovakia', () => {
  test('coordinates in and out', () => {
    assert.equal(inSlovakia({ lat: 48.1486, lon: 17.1077 }), true); // Bratislava
    assert.equal(inSlovakia({ lat: 48.7164, lon: 21.2611 }), true); // Košice
    assert.equal(inSlovakia({ lat: 48.2082, lon: 16.3738 }), false); // Vienna
    assert.equal(inSlovakia({ lat: 50.08, lon: 14.43 }), false); // Prague
    assert.equal(inSlovakia({ lat: 47.79, lon: 18.74 }), false); // Esztergom
  });
  test('no coordinates: unknown', () => {
    assert.equal(inSlovakia({}), undefined);
    assert.equal(inSlovakia(null), undefined);
  });
});

describe('countryInUrl', () => {
  test('what a listing address says', () => {
    assert.equal(countryInUrl('https://www.eventbrite.com/d/united-kingdom/events/'), 'abroad');
    assert.equal(countryInUrl('https://www.eventbrite.com/d/slovakia--trnava/events/'), 'sk');
    assert.equal(countryInUrl('https://x.com/festivals/hamburg'), 'abroad');
    assert.equal(countryInUrl('https://allevents.in/kosice/all'), 'sk');
    assert.equal(countryInUrl('https://ticketportal.sk/venue/Kino-Hviezda-Trencin'), 'sk');
  });
  test('the place named first wins: the section before the event\'s slug', () => {
    assert.equal(countryInUrl('https://eventland.eu/bratislava/event/81958/milan-lieskovsky-in-neptune-club/'), 'sk');
    assert.equal(countryInUrl('https://eventland.eu/vienna/event/81183/christmas-market-am-hof-2/'), 'abroad');
    assert.equal(countryInUrl('https://www.ticketlive.sk/sk/event/rfa-35-praha-27-11-2026'), 'abroad');
    assert.equal(countryInUrl('https://www.eventbrite.com/d/austria--vienna/slovak-folk-night/'), 'abroad');
  });
  test('towns that are also first names, and bad URLs, say nothing', () => {
    assert.equal(countryInUrl('https://x.com/martin/'), undefined);
    assert.equal(countryInUrl('not a url'), undefined);
  });
});

describe('regionOf', () => {
  test('a verdict from 3 or more known events', () => {
    assert.equal(regionOf({ sk: 3 }), 'sk');
    assert.equal(regionOf({ abroad: 3 }), 'abroad');
    assert.equal(regionOf({ sk: 5, abroad: 5 }), 'mixed');
    assert.equal(regionOf({ sk: 9, abroad: 1 }), 'sk');
    assert.equal(regionOf({ sk: 1, abroad: 9 }), 'abroad');
    assert.equal(regionOf({ sk: 17, abroad: 3 }), 'mixed'); // exactly 85 % is not "over 85 %"
  });
  test('fewer than 3 known: no verdict', () => {
    assert.equal(regionOf({ sk: 1, abroad: 1 }), undefined);
    assert.equal(regionOf(null), undefined);
  });
});

describe('slovakVariants', () => {
  test('swaps a country--town segment or a town abroad for Slovak towns', () => {
    assert.deepEqual(slovakVariants('https://www.eventbrite.com/d/germany--hamburg/networking/', ['Bratislava', 'Košice']), [
      'https://www.eventbrite.com/d/slovakia--bratislava/networking/',
      'https://www.eventbrite.com/d/slovakia--kosice/networking/',
    ]);
    assert.deepEqual(slovakVariants('https://allevents.in/vienna/concerts?x=1', ['Bratislava']),
      ['https://allevents.in/bratislava/concerts']);
  });
  test('nothing to swap, or already Slovak', () => {
    assert.deepEqual(slovakVariants('https://x.sk/vienna/', ['Bratislava']), []);
    assert.deepEqual(slovakVariants('https://x.com/foo/'), []);
    assert.deepEqual(slovakVariants('not a url'), []);
  });
});

describe('namesSkTown', () => {
  test('a town, a form of it, or its other name', () => {
    for (const t of ['bratislavske', 'kosicky', 'v-trencine', 'kassa']) assert.equal(namesSkTown(t), true, t);
  });
  test('not first names or other words', () => {
    assert.equal(namesSkTown('martin'), false);
    assert.equal(namesSkTown('hello world'), false);
  });
});

describe('locativeTown / slovakWords', () => {
  test('a Slovak town in the locative', () => {
    assert.equal(locativeTown('Divadlo J. Palárika v Trnave'), 'Trnava');
    assert.equal(locativeTown('knižnica v Tvrdošovciach'), 'Tvrdošovce');
    assert.equal(locativeTown('v Košiciach'), 'Košice');
    assert.equal(locativeTown('Lucerna, Praha'), undefined);
  });
  test('Slovak venue words and letters', () => {
    for (const t of ['Dom kultúry Kanianka', 'Evanjelický kostol', 'Hlavné námestie', 'Divadlo J. Palárika v Trnave']) {
      assert.equal(slovakWords(t), true, t);
    }
  });
  test('not Slovak', () => {
    for (const t of ['Lucerna, Praha', 'Café Paris', 'Městské divadlo', '']) assert.equal(slovakWords(t), false, t);
  });
});

describe('slovakPage', () => {
  test('pages that could be about Slovakia', () => {
    assert.equal(slovakPage({ url: 'https://foo.sk/' }), true);
    assert.equal(slovakPage({ url: 'https://x.com/', lang: 'cs-CZ' }), true);
    assert.equal(slovakPage({ url: 'https://x.com/', text: 'Koncert v Bratislave' }), true);
    assert.equal(slovakPage({ url: 'https://x.com/', text: 'ľĺŕ abc' }), true);
  });
  test('pages that cannot be', () => {
    assert.equal(slovakPage({ url: 'https://capitalone.com/', text: 'Banking' }), false);
    assert.equal(slovakPage({ url: 'bad' }), false);
  });
});
