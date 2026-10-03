// Right column: upcoming events as a list (each with the table of sources that confirm it) or on a
// map. Both views share the filters: dates, search, town and kind of event.
const shortDate = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtDate = (s) => s.start
  ? shortDate.format(new Date(`${s.start}T12:00`)) + (s.end && s.end !== s.start ? ` – ${shortDate.format(new Date(`${s.end}T12:00`))}` : '')
  : '';
const STATUS = { not_checked: 'not checked', no_date: 'no date found', error: 'unreachable' };

// Does a source agree with the event? Its start must match (or fall on a day of a run the event
// spans); times only if both have one.
function agrees(row, e) {
  const day = e.end ? row.start >= e.start && row.start <= e.end : row.start === e.start;
  return day && (!row.time || !e.time || row.time === e.time);
}

// The primary site listing the same title on other days: days of one run, not a disagreement
// (the event's dates already span them; see runRows in src/events.js).
const sameTitle = (a, b) => (a || '').trim().toLowerCase() === (b || '').trim().toLowerCase();
const isRunDay = (r, p) => r !== p && !r.linked && r.start && r.site === p.site && sameTitle(r.title, p.title);

function sourcesTable(e) {
  const all = (e.sources || []).map((r) => ({ title: e.title, ...r })); // the server leaves out titles equal to the event's
  if (!all.length) return '';
  const p = all[0];
  const days = new Set(all.filter((r) => r === p || isRunDay(r, p)).map((r) => r.start)).size;
  const rows = all.filter((r) => !isRunDay(r, p));
  return `<table class="sources">
    <tr><th>Source</th><th>Date</th><th>Time</th></tr>
    ${rows.map((r, i) => {
      const cls = i === 0 ? '' : r.status === 'ok' ? (agrees(r, e) ? 'ok' : 'bad') : 'na';
      const date = i === 0 ? fmtDate(e) : r.status === 'ok' ? fmtDate(r) : (STATUS[r.status] || r.status);
      const role = i === 0 ? (days > 1 ? `primary, listed on ${days} days` : 'primary')
        : r.kind === 'facebook' ? 'Facebook' : r.linked ? 'linked' : 'also listed';
      const time = r.status === 'ok' || i === 0 ? [r.time, r.endTime].filter(Boolean).join('–') : '';
      return `<tr>
        <td><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.site || host(r.url))}</a> <span class="role">· ${role}</span></td>
        <td><span class="d ${cls}" title="${esc(r.note || '')}">${esc(date)}</span></td>
        <td><span class="d ${i > 0 && r.status === 'ok' && r.time && p.time ? cls : ''}">${esc(time)}</span></td>
      </tr>`;
    }).join('')}
  </table>`;
}

let events = [];
let range = 'week';
// Remembered in this browser: List or Map, and the chosen town.
const remember = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const recall = (k) => { try { return localStorage.getItem(k) || ''; } catch { return ''; } };
// ?view=map opens the map (a link someone can share); otherwise the last view used here.
let view = (new URLSearchParams(location.search).get('view') || recall('view')) === 'map' ? 'map' : 'list';
let city = recall('city');

// Kinds of event (same list as src/tags.js); "other" is an event with none of them.
const TAG_LABELS = {
  cinema: 'Cinema', concert: 'Concerts', theatre: 'Theatre', exhibition: 'Exhibitions', festival: 'Festivals',
  kids: 'Kids', sport: 'Sport', workshop: 'Workshops', talk: 'Talks', party: 'Parties & dance',
  market: 'Markets & food', other: 'Other',
};
const tagsOf = (e) => (e.tags?.length ? e.tags : ['other']);
// Unchecked tags, remembered in this browser.
let hidden = new Set();
try { hidden = new Set(JSON.parse(localStorage.getItem('hiddenTags') || '[]')); } catch {}
const saveHidden = () => { try { localStorage.setItem('hiddenTags', JSON.stringify([...hidden])); } catch {} };

// Tag chip on an event; tags that came from AI say so ("AI": this event was tagged by AI;
// "learned": a rule the crawler learned from earlier AI answers).
const TAG_FROM = {
  ai: ['AI', 'Tagged by AI'],
  learned: ['learned', 'From a rule learned from earlier AI answers (same venue, page or title words)'],
};
function tagChip(e, t) {
  const from = TAG_FROM[e.tagFrom?.[t]];
  return `<span class="etag ${from ? 'ai' : ''}" title="${esc(from ? from[1] : 'From the page or the keyword rules')}">${esc(TAG_LABELS[t] || t)}${from ? ` · ${from[0]}` : ''}</span>`;
}

function renderTagFilter(inRange) {
  const counts = {};
  for (const e of inRange) for (const t of tagsOf(e)) counts[t] = (counts[t] || 0) + 1;
  $('#tags').innerHTML = Object.entries(TAG_LABELS).map(([t, label]) => `
    <label class="${counts[t] ? '' : 'zero'}"><input type="checkbox" data-tag="${t}" ${hidden.has(t) ? '' : 'checked'}>
      ${label} <span class="n">${counts[t] || 0}</span></label>`).join('') +
    `<button class="all" data-all="${hidden.size ? 'on' : 'off'}">${hidden.size ? 'Show all' : 'Hide all'}</button>`;
}

$('#tags').addEventListener('change', (e) => {
  const t = e.target.dataset.tag;
  if (!t) return;
  if (e.target.checked) hidden.delete(t); else hidden.add(t);
  saveHidden();
  renderEvents();
});
$('#tags').addEventListener('click', (e) => {
  const all = e.target.dataset.all;
  if (!all) return;
  hidden = all === 'on' ? new Set() : new Set(Object.keys(TAG_LABELS));
  saveHidden();
  renderEvents();
});

function rangeBounds() {
  const now = new Date(), today = ymd(now);
  if (range === 'today') return [today, today];
  if (range === 'week') return [today, ymd(addDays(now, 6))];
  if (range === 'weekend') {
    const dow = now.getDay(); // 0 Sun … 6 Sat
    const fri = dow === 0 ? addDays(now, -2) : dow === 6 ? addDays(now, -1) : addDays(now, 5 - dow);
    return [ymd(new Date(Math.max(fri, now))), ymd(addDays(fri, 2))];
  }
  return [today, '9999-12-31'];
}

const weekday = new Intl.DateTimeFormat('sk-SK', { weekday: 'short' });
// Start (and end) time on day d: that day's own hours when the event has a per-day schedule.
function timeCell(e, d) {
  const day = e.schedule?.find((x) => x.date === d);
  const [t, end] = day?.time ? [day.time, day.endTime] : [e.time, e.endTime];
  return `<div class="time">${esc(t || '—')}${t && end ? `<small>–${esc(end)}</small>` : ''}</div>`;
}

// Events that pass the date range, search and town filters (before the kind filter).
function inFilters() {
  const [from, to] = rangeBounds();
  const q = fold($('#q').value);
  return events.filter((e) => e.start <= to && (e.end || e.start) >= from
    && (!city || e.city === city)
    && (!q || fold(`${e.title} ${e.location} ${e.description}`).includes(q)));
}

// Town filter: towns with upcoming events, most events first.
function renderCities() {
  const counts = {};
  for (const e of events) if (e.city) counts[e.city] = (counts[e.city] || 0) + 1;
  if (city && !counts[city]) counts[city] = 0;
  const towns = Object.entries(counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'sk'));
  $('#city').innerHTML = `<option value="">All towns (${fmtCount(events.length)})</option>` + towns.map(([t, n]) =>
    `<option value="${esc(t)}" ${t === city ? 'selected' : ''}>${esc(t)} (${fmtCount(n)})</option>`).join('');
}
const fmtCount = (n) => n.toLocaleString('sk-SK');

function renderEvents() {
  const [from] = rangeBounds();
  const inRange = inFilters();
  renderTagFilter(inRange);
  // Shown if any of its tags is checked: a kids' film stays visible with Kids on and Cinema off.
  const shown = inRange.filter((e) => tagsOf(e).some((t) => !hidden.has(t)));
  $('#list').hidden = view === 'map';
  $('#mapview').hidden = view !== 'map';
  if (view === 'map') return renderMap(shown);
  // Multi-day events show on the first visible day of the range.
  const byDay = new Map();
  for (const e of shown) {
    const day = e.start < from ? from : e.start;
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(e);
  }
  const days = [...byDay.keys()].sort();
  const dayFmt = new Intl.DateTimeFormat('sk-SK', { weekday: 'long', day: 'numeric', month: 'long' });
  const dayLabel = (d) => d === ymd(new Date()) ? 'Today' : d === ymd(addDays(new Date(), 1)) ? 'Tomorrow'
    : dayFmt.format(new Date(`${d}T12:00`));
  const shortFmt = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric' });
  const dayAgo = Date.now() - 864e5;
  // Events that started before the range (exhibitions, runs) come after the day's own, ending soonest first.
  const byTime = (a, b) => (a.time || '99').localeCompare(b.time || '99');
  const ordered = (d) => {
    const all = byDay.get(d);
    const running = all.filter((e) => e.start < d).sort((a, b) => (a.end || a.start).localeCompare(b.end || b.start) || byTime(a, b));
    return [...all.filter((e) => e.start >= d).sort(byTime), ...running];
  };
  $('#list').innerHTML = days.length ? days.map((d) => `
    <h4 class="day">${esc(dayLabel(d))}</h4>
    ${ordered(d).map((e, i, list) => `
      ${e.start < d && !(list[i - 1]?.start < d) ? '<h5 class="running">Still running</h5>' : ''}
      <article class="event">
        ${timeCell(e, d)}
        <div>
          <a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
          ${Date.parse(e.firstSeenAt) > dayAgo ? '<span class="badge">new</span>' : ''}
          ${(e.tags || []).map((t) => tagChip(e, t)).join('')}
          <div class="meta">
            ${e.end && e.end !== e.start ? `until ${esc(shortFmt.format(new Date(`${e.end}T12:00`)))} · ` : ''}
            ${e.schedule?.length > 1 && new Set(e.schedule.map((x) => `${x.time}–${x.endTime}`)).size > 1 ? `${e.schedule.map((x) => esc(`${weekday.format(new Date(`${x.date}T12:00`))} ${[x.time, x.endTime].filter(Boolean).join('–')}`)).join(', ')} · ` : ''}
            ${e.showings?.[d] ? `${e.showings[d].map((s) => [s.venue, s.times.join(', ')].filter(Boolean).map(esc).join(' ')).join(' · ')} · `
              : e.location ? `${esc(e.location)} · ` : ''}via ${esc(host(e.source))}
          </div>
          ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
          ${sourcesTable(e)}
        </div>
      </article>`).join('')}`).join('')
    : '<p class="empty">No events found for this filter yet.</p>';
}

// ---------------------------------------------------------------- map

// Leaflet (and its marker clustering) load the first time the map is shown.
const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/';
const CLUSTER = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet.markercluster/1.5.3/';
const SLOVAKIA = [[47.73, 16.83], [49.61, 22.57]];
let map = null, cluster = null, mapReady = null, lastBounds = null;
// While a popup is open, live refreshes wait (rebuilding the pins would close it).
let popupOpen = false, pendingRender = null, mapFitted = false;

const loadCss = (href) => document.head.insertAdjacentHTML('beforeend', `<link rel="stylesheet" href="${href}">`);
const loadJs = (src) => new Promise((resolve, reject) => {
  const el = document.createElement('script');
  Object.assign(el, { src, onload: resolve, onerror: () => reject(new Error(`could not load ${src}`)) });
  document.head.append(el);
});

function initMap() {
  mapReady ??= (async () => {
    loadCss(`${LEAFLET}leaflet.min.css`);
    loadCss(`${CLUSTER}MarkerCluster.min.css`);
    loadCss(`${CLUSTER}MarkerCluster.Default.min.css`);
    await loadJs(`${LEAFLET}leaflet.min.js`);
    await loadJs(`${CLUSTER}leaflet.markercluster.min.js`);
    map = L.map('map', { zoomSnap: 0.5 }).fitBounds(SLOVAKIA);
    // OpenStreetMap's own tiles (dimmed by CSS in dark mode).
    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
    }).addTo(map);
    // A cluster shows how many events (not places) it holds.
    cluster = L.markerClusterGroup({
      showCoverageOnHover: false,
      maxClusterRadius: 45,
      iconCreateFunction: (c) => {
        const n = c.getAllChildMarkers().reduce((t, m) => t + m.options.events, 0);
        const size = n >= 100 ? 46 : n >= 10 ? 40 : 34;
        return L.divIcon({ className: '', html: `<div class="pin group" style="width:${size}px;height:${size}px">${n}</div>`, iconSize: [size, size] });
      },
    });
    map.addLayer(cluster);
    map.on('popupopen', () => { popupOpen = true; });
    map.on('popupclose', () => {
      popupOpen = false;
      if (pendingRender) { const shown = pendingRender; pendingRender = null; renderMap(shown); }
    });
  })();
  return mapReady;
}

const popupDate = new Intl.DateTimeFormat('sk-SK', { weekday: 'short', day: 'numeric', month: 'numeric' });
const PRECISION = {
  city: 'Only the town is known; the pin is at the town centre.',
  venue: '', address: '', page: '', manual: '',
};

// One pin per place, with the number of events there; the popup lists them by date.
// Where an event goes on the map: its place, and each other venue it's on at (with that venue's times).
function spotsOf(e) {
  const out = new Map();
  const add = (p, times) => {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lon)) return;
    const key = `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`;
    if (!out.has(key)) out.set(key, { place: p, times });
  };
  for (const list of Object.values(e.showings || {})) for (const s of list) add(s.place, s.times);
  add(e.place);
  return [...out.values()];
}

async function renderMap(shown) {
  const spotted = shown.map((e) => [e, spotsOf(e)]).filter(([, s]) => s.length);
  const placed = spotted.map(([e]) => e);
  const missing = shown.length - placed.length;
  $('#mapnote').textContent = `${fmtCount(placed.length)} events on the map`
    + (missing ? ` · ${fmtCount(missing)} more have no position yet (they're in the list)` : '');
  try {
    await initMap();
  } catch (err) {
    $('#mapnote').textContent = `The map could not load (${err.message}).`;
    return;
  }
  map.invalidateSize();
  if (popupOpen) { pendingRender = shown; return; }
  const places = new Map();
  for (const [e, spots] of spotted) {
    for (const { place, times } of spots) {
      const key = `${place.lat.toFixed(4)},${place.lon.toFixed(4)}`;
      if (!places.has(key)) places.set(key, { place, events: [] });
      places.get(key).events.push({ ...e, time: times?.length ? times.join(', ') : e.time });
    }
  }
  cluster.clearLayers();
  const markers = [...places.values()].map(({ place, events: here }) => {
    here.sort((a, b) => a.start.localeCompare(b.start) || (a.time || '99').localeCompare(b.time || '99'));
    const approx = place.precision === 'city';
    const icon = L.divIcon({ className: '', html: `<div class="pin ${approx ? 'approx' : ''}">${here.length}</div>`, iconSize: [30, 30] });
    const title = place.name || place.address || here[0].location || '';
    const items = here.slice(0, 40).map((e) => `<li><b>${esc(popupDate.format(new Date(`${e.start}T12:00`)))}${e.time ? ` ${esc(e.time)}` : ''}</b>
      <a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
      ${(e.tags || []).map((t) => `<span class="etag">${esc(TAG_LABELS[t] || t)}</span>`).join('')}</li>`).join('');
    const popup = `<div class="pop"><h5>${esc(title)}</h5>
      ${place.address && place.address !== title ? `<div class="addr">${esc(place.address)}</div>` : ''}
      ${PRECISION[place.precision] ? `<div class="warn">${esc(PRECISION[place.precision])}</div>` : ''}
      <ul>${items}</ul>${here.length > 40 ? `<div class="addr">…and ${here.length - 40} more</div>` : ''}</div>`;
    return L.marker([place.lat, place.lon], { icon, title, events: here.length }).bindPopup(popup, { maxWidth: 320 });
  });
  cluster.addLayers(markers);
  lastBounds = markers.length ? cluster.getBounds() : null;
  // First time the map opens with a town chosen: start there.
  if (!mapFitted && city && lastBounds?.isValid()) map.fitBounds(lastBounds, { padding: [30, 30], maxZoom: 14 });
  mapFitted = true;
}

$('#fit').addEventListener('click', () => {
  if (map && lastBounds?.isValid()) map.fitBounds(lastBounds, { padding: [30, 30], maxZoom: 15 });
});

function setView(v) {
  view = v;
  remember('view', v);
  document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === v));
  renderEvents();
}
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$('#city').addEventListener('change', (e) => {
  city = e.target.value;
  remember('city', city);
  // On the map, go to the town picked (or back to all of Slovakia).
  Promise.resolve(renderEvents()).then(() => {
    if (view !== 'map' || !map) return;
    if (city && lastBounds?.isValid()) map.fitBounds(lastBounds, { padding: [30, 30], maxZoom: 14 });
    else if (!city) map.fitBounds(SLOVAKIA);
  });
});

document.querySelectorAll('#ranges button').forEach((b) => b.addEventListener('click', () => {
  range = b.dataset.range;
  document.querySelectorAll('#ranges button').forEach((x) => x.setAttribute('aria-pressed', x === b));
  renderEvents();
}));
$('#q').addEventListener('input', renderEvents);

async function loadEvents() {
  try {
    const [ev, sources] = await Promise.all([getJson('/api/events'), getJson('/api/sources')]);
    const live = sources.filter((s) => s.kind === 'events');
    events = ev;
    const towns = new Set(ev.map((e) => e.city).filter(Boolean)).size;
    const located = ev.filter((e) => e.place).length;
    $('#summary').textContent = `${fmtCount(ev.length)} upcoming events in ${fmtCount(towns)} towns from ${fmtCount(live.length)} sources`
      + ` · ${fmtCount(located)} on the map`;
    renderCities();
    $('#footer').innerHTML = live.length
      ? `Sources: ${live.map((s) => `<a href="${esc(s.origin)}" target="_blank" rel="noopener">${esc(host(s.origin))}</a>`).join(', ')}`
      : '';
    renderEvents();
  } catch {
    $('#summary').textContent = 'Could not load events. Is the server running?';
  }
}
document.querySelectorAll('#views button').forEach((b) => b.setAttribute('aria-pressed', b.dataset.view === view));
loadEvents();
