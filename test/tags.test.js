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

describe('guessTags: rules fixed after the audit of live data', () => {
  test('kids: a title says so; a description only with "pre deti", "detské predstavenie", "od 5 rokov"…', () => {
    assert.deepEqual(g('Wellness pobyt v Tatrách', { description: 'Ubytovanie, raňajky, wellness, deti do 6 rokov zadarmo.' }), []);
    assert.ok(!g('Lakomec', { description: 'Komédia o tom, aké ťažké je, aby si rodičia a deti rozumeli. Predstavenie.' }).includes('kids'));
    assert.ok(!g('Keramika', { description: 'Kurz pre dospelých, okrem detských skupín.' }).includes('kids'));
    assert.ok(!g('Rave', { description: 'Vstup od 15 rokov.' }).includes('kids'));
    assert.ok(!g('3.liga, 8.kolo ŠK SP+SK juniori - MSK Vranov').includes('kids'));
    assert.ok(g('Kocúr v čižmách', { description: 'Bábkové divadlo pre deti.' }).includes('kids'));
    assert.ok(g('Kocúr v čižmách', { description: 'Vhodné od 3 rokov.' }).includes('kids'));
    assert.ok(g('Divadlo pre deti: Kocúr').includes('kids'));
    assert.ok(g('Rozprávkové popoludnie').includes('kids'));
  });
  test('party only for dance parties; ballet and dance theatre are theatre', () => {
    assert.ok(!g('Vital dance – tanec pre vaše zdravie a vitalitu').includes('party'));
    assert.ok(!g('Začiatočnícky kurz tanga').includes('party'));
    assert.deepEqual(g('Luskáčik', { description: 'Balet SND' }), ['theatre']);
    assert.deepEqual(g('Nočná pyramída', { description: 'Tanečné predstavenie súboru Lúčnica' }), ['theatre']);
    assert.deepEqual(g('Katarínska zábava'), ['party']);
    assert.deepEqual(g('FAJNOVÁ LABKO-ZÁBAVA'), ['party']);
    assert.ok(!g('OPERA NÁS ZABÁVA – Barbier zo Sevilly').includes('party'));
    assert.deepEqual(g('Stále dobrí: Cudzie jazyky ako zábava'), []);
    assert.deepEqual(g('Pomalá tančiareň'), ['party']);
    assert.deepEqual(g('Reprezentačný ples mesta'), ['party']);
    assert.deepEqual(g('Večer', { description: 'Tanečná zábava s kapelou' }), ['concert', 'party']);
    assert.ok(!g('Stand up', { description: 'Tam, kde sa zábava stretáva s príbehmi' }).includes('party'));
  });
  test('"disco" is not discover/discount/Discord', () => {
    assert.deepEqual(g('Discover Bratislava'), []);
    assert.deepEqual(g('Discount day'), []);
    assert.deepEqual(g('Discord meetup'), []);
    assert.deepEqual(g('Disco 80s'), ['party']);
    assert.deepEqual(g('Detská diskotéka'), ['kids', 'party']);
  });
  test('opera is not Operations / Operatívna porada', () => {
    assert.deepEqual(g('FNsP NZ – Operatívna porada vedúcich zamestnancov'), []);
    assert.deepEqual(g('Bosch Operations Excellence'), []);
    assert.deepEqual(g('Opera: Carmen'), ['theatre']);
    assert.deepEqual(g('Netopier – opereta'), ['theatre']);
    assert.deepEqual(g('Prenosy z Metropolitnej opery'), ['theatre']);
    assert.ok(!g('Virtualizácia v operačnom systéme Linux').includes('theatre'));
  });
  test('names of museums, galleries, sports halls in the description are places, not kinds', () => {
    assert.deepEqual(g('Aj malé je pekné', { description: 'Múzeum Spiša v Spišskej Novej Vsi, kultúrne zariadenie' }), []);
    assert.deepEqual(g('Jazz večer', { description: 'Koncert vo Východoslovenskej galérii.' }), ['concert']);
    assert.deepEqual(g('Koncert', { description: 'Koncert v Mestskom divadle.' }), ['concert']);
    assert.deepEqual(g('THE DUCHON’S 2', { description: 'Mestská športová hala, Partizánske' }), []);
    assert.deepEqual(g('Bašavel', { description: 'Kultúrno-kreatívne centrum Hviezda' }), []);
    assert.ok(!g('Případ Janákovi', { description: 'Po nálezu neznámého muže v poli…' }).includes('exhibition'));
    // …but a theatre company named in the text still makes a play, and a museum's exhibition stays one.
    assert.ok(g('Horúce strely', { description: 'Komédia v podaní divadla Komédie.' }).includes('theatre'));
    assert.ok(g('Bež ako o ženu!', { description: 'Divadlo Artyňas uvádza komédiu.' }).includes('theatre'));
    assert.deepEqual(g('Výstava v múzeu'), ['exhibition']);
    assert.deepEqual(g('Noc múzeí'), ['exhibition']);
  });
  test('kulthund titles: the kind after " — " counts, the venue there does not', () => {
    assert.deepEqual(g('Odkazy — koncert, 21.11.2026 16:00, Mestské divadlo Banská Bystrica, Banská Bystrica.'), ['concert']);
    assert.deepEqual(g('THE DUCHON’S 2 — divadlo, 26.11.2026 18:00, Mestská športová hala, Partizánske.'), ['theatre']);
    assert.deepEqual(g('Luskáčik — tanec, 27.12.2026 18:00, Nová budova SND, Bratislava.'), ['theatre']);
    assert.deepEqual(g('Latino party — tanec, 28.11.2026 20:00, Klub, Žilina.'), ['party']);
    assert.deepEqual(g('Flamenkový workshop pre začiatočníkov — tanec, 28.11.2026 10:00, Klub, Žilina.'), ['workshop']);
    assert.deepEqual(g('Tereza Matoušková: Pláč — čítačka, 19.11.2026 18:00, Knižnica, Martin.'), ['talk']);
    assert.deepEqual(g('BACH A HLASY VIANOC — vážna hudba, 17.12.2026 19:00, Dom umenia, Košice.'), ['concert']);
    assert.deepEqual(g('Kde je mama kačka? — podujatie pre rodiny, 15.11.2026 10:00, Kultúrny dom, Trnava.'), ['kids']);
    assert.deepEqual(g('Miska solidarity — film, 21.11.2026 20:30, Slovenské komorné divadlo Martin, Martin.'), ['cinema']);
    assert.deepEqual(g('Festival PAN 2026 — festival, prebieha do 15.11.2026, Dom kultúry, Liptovský Mikuláš.'), ['festival']);
    assert.deepEqual(g('Tak sa robí humor — diskusia, 4.12.2026 19:00, Kino Úsmev, Košice.'), ['talk']);
    // An unknown kind ("komunitné podujatie") adds nothing; the title's words still count.
    assert.deepEqual(g('Ondrejský jarmok — komunitné podujatie, prebieha do 15.11.2026, Komárno.'), ['market']);
  });
  test('talk: literary evenings and author readings, not every "literatúra" or "autorská"', () => {
    assert.deepEqual(g('Doktorandské štúdium o svetovej literatúre'), []);
    assert.ok(!g('Patch to match - textilný autorský kurz').includes('talk'));
    assert.deepEqual(g('Literárny večer s Jánom'), ['talk']);
    assert.deepEqual(g('Autorské čítanie: Peter Stamm'), ['talk']);
    assert.deepEqual(g('Autogramiáda s hercami'), ['talk']);
    assert.deepEqual(g('Prezentácia knihy o Eve Polákovej'), ['talk']);
    assert.deepEqual(g('Stretnutie s autorkou Veronikou'), ['talk']);
  });
  test('sport: "fitness" only in a title; running, skiing, chess, tennis…; not "pochod" or Czech "během"', () => {
    assert.ok(!g('Spa víkend', { description: 'wellness a fitness centrum v cene' }).includes('sport'));
    assert.deepEqual(g('Fitness pre ženy'), ['sport']);
    assert.deepEqual(g('Rozhanovská dvanástka', { description: 'Beh na 12 km' }), ['sport']);
    assert.deepEqual(g('Domáci zápas stolného tenisu'), ['sport']);
    assert.deepEqual(g('Lyžiarsky výcvik'), ['sport']);
    assert.deepEqual(g('Šach v parku'), ['sport']);
    assert.deepEqual(g('Splav Váhu'), ['sport']);
    assert.deepEqual(g('Pilates v knižnici'), ['sport']);
    assert.deepEqual(g('Sviečkový pochod'), []);
    assert.ok(!g('ZAGORKA', { description: 'Speváčka a herečka. Během své kariéry…' }).includes('sport'));
    assert.deepEqual(g('Výlet', { description: 'Turistický výlet na Sitno' }), ['sport']);
    assert.ok(!g('Deň turistických sprievodcov', { description: 'Turistická informačná kancelária' }).includes('sport'));
  });
  test('concert: tours of bands, not food/wine/guided tours; "turné", piano, kapela, gospel', () => {
    assert.deepEqual(g('Food Tour Zvolen'), []);
    assert.deepEqual(g('Wine Tour – 6 zlatých vín'), ['market']);
    assert.deepEqual(g('Guided Tour of Trenčín’s Historic City Centre'), []);
    assert.deepEqual(g('Calin & Viktor Sheen - Arena Tour'), ['concert']);
    assert.deepEqual(g('KORBEN DALLAS - TURNÉ ČOMU UVERÍŠ'), ['concert']);
    assert.deepEqual(g('JOZEF HOLLY PIANO SHOW 2026'), ['concert']);
    assert.deepEqual(g('Večer', { description: 'Hrá kapela Horkýže Slíže' }), ['concert']);
    assert.deepEqual(g('The Best of Bratislava spieva gospel'), ['concert']);
    assert.deepEqual(g('Hudobný večer'), ['concert']);
  });
  test('concert: rock is not Rockville / Rocky, singing is not "spevná"', () => {
    assert.ok(!g('11/16- Rockville, MD- Friendsgiving').includes('concert'));
    assert.ok(!g('Hudba pod hviezdnou oblohou', { description: 'Mozartova hudba je vrelá a spevná' }).includes('concert'));
    assert.deepEqual(g('Rockové balady'), ['concert']);
    assert.deepEqual(g('Rock night'), ['concert']);
    assert.deepEqual(g('Spevácky zbor Lúčnica'), ['concert']);
    assert.deepEqual(g('Vianoce', { description: 'Vystúpi zbor' }), ['concert']);
  });
  test('wine: in a title, or a tasting / festival of wine in the description', () => {
    assert.deepEqual(g('Ježišove znamenia', { description: 'Premenil vodu na víno.' }), []);
    assert.deepEqual(g('Mladé víno 2026'), ['market']);
    assert.deepEqual(g('Deň otvorených pivníc 2026'), ['market']);
    assert.deepEqual(g('Slávnosti', { description: 'Slávnosti vína v Pezinku' }), ['market']);
  });
  test('festival from the title, or "N. ročník festivalu", not "v rámci festivalu"', () => {
    assert.deepEqual(g('Výstava', { description: 'Výstava v rámci festivalu Biela noc.' }), ['exhibition']);
    assert.deepEqual(g('Folkové Vianoce', { description: 'Pozývame vás na 20. ročník festivalu Folkové Vianoce.' }), ['festival']);
    assert.deepEqual(g('Majáles 2027'), ['festival']);
  });
  test('cinema: "3D prehliadky" of flats and 3D printing are not films; a talk show at a cinema is not one', () => {
    assert.deepEqual(g('3D prehliadky 2-izbový byt Mateja Bela, Žilina'), []);
    assert.deepEqual(g('3D TLAČ – ZAŠKOĽOVACÍ WORKSHOP'), ['workshop']);
    assert.deepEqual(g('Avatar 3D'), ['cinema']);
    assert.deepEqual(g('Neskoro večer: Talkshow Petra Marcina', { location: 'Kino Úsmev, Hlohovec' }), ['talk']);
    assert.deepEqual(g('STAND - UP COMEDY: Večer', { location: 'Kino Úsmev' }), ['theatre']);
    assert.deepEqual(g('Kabaret Ťuk-ťuk', { location: 'Cinemax' }), ['theatre']);
    // A show title that names no kind is still a film at a cinema.
    assert.deepEqual(g('The Truman Show', { location: 'Kino Úsmev' }), ['cinema']);
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
  test('SocialEvent is not a party (Eventbrite calls every event one); DanceEvent is', () => {
    assert.deepEqual(tagsFromSchemaTypes(['SocialEvent']), []);
    assert.deepEqual(tagsFromSchemaTypes(['DanceEvent', 'SocialEvent']), ['party']);
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
