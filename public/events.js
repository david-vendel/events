// Right column: upcoming events, each with the table of sources that confirm it.
const shortDate = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', year: 'numeric' });
const fmtDate = (s) => s.start
  ? shortDate.format(new Date(`${s.start}T12:00`)) + (s.end && s.end !== s.start ? ` – ${shortDate.format(new Date(`${s.end}T12:00`))}` : '')
  : '';
const STATUS = { not_checked: 'not checked', no_date: 'no date found', error: 'unreachable' };

// Does a source agree with the primary one? Start dates must match; times only if both have one.
function agrees(row, primary) {
  return row.start === primary.start && (!row.time || !primary.time || row.time === primary.time);
}

function sourcesTable(e) {
  const rows = e.sources || [];
  if (!rows.length) return '';
  const p = rows[0];
  return `<table class="sources">
    <tr><th>Source</th><th>Date</th><th>Time</th></tr>
    ${rows.map((r, i) => {
      const cls = i === 0 ? '' : r.status === 'ok' ? (agrees(r, p) ? 'ok' : 'bad') : 'na';
      const date = r.status === 'ok' || i === 0 ? fmtDate(r) : (STATUS[r.status] || r.status);
      const role = i === 0 ? 'primary' : r.kind === 'facebook' ? 'Facebook' : r.linked ? 'linked' : 'also listed';
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

function renderEvents() {
  const [from, to] = rangeBounds();
  const q = fold($('#q').value);
  const shown = events.filter((e) => e.start <= to && (e.end || e.start) >= from
    && (!q || fold(`${e.title} ${e.location} ${e.description}`).includes(q)));
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
  $('#list').innerHTML = days.length ? days.map((d) => `
    <h4 class="day">${esc(dayLabel(d))}</h4>
    ${byDay.get(d).sort((a, b) => (a.time || '99').localeCompare(b.time || '99')).map((e) => `
      <article class="event">
        <div class="time">${esc(e.time || '—')}</div>
        <div>
          <a class="name" href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>
          ${Date.parse(e.firstSeenAt) > dayAgo ? '<span class="badge">new</span>' : ''}
          <div class="meta">
            ${e.end && e.end !== e.start ? `until ${esc(shortFmt.format(new Date(`${e.end}T12:00`)))} · ` : ''}
            ${e.location ? `${esc(e.location)} · ` : ''}via ${esc(host(e.source))}
          </div>
          ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
          ${sourcesTable(e)}
        </div>
      </article>`).join('')}`).join('')
    : '<p class="empty">No events found for this filter yet.</p>';
}

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
    $('#summary').textContent = `${ev.length} upcoming events from ${live.length} sources`;
    $('#footer').innerHTML = live.length
      ? `Sources: ${live.map((s) => `<a href="${esc(s.origin)}" target="_blank" rel="noopener">${esc(host(s.origin))}</a>`).join(', ')}`
      : '';
    renderEvents();
  } catch {
    $('#summary').textContent = 'Could not load events. Is the server running?';
  }
}
loadEvents();
