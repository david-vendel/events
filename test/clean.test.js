// Titles, places and addresses as the audit of the live site found them (Nov 2026).
import test from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import {
  applyRecipe, blockText, cleanLocation, cleanTitle, eventUrl, junkTitle, makeEvent, notAnEvent, repairRow, splitTitleMeta,
} from '../src/extract.js';

const NOW = new Date(2026, 10, 15, 12, 0);
const SRC = 'https://example.sk/podujatia';

test('splitTitleMeta: kulthund.sk link text', () => {
  assert.deepEqual(splitTitleMeta('FSS Radosť – Spomienky pri mladom víne — folklór, 28.11.2026 18:00, Dom kultúry Pezinok, Pezinok.'),
    { title: 'FSS Radosť – Spomienky pri mladom víne', category: 'folklór', location: 'Dom kultúry Pezinok, Pezinok' });
  assert.deepEqual(splitTitleMeta('Iránsky zoznam — výstava, prebieha do 30.11.2026, Krajská knižnica P. O. Hviezdoslava v Prešove, Prešov.'),
    { title: 'Iránsky zoznam', category: 'výstava', location: 'Krajská knižnica P. O. Hviezdoslava v Prešove, Prešov' });
  // A venue with a dash and commas of its own; a title with " — " in it.
  assert.equal(splitTitleMeta('Pi čaj, miláčik! — divadlo, 20.1.2027 19:00, MsKS Šamorín — Divadelná sála, Šamorín.').location,
    'MsKS Šamorín — Divadelná sála, Šamorín');
  assert.equal(splitTitleMeta('A — B — koncert, 1.12.2026 19:00, Klub, Nitra.').title, 'A — B');
  // Normal titles with a dash: no date after the category, so nothing to split.
  assert.equal(splitTitleMeta('Hamlet — Shakespeare'), null);
  assert.equal(splitTitleMeta('Kurz ručného šitia a látania sashiko — oprav si obľúbený kus'), null);
  assert.equal(splitTitleMeta('Koncert — hostia, Bratislava'), null);
});

test('makeEvent: kulthund title cleaned, its place used when the row has none or only the town', () => {
  const raw = 'Gonsofus (DJ Set) – DJ Global Groove Medicine — párty, 5.11.2026 00:00, Nu Spirit Bar, Bratislava.';
  const ev = makeEvent({ title: raw, dateText: raw, location: 'Bratislava', url: 'https://kulthund.sk/podujatie/gonsofus-8205' }, SRC, NOW);
  assert.equal(ev.title, 'Gonsofus (DJ Set) – DJ Global Groove Medicine');
  assert.equal(ev.location, 'Nu Spirit Bar, Bratislava');
  assert.equal(makeEvent({ title: raw, dateText: raw }, SRC, NOW).location, 'Nu Spirit Bar, Bratislava');
  // A location of its own that says more is kept.
  assert.equal(makeEvent({ title: raw, dateText: raw, location: 'Medená 16, Bratislava' }, SRC, NOW).location, 'Medená 16, Bratislava');
});

test('cleanTitle: screen-reader words', () => {
  assert.equal(cleanTitle('Antonio Vivaldi: Štyri ročné obdobia (otvorí sa na novej karte)'), 'Antonio Vivaldi: Štyri ročné obdobia');
  assert.equal(cleanTitle('Vianočný koncert (K) (otvorí sa na novej karte)'), 'Vianočný koncert (K)');
  assert.equal(cleanTitle('Jazz Night (opens in a new tab)'), 'Jazz Night');
  assert.equal(cleanTitle('Výstava otvorí sa v novom okne'), 'Výstava');
});

test('cleanTitle: a showtime glued to the title', () => {
  assert.equal(cleanTitle('VŠETCI FOTRI SÚ LOTRI18:30'), 'VŠETCI FOTRI SÚ LOTRI');
  assert.equal(cleanTitle('Ebenezer: Vianočná koleda (ČD)19:30'), 'Ebenezer: Vianočná koleda (ČD)');
  assert.equal(cleanTitle('Malá Amélia + En ten tiky!17:00'), 'Malá Amélia + En ten tiky!');
  assert.equal(cleanTitle('Film – 18:30'), 'Film');
  // Kept: a time with a space, a range, digits before, an impossible time, a time range after " – ".
  assert.equal(cleanTitle('Party 2:00'), 'Party 2:00');
  assert.equal(cleanTitle('Masala Jazz, 8-9:30'), 'Masala Jazz, 8-9:30');
  assert.equal(cleanTitle('Rok 202519:00'), 'Rok 202519:00');
  assert.equal(cleanTitle('Hra o 99:99'), 'Hra o 99:99');
  assert.equal(cleanTitle('Kurz jogy • ŠTVRTKY 18:00 – 19:30'), 'Kurz jogy • ŠTVRTKY 18:00 – 19:30');
});

test('cleanTitle: separator or score left at the end', () => {
  assert.equal(cleanTitle('SLÁVIA Banská Bystrica – BKM Žilina -'), 'SLÁVIA Banská Bystrica – BKM Žilina');
  assert.equal(cleanTitle('SÁNDOR HOMONYIK –'), 'SÁNDOR HOMONYIK');
  assert.equal(cleanTitle('MFK Zvolen – -'), 'MFK Zvolen');
  assert.equal(cleanTitle('BC Slovan – Slávia ŠKP – 36 - 67'), 'BC Slovan – Slávia ŠKP');
  assert.equal(cleanTitle('Hamlet — Shakespeare'), 'Hamlet — Shakespeare');
});

test('junkTitle: dates, numbers, weekdays, button words', () => {
  for (const t of ['19.11.2026', '27. 1.', '09. 12. 2026', '14', 'So 21. 11.', 'Ne 15. 11.', 'sobota', '8:00 - 11:00',
    '04.07.2027 10.07.2027', 'Pozvánka', 'POZVÁNKA', 'Viac info', 'Detail', 'Program', 'Rezervácia', '']) {
    assert.equal(junkTitle(t), true, t);
  }
  for (const t of ['1970', '1917', 'Koncert', 'Hamlet', '3 ŽELANIA PRE POPOLUŠKU', 'Pozvánka na ľudovú zábavu', 'Detail v umení',
    '14 dní', 'Sobota v divadle', 'Program pre deti']) {
    assert.equal(junkTitle(t), false, t);
  }
  assert.equal(makeEvent({ title: '19.11.2026', dateText: '19.11.2026' }, SRC, NOW), null);
  assert.equal(makeEvent({ title: 'Pozvánka', dateText: '19.11.2026' }, SRC, NOW), null);
});

test('notAnEvent: waste collection, cancelled, byes, outages', () => {
  const cases = {
    'Vývoz komunálneho odpadu': 'waste collection',
    'Vývoz KUCHYNSKÉHO odpadu': 'waste collection',
    'Odvoz ZKO 14 d': 'waste collection',
    'zber plastov a nápojových obalov': 'waste collection',
    'Vývoz papiera z domácností': 'waste collection',
    'Zber : Plasty, Kovy, Tetrapaky od RD': 'waste collection',
    'KOMUNÁLNY ODPAD': 'waste collection',
    'ZRUŠENÉ: JAZZ FOR SALE FESTIVAL | koncert': 'cancelled',
    'Držím ti miesto - ZRUŠENÉ': 'cancelled',
    'Bibliometrické ukazovatele (zrušené)': 'cancelled',
    'Karol Duchoň, koncert - ZRUŠENÝ': 'cancelled',
    'Vital dance – tanec pre vaše zdravie, z technických príčin zrušené': 'cancelled',
    'Voľno': 'bye',
    'Prerušenie distribúcie elektriny na Františkánskej a Štefánikovej': 'outage',
    'Plánovaná odstávka vody – Vajslova dolina': 'outage',
    'Dočasná uzávierka Štefánikovej ulice': 'road closure',
    'Úradné hodiny': 'office hours',
    'Rozvrh hodín': 'timetable',
  };
  for (const [t, why] of Object.entries(cases)) assert.equal(notAnEvent({ title: t }), why, t);
  // Real events.
  for (const t of ['Zber gaštanov pre deti', 'Zrušenie oddlženia pre nepoctivý zámer dlžníka', 'Zákon o odpadoch a jeho aplikácia',
    'Duchovno – formačný pobyt v Ríme – uzávierka prihlášok', 'Nerovnomerne rozvrhnutý pracovný čas', 'Voľno v meste – festival',
    'Koncert', 'Odpadová party']) {
    assert.equal(notAnEvent({ title: t }), null, t);
  }
  assert.equal(makeEvent({ title: 'Vývoz komunálneho odpadu', dateText: '19.11.2026' }, SRC, NOW), null);
});

test('cleanLocation: junk from the audit', () => {
  assert.equal(cleanLocation('Kde: O~art centrum , Skalica'), 'O~art centrum, Skalica');
  assert.equal(cleanLocation('Kde: Dom kultúry, Snina'), 'Dom kultúry, Snina');
  assert.equal(cleanLocation('Org. MBK Handlová Academy'), '');
  assert.equal(cleanLocation('Bude doplnené'), '');
  assert.equal(cleanLocation('Multihala Košice "kategória A+"'), 'Multihala Košice');
  assert.equal(cleanLocation('Telocvičňa Školská ulica 4 Chorvátsky Grob kategória "E"'), 'Telocvičňa Školská ulica 4 Chorvátsky Grob');
  assert.equal(cleanLocation('ŠH ŠDaJĽŠ Bratislava "kategória D?"'), 'ŠH ŠDaJĽŠ Bratislava');
  assert.equal(cleanLocation('Kino PALACE, Radlinského 108/9, Nitra 6 €'), 'Kino PALACE, Radlinského 108/9, Nitra');
  assert.equal(cleanLocation('Zelené pleso · 315 €'), 'Zelené pleso');
  assert.equal(cleanLocation('Šaľa – Divadelná sála Domu kultúry 120 minút'), 'Šaľa – Divadelná sála Domu kultúry');
  assert.equal(cleanLocation('Rožňava, Slovenská republika /'), 'Rožňava, Slovenská republika');
  assert.equal(cleanLocation('Martin (SR - Žilinský kraj)'), 'Martin');
  assert.equal(cleanLocation('// Nové Mesto nad Váhom'), 'Nové Mesto nad Váhom');
  assert.equal(cleanLocation(','), '');
  assert.equal(cleanLocation('@'), '');
  assert.equal(cleanLocation('— Dom umenia, Národné osvetové centrum — Bratislava'), 'Dom umenia, Národné osvetové centrum, Bratislava');
  assert.equal(cleanLocation('Kategória: Koncert • Dátum a čas: od 19:00 • PKO Nitra, J. Kráľa 4'), 'PKO Nitra, J. Kráľa 4');
  assert.equal(cleanLocation('Kategória: Beseda • Dátum a čas:'), '');
  // Kept as they were.
  assert.equal(cleanLocation('Bratislava - Ružinov'), 'Bratislava - Ružinov');
  assert.equal(cleanLocation('Ul. 7. pešieho pluku'), 'Ul. 7. pešieho pluku');
  assert.equal(cleanLocation('Kultúrny dom ,,Vianoce s DUO JAMAHA\'\''), 'Kultúrny dom ,,Vianoce s DUO JAMAHA\'\'');
  assert.equal(cleanLocation('Kino Úsmev, Kináreň'), 'Kino Úsmev, Kináreň');
});

test('eventUrl: not scripts, files, maps or front pages', () => {
  assert.equal(eventUrl('javascript:NPerformance_load(214739, 0, 214739);'), undefined);
  assert.equal(eventUrl('mailto:info@example.sk'), undefined);
  assert.equal(eventUrl('https://punkgen.sk/plagaty/blatoidearitalin.jpg'), undefined);
  assert.equal(eventUrl('http://sbs.sav.sk/docs/SBS-2026-Luky-pozvanka.pdf'), undefined);
  assert.equal(eventUrl('https://example.sk/propozicie.docx'), undefined);
  assert.equal(eventUrl('https://www.google.sk/maps/search/Fleck,%20Mierov%C3%A9%20n%C3%A1m.%2017'), undefined);
  assert.equal(eventUrl('https://maps.app.goo.gl/abc'), undefined);
  assert.equal(eventUrl('https://www.cafenance.sk/'), undefined);
  assert.equal(eventUrl('https://example.sk/podujatia', 'https://example.sk/podujatia/'), undefined); // the listing itself
  assert.equal(eventUrl('https://www.ticketportal.sk/Event/145156'), 'https://www.ticketportal.sk/Event/145156');
  assert.equal(eventUrl('https://example.sk/?id=5'), 'https://example.sk/?id=5');
  assert.equal(eventUrl('https://example.sk/akcie/plagat-koncert'), 'https://example.sk/akcie/plagat-koncert');
});

test('makeEvent: a rejected url falls back to the listing, marked', () => {
  const ev = makeEvent({ title: 'Koncert', dateText: '5.12.2026', url: 'https://example.sk/plagat.jpg' }, SRC, NOW);
  assert.equal(ev.url, SRC);
  assert.equal(ev.listingUrl, true);
  const own = makeEvent({ title: 'Koncert', dateText: '5.12.2026', url: 'https://example.sk/koncert' }, SRC, NOW);
  assert.equal(own.url, 'https://example.sk/koncert');
  assert.equal(own.listingUrl, undefined);
  // A relative address (AI) is read against the listing.
  assert.equal(makeEvent({ title: 'Koncert', dateText: '5.12.2026', url: '/koncert' }, SRC, NOW).url, 'https://example.sk/koncert');
});

test('blockText: blocks and line breaks told apart, screen-reader text left out', () => {
  const $ = cheerio.load('<table><tr><td id="a">Royale Union SG<br />Lech Poznaň</td></tr></table><div id="b"><div>A</div> <div>B</div></div>'
    + '<a id="c">Luskáčik<span class="sr-only"> (otvorí sa na novej karte)</span></a><p id="d">Koncert <b>v Dóme</b></p>');
  assert.equal(blockText($, $('#a')[0]), 'Royale Union SG – Lech Poznaň');
  assert.equal(blockText($, $('#b')[0]), 'A B'); // a space between them already: as before
  assert.equal(blockText($, $('#c')[0]), 'Luskáčik');
  assert.equal(blockText($, $('#d')[0]), 'Koncert v Dóme');
});

test('applyRecipe: teams in cells told apart by a home/away modifier (slovakbasket, shl)', () => {
  const $ = cheerio.load(`<table><tr class="fn-tap-row">
    <td class="td-mobile-w-team"><div><span class="visible-xs competitor-img">MRK</span><span class="hidden-xs">MBK Ružomberok</span></div></td>
    <td class="td-mobile-w-team team-away"><div><span class="visible-xs competitor-img">SAM</span><span class="hidden-xs">ŠBK Šamorín</span></div></td>
    <td class="d">21.11.2026 18:00</td></tr></table>`);
  const [ev] = applyRecipe($, { item: 'tr.fn-tap-row', title: 'td.td-mobile-w-team', date: '.d' }, SRC);
  assert.equal(ev.title, 'MBK Ružomberok – ŠBK Šamorín');
});

test('applyRecipe: score cells are not names (sportnet)', () => {
  const $ = cheerio.load(`<ul><li class="m"><a class="l" href="/zapas/1/"><p class="d">15.11.2026 11:30</p>
    <div class="t"><div class="c x1"><p>FK Železiarne Podbrezová</p></div><div class="c x2"><p>MFK Zvolen</p></div></div>
    <div class="t s"><div class="c x1"><p>6</p></div><div class="c x2"><p>2</p></div></div></a></li>
    <li class="m"><a class="l" href="/zapas/2/"><p class="d">13.3.2027 11:30</p>
    <div class="t"><div class="c x1"><p></p></div><div class="c x2"><p>MFK Zvolen</p></div></div>
    <div class="t s"><div class="c x1"><p>-</p></div><div class="c x2"><p>-</p></div></div></a></li></ul>`);
  const evs = applyRecipe($, { item: 'li.m', title: '.t .c', date: '.d', link: 'a.l' }, SRC);
  assert.deepEqual(evs.map((e) => e.title), ['FK Železiarne Podbrezová – MFK Zvolen', 'MFK Zvolen']);
});

test('applyRecipe: teams in one cell split by <br> or glued blocks (futbalspravy, slaviabb)', () => {
  const $ = cheerio.load(`<table><tbody>
    <tr><td>26. 11. 2026,<br />18:45</td><td>Royale Union SG<br />Lech Poznaň</td><td>–</td></tr></tbody></table>
    <ul><li class="w"><time>21. 11. 2026</time><div class="c"><div class="t"><h5>SLÁVIA Banská Bystrica</h5></div><div class="t"><h5>BKM Žilina</h5></div> <div class="r"> - </div></div></li></ul>`);
  assert.equal(applyRecipe($, { item: 'tbody tr', title: 'td:nth-child(2)', date: 'td:nth-child(1)' }, SRC)[0].title, 'Royale Union SG – Lech Poznaň');
  assert.equal(applyRecipe($, { item: 'li.w', title: '.c', date: 'time' }, SRC)[0].title, 'SLÁVIA Banská Bystrica – BKM Žilina');
});

test('applyRecipe: home team in the title, away team in the "away" cell (stolnytenis.info)', () => {
  const $ = cheerio.load(`<div class="mtchr row"><span class="mtchr__round__date">14.11.2026 17:00 (Sob)</span>
    <a class="mtchr__home" href="/rozpis?club_id=1"><span>TTC Spartak Poprad</span></a><a class="mtchr__score" href="/zapas/164980">10</a>
    <a class="mtchr__away" href="/rozpis?club_id=2"><span>ŠKST Spišský Štvrtok</span></a></div>`);
  const [ev] = applyRecipe($, { item: '.mtchr.row', title: '.mtchr__home', date: '.mtchr__round__date', description: '.mtchr__away', link: '.mtchr__score' }, SRC);
  assert.equal(ev.title, 'TTC Spartak Poprad – ŠKST Spišský Štvrtok');
  assert.equal(ev.description, undefined); // it only repeated the away team
  assert.equal(ev.url, 'https://example.sk/zapas/164980');
});

test('applyRecipe: a "javascript:" buy button gives way to the item\'s own event link (ticketportal)', () => {
  const $ = cheerio.load(`<div class="ticket-cover"><div class="ticket-date"><div class="date">21.11.2026</div></div>
    <div class="ticket-info"><a href="/Event/145104" class="event"><span>NA SKLE MAĽOVANÉ</span></a><a href="/venue/104955" class="building">STARS</a></div>
    <div class="ticket-control"><a href="javascript:NPerformance_load(1451230, 0, 1451230);">Kúpiť</a></div></div>`);
  const [ev] = applyRecipe($, { item: '.ticket-cover', title: '.event', date: '.ticket-date .date', link: '.ticket-control a' }, SRC);
  assert.equal(ev.url, 'https://example.sk/Event/145104');
});

test('repairRow: a stored row read again', () => {
  assert.deepEqual(repairRow({
    title: 'Chlapský raj — divadlo, 28.11.2026 18:00, Dom kultúry Svidník, Svidník.', location: '', url: 'https://kulthund.sk/podujatie/chlapsky-raj-10686',
    via: 'https://kulthund.sk/m/svidnik',
  }), { title: 'Chlapský raj', location: 'Dom kultúry Svidník, Svidník', url: 'https://kulthund.sk/podujatie/chlapsky-raj-10686' });
  assert.deepEqual(repairRow({ title: 'INÉ KAFE na zámku', location: 'Kde: Šimák Zámok Pezinok', url: 'javascript:Performance_load(14290267, 0, 14290267);' }),
    { title: 'INÉ KAFE na zámku', location: 'Šimák Zámok Pezinok', url: undefined });
  assert.equal(repairRow({ title: 'Vývoz KUCHYNSKÉHO odpadu', location: 'Priamo od vašich domácností' }), null);
  assert.equal(repairRow({ title: '09.11.2026', location: 'Dom odborov Žilina' }), null);
  // A row whose own page is its listing page keeps it.
  assert.equal(repairRow({ title: 'Koncert', url: 'https://kulthund.sk/podujatie/x-1', via: 'https://kulthund.sk/podujatie/x-1' }).url,
    'https://kulthund.sk/podujatie/x-1');
});
