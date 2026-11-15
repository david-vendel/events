// Unit tests for src/events.js: how sightings become events, and how stored events are joined and
// split again each pass (migrate). Cases from the live data (Nov 2026).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { EventIndex, migrate } from '../src/events.js';

const TODAY = '2026-11-15';
const row = (title, start, location, url, extra = {}) => ({
  kind: 'web', status: 'ok', title, start, location, url, via: extra.via || url, ...extra,
});
const site = (url) => new URL(url).hostname.replace(/^www\./, '');
/** A stored event made of listing rows, as the crawler keeps it. */
const stored = (id, rows, firstSeenAt = '2026-11-01T00:00:00.000Z') => ({
  id, title: rows[0].title, start: rows[0].start, location: rows[0].location,
  sources: rows.map((r) => ({ ...r, site: site(r.url) })), firstSeenAt, lastSeenAt: firstSeenAt,
});
// Past events with titles of their own, so word weights are as in real data: a word every title
// shares weighs nothing.
const WORDS = ['jazz', 'rock', 'folk', 'opera', 'balet', 'dielňa', 'beh', 'trh', 'výstava', 'kurz', 'ples', 'omša', 'film', 'súťaž',
  'prednáška', 'koncert', 'tanec', 'divadlo', 'kvíz', 'jarmok'];
const filler = Array.from({ length: 200 }, (_, i) => stored(`old${i}`, [row(`${WORDS[i % 20]} ${WORDS[(i * 7 + 3) % 20]} č${i}`, '2026-01-10',
  'Somewhere', `https://old.example.com/${i}`)]));
const run = (events, sources = {}) => {
  const state = { events: Object.fromEntries([...filler, ...events].map((e) => [e.id, e])), sources, venues: {}, meta: {} };
  const log = console.log;
  console.log = () => {};
  try { migrate(state, TODAY); } finally { console.log = log; }
  return state;
};
/** The event each row (by URL) ended up in. */
const eventOf = (state, url) => Object.values(state.events).find((e) => e.sources.some((r) => r.url === url))?.id;

describe('EventIndex: sightings of one title on one day', () => {
  test('a film at another cinema in the same town is another event', () => {
    const index = new EventIndex({ events: {}, sources: {} });
    const klubkino = index.add(row('Ja, Rocky – Kino Film Europe', '2026-11-19', 'Kino Film Europe, Štefánikova 25, Bratislava',
      'https://www.klubkino.sk/film/ja-rocky/', { time: '19:00' }));
    const eurovea = index.add(row('Ja, Rocky', '2026-11-19', 'Cinema City Eurovea, Pribinova 8, Bratislava',
      'https://kinoprogram.sk/program/tyzden/', { time: '20:00' }));
    assert.equal(eurovea.isNew, true);
    // The same screening on another site joins it.
    const csfd = index.add(row('Ja, Rocky', '2026-11-19', 'Bratislava - Kino Film Europe',
      'https://www.csfd.sk/film/1751594-ja-rocky/prehlad/', { time: '19:00', via: 'https://www.csfd.sk/kino/94-bratislava/' }));
    assert.equal(csfd.event, klubkino.event);
  });
  test('two shows of one day are two events, each joined by its own listings', () => {
    const index = new EventIndex({ events: {}, sources: {} });
    const morning = index.add(row('Rozprávky o Malej tučnej víle', '2026-11-28', 'Bratislavské bábkové divadlo, Bratislava',
      'https://kulthund.sk/podujatie/rozpravky-1', { time: '10:00' }));
    const afternoon = index.add(row('Rozprávky o Malej tučnej víle', '2026-11-28', 'Bratislavské bábkové divadlo – Štúdio, Dunajská 36, Bratislava',
      'https://www.lifezone.sk/podujatia/rozpravky-1430/', { time: '14:30' }));
    assert.equal(afternoon.isNew, true);
    const again = index.add(row('Rozprávky o Malej tučnej víle', '2026-11-28', 'Bratislavské bábkové divadlo',
      'https://predpredaj.zoznam.sk/sk/podujatie/rozpravky/', { time: '14:30' }));
    assert.equal(again.event, afternoon.event);
    assert.notEqual(again.event, morning.event);
  });
  test('the same row seen again with its time corrected stays in its event', () => {
    const index = new EventIndex({ events: {}, sources: {} });
    const first = index.add(row('Mireille Mathieu', '2026-12-01', 'PEUGEOT aréna Bratislava', 'https://www.livemusic.sk/koncert/1', { time: '18:00' }));
    const again = index.add(row('Mireille Mathieu', '2026-12-01', 'PEUGEOT aréna Bratislava', 'https://www.livemusic.sk/koncert/1', { time: '20:00' }));
    assert.equal(again.event, first.event);
    assert.equal(first.event.sources.length, 1);
  });
  test('titles in another script on one day are not one event (their ids have no letters)', () => {
    const index = new EventIndex({ events: {}, sources: {} });
    const a = index.add(row('Класика при свічках', '2026-11-21', 'Братислава', 'https://a.example.com/1'));
    const b = index.add(row('Вечір поезії', '2026-11-21', 'Братислава', 'https://b.example.com/2'));
    assert.equal(b.isNew, true);
    assert.notEqual(a.event, b.event);
  });
});

describe('migrate: stored events split and joined again', () => {
  test('a row that names no town does not bridge two towns (Fragile in Nitra, Trnava and Košice)', () => {
    const nitra = 'https://www.ajdnes.sk/vianocne-koncerty-fragile--robo-opatovsky/nitra/159929';
    const nitraTown = 'https://nitra.virtualne.sk/akcie-a-podujatia/vianocne-koncerty-fragile--amp--robo-opatovsky-0.html';
    const trnava = 'https://trnava.virtualne.sk/akcie-a-podujatia/vianocne-koncerty-fragile--amp--robo-opatovsky-1.html';
    const kosice = 'https://kulthund.sk/podujatie/fragile-vianocne-koncerty-13480';
    const state = run([stored('f86e52e39946b46b', [
      row('Vianočné koncerty Fragile & Robo Opatovský', '2026-12-15', 'PKO, Nitra', nitra),
      row('Vianočné koncerty Fragile & Robo Opatovský', '2026-12-15', 'Janka Kráľa 1048/4', nitraTown),
      row('Vianočné koncerty Fragile & Robo Opatovský', '2026-12-13', 'Trojičné námestie', trnava),
      row('FRAGILE - Vianočné koncerty', '2026-12-16', 'Kresťanské centrum AC, Košice', kosice, { time: '19:00' }),
    ])]);
    assert.equal(eventOf(state, nitra), eventOf(state, nitraTown));
    assert.notEqual(eventOf(state, nitra), eventOf(state, trnava));
    assert.notEqual(eventOf(state, nitra), eventOf(state, kosice));
  });
  test("one cinema's screenings stay apart from another's", () => {
    const klubkino = 'https://www.klubkino.sk/film/ja-rocky/';
    const eurovea = 'https://kinoprogram.sk/program/tyzden/';
    const csfd = 'https://www.csfd.sk/film/1751594-ja-rocky/prehlad/';
    const state = run([stored('6eebbdd960fc6109', [
      row('Ja, Rocky – Kino Lúky', '2026-11-19', 'Kino Lúky, Vigľašská 1, Petržalka, Bratislava', klubkino, { time: '19:00' }),
      row('Ja, Rocky', '2026-11-19', 'Cinema City Eurovea, Pribinova 8, Bratislava', eurovea, { time: '19:30' }),
      row('Ja, Rocky', '2026-11-19', 'Bratislava - Kino Lúky', csfd, { time: '19:00', via: 'https://www.csfd.sk/kino/94-bratislava/' }),
    ])]);
    assert.equal(eventOf(state, klubkino), eventOf(state, csfd));
    assert.notEqual(eventOf(state, klubkino), eventOf(state, eurovea));
  });
  test('an event grown by one join is checked again before the next (Beh za duše 2026)', () => {
    const vyveska = 'https://www.vyveska.sk/beh-za-duse-2026/';
    const ivanka = 'https://kolegium.org/event/udalost-beh-za-duse-2026/';
    const kosice = 'https://hapsy.co/sk/e/beh-za-duse';
    const state = run([
      stored('a1', [row('Beh za duše 2026', '2026-11-20', 'celé Slovensko Duchovné, Mládež, Ostatné', vyveska, { via: 'https://www.vyveska.sk/zoznam-podujati/' })], '2026-10-01T00:00:00.000Z'),
      stored('a2', [row('Beh za duše 2026', '2026-11-20', 'Ivanka pri Dunaji', ivanka, { via: 'https://kolegium.org/events/' })], '2026-10-02T00:00:00.000Z'),
      stored('a3', [row('Beh za duše 2026', '2026-11-20', 'Košice', kosice, { via: 'https://hapsy.co/sk/slovensko/beh' })], '2026-10-03T00:00:00.000Z'),
    ]);
    assert.notEqual(eventOf(state, ivanka), eventOf(state, kosice));
    assert.equal(Object.keys(state.events).length - filler.length, 2);
  });
  test("a site that lists all of Slovakia doesn't place its events in its first page's town (hapsy.co)", () => {
    const hapsy = 'https://hapsy.co/sk/e/millennium-mashup-tv-31';
    const kulthund = 'https://kulthund.sk/podujatie/millennium-mashup-tv-the-pussycat-dolls-edition-14504';
    const sources = { 'https://hapsy.co': { origin: 'https://hapsy.co', kind: 'events', city: 'Košice',
      pages: { 'https://hapsy.co/de/kosice/partys': { city: 'Košice' } } } };
    const state = run([
      stored('b1', [row('Millennium Mashup TV – The Pussycat Dolls Edition', '2026-11-21', 'Aldea Club, Bratislava', kulthund,
        { time: '22:00', via: 'https://kulthund.sk/podujatia/party' })]),
      stored('b2', [row('Millennium Mashup TV: The Pussycat Dolls Edition', '2026-11-21', undefined, hapsy,
        { time: '22:00', via: 'https://hapsy.co/sk/bratislava/party' })], '2026-11-04T00:00:00.000Z'),
    ], sources);
    assert.equal(eventOf(state, hapsy), eventOf(state, kulthund));
  });
  test('true duplicates on different sites are still joined', () => {
    const kulthund = 'https://kulthund.sk/podujatie/vianocne-koncerty-fragile-robo-opatovsky-1795';
    const ajdnes = 'https://www.ajdnes.sk/vianocne-koncerty-fragile--robo-opatovsky/nitra/159929';
    const ticketportal = 'https://www.ticketportal.sk/event/Vianocne-koncerty-Fragile-Robo-Opatovsky';
    const predpredaj = 'https://predpredaj.zoznam.sk/sk/podujatie/vianocne-koncerty-fragile-nitra/';
    const state = run([
      stored('c1', [row('Vianočné koncerty Fragile & Robo Opatovský', '2026-12-15', 'PKO Nitra, Nitra', kulthund, { time: '19:00' })]),
      stored('c2', [row('Vianočné koncerty Fragile & Robo Opatovský', '2026-12-15', 'PKO, Nitra', ajdnes)], '2026-11-02T00:00:00.000Z'),
      stored('c3', [row('Vianočné koncerty Fragile & Robo Opatovský 15.12.2026 19:00 - hosť Bystrík', '2026-12-15', 'PKO Nitra', ticketportal,
        { time: '19:00' })], '2026-11-03T00:00:00.000Z'),
      stored('c4', [row('Vianočné koncerty Fragile & Robo Opatovský - Nitra', '2026-12-15', 'PKO Nitra, Štefánikova trieda 3, 949 01 Nitra', predpredaj,
        { time: '18:00' })], '2026-11-04T00:00:00.000Z'),
    ]);
    assert.equal(Object.keys(state.events).length - filler.length, 1);
  });
});
