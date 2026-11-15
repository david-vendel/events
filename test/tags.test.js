// Unit tests for src/tags.js: what kind of event something is.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  guessTags, tagSources, eventTags, headingTags, tagsFromSchemaTypes, emptyRules, learnTags, learnedTags, activeRuleCount,
} from '../src/tags.js';

const g = (title, more = {}) => guessTags({ title, ...more });

describe('guessTags: keywords', () => {
  test('a concert by keyword', () => {
    assert.deepEqual(g('Koncert: Peter Bažík'), ['concert']);
    assert.deepEqual(g('Jazz večer', { location: 'Hudobný klub' }), ['concert']);
  });
  test('"live" alone does not make a concert', () => {
    assert.deepEqual(g('Peter Bažík live'), []);
    assert.deepEqual(g('Live music night'), []);
  });
  test('"Food" in a title does not make a market', () => {
    assert.deepEqual(g('Food & Drinks Night'), []);
    assert.ok(!g('Good food talk').includes('market'));
  });
  test('"food festival", "street food", "food truck", "trh" do', () => {
    assert.deepEqual(g('Food Festival Košice'), ['festival', 'market']);
    assert.deepEqual(g('Street food weekend'), ['market']);
    assert.deepEqual(g('Food truck zraz'), ['market']);
    assert.deepEqual(g('Vianočný trh'), ['market']);
    assert.deepEqual(g('Trhy na námestí'), ['market']);
  });
  test('the description counts too', () => {
    assert.deepEqual(g('Večer s Jánom', { description: 'Prednáška o histórii mesta' }), ['talk']);
  });
  test('nothing recognisable gives no tags', () => {
    assert.deepEqual(g('Zvláštny večer'), []);
    assert.deepEqual(guessTags({}), []);
  });
});

describe('guessTags: the venue name does not tag', () => {
  test('"Športové námestie" hosting cabaret is not sport', () => {
    assert.ok(!g('Kabaret Ťuk-ťuk', { location: 'Športové námestie, Košice' }).includes('sport'));
  });
  test('"(bývalé kino Slovan)" is not a cinema', () => {
    assert.deepEqual(g('Divadlo Ludus', { location: 'Kultúrne centrum (bývalé kino Slovan), Košice' }), ['theatre']);
    assert.ok(!g('Večer', { location: 'Dom kultúry (bývalé kino Slovan)' }).includes('cinema'));
    assert.ok(!g('Večer', { location: 'Dom kultúry, bývalé kino Slovan' }).includes('cinema'));
  });
  test('a venue named after a gallery or museum does not make an exhibition', () => {
    assert.deepEqual(g('Jazz večer', { location: 'Východoslovenská galéria, Košice' }), ['concert']);
  });
});

describe('guessTags: cinema', () => {
  test('a cinema venue makes a screening; the film title does not trip keyword rules', () => {
    assert.deepEqual(g('Zápas storočia', { location: 'Cinemax Košice' }), ['cinema']);
    assert.deepEqual(g('Zápas storočia', { location: 'Kino Úsmev, Košice' }), ['cinema']);
  });
  test('a cinema programme URL makes a screening', () => {
    assert.deepEqual(g('Zápas storočia', { url: 'https://x.sk/program-kina/1' }), ['cinema']);
    assert.deepEqual(g('Zápas storočia', { via: 'https://x.sk/kino/program' }), ['cinema']);
  });
  test('2D/3D/dabing/film in the title make a screening', () => {
    assert.deepEqual(g('Odysea 2D'), ['cinema']);
    assert.deepEqual(g('Odysea (dabing)'), ['cinema']);
  });
  test('a screening keeps only kids and festival', () => {
    assert.deepEqual(g('Rozprávka pre deti 2D'), ['cinema', 'kids']);
    assert.deepEqual(g('Filmový festival: Hokejový zápas 2D'), ['cinema', 'festival']);
  });
  test('a live show at a cinema is tagged from its title only', () => {
    assert.deepEqual(g('Koncert Jana Nováka', {
      description: 'Film o hudbe, projekcia v 2D, workshop pre deti', location: 'Kino Úsmev, Košice',
    }), ['concert']);
    assert.deepEqual(g('Divadlo: Hamlet', { location: 'Cinemax Košice' }), ['theatre']);
  });
  test('a live show elsewhere keeps its description tags', () => {
    assert.deepEqual(g('Koncert Jana Nováka', { description: 'Workshop pre deti', location: 'Dom umenia' }),
      ['concert', 'kids', 'workshop']);
  });
  test('a recorded show is a screening ("MET Opera – záznam")', () => {
    assert.deepEqual(g('MET Opera: Tosca – záznam', { location: 'Kino Úsmev' }), ['cinema']);
    assert.deepEqual(g('Balet 2D: Luskáčik'), ['cinema']);
  });
});

describe('headingTags and tagsFromSchemaTypes', () => {
  test('a cinema programme heading', () => {
    assert.deepEqual(headingTags('Program kina CINEMAX Košice'), ['cinema']);
  });
  test('one clear kind only', () => {
    assert.deepEqual(headingTags('Výstavy'), ['exhibition']);
    assert.deepEqual(headingTags('Koncerty a výstavy'), []);
    assert.deepEqual(headingTags('Aktuality'), []);
  });
  test('schema.org types', () => {
    assert.deepEqual(tagsFromSchemaTypes(['ScreeningEvent']), ['cinema']);
    assert.deepEqual(tagsFromSchemaTypes(['TheaterEvent', 'ComedyEvent', 'Event']), ['theatre']);
    assert.deepEqual(tagsFromSchemaTypes(['MusicEvent', 'Festival']), ['concert', 'festival']);
    assert.deepEqual(tagsFromSchemaTypes([]), []);
  });
});

describe('tagSources', () => {
  test('keyword tags come from rules', () => {
    assert.deepEqual(tagSources({ title: 'Jazz večer', sources: [{}] }), { concert: 'rules' });
  });
  test("a source's own 'theatre' suppresses a cinema guessed from the venue", () => {
    const ev = { title: 'Hamlet', location: 'Kino Úsmev, Košice', sources: [{ tags: ['theatre'] }] };
    assert.deepEqual(tagSources(ev), { theatre: 'rules' });
    assert.deepEqual(eventTags(ev), ['theatre']);
  });
  test('without own tags the cinema guess stands', () => {
    assert.deepEqual(tagSources({ title: 'Hamlet', location: 'Kino Úsmev, Košice', sources: [{}] }), { cinema: 'rules' });
  });
  test("a source's own 'cinema' keeps only kids/festival from keywords", () => {
    assert.deepEqual(tagSources({ title: 'Futbal', sources: [{ tags: ['cinema'] }] }), { cinema: 'rules' });
    assert.deepEqual(tagSources({ title: 'Futbal pre deti', sources: [{ tags: ['cinema'] }] }), { cinema: 'rules', kids: 'rules' });
  });
  test("a live show on a cinema's programme drops the cinema tag", () => {
    assert.deepEqual(tagSources({ title: 'Koncert Jana', sources: [{ tags: ['cinema'] }] }), { concert: 'rules' });
  });
  test('own tags and keyword tags combine, in TAGS order', () => {
    assert.deepEqual(eventTags({ title: 'Jazz pre deti', sources: [{ tags: ['festival'] }] }), ['concert', 'festival', 'kids']);
  });
  test('AI tags only fill in when nothing else tagged', () => {
    assert.deepEqual(tagSources({ title: 'Zvláštny večer', sources: [{}], aiTags: ['party'] }), { party: 'ai' });
    assert.deepEqual(tagSources({ title: 'Jazz večer', sources: [{}], aiTags: ['party'] }), { concert: 'rules' });
    assert.deepEqual(tagSources({ title: 'Zvláštny večer', sources: [{ tags: ['exhibition'] }], aiTags: ['party'] }),
      { exhibition: 'rules' });
  });
  test('no tags at all', () => {
    assert.deepEqual(tagSources({ title: 'Zvláštny večer' }), {});
    assert.deepEqual(tagSources({ title: 'Zvláštny večer' }, emptyRules()), {});
  });
});

describe('learned rules', () => {
  const venue = 'Klub Tabačka, Košice';
  const learned = () => {
    const rules = emptyRules();
    learnTags(rules, { title: 'Abc one', location: venue }, ['concert']);
    const activated = learnTags(rules, { title: 'Def two', location: venue }, ['concert']);
    return { rules, activated };
  };

  test('a venue rule activates after 2 agreeing events', () => {
    const rules = emptyRules();
    assert.deepEqual(learnTags(rules, { title: 'Abc one', location: venue }, ['concert']), []);
    const { activated } = learned();
    assert.equal(activated.length, 1);
    assert.match(activated[0], /^venue ".*" → concert$/);
    assert.equal(activeRuleCount(learned().rules), 1);
  });
  test('the same title twice is one piece of evidence', () => {
    const rules = emptyRules();
    learnTags(rules, { title: 'MEET & GREET FRIDAYS', location: venue }, ['party']);
    assert.deepEqual(learnTags(rules, { title: 'MEET & GREET FRIDAYS', location: venue }, ['party']), []);
    assert.deepEqual(learnedTags(rules, { title: 'X', location: venue }), []);
  });
  test('not enough agreement, no rule', () => {
    const rules = emptyRules();
    learnTags(rules, { title: 'Abc one', location: venue }, ['concert']);
    learnTags(rules, { title: 'Def two', location: venue }, ['party']);
    assert.deepEqual(learnedTags(rules, { title: 'Ghi', location: venue }), []);
  });
  test('learnedTags without rules', () => {
    assert.deepEqual(learnedTags(undefined, { title: 'Ghi', location: venue }), []);
  });
  test('learned rules fill in an untagged event, ahead of AI', () => {
    const { rules } = learned();
    assert.deepEqual(learnedTags(rules, { title: 'Ghi', location: venue }), ['concert']);
    assert.deepEqual(tagSources({ title: 'Ghi', location: venue, aiTags: ['party'] }, rules), { concert: 'learned' });
  });
  test("learned rules don't add to an event the keyword rules tagged", () => {
    const { rules } = learned();
    assert.deepEqual(tagSources({ title: 'Workshop keramiky', location: venue }, rules), { workshop: 'rules' });
  });
  test("learned rules don't add to an event its source tagged", () => {
    const { rules } = learned();
    assert.deepEqual(tagSources({ title: 'Ghi', location: venue, sources: [{ tags: ['exhibition'] }] }, rules), { exhibition: 'rules' });
  });
});
