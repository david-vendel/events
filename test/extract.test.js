import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { cleanLocation, plain, clean, makeEvent, jsonLdEvents, applyRecipe, eventId } from '../src/extract.js';

const NOW = new Date(2026, 10, 15, 12, 0); // mid-November 2026, local time
const SRC = 'https://example.sk/podujatia';
// jsonLdEvents / applyRecipe don't take `now` (makeEvent defaults to today): fixtures use dates
// with a year and in the past, which nothing filters out, so these tests don't depend on today.

test('clean collapses whitespace', () => {
  assert.equal(clean('  a \n\t b  '), 'a b');
  assert.equal(clean(undefined), '');
});

test('plain: text from (escaped) HTML', () => {
  assert.equal(plain('<p>Koncert <b>v Dóme</b></p>'), 'Koncert v Dóme');
  assert.equal(plain('&lt;b&gt;Ahoj&lt;/b&gt; svet'), 'Ahoj svet');
  assert.equal(plain('Tom &amp; Jerry'), 'Tom & Jerry');
  assert.equal(plain('riadok\\nďalší'), 'riadok ďalší');
  assert.equal(plain('Pekný večer. Čítať viac…'), 'Pekný večer.');
  assert.equal(plain('Pekný večer Read More...'), 'Pekný večer');
  assert.equal(plain(null), '');
});

test('cleanLocation strips labels', () => {
  assert.equal(cleanLocation('Miesto konania: Dom umenia, Košice'), 'Dom umenia, Košice');
  assert.equal(cleanLocation('Miesto podujatia: Kasárne Kulturpark'), 'Kasárne Kulturpark');
  assert.equal(cleanLocation('Lokalita: Badín'), 'Badín');
  assert.equal(cleanLocation('Venue: Steel Aréna'), 'Steel Aréna');
  assert.equal(cleanLocation('Location: Hlavná 1, Košice'), 'Hlavná 1, Košice');
  assert.equal(cleanLocation('Adresa: Hlavná 1'), 'Hlavná 1');
});

test('cleanLocation strips dates', () => {
  assert.equal(cleanLocation('04.10.2026 10:30 | BDNR'), 'BDNR');
  assert.equal(cleanLocation('Termín: 03.10.2026 a ďalšie Mesto: Badín'), 'Badín');
  assert.equal(cleanLocation('4. 10. Tabačka'), 'Tabačka');
  // Text without a label or date is unchanged.
  assert.equal(cleanLocation('Kino Úsmev, Kináreň'), 'Kino Úsmev, Kináreň');
  assert.equal(cleanLocation(''), '');
});

test('makeEvent: basic event from date text', () => {
  const ev = makeEvent({ title: ' Koncert ', dateText: '5.12.2026 19:00', location: 'Miesto: Dom umenia', url: 'https://example.sk/k' }, SRC, NOW);
  assert.equal(ev.title, 'Koncert');
  assert.equal(ev.start, '2026-12-05');
  assert.equal(ev.time, '19:00');
  assert.equal(ev.location, 'Dom umenia');
  assert.equal(ev.url, 'https://example.sk/k');
  assert.equal(ev.source, SRC);
  assert.equal(ev.dateText, '5.12.2026 19:00');
  assert.equal(ev.id, eventId('Koncert', '2026-12-05'));
});

test('makeEvent: url falls back to the source', () => {
  const ev = makeEvent({ title: 'X', dateText: '5.12.2026' }, SRC, NOW);
  assert.equal(ev.url, SRC);
  assert.equal(ev.location, undefined);
  assert.equal(ev.description, undefined);
});

test('makeEvent: null without a title or a date', () => {
  assert.equal(makeEvent({ title: '', dateText: '5.12.2026' }, SRC, NOW), null);
  assert.equal(makeEvent({ dateText: '5.12.2026' }, SRC, NOW), null);
  assert.equal(makeEvent({ title: 'Koncert', dateText: 'čoskoro' }, SRC, NOW), null);
  assert.equal(makeEvent({ title: 'Koncert' }, SRC, NOW), null);
});

test('makeEvent: year from the event URL when the date text has none', () => {
  // Guessed 2026 (88 days back), URL says 2026: unchanged.
  assert.equal(makeEvent({ title: 'Zápas', dateText: '19. 8.', url: 'https://example.sk/2026-08-19-zapas' }, SRC, NOW).start, '2026-08-19');
  // Guessed 2026-12-20, URL says 2025.
  assert.equal(makeEvent({ title: 'Zápas', dateText: '20. 12.', url: 'https://example.sk/zapasy/2025-12-20-a-b' }, SRC, NOW).start, '2025-12-20');
  // Guessed 2027-08-01 (more than 100 days back), URL in "dd-mm-yyyy" says 2026.
  assert.equal(makeEvent({ title: 'Zápas', dateText: '1. 8.', url: 'https://example.sk/zapas-01-08-2026' }, SRC, NOW).start, '2026-08-01');
  assert.equal(makeEvent({ title: 'Zápas', dateText: '20. 12.', url: 'https://example.sk/2025/12/20/zapas' }, SRC, NOW).start, '2025-12-20');
});

test('makeEvent: URL year ignored when the date text has a year or the URL date differs', () => {
  assert.equal(makeEvent({ title: 'Z', dateText: '20. 12. 2026', url: 'https://example.sk/2025-12-20' }, SRC, NOW).start, '2026-12-20');
  // Different day in the URL: not this event's date.
  assert.equal(makeEvent({ title: 'Z', dateText: '20. 12.', url: 'https://example.sk/2025-12-21' }, SRC, NOW).start, '2026-12-20');
});

test('makeEvent: description label stripped', () => {
  const d = (description) => makeEvent({ title: 'X', dateText: '5.12.2026', description }, SRC, NOW).description;
  assert.equal(d('Popis podujatia: Veľký koncert.'), 'Veľký koncert.');
  assert.equal(d('Popis: Veľký koncert.'), 'Veľký koncert.');
  assert.equal(d('Description: Big gig'), 'Big gig');
  assert.equal(d('<p>Popis udalosti:</p> Text'), 'Text');
});

test('makeEvent: structured start/end', () => {
  const ev = makeEvent({ title: 'Festival', start: '2026-10-02T18:00', end: '2026-10-04T22:00' }, SRC, NOW);
  assert.equal(ev.start, '2026-10-02');
  assert.equal(ev.end, '2026-10-04');
  assert.equal(ev.time, '18:00');
  assert.equal(ev.endTime, '22:00');
  assert.equal(ev.dateText, undefined);
});

test('makeEvent: too far ahead is dropped', () => {
  assert.equal(makeEvent({ title: 'X', dateText: '13.11.2058' }, SRC, NOW), null);
  assert.equal(makeEvent({ title: 'X', start: '2030-01-01' }, SRC, NOW), null);
});

test('makeEvent: only known tags kept', () => {
  const ev = makeEvent({ title: 'X', dateText: '5.12.2026', tags: ['nonsense-tag-xyz'] }, SRC, NOW);
  assert.equal(ev.tags, undefined);
});

// ---------------------------------------------------------------- JSON-LD

const page = (...objs) => cheerio.load(`<html><head>${objs.map((o) => `<script type="application/ld+json">${JSON.stringify(o)}</script>`).join('')}</head><body></body></html>`);

test('jsonLdEvents: Event with place, geo and address country', () => {
  const $ = page({
    '@context': 'https://schema.org', '@type': 'MusicEvent', name: 'Koncert &amp; spol.', startDate: '2026-10-07T19:00',
    endDate: '2026-10-07T22:00', url: '/koncert',
    description: '<p>Popis podujatia: Dobrá hudba</p>',
    location: { '@type': 'Place', name: 'Dom umenia', address: { streetAddress: 'Moyzesova 66', addressLocality: 'Košice', addressCountry: 'SK' },
      geo: { latitude: '48.72', longitude: 21.26 } },
  });
  const [ev, ...rest] = jsonLdEvents($, SRC);
  assert.equal(rest.length, 0);
  assert.equal(ev.title, 'Koncert & spol.');
  assert.equal(ev.start, '2026-10-07');
  assert.equal(ev.time, '19:00');
  assert.equal(ev.endTime, '22:00');
  assert.equal(ev.location, 'Dom umenia, Moyzesova 66, Košice');
  assert.equal(ev.description, 'Dobrá hudba');
  assert.equal(ev.url, 'https://example.sk/koncert');
  assert.deepEqual(ev.geo, { lat: 48.72, lon: 21.26 });
  assert.equal(ev.pageCountry, 'SK');
});

test('jsonLdEvents: addressCountry as an object; no geo when missing or 0,0', () => {
  const $ = page({ '@type': 'Event', name: 'A', startDate: '2026-10-07',
    location: { '@type': 'Place', name: 'Hall', address: { addressLocality: 'Wien', addressCountry: { name: 'Austria' } }, geo: { latitude: 0, longitude: 0 } } });
  const [ev] = jsonLdEvents($, SRC);
  assert.equal(ev.pageCountry, 'Austria');
  assert.equal(ev.geo, undefined);
});

test('jsonLdEvents: start time zone', () => {
  const zone = (startDate) => jsonLdEvents(page({ '@type': 'Event', name: 'A', startDate, location: { name: 'Hall' } }), SRC)[0];
  assert.equal(zone('2026-10-07T19:00:00-05:00').pageCountry, 'abroad');
  assert.equal(zone('2026-10-07T19:00:00+09:00').pageCountry, 'abroad');
  assert.equal(zone('2026-10-07T19:00:00+01:00').pageCountry, undefined);
  assert.equal(zone('2026-10-07T19:00:00+02:00').pageCountry, undefined);
  assert.equal(zone('2026-10-07T19:00:00+00:00').pageCountry, undefined);
  assert.equal(zone('2026-10-07T19:00:00Z').pageCountry, undefined);
  // The written local time is kept.
  assert.equal(zone('2026-10-07T19:00:00+01:00').time, '19:00');
});

test('jsonLdEvents: online only', () => {
  const virtual = jsonLdEvents(page({ '@type': 'Event', name: 'Webinár', startDate: '2026-10-07T10:00',
    location: { '@type': 'VirtualLocation', url: 'https://zoom.us/j/1' } }), SRC)[0];
  assert.equal(virtual.location, 'Online');
  const mode = jsonLdEvents(page({ '@type': 'Event', name: 'Webinár', startDate: '2026-10-07T10:00',
    eventAttendanceMode: 'https://schema.org/OnlineEventAttendanceMode' }), SRC)[0];
  assert.equal(mode.location, 'Online');
  // Mixed: a physical place next to the virtual one wins.
  const mixed = jsonLdEvents(page({ '@type': 'Event', name: 'Hybrid', startDate: '2026-10-07T10:00',
    location: [{ '@type': 'VirtualLocation', url: 'https://zoom.us/j/1' }, { '@type': 'Place', name: 'Tabačka', address: 'Gorkého 2, Košice' }] }), SRC)[0];
  assert.equal(mixed.location, 'Tabačka, Gorkého 2, Košice');
  // No location at all and not online: no location.
  const none = jsonLdEvents(page({ '@type': 'Event', name: 'X', startDate: '2026-10-07' }), SRC)[0];
  assert.equal(none.location, undefined);
});

test('jsonLdEvents: @graph, subEvent, arrays, non-events and bad JSON', () => {
  const $ = cheerio.load(`<script type="application/ld+json">{ not json</script>
    <script type="application/ld+json">${JSON.stringify({ '@graph': [
      { '@type': 'Organization', name: 'Org' },
      { '@type': ['Event', 'Festival'], name: 'Fest', startDate: '2026-07-01', endDate: '2026-07-03',
        subEvent: [{ '@type': 'TheaterEvent', name: 'Hra', startDate: '2026-07-02T20:00' }] },
    ] })}</script>
    <script type="application/ld+json">${JSON.stringify([{ '@type': 'SportsEvent', name: 'Zápas', startDate: '2026-09-01', URL: 'https://example.sk/z' }])}</script>`);
  const evs = jsonLdEvents($, SRC);
  assert.deepEqual(evs.map((e) => e.title), ['Fest', 'Hra', 'Zápas']);
  assert.equal(evs[0].end, '2026-07-03');
  assert.equal(evs[2].url, 'https://example.sk/z');
});

test('jsonLdEvents: events without name or date are skipped', () => {
  const evs = jsonLdEvents(page({ '@type': 'Event', name: 'Bez dátumu' }, { '@type': 'Event', startDate: '2026-10-07' }), SRC);
  assert.equal(evs.length, 0);
});

// ---------------------------------------------------------------- recipes

test('applyRecipe: basic recipe', () => {
  const $ = cheerio.load(`<ul>
    <li class="ev"><h3>Koncert</h3><span class="d">5.12.2026</span><span class="t">19:00</span><span class="p">Miesto konania: Dom umenia</span>
      <p class="desc">Popis podujatia: Hudba</p><a href="/koncert">Viac</a><a href="https://maps.google.com/x">mapa</a></li>
    <li class="ev"><h3>Divadlo</h3><span class="d">6.12.2026</span></li>
    <li class="ev"><h3></h3><span class="d">7.12.2026</span></li>
  </ul>`);
  const evs = applyRecipe($, { item: 'li.ev', title: 'h3', date: '.d', time: '.t', location: '.p', description: '.desc' }, SRC);
  assert.equal(evs.length, 2); // the one without a title is dropped
  assert.equal(evs[0].title, 'Koncert');
  assert.equal(evs[0].start, '2026-12-05');
  assert.equal(evs[0].time, '19:00');
  assert.equal(evs[0].location, 'Dom umenia');
  assert.equal(evs[0].description, 'Hudba');
  assert.equal(evs[0].url, 'https://example.sk/koncert'); // first same-site link, not the map
  assert.equal(evs[1].url, SRC);
});

test('applyRecipe: title spread over alike cells is joined', () => {
  const $ = cheerio.load(`<table>
    <tr class="m"><td class="team">BK DSG Dunajská Streda</td><td class="team">BK Iskra Partizánske</td><td class="d">1.10.2026 18:00</td></tr>
  </table>`);
  const [ev] = applyRecipe($, { item: 'tr.m', title: 'td.team', date: '.d' }, SRC);
  assert.equal(ev.title, 'BK DSG Dunajská Streda – BK Iskra Partizánske');
  assert.equal(ev.time, '18:00');
});

test('applyRecipe: three alike cells joined; four or unlike cells are not', () => {
  const three = cheerio.load('<div class="i"><b class="x">A</b><b class="x">B</b><b class="x">C</b><i>1.10.2026</i></div>');
  assert.equal(applyRecipe(three, { item: '.i', title: '.x', date: 'i' }, SRC)[0].title, 'A – B – C');
  const four = cheerio.load('<div class="i"><b class="x">A</b><b class="x">B</b><b class="x">C</b><b class="x">D</b><i>1.10.2026</i></div>');
  assert.equal(applyRecipe(four, { item: '.i', title: '.x', date: 'i' }, SRC)[0].title, 'A');
  // A title and a "more" link, or cells of different classes: the first cell only.
  const more = cheerio.load('<div class="i"><a class="x">Koncert</a><a class="x">Viac info</a><i>1.10.2026</i></div>');
  assert.equal(applyRecipe(more, { item: '.i', title: '.x', date: 'i' }, SRC)[0].title, 'Koncert');
  const unlike = cheerio.load('<div class="i"><h3 class="x">Koncert</h3><span class="x">Podtitul</span><i>1.10.2026</i></div>');
  assert.equal(applyRecipe(unlike, { item: '.i', title: '.x', date: 'i' }, SRC)[0].title, 'Koncert');
});

test('applyRecipe: javascript:, mailto: and tel: links are not used as url', () => {
  const $ = cheerio.load(`
    <div class="i"><h3>A</h3><i>1.10.2026</i><a class="l" href="javascript:void(0)">x</a></div>
    <div class="i"><h3>B</h3><i>2.10.2026</i><a class="l" href="mailto:info@example.sk">x</a></div>
    <div class="i"><h3>C</h3><i>3.10.2026</i><a class="l" href="tel:+421900000000">x</a></div>
    <div class="i"><h3>D</h3><i>4.10.2026</i><a class="l" href="/d">x</a></div>`);
  const evs = applyRecipe($, { item: '.i', title: 'h3', date: 'i', link: 'a.l' }, SRC);
  assert.deepEqual(evs.map((e) => e.url), [SRC, SRC, SRC, 'https://example.sk/d']);
});

test('applyRecipe: item that is itself a link', () => {
  const $ = cheerio.load('<a class="i" href="/e/1"><h3>A</h3><i>1.10.2026</i></a>');
  assert.equal(applyRecipe($, { item: 'a.i', title: 'h3', date: 'i' }, SRC)[0].url, 'https://example.sk/e/1');
});

test('applyRecipe: invalid selectors give nothing, not an error', () => {
  const $ = cheerio.load('<div class="i"><h3>A</h3><i>1.10.2026</i></div>');
  assert.deepEqual(applyRecipe($, { item: '[[[', title: 'h3', date: 'i' }, SRC), []);
  assert.deepEqual(applyRecipe($, { item: '.i', title: '[[[', date: 'i' }, SRC), []);
});
