// Unit tests for src/match.js: when two sightings from different sites are one event.
// Note: useTitleWeights sets module-wide state, and there's no way to clear it, so the unweighted
// tests come first and node:test runs a file's tests in order.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  titleTokens, titleMatch, titleSimilarity, useTitleWeights, dateDistance, differentTowns,
  sameEventScore, findSameEvent, couldBeSame, rowsDiffer, clash,
} from '../src/match.js';

const tokens = (t) => [...titleTokens(t)].sort();

describe('titleTokens', () => {
  test('drops grammar words, ticket notes, years and day numbers', () => {
    assert.deepEqual(tokens('Koncert pre deti 2026 15 VYPREDANÉ'), ['deti', 'koncert']);
  });
  test('drops towns, folding diacritics', () => {
    assert.deepEqual(tokens('Koncert v Košiciach'), ['koncert']);
    assert.deepEqual(tokens('Dom umenia Košice'), ['dom', 'umenia']);
  });
  test('a title that is only a town keeps it', () => {
    assert.deepEqual(tokens('Košice'), ['kosice']);
  });
  test('cinema format and language tags are not part of the film title', () => {
    assert.deepEqual(tokens('Odysea 2D ATMOS (ČT)'), ['odysea']);
    assert.deepEqual(tokens('Odysea 3D titulky'), ['odysea']);
  });
  test('a bracketed original title is dropped, but a leading bracket stays', () => {
    assert.deepEqual(tokens('Nádej (Håp)'), ['nadej']);
    assert.deepEqual(tokens('(Ne)viditeľní'), ['ne', 'viditelni']);
  });
  test('spaced-out letters are one word', () => {
    assert.deepEqual(tokens('C A R M E N'), ['carmen']);
  });
  test('"Divadlo ST" keeps ST (a language code only right after a format)', () => {
    assert.ok(titleTokens('Divadlo ST').has('st'));
  });
});

describe('titles without word weights (every word weighs 1)', () => {
  test('identical titles', () => {
    assert.equal(titleSimilarity('Jazzový večer Kollár', 'Jazzový večer Kollár'), 1);
  });
  test('film title with format tags matches the bare title', () => {
    assert.equal(titleSimilarity('Odysea 2D ATMOS (ČT)', 'Odysea'), 1);
  });
  test('series items are told apart by what follows the series name', () => {
    assert.deepEqual(titleMatch('Kino pre deti: HLAVIČKA', 'Kino pre deti: ZABUDNUTÝ OSTROV'), { sim: 0, jaccard: 0 });
    assert.equal(titleSimilarity('Domáca úroda: LÁSKA', 'Domáca úroda: GENERÁL GOLIAN'), 0);
  });
  test('same series item matches', () => {
    assert.equal(titleSimilarity('Kino pre deti: HLAVIČKA', 'Kino pre deti: Hlavička'), 1);
  });
  test('containment of a 2+ word title scores 0.9', () => {
    const m = titleMatch('Biela noc', 'Biela noc Košice 2026 – festival svetla');
    assert.equal(m.sim, 0.9);
    assert.ok(m.jaccard < 0.9);
  });
  test('a one-word title inside a longer one is only Jaccard without weights', () => {
    assert.ok(titleSimilarity('TOSCA', 'Giacomo Puccini: TOSCA') < 0.5);
  });
  test('empty or meaningless titles score 0', () => {
    assert.deepEqual(titleMatch('', 'Koncert'), { sim: 0, jaccard: 0 });
    assert.deepEqual(titleMatch(undefined, 'Koncert'), { sim: 0, jaccard: 0 });
  });
});

describe('dateDistance', () => {
  test('same day is 0', () => {
    assert.equal(dateDistance({ start: '2026-11-10' }, { start: '2026-11-10' }), 0);
  });
  test('days between two single days, either order', () => {
    assert.equal(dateDistance({ start: '2026-11-10' }, { start: '2026-11-13' }), 3);
    assert.equal(dateDistance({ start: '2026-11-13' }, { start: '2026-11-10' }), 3);
  });
  test('a day inside a run is 0', () => {
    assert.equal(dateDistance({ start: '2026-11-10', end: '2026-11-15' }, { start: '2026-11-13' }), 0);
    assert.equal(dateDistance({ start: '2026-11-13' }, { start: '2026-11-10', end: '2026-11-15' }), 0);
  });
  test('overlapping runs are 0', () => {
    assert.equal(dateDistance({ start: '2026-11-01', end: '2026-11-10' }, { start: '2026-11-08', end: '2026-11-20' }), 0);
  });
  test('distance from the end of a run', () => {
    assert.equal(dateDistance({ start: '2026-11-13' }, { start: '2026-11-10', end: '2026-11-11' }), 2);
    assert.equal(dateDistance({ start: '2026-11-01', end: '2026-11-05' }, { start: '2026-11-09', end: '2026-11-12' }), 4);
  });
  test('across a month boundary and DST change', () => {
    assert.equal(dateDistance({ start: '2026-10-24' }, { start: '2026-10-26' }), 2);
    assert.equal(dateDistance({ start: '2026-11-30' }, { start: '2026-12-01' }), 1);
  });
});

describe('differentTowns', () => {
  test("a town site's address with the town's words run together or hyphenated (virtualne.sk)", () => {
    // "Ja, Rocky" at Kino Úsmev in Hlohovec was joined with Kino Orbis in Rimavská Sobota.
    const hlohovec = { location: 'Kino Úsmev, Hlohovec', url: 'https://kulthund.sk/podujatie/ja-rocky-16298' };
    assert.equal(differentTowns(hlohovec, { location: 'Kino Orbis', url: 'https://rimavskasobota.virtualne.sk/akcie-a-podujatia/ja--rocky--0.htm' }), true);
    assert.equal(differentTowns(hlohovec, { location: 'Kino', url: 'https://banska-bystrica.example.sk/a' }), true);
    assert.equal(differentTowns(hlohovec, { location: 'Milana Rastislava Štefánika 223/3', url: 'https://hlohovec.virtualne.sk/a' }), false);
  });
  test('two known Slovak towns', () => {
    assert.equal(differentTowns({ location: 'Dom umenia, Košice' }, { location: 'Mestské divadlo, Žilina' }), true);
  });
  test('the same known town, different venues', () => {
    assert.equal(differentTowns({ location: 'Dom umenia, Košice' }, { location: 'Kulturpark, Košice' }), false);
  });
  test('same town spelled with and without diacritics', () => {
    assert.equal(differentTowns({ location: 'Dom umenia, Košice' }, { location: 'Kulturpark, Kosice' }), false);
  });
  test('any parsed town counts, also unknown foreign ones', () => {
    assert.equal(differentTowns({ location: 'Klub, Barnaul' }, { location: 'Klub, Kemerovo' }), true);
    assert.equal(differentTowns({ location: 'Lenina 5, Barnaul' }, { location: 'Lenina 7, Barnaul' }), false);
  });
  test('town subdomains decide when locations are streets only', () => {
    assert.equal(differentTowns(
      { location: 'Hlavná 5', url: 'https://zilina.virtualne.sk/akcia/1' },
      { location: 'Mierová 3', url: 'https://kosice.virtualne.sk/akcia/2' },
    ), true);
    assert.equal(differentTowns(
      { location: 'Hlavná 5', url: 'https://kosice.virtualne.sk/akcia/1' },
      { location: 'Mierová 3', url: 'https://kosice.virtualne.sk/akcia/2' },
    ), false);
  });
  test('subdomain from via/source when there is no url', () => {
    assert.equal(differentTowns(
      { via: 'https://zilina.virtualne.sk/program' },
      { source: 'https://kosice.virtualne.sk/program' },
    ), true);
  });
  test('a non-town subdomain says nothing', () => {
    assert.equal(differentTowns(
      { url: 'https://www.ticketportal.sk/event/1' },
      { url: 'https://kosice.virtualne.sk/akcia/2' },
    ), false);
  });
  test('a known town in one location against a town subdomain', () => {
    assert.equal(differentTowns(
      { location: 'Dom umenia, Košice' },
      { location: 'Hlavná 5', url: 'https://zilina.virtualne.sk/akcia/1' },
    ), true);
  });
  test('unknown places are not different', () => {
    assert.equal(differentTowns({ location: 'Somewhere' }, { location: 'Elsewhere' }), false);
    assert.equal(differentTowns({ location: 'Dom umenia, Košice' }, {}), false);
    assert.equal(differentTowns({}, {}), false);
  });
});

describe('same event (no word weights)', () => {
  const film = (location, start = '2026-11-20') => ({ title: 'Odysea 2D', start, location });

  test('one film in two towns the same day is not one event', () => {
    assert.equal(sameEventScore(film('Cinemax, Košice'), film('Cinemax, Žilina')), 0);
    assert.equal(couldBeSame(film('Cinemax, Košice'), film('Cinemax, Žilina')), false);
  });
  test('one film in one town on two sites is one event', () => {
    assert.equal(sameEventScore(film('Cinemax, Košice'), film('Cinemax OC Optima, Košice')), 1);
    assert.equal(couldBeSame(film('Cinemax, Košice'), { title: 'Odysea', start: '2026-11-20', location: 'Cinemax, Košice' }), true);
  });
  test('findSameEvent picks the event in the same town, not the one elsewhere', () => {
    const elsewhere = { ...film('Cinemax, Žilina'), id: 'za' };
    const here = { ...film('Cinemax, Košice'), id: 'ke' };
    assert.equal(findSameEvent([elsewhere, here], film('Cinemax OC Optima, Košice')).id, 'ke');
    assert.equal(findSameEvent([elsewhere], film('Cinemax OC Optima, Košice')), null);
  });
  test('identical title up to 3 days apart from different sites: a date mismatch, lower score', () => {
    const a = { title: 'Jazzový večer Kollár', start: '2026-11-20' };
    assert.equal(sameEventScore(a, { ...a, start: '2026-11-22' }), 0.9);
    assert.equal(sameEventScore(a, { ...a, start: '2026-11-23' }), 0.85);
    assert.equal(sameEventScore(a, { ...a, start: '2026-11-24' }), 0);
  });
  test('the same site: next day joins (a run), two days apart is another performance', () => {
    const a = { title: 'Jazzový večer Kollár', start: '2026-11-20' };
    assert.equal(sameEventScore(a, { ...a, start: '2026-11-21' }, true), 0.95);
    assert.equal(sameEventScore(a, { ...a, start: '2026-11-22' }, true), 0);
  });
  test('findSameEvent treats rows of one site as sameSite', () => {
    const ev = { title: 'Október v knižnici', start: '2026-10-01', sources: [{ site: 'kniznica.sk' }] };
    assert.equal(findSameEvent([ev], { title: 'Október v knižnici', start: '2026-10-03', site: 'kniznica.sk' }), null);
    assert.equal(findSameEvent([ev], { title: 'Október v knižnici', start: '2026-10-03', site: 'other.sk' }), ev);
  });
  test('days apart need a near-identical title', () => {
    const a = { title: 'Biela noc', start: '2026-09-26' };
    const b = { title: 'Biela noc Košice 2026 – festival svetla', start: '2026-09-26' };
    assert.equal(sameEventScore(a, b), 0.9);
    assert.ok(sameEventScore(a, { ...b, start: '2026-09-28' }) > 0); // 0.9 >= 0.85
    const c = { title: 'Jazz večer Kollár', start: '2026-11-20' };
    const d = { title: 'Jazz večer Novák', start: '2026-11-20' };
    assert.ok(sameEventScore(c, d) >= 0.5); // most words in common: enough on the same day
    assert.equal(sameEventScore(c, { ...d, start: '2026-11-22' }), 0);
  });
  test('a festival run and one show of it are not one event', () => {
    const fest = { title: 'BASSFEST+ 2026', start: '2026-07-01', end: '2026-07-04' };
    const show = { title: 'Orchester BassFest+ 2026 - Puškár', start: '2026-07-02' };
    assert.equal(sameEventScore(fest, show), 0);
    assert.equal(couldBeSame(fest, show), false);
  });
  test('a title found inside another is not enough between a run and a single day', () => {
    const run = { title: 'Biela noc', start: '2026-09-25', end: '2026-09-27' };
    const day = { title: 'Biela noc Košice 2026 – festival svetla a hudby', start: '2026-09-26' };
    assert.deepEqual(titleMatch(run.title, day.title), { sim: 0.9, jaccard: 0.4 }); // contained
    assert.equal(sameEventScore(run, day), 0);
    assert.equal(sameEventScore({ ...run, end: undefined, start: '2026-09-26' }, day), 0.9);
    assert.equal(sameEventScore(run, { ...day, start: '2026-09-25', end: '2026-09-27' }), 0.9);
  });
  test('couldBeSame ignores the date for the title, but not beyond 3 days', () => {
    const a = { title: 'Jazzový večer Kollár', start: '2026-11-20' };
    assert.equal(couldBeSame(a, { title: 'Jazzový večer', start: '2026-11-22' }), true);
    assert.equal(couldBeSame(a, { title: 'Jazzový večer', start: '2026-11-25' }), false);
  });
  test('different titles the same day are not one event', () => {
    assert.equal(sameEventScore({ title: 'Labková patrola', start: '2026-11-20' }, { title: 'Hamlet', start: '2026-11-20' }), 0);
  });
});

// Cases from the live data (Nov 2026) that were joined or kept apart wrongly.
describe('titles: scripts, towns, matches and word forms', () => {
  test('words in another script count ("Никита Шевчук. Stand Up" is not "stand up")', () => {
    assert.deepEqual(tokens('Никита Шевчук. Stand Up'), ['stand', 'up', 'никита', 'шевчук']);
    assert.ok(titleSimilarity('Никита Шевчук. Stand Up', 'MEDZI RIADKAMI - STAND UP ZO ŠKOLSKÝCH LAVÍC') < 0.5);
    assert.ok(titleSimilarity('Евгений Чебатков. Stand Up', 'Карина Мейханаджян: Stand Up') < 0.5);
  });
  test('titles naming different towns are different events', () => {
    assert.equal(titleSimilarity('Trenčín vs. Slovan', 'Slovan vs. Žilina'), 0);
    assert.equal(titleSimilarity('Slovan vs. Žilina', 'Slovan vs. Spišská Nová Ves'), 0);
    assert.equal(titleSimilarity('Prešovské vianočné trhy 2026 Prešov', 'Vianočné trhy 2026 Košice'), 0);
    assert.equal(titleSimilarity('Žilina: Microsoft 365 - Teams', 'Nitra: Microsoft 365 - Teams'), 0);
  });
  test('the same town in other forms agrees', () => {
    assert.ok(titleSimilarity('Prešovské vianočné trhy', 'Vianočné trhy v Prešove') >= 0.5);
    assert.ok(titleSimilarity('Jan Kraus v Prievidzi', 'Jan Kraus - Prievidza - Pridané') >= 0.5);
  });
  test('a match needs both opponents', () => {
    assert.equal(titleSimilarity('Górnik Zabrze vs. ŠK Slovan', 'ŠK Slovan vs. MFK Zvolen'), 0);
    assert.equal(titleSimilarity('CSKA Moskva vs. HC Soči', 'HK 32 Liptovský Mikuláš vs HC Košice'), 0);
    assert.equal(titleSimilarity('HK Poprad vs HC Košice', 'HK Poprad VS. HC Košice'), 1);
  });
  test("a word's forms agree", () => {
    assert.ok(titleSimilarity('Workshop hry na handpan s Milanom Zdvořilým', 'Workshop hra na handpan s Milan Zdvořilým') >= 0.5);
  });
});

describe('rows that cannot be one event', () => {
  const day = '2026-11-19';
  test('a film at two cinemas in one town: "Ja, Rocky" at Kino Film Europe and at Cinema City Eurovea', () => {
    const klubkino = { title: 'Ja, Rocky – Kino Film Europe', start: day, time: '19:00', location: 'Kino Film Europe, Štefánikova 25, Bratislava',
      url: 'https://www.klubkino.sk/film/ja-rocky/', via: 'https://www.klubkino.sk/film/ja-rocky/' };
    const eurovea = { title: 'Ja, Rocky', start: day, time: '20:00', location: 'Cinema City Eurovea, Pribinova 8, Bratislava',
      url: 'https://kinoprogram.sk/program/tyzden/', via: 'https://kinoprogram.sk/program/tyzden/' };
    assert.equal(differentTowns(klubkino, eurovea), false);
    assert.equal(rowsDiffer(klubkino, eurovea), true);
    assert.equal(sameEventScore(klubkino, eurovea), 0);
    assert.equal(couldBeSame(klubkino, eurovea), false);
    assert.equal(sameEventScore(klubkino, { ...eurovea, time: '19:00' }), 0); // another cinema, same time
  });
  test('one screening on two sites is one event', () => {
    const klubkino = { title: 'Ja, Rocky – Kino Lúky', start: day, time: '19:00', location: 'Kino Lúky, Vigľašská 1, Petržalka, Bratislava',
      url: 'https://www.klubkino.sk/film/ja-rocky/', via: 'https://www.klubkino.sk/film/ja-rocky/' };
    const csfd = { title: 'Ja, Rocky', start: day, time: '19:00', location: 'Bratislava - Kino Lúky',
      url: 'https://www.csfd.sk/film/1751594-ja-rocky/prehlad/', via: 'https://www.csfd.sk/kino/94-bratislava/?period=all' };
    assert.ok(sameEventScore(klubkino, csfd) > 0);
    // Artkino Za zrkadlom is in the DK Zrkadlový háj, at Rovniankova 3.
    const artkino = { title: 'Já, Rocky', start: '2026-11-22', time: '19:00', location: 'Artkino Za zrkadlom, Rovniankova ulica 3., Bratislava 85102',
      url: 'https://tv-program.aktuality.sk/film/ja-rocky/', via: 'https://tv-program.aktuality.sk/program-kina/bratislava/artkino-za-zrkadlom/' };
    const kzp = { title: 'Klenoty žánrového filmu: JA, ROCKY', start: '2026-11-22', time: '19:00', location: 'DK Zrkadlový háj, Rovniankova 3, Bratislava',
      url: 'http://kulturavpetrzalke.sk/podujatie/klenoty-zanroveho-filmu-ja-rocky', via: 'http://kulturavpetrzalke.sk/podujatia/kino?paginator-page=2' };
    assert.equal(rowsDiffer(artkino, kzp), false);
  });
  test("a cinema's own ticket site says which cinema a row without a place is at (kinomat.sk)", () => {
    const at = (url, time = '20:00') => ({ title: 'Sense and Sensibility', start: day, time, url, via: 'https://kinomat.sk/en/program' });
    const edison = { title: 'Sense and Sensibility – Edison Filmhub', start: day, time: '17:20', location: 'Edison Filmhub, Baštová 6A, Bratislava',
      url: 'https://www.klubkino.sk/en/film/rozum-a-cit/', via: 'https://www.klubkino.sk/en/film/rozum-a-cit/' };
    assert.equal(rowsDiffer(at('https://edisonfilmhub.sk/kosik?ent_id=102720', '17:20'), edison), false);
    assert.equal(rowsDiffer(at('https://tickets.cinemacity.sk/order/108003?lang=sk', '17:20'), edison), true);
    assert.equal(rowsDiffer(at('https://tickets.cinemacity.sk/order/107547?lang=sk'), { title: 'Sense and Sensibility', start: day, time: '20:00',
      location: 'Cinema City Eurovea, Pribinova 8, Bratislava', url: 'https://kinoprogram.sk/program/tyzden/', via: 'https://kinoprogram.sk/program/tyzden/' }), false);
    assert.equal(rowsDiffer(at('https://tickets.cinemacity.sk/order/1'), at('https://predaj.cine-max.sk/kino-ba/192214')), true);
    // Film screenings have no doors: twenty minutes apart are two screenings.
    assert.equal(rowsDiffer(at('https://tickets.cinemacity.sk/order/1', '16:00'), { title: 'The Cat in the Hat', start: day, time: '16:20' }), true);
  });
  test('a play that kulthund places in a cinema is not a film', () => {
    const kulthund = { title: 'PI ČAJ, MILÁČIK', start: '2026-11-16', time: '18:00', location: 'Kino Úsmev, Levoča', url: 'https://kulthund.sk/a', via: 'https://kulthund.sk/m/levoca' };
    const town = { title: 'Pi čaj, miláčik!', start: '2026-11-16', time: '18:00', location: 'Mestské divadlo', url: 'https://kulturavlevoci.sk/a', via: 'https://kulturavlevoci.sk/' };
    assert.equal(rowsDiffer(kulthund, town), false);
  });
  test('times an hour apart are doors and start; more are two shows', () => {
    const livemusic = { title: 'Mireille Mathieu', start: '2026-12-01', time: '19:00', location: 'PEUGEOT aréna Bratislava' };
    const radio = { title: 'MIREILLE MATHIEU', start: '2026-12-01', time: '20:00', location: 'Peugeut aréna' };
    assert.ok(sameEventScore(livemusic, radio) > 0);
    const kulthund = { title: 'Hľadá sa snehuliak', start: '2026-12-06', time: '14:30', location: 'Bábkové divadlo v Košiciach, Košice' };
    const zoznam = { title: 'Hľadá sa snehuliak', start: '2026-12-06', time: '16:30', location: 'Bábkové divadlo Košického kraja, Alžbetina 38, 04001 Košice' };
    assert.equal(sameEventScore(kulthund, zoznam), 0);
    assert.ok(sameEventScore(kulthund, { ...zoznam, time: undefined }) > 0); // no time: can't tell
    assert.ok(sameEventScore(kulthund, { ...zoznam, time: '00:00' }) > 0); // a placeholder time
    assert.ok(sameEventScore(kulthund, { ...zoznam, start: '2026-12-05', end: '2026-12-07' }) > 0); // a run's time is any day's
  });
});

describe('an event is matched by all its listing rows', () => {
  const row = (location, site, extra = {}) => ({ title: 'Beh za duše 2026', start: '2026-11-20', location, url: `https://${site}/beh`, via: `https://${site}/`, site, ...extra });
  test("a town given by the event's other rows counts, not only its primary's", () => {
    const ev = { title: 'Beh za duše 2026', start: '2026-11-20', location: 'celé Slovensko Duchovné, Mládež, Ostatné',
      sources: [row('celé Slovensko Duchovné, Mládež, Ostatné', 'www.vyveska.sk'), row('Ivanka pri Dunaji', 'kolegium.org')] };
    const kosice = row('Košice', 'hapsy.co');
    assert.equal(differentTowns(ev, kosice), false); // the primary row names no town
    assert.equal(clash(ev, kosice), true);
    assert.equal(sameEventScore(ev, kosice), 0);
    assert.equal(findSameEvent([ev], kosice), null);
    assert.equal(findSameEvent([ev], row('Ivanka pri Dunaji', 'hapsy.co')), ev);
  });
  test("an event's own place counts when its primary row has none (the site's town, or AI's)", () => {
    const rimava = { title: 'Čarovné hodinky', start: '2026-11-27', location: 'Rimavská Sobota',
      sources: [{ title: 'Čarovné hodinky', start: '2026-11-27', time: '19:00', url: 'https://www.rimava.sk/podujatie/carovne-hodinky-2/', via: 'https://www.rimava.sk/podujatia/page/2/' }] };
    const kulthund = { title: 'ČAROVNÉ HODINKY', start: '2026-11-27', time: '19:00', location: 'Národné divadlo Košice, Košice' };
    assert.equal(sameEventScore(rimava, kulthund), 0);
  });
  test('linked pages do not count', () => {
    const ev = { title: 'X', start: '2026-11-20', sources: [row('Košice', 'a.sk'), row('Žilina', 'b.sk', { linked: true })] };
    assert.equal(clash(ev, row('Košice', 'c.sk')), false);
  });
});

describe('titles with word weights (rare words count)', () => {
  // A small catalogue: "Kino pre deti" and "KONCERT" are in many titles, TOSCA in two.
  const greek = ['alfa', 'beta', 'gama', 'delta', 'epsilon', 'zeta', 'eta', 'theta', 'iota', 'kappa', 'lambda',
    'omikron', 'sigma', 'omega', 'ypsilon', 'psi', 'chi', 'rho', 'tau', 'phi'];
  const titles = [
    'Kino pre deti: HLAVIČKA', 'Kino pre deti: ZABUDNUTÝ OSTROV', 'Kino pre deti: KOCÚR', 'Kino pre deti: PSÍK',
    'Kino pre deti: MAČKA', 'Kino pre deti: VLAK', 'Kino pre deti: LES', 'Kino pre deti: DOM',
    'TOSCA', 'Giacomo Puccini: TOSCA',
    'KONCERT', 'Jazz KONCERT', 'Rock KONCERT', 'KONCERT Gospel', 'KONCERT organ', 'KONCERT Hlas', 'KONCERT mládeže',
    ...greek.map((w) => `Večer ${w} show`),
  ];
  test('setup', () => useTitleWeights(titles));

  test('"TOSCA" is found in "Giacomo Puccini: TOSCA"', () => {
    assert.ok(titleSimilarity('TOSCA', 'Giacomo Puccini: TOSCA') >= 0.5);
    assert.ok(sameEventScore({ title: 'TOSCA', start: '2026-11-20' }, { title: 'Giacomo Puccini: TOSCA', start: '2026-11-20' }) > 0);
  });
  test('"Kino pre deti: HLAVIČKA" and "Kino pre deti: ZABUDNUTÝ OSTROV" do not match', () => {
    assert.equal(titleSimilarity('Kino pre deti: HLAVIČKA', 'Kino pre deti: ZABUDNUTÝ OSTROV'), 0);
    assert.equal(sameEventScore(
      { title: 'Kino pre deti: HLAVIČKA', start: '2026-11-20' },
      { title: 'Kino pre deti: ZABUDNUTÝ OSTROV', start: '2026-11-20' },
    ), 0);
  });
  test('the same without the colon: only common words in common', () => {
    assert.ok(titleSimilarity('Kino pre deti HLAVIČKA', 'Kino pre deti ZABUDNUTÝ OSTROV') < 0.5);
  });
  test('a common word found whole in another title is not enough', () => {
    assert.ok(titleSimilarity('KONCERT', 'Jazz KONCERT') < 0.5);
  });
  test('findSameEvent with weights', () => {
    const events = [
      { title: 'Giacomo Puccini: TOSCA', start: '2026-11-20', location: 'Štátne divadlo, Košice' },
      { title: 'Kino pre deti: HLAVIČKA', start: '2026-11-20', location: 'Kino Úsmev, Košice' },
    ];
    assert.equal(findSameEvent(events, { title: 'TOSCA', start: '2026-11-20', location: 'Štátne divadlo Košice' }), events[0]);
    assert.equal(findSameEvent(events, { title: 'Kino pre deti: ZABUDNUTÝ OSTROV', start: '2026-11-20', location: 'Kino Úsmev, Košice' }), null);
    assert.equal(findSameEvent(events, { title: 'TOSCA', start: '2026-11-20', location: 'Mestské divadlo, Žilina' }), null);
  });
});

describe('a title found in another, with word weights', () => {
  // A catalogue where "Deň", "Vianočné", "koncerty", "trhy" are common and the names are rare.
  const filler = (w, n) => Array.from({ length: n }, (_, i) => `${w} ${['alfa', 'beta', 'gama', 'delta', 'omega', 'sigma', 'kappa', 'theta', 'lambda', 'zeta'][i % 10]}${i}`);
  const titles = [
    ...filler('Deň', 60), ...filler('Vianočné koncerty', 60), ...filler('Vianočné trhy', 60), ...filler('Čas', 60), ...filler('Workshop', 60),
    'Deň radosti (v 21. storočí)', 'Čas radosti a veselosti', 'FRAGILE - Vianočné koncerty', 'Vianočné koncerty Zuzany Mauréry | Piešťany',
    'Tradičné mestské vianočné trhy 2026 Modra', 'Neskoro večer - Poprad', 'Talkshow – Neskoro večer', ...filler('Talkshow', 50),
  ];
  test('setup', () => useTitleWeights(titles));
  test('sharing a word is not being found in the other title', () => {
    // "Deň radosti" (Štúdio L + S, Bratislava) was joined with "Čas radosti a veselosti" (Trnava).
    assert.ok(titleSimilarity('Deň radosti (v 21. storočí)', 'Čas radosti a veselosti') < 0.5);
    assert.ok(titleSimilarity('Vianočné koncerty Zuzany Mauréry | Piešťany', 'FRAGILE - Vianočné koncerty') < 0.5);
  });
  test('common words found whole in a longer title are not enough', () => {
    assert.ok(titleSimilarity('Vianočné trhy', 'Tradičné mestské vianočné trhy 2026 Modra') < 0.5);
  });
  test('a telling title found whole still matches', () => {
    assert.ok(titleSimilarity('Neskoro večer - Poprad', 'Talkshow – Neskoro večer') >= 0.5);
  });
});
