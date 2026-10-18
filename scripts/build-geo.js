// Builds the map of Slovakia the crawler uses to tell where an event is (src/geo-sk.js):
//   src/sk-places.json  every Slovak municipality (and borough of Bratislava and Košice) with its
//                       coordinates, population, district, official website and names in other
//                       languages (Hungarian, German, Polish, Czech, English), from Wikidata (each has a LAU code);
//   src/sk-border.json  the country's outline, from OpenStreetMap (Nominatim), simplified to ~300 m.
// Both change rarely; run `node scripts/build-geo.js` to refresh them and commit the result.
import fs from 'node:fs';

const UA = 'KosiceEventsBot/0.1 (+https://github.com/david-vendel/events)';

// Towns and cities by status (town, city, big city, spa town…); "border city" alone isn't one, many are villages.
const TOWN_TYPES = 'wd:Q3957 wd:Q515 wd:Q1549591 wd:Q6882870 wd:Q4946461 wd:Q67123843';
const QUERY = `SELECT ?item ?name ?coord ?pop ?district ?town ?parent WHERE {
  ?item wdt:P17 wd:Q214; wdt:P782 ?lau; wdt:P625 ?coord.
  FILTER NOT EXISTS { ?item wdt:P576 ?end }
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q2264478 }   # districts (okres)
  FILTER NOT EXISTS { ?item wdt:P31 wd:Q1778846 }   # military training areas
  ?item rdfs:label ?name FILTER(lang(?name) = "sk")
  OPTIONAL { ?item wdt:P1082 ?pop }
  OPTIONAL { ?item wdt:P131 ?d. ?d wdt:P31 wd:Q2264478; rdfs:label ?district FILTER(lang(?district) = "sk") }
  OPTIONAL { ?item wdt:P131 ?parent. VALUES ?parent { wd:Q1780 wd:Q25409 } }
  BIND(EXISTS { VALUES ?tt { ${TOWN_TYPES} } ?item wdt:P31 ?tt } AS ?town)
}`;

// Each municipality's website and its names in other languages ("Kassa", "Kaschau", "Pressburg").
const EXTRA = `SELECT ?item ?web (GROUP_CONCAT(DISTINCT ?l; separator="|") AS ?names) WHERE {
  ?item wdt:P17 wd:Q214; wdt:P782 ?lau.
  FILTER NOT EXISTS { ?item wdt:P576 ?end }
  OPTIONAL { ?item wdt:P856 ?web }
  OPTIONAL { ?item rdfs:label|skos:altLabel ?l FILTER(lang(?l) IN ("hu","de","pl","cs","en")) }
} GROUP BY ?item ?web`;

async function sparql(query) {
  const url = `https://query.wikidata.org/sparql?${new URLSearchParams({ query })}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/sparql-results+json' } });
  if (!res.ok) throw new Error(`Wikidata HTTP ${res.status}`);
  return (await res.json()).results.bindings;
}

const fold = (s) => s.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();

async function places() {
  const [rows, extra] = [await sparql(QUERY), await sparql(EXTRA)];
  const byId = new Map();
  for (const r of rows) {
    const id = r.item.value.split('/').pop();
    const [lon, lat] = r.coord.value.match(/-?[\d.]+/g).map(Number);
    const district = r.district?.value.replace(/^okres /, '');
    // Boroughs of the two cities: by their parent, or by the city's districts ("okres Košice II").
    const city = r.parent ? (r.parent.value.endsWith('Q1780') ? 'Bratislava' : 'Košice')
      : /^(Bratislava|Košice) [IV]+$/.test(district || '') ? district.split(' ')[0] : undefined;
    const prev = byId.get(id);
    if (prev && prev.pop >= Number(r.pop?.value || 0)) continue; // several populations (census years): the largest
    byId.set(id, {
      name: r.name.value, lat: round(lat), lon: round(lon), pop: Number(r.pop?.value || 0) || undefined,
      district, town: r.town.value === 'true' || undefined, partOf: city !== r.name.value ? city : undefined,
    });
  }
  // Websites (one per place; the first given), and other names: only Latin-script ones that differ
  // from the Slovak name once accents are dropped (slovakia.js decides which of them count).
  for (const r of extra) {
    const p = byId.get(r.item.value.split('/').pop());
    if (!p) continue;
    if (r.web && !p.web) p.web = r.web.value.replace(/^http:\/\/(www\.)?/i, 'https://$1').toLowerCase();
    const other = new Set((r.names?.value || '').split('|').map((n) => n.trim())
      .filter((n) => n && /^[\p{Script=Latin}\s.'’()-]+$/u.test(n) && fold(n) !== fold(p.name) && !n.includes('(')));
    if (other.size) p.aka = [...other].sort();
  }
  return [...byId.values()].sort((a, b) => (b.pop || 0) - (a.pop || 0) || a.name.localeCompare(b.name, 'sk'));
}

async function border() {
  const url = 'https://nominatim.openstreetmap.org/search?country=Slovakia&polygon_geojson=1&polygon_threshold=0.003&format=json&limit=1';
  const res = await fetch(url, { headers: { 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
  const [hit] = await res.json();
  if (hit?.geojson?.type !== 'Polygon') throw new Error(`unexpected outline: ${hit?.geojson?.type}`);
  return hit.geojson.coordinates[0].map(([lon, lat]) => [round(lat), round(lon)]);
}

const round = (x) => Math.round(x * 1e5) / 1e5;

const [list, outline] = await Promise.all([places(), border()]);
fs.writeFileSync('src/sk-places.json', `[\n${list.map((p) => JSON.stringify(p)).join(',\n')}\n]\n`);
fs.writeFileSync('src/sk-border.json', `${JSON.stringify(outline)}\n`);
console.log(`${list.length} places (${list.filter((p) => p.town).length} towns), border of ${outline.length} points`);
