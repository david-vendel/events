// The language of an event's text (src/language.js), as geo.js uses it to tell where an event is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { languageOf, languageScores } from '../src/language.js';

describe('languageOf', () => {
  test('Slovak sentences', () => {
    assert.equal(languageOf('Srdečne vás pozývame na koncert, ktorý sa uskutoční v sobotu.'), 'sk');
    assert.equal(languageOf('Keď sa skanzen ukladá na spánok'), 'sk');
    assert.equal(languageOf('Ako zvládnuť pokročilé vyhľadávanie v databáze Scopus'), 'sk');
  });
  test('Czech sentences', () => {
    assert.equal(languageOf('Srdečně zveme všechny, kteří chtějí přijít. Vstupenky jsou k dispozici.'), 'cz');
    assert.equal(languageOf('Přijďte na akci, která se koná na náměstí'), 'cz');
  });
  test('a Czech name in a Slovak text stays Slovak', () => {
    assert.equal(languageOf('Koncert, ktorý venujeme dielu Antonína Dvořáka, sa uskutoční v Redute.'), 'sk');
  });
  test('a Czech band\'s name alone is no Czech sentence', () => {
    assert.notEqual(languageOf('Zdeněk Vřešťál 70 - NEŘEŽ TRIO'), 'cz');
    assert.notEqual(languageOf('Vojta Nedvěd s kapelou'), 'cz');
  });
  test('English', () => {
    assert.equal(languageOf('Join us for a free online event about the future of your community.'), 'en');
    assert.equal(languageOf('Please register to learn more about this week of events'), 'en');
  });
  test('Spanish or French with "se", "co", "pro", "Ste." is neither Slovak nor Czech', () => {
    for (const t of ['Días internacionales de puertas abiertas Passivhaus', 'Curso Edificios CO2-neutro: Streaming',
      'Carolers at Ste. Chapelle — Ste. Chapelle Winery', 'La bola negra se proyecta pro bono']) {
      assert.ok(!['sk', 'cz'].includes(languageOf(t)), t);
    }
  });
  test('too short or mixed: undefined', () => {
    assert.equal(languageOf('Náš priateľ René'), undefined);
    assert.equal(languageOf('Zajačik'), undefined);
    assert.equal(languageOf(''), undefined);
    assert.equal(languageOf(undefined), undefined);
  });
  test('Hungarian and German are not told apart (they say nothing about the country)', () => {
    assert.equal(languageOf('Szeretettel várunk mindenkit a koncertre'), undefined);
    assert.equal(languageOf('Die Software für Ihr Carbon Management'), undefined);
  });
});

describe('languageScores', () => {
  test('words both languages write alike count for neither', () => {
    const s = languageScores('divadlo program večer');
    assert.equal(s.sk, 0);
    assert.equal(s.cz, 0);
  });
  test('letters counted apart from words', () => {
    const s = languageScores('ľ ĺ ŕ ô ě ř ů');
    assert.equal(s.skLetters, 4);
    assert.equal(s.czLetters, 3);
    assert.equal(s.sk + s.cz, 0);
  });
});
