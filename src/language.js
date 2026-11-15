// The language of an event's text, for telling where it is (geo.js: countrySignals). By the small
// words every sentence has, which Slovak and Czech write differently ("sú"/"jsou", "ktorý"/"který",
// "pre"/"pro"), not by single letters: one "ř" is often just a Czech name in a Slovak event
// ("Antonín Dvořák"). Hungarian and German say nothing about the country (Hungarians live in
// southern Slovakia, felvidek.ma), so they aren't told apart here.

const SK = new Set(`sú ktorý ktorá ktoré ktorí ktorých ktorým tiež alebo pre ako keď čo všetko všetci všetkých
  môže môžete môžu nie sa aj ešte veľký veľká veľké deti mesto mesta meste hodín zo vás vám sme ste byť
  bol bola boli bude budú tu tam kde kedy preto lebo že ani pri ďalšie ďalší ďalšia podujatie podujatia
  vstup vstupné srdečne pozývame príďte prídite čaká čakajú nájdete program večer ráno pozvánka
  divadlo kultúry námestí námestie obecný mestský mestská`.split(/\s+/));
const CZ = new Set(`jsou který která které kteří kterých kterým také nebo pro jako když co všechno všichni všech
  může můžete mohou není se ještě velký velká velké děti město města městě hodin jsme jste být
  byl byla byli budou zde tady proto protože ani při další akce akci srdečně zveme přijďte čeká čekají
  najdete pozvánka divadlo kultury náměstí náměstí obecní městský městská vstupenky vstupné
  vás vám že bude tam kde kdy večer ráno program`.split(/\s+/));
// Words both write the same way say nothing.
for (const w of [...SK]) if (CZ.has(w)) { SK.delete(w); CZ.delete(w); }
const EN = new Set(`the and of for with to in on at is are be will this that our your you we join us from by
  an or about more learn register free online event events day week please who what how all`.split(/\s+/));

const SK_LETTERS = /[ľĺŕô]/gi; // Czech doesn't have them (not ä: German has it)
const CZ_LETTERS = /[ěřů]/gi; // Slovak doesn't have them
// Letters of Slovak and Czech that Spanish, French or English don't have: without one, "se", "co"
// or "pro" are Spanish or English ("Ste. Chapelle Winery", "Días internacionales…").
const SK_CZ = /[čšžťďňľĺŕôěřů]/i;

/**
 * Word counts by language: { sk, cz, en, skLetters, czLetters }. Letters only one of Slovak and
 * Czech has are counted apart from words: a band's name full of "ř" in a Slovak listing ("Zdeněk
 * Vřešťál – NEŘEŽ TRIO", Nitra) is no Czech sentence.
 */
export function languageScores(text) {
  const s = String(text || '').toLowerCase();
  const out = { sk: 0, cz: 0, en: 0 };
  for (const w of s.match(/\p{L}+/gu) || []) {
    if (SK.has(w)) out.sk++;
    else if (CZ.has(w)) out.cz++;
    else if (EN.has(w)) out.en++;
  }
  out.skLetters = (s.match(SK_LETTERS) || []).length;
  out.czLetters = (s.match(CZ_LETTERS) || []).length;
  return out;
}

/**
 * 'sk', 'cz', 'en', or undefined when the text is too short or mixed. One language must have enough
 * words and clearly more than the others: a Slovak text naming "Dvořák" stays Slovak.
 */
export function languageOf(text) {
  const { sk, cz, en, skLetters, czLetters } = languageScores(text);
  const slavic = SK_CZ.test(text || '');
  // Slovak: a Slovak word, and with its letters enough of them ("Náš priateľ René" is too little).
  const skAll = sk + skLetters;
  if (slavic && sk >= 1 && skAll >= 2 && skAll >= 2 * cz && skAll >= en / 2) return 'sk';
  // Czech: Czech words, never letters alone.
  if (slavic && cz >= 2 && cz >= 2 * skAll && cz + czLetters >= en / 2) return 'cz';
  if (en >= 4 && en >= 4 * (sk + cz)) return 'en';
  return undefined;
}
