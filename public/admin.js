// Left column: live crawler dashboard. Status arrives once a second over /api/stream;
// the Queue, Sources and AI tabs fetch their own data while open.
const WORKER_PRESETS = [1, 2, 5, 10, 20];
const PHASE_TAG = { recheck: 'info', verify: 'warn', explore: '', discover: 'info' };

let snap = null;
let tab = 'overview';
let tabData = null; // data for queue/sources/ai tabs
let selectedAi = null; // id of the AI call whose details are open
let openSource = null; // origin whose pages are expanded
let lastEventCount = -1;

// ---------------------------------------------------------------- header

function renderHeader() {
  const s = snap;
  const waiting = s.running && s.phase.name === 'Waiting';
  const state = s.stopping ? 'stopping' : waiting ? 'waiting' : s.running ? 'running' : 'idle';
  const pill = $('#state');
  pill.className = `pill ${state}`;
  pill.textContent = state;

  $('#start').disabled = s.running && !waiting;
  $('#start').textContent = waiting ? 'Start next cycle now' : 'Start';
  $('#once').disabled = s.running;
  $('#stop').disabled = !s.running || s.stopping;

  const workers = $('#workers');
  const presets = WORKER_PRESETS.includes(s.settings.concurrency) ? WORKER_PRESETS : [...WORKER_PRESETS, s.settings.concurrency].sort((a, b) => a - b);
  const key = presets.join() + s.settings.concurrency;
  if (workers.dataset.key !== key) {
    workers.dataset.key = key;
    workers.innerHTML = `<span>Parallel pages</span>${presets.map((n) =>
      `<button data-n="${n}" aria-pressed="${n === s.settings.concurrency}">${n}</button>`).join('')}`;
  }

  const detail = waiting && s.nextCycleAt ? `next cycle in ${until(s.nextCycleAt)}` : s.phase.detail;
  $('#phase').innerHTML = `<b>${esc(s.phase.name)}</b>${detail ? ` <span class="muted">— ${esc(detail)}</span>` : ''}` +
    (s.cycle ? ` <span class="muted">· cycle ${s.cycle.n}, started ${fmtTime(s.cycle.startedAt)}</span>` : '');

  const c = s.cycle;
  const bars = c ? [
    ['Pages', c.used.pages, c.used.pages + c.budget.pages],
    ['AI calls', c.used.ai, c.used.ai + c.budget.ai],
    ['Events verified', c.used.verify, c.budget.verify],
  ] : [];
  $('#progress').innerHTML = bars.map(([label, used, total]) => `
    <div><div class="label"><span>${label}</span><span>${used} / ${total}</span></div>
    <div class="track"><div style="width:${total ? Math.min(100, (used / total) * 100) : 0}%"></div></div></div>`).join('');
}

$('#start').onclick = () => postJson('/api/start').then(apply);
$('#once').onclick = () => postJson('/api/run-once').then(apply);
$('#stop').onclick = () => postJson('/api/stop').then(apply);
$('#workers').onclick = (e) => {
  const n = e.target.closest('button')?.dataset.n;
  if (n) postJson('/api/settings', { concurrency: Number(n) }).then(apply);
};

// ---------------------------------------------------------------- tabs

const tag = (text, cls = '') => `<span class="tag ${cls}">${esc(text)}</span>`;

function resultCell(r) {
  if (r.phase === 'verify') {
    return [tag(`${r.sources} source${r.sources === 1 ? '' : 's'}`), r.agree ? tag(`${r.agree} agree`, 'ok') : '', r.disagree ? tag(`${r.disagree} differ`, 'bad') : '',
      r.note ? `<div class="muted">${esc(r.note)}</div>` : ''].join(' ');
  }
  if (r.status === 'error') {
    if (r.note === 'not html' || r.note === 'robots.txt') return tag(r.note === 'not html' ? 'not a web page' : 'blocked by robots.txt');
    return `${r.ai ? `${aiTag(r.ai)} ` : ''}${tag(r.http ? `HTTP ${r.http}` : 'error', 'bad')} <span class="muted">${esc(r.note || '')}</span>`;
  }
  if (r.status === 'unchanged') return tag('unchanged');
  const parts = [];
  if (r.ai) parts.push(aiTag(r.ai));
  if (r.events !== undefined) parts.push(r.events ? tag(`${r.events} event${r.events === 1 ? '' : 's'}`, 'ok') : tag('no events'));
  if (r.added) parts.push(tag(`+${r.added} new`, 'ok'));
  if (r.how) parts.push(tag(r.how, 'info'));
  if (r.kind) parts.push(tag(r.kind, r.kind === 'events' ? 'ok' : ''));
  if (r.links) parts.push(`<span class="muted">${r.links} links queued</span>`);
  return parts.join(' ');
}

// "AI · 54.5k tokens" — click to open that call in the AI usage tab.
const aiTag = (a) => `<span class="tag ai" data-aicall="${esc(a.id)}" title="Open this AI call">AI · ${fmtTokens(a.tokens)} tokens${a.error ? ' · failed' : ''}</span>`;

// The steps of one cycle, with the current one highlighted.
const STEPS = [
  ['Re-checking sources', 'Re-check sources'], ['Verifying events', 'Verify events'],
  ['AI discovery search', 'AI discovery'], ['Exploring', 'Explore'],
];
function stepsStrip(s) {
  const name = s.phase.name;
  const at = STEPS.findIndex(([phase]) => phase === name);
  const finished = ['Cycle done', 'Waiting', 'Stopped'].includes(name);
  const items = STEPS.map(([, label], i) =>
    `<span class="${i === at ? 'now' : (finished || (at >= 0 && i < at)) ? 'done' : ''}">${i + 1}. ${label}</span>`);
  const last = name === 'Waiting' ? `Wait ${s.nextCycleAt ? until(s.nextCycleAt) : ''}` : s.running ? 'Wait' : 'Idle';
  items.push(`<span class="${name === 'Waiting' || !s.running ? 'now' : ''}">${esc(last)}</span>`);
  return `<div class="steps">${items.join('<i>›</i>')}</div>`;
}

function aiBox(s) {
  const a = s.ai;
  if (!a.enabled) return '<div class="aibox"><span class="dot"></span><div class="grow">AI is off (EVENTS_AI=off).</div></div>';
  const today = `${fmtInt(a.todayCalls)} call${a.todayCalls === 1 ? '' : 's'} · ${fmtTokens(a.todayTokens)} tokens today`;
  const now = a.busy
    ? `<b>AI ${a.busy.kind === 'discover' ? 'searching the web' : 'reading'}</b> ${esc(a.busy.target)} <span class="muted">· ${ago(a.busy.startedAt)}</span>`
    : '<b>AI idle</b>';
  const queue = a.waiting ? ` · <b>${a.waiting}</b> page${a.waiting === 1 ? '' : 's'} waiting for AI` : '';
  return `<div class="aibox ${a.busy ? 'busy' : ''}"><span class="dot"></span>
    <div class="grow">${now}${queue}<div class="muted">One page at a time · ${today}</div></div>
    <button class="btn" data-go="ai">AI usage ›</button></div>`;
}

function jobLabel(j) {
  const link = j.url?.startsWith('http') ? `<a href="${esc(j.url)}" target="_blank" rel="noopener">${esc(j.url)}</a>` : esc(j.url);
  return j.label ? `<b>${esc(j.label)}</b><br>${link}` : link;
}

function overview() {
  const s = snap, k = s.counts;
  const tiles = [
    ['Upcoming events', fmtInt(k.upcoming)],
    ['Event sources', fmtInt(k.sources)],
    ['Links in queue', fmtInt(k.queue), 'queue'],
    ['Pages seen', fmtInt(k.pagesKnown)],
    ['Sites judged', `${fmtInt(k.sources + k.irrelevant)}`, 'sources'],
    ['AI calls today', s.ai.enabled ? fmtInt(s.ai.todayCalls) : 'off', 'ai'],
    ['AI tokens today', fmtTokens(s.ai.todayTokens), 'ai'],
  ];
  const found = s.cycle ? `${s.cycle.found.events} events seen, ${s.cycle.found.added} new` : '';
  return `
    ${stepsStrip(s)}
    ${aiBox(s)}
    <div class="tiles">${tiles.map(([label, n, go]) => go
      ? `<button class="tile" data-go="${go}"><div class="n">${n}</div><div class="k">${label} ›</div></button>`
      : `<div class="tile"><div class="n">${n}</div><div class="k">${label}</div></div>`).join('')}</div>

    <h3>Scanning now (${s.active.length})</h3>
    <div class="scroll"><table class="grid">
      ${s.active.length ? s.active.map((j) => `<tr>
        <td>${tag(j.phase, PHASE_TAG[j.phase])}${j.ai ? `<br>${tag(j.ai === 'running' ? 'AI working' : 'AI queue', 'ai')}` : ''}</td>
        <td class="url">${jobLabel(j)}${j.note ? `<div class="muted">${esc(j.note)}</div>` : ''}</td>
        <td class="num">${ago(j.startedAt)}</td></tr>`).join('')
      : `<tr><td class="empty-row">${s.running ? 'Between tasks…' : 'Not running. Press Start.'}</td></tr>`}
    </table></div>

    <h3>Recently scanned ${found ? `<span style="text-transform:none;letter-spacing:0">· this cycle: ${found}</span>` : ''}</h3>
    <div class="scroll"><table class="grid">
      <tr><th>Time</th><th></th><th>Page</th><th>Result</th><th class="num">ms</th></tr>
      ${s.recent.length ? s.recent.map((r) => `<tr>
        <td class="num">${fmtTime(r.endedAt)}</td>
        <td>${tag(r.phase, PHASE_TAG[r.phase])}</td>
        <td class="url">${jobLabel(r)}</td>
        <td>${resultCell(r)}</td>
        <td class="num">${fmtInt(r.ms)}</td></tr>`).join('')
      : '<tr><td class="empty-row" colspan="5">Nothing scanned since the server started.</td></tr>'}
    </table></div>

    <h3>Log</h3>
    <div class="log">${s.log.map((l) => `<div>${fmtTime(l.at)} ${esc(l.text)}</div>`).join('') || 'Empty.'}</div>`;
}

function queueTab() {
  const q = tabData || [];
  return `<p class="muted" style="margin-top:0">${fmtInt(snap.counts.queue)} links waiting. Highest scores first; each cycle
    picks by score plus randomness, at most 3 per site.</p>
    <div class="scroll"><table class="grid">
      <tr><th class="num">Score</th><th>Link</th><th>Found on</th><th class="num">Added</th></tr>
      ${q.map((f) => `<tr><td class="num">${f.score}</td>
        <td class="url"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.url)}</a></td>
        <td>${f.foundOn?.startsWith('http') ? esc(host(f.foundOn)) : tag(f.foundOn || '?', 'info')}</td>
        <td class="num">${f.addedAt ? ago(f.addedAt) : ''}</td></tr>`).join('')
      || '<tr><td class="empty-row">Queue is empty.</td></tr>'}
    </table></div>`;
}

function sourcesTab() {
  const list = tabData || [];
  return `<p class="muted" style="margin-top:0">Websites the crawler has judged. Click a row to see its listing pages.</p>
    <div class="scroll"><table class="grid">
      <tr><th>Site</th><th>Kind</th><th class="num">Events</th><th class="num">Every</th><th>Next check</th></tr>
      ${list.map((x) => `
        <tr class="click ${openSource === x.origin ? 'sel' : ''}" data-origin="${esc(x.origin)}">
          <td class="url"><b>${esc(host(x.origin))}</b>${x.summary ? `<div class="muted">${esc(x.summary)}</div>` : ''}</td>
          <td>${tag(x.kind, x.kind === 'events' ? 'ok' : '')}${x.siteKind ? ` ${tag(x.siteKind)}` : ''}</td>
          <td class="num">${fmtInt(x.stats.events)}<div class="muted">${fmtInt(x.stats.newEvents)} new</div></td>
          <td class="num">${x.kind === 'events' ? `${x.intervalHours} h` : ''}</td>
          <td>${x.kind === 'events' ? fmtWhen(x.nextCheckAt) : ''}</td>
        </tr>
        ${openSource === x.origin ? `<tr><td colspan="5">
          ${x.pages.length ? x.pages.map((p) => `<div style="margin:4px 0">
            <a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.url)}</a>
            ${p.recipe ? tag('recipe', 'ok') : tag('no recipe', 'warn')}
            ${p.lastCount !== undefined ? tag(`${p.lastCount} items last time`) : ''}
            ${p.failures ? tag(`${p.failures} failures`, 'bad') : ''}
            ${p.analyzedAt ? `<span class="muted">AI ${fmtWhen(p.analyzedAt)}</span>` : ''}</div>`).join('')
          : '<span class="muted">No listing pages saved.</span>'}
          <div class="muted">${fmtInt(x.stats.visits)} visits · last checked ${fmtWhen(x.lastCheckedAt)}</div>
        </td></tr>` : ''}`).join('')
      || '<tr><td class="empty-row">No sites judged yet.</td></tr>'}
    </table></div>`;
}

function aiTab() {
  const a = snap.ai;
  const calls = tabData || [];
  const tiles = [
    ['Calls', fmtInt(a.calls)], ['Today', `${fmtInt(a.todayCalls)} · ${fmtTokens(a.todayTokens)}`],
    ['Tokens in', fmtTokens(a.input)], ['Tokens out', fmtTokens(a.output)], ['Web searches', fmtInt(a.webSearches)],
    ['Failed', fmtInt(a.errors)],
  ];
  return `<p class="note" style="margin-top:0">${a.enabled
    ? 'AI runs on your Claude subscription through your Claude Code login: calls use your plan\'s usage limits (shared with your own Claude Code use) and aren\'t billed per token.'
    : 'AI is off (EVENTS_AI=off).'}</p>
    <div class="tiles">${tiles.map(([k, n]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('')}</div>
    <div class="scroll"><table class="grid">
      <tr><th>Time</th><th>Kind</th><th>Page / query</th><th class="num">Tokens in/out</th><th class="num">s</th></tr>
      ${calls.map((c) => `<tr class="click ${selectedAi === c.id ? 'sel' : ''}" data-ai="${c.id}">
        <td class="num">${fmtWhen(c.at)}</td>
        <td>${tag(c.kind, 'info')}${c.error ? ` ${tag(c.error, 'bad')}` : ''}</td>
        <td class="url">${esc(c.target)}</td>
        <td class="num">${fmtTokens(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} / ${fmtTokens(c.usage.output)}</td>
        <td class="num">${(c.ms / 1000).toFixed(1)}</td></tr>`).join('')
      || '<tr><td class="empty-row">No AI calls yet.</td></tr>'}
    </table></div>
    <div id="ai-detail"></div>`;
}

async function showAiDetail(id) {
  selectedAi = id;
  history.replaceState(null, '', `#ai/${id}`);
  const box = $('#ai-detail');
  if (!box) return;
  box.innerHTML = '<div class="detail muted">Loading…</div>';
  const c = await getJson(`/api/ai/${id}`);
  const u = c.usage || {};
  box.innerHTML = `<div class="detail">
    <dl>
      <dt>Kind</dt><dd>${esc(c.kind)}</dd>
      <dt>${c.kind === 'discover' ? 'Query' : 'Page'}</dt><dd>${c.target?.startsWith('http') ? `<a href="${esc(c.target)}" target="_blank" rel="noopener">${esc(c.target)}</a>` : esc(c.target)}</dd>
      <dt>When</dt><dd>${new Date(c.at).toLocaleString('sk-SK')} · ${(c.ms / 1000).toFixed(1)} s</dd>
      <dt>Model</dt><dd>${esc(c.model)}${c.turns ? ` · ${c.turns} turns` : ''}</dd>
      <dt>Tokens</dt><dd>${fmtInt(u.input + u.cacheRead + u.cacheWrite)} in (${fmtInt(u.cacheRead)} from cache) · ${fmtInt(u.output)} out${u.webSearches ? ` · ${u.webSearches} web searches` : ''}</dd>
      ${c.inputChars ? `<dt>Page sent</dt><dd>${fmtInt(c.inputChars)} characters of simplified HTML</dd>` : ''}
      ${c.error ? `<dt>Error</dt><dd>${esc(c.error)}</dd>` : ''}
    </dl>
    <h3 style="margin-top:0">What it returned</h3>
    <pre>${esc(JSON.stringify(c.result, null, 2) ?? 'nothing')}</pre>
  </div>`;
  document.querySelectorAll('[data-ai]').forEach((r) => r.classList.toggle('sel', r.dataset.ai === id));
}

function settingsTab() {
  const s = snap.settings;
  const field = (key, label) => `<label for="set-${key}">${label}</label><input id="set-${key}" type="number" min="0" value="${s[key]}">`;
  return `<div class="form">
      ${field('concurrency', 'Parallel pages')}
      ${field('pagesPerCycle', 'Pages per cycle')}
      ${field('aiPerCycle', 'AI calls per cycle')}
      ${field('verifyPerCycle', 'Events verified per cycle')}
      ${field('cycleEveryMin', 'Minutes between cycles')}
    </div>
    <p><button class="btn primary" id="save-settings">Save</button> <span class="muted" id="saved"></span></p>
    <p class="note">Each site still gets one request every 2 seconds, however many pages run in parallel.<br>
      AI: ${snap.ai.enabled ? 'on (Claude subscription via your Claude Code login)' : 'off (EVENTS_AI=off)'} · Facebook dates: ${snap.facebook ? 'on' : 'off (set EVENTS_FACEBOOK=on)'}.
      Both are set when starting the server.</p>`;
}

const TABS = { overview, queue: queueTab, sources: sourcesTab, ai: aiTab, settings: settingsTab };
const TAB_DATA = { queue: '/api/queue', sources: '/api/sources', ai: '/api/ai' };

function renderTab() {
  if (!snap) return;
  $('#tab').innerHTML = TABS[tab]();
  if (tab === 'ai' && selectedAi) showAiDetail(selectedAi);
}

async function refreshTabData() {
  if (!TAB_DATA[tab]) return;
  tabData = await getJson(TAB_DATA[tab]);
  renderTab();
}

function selectTab(name) {
  if (!TABS[name]) name = 'overview';
  tab = name;
  history.replaceState(null, '', name === 'overview' ? location.pathname : `#${name}`);
  tabData = null;
  document.querySelectorAll('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === name));
  renderTab();
  refreshTabData();
}

document.querySelector('.tabs').onclick = (e) => {
  const b = e.target.closest('button[data-tab]');
  if (b) selectTab(b.dataset.tab);
};
$('#tab').onclick = (e) => {
  if (e.target.closest('a')) return;
  const go = e.target.closest('[data-go]');
  if (go) return selectTab(go.dataset.go);
  const call = e.target.closest('[data-aicall]');
  if (call) {
    selectedAi = call.dataset.aicall;
    return selectTab('ai');
  }
  const ai = e.target.closest('[data-ai]');
  if (ai) return showAiDetail(ai.dataset.ai);
  const src = e.target.closest('[data-origin]');
  if (src) {
    openSource = openSource === src.dataset.origin ? null : src.dataset.origin;
    renderTab();
  }
  if (e.target.id === 'save-settings') {
    const patch = {};
    for (const key of Object.keys(snap.settings)) {
      const input = $(`#set-${key}`);
      if (input) patch[key] = Number(input.value);
    }
    postJson('/api/settings', patch).then((s) => { apply(s); $('#saved').textContent = 'Saved.'; });
  }
};

// ---------------------------------------------------------------- live updates

// Re-rendering every second would swallow clicks that straddle an update; hold off while pressed.
let pressed = false;
$('#tab').addEventListener('pointerdown', () => { pressed = true; });
window.addEventListener('pointerup', () => setTimeout(() => { pressed = false; }, 50));

function apply(s) {
  snap = s;
  renderHeader();
  // Overview is live; other tabs render once here (first status) and then on their own refresh.
  if ((tab === 'overview' && !pressed) || !$('#tab').childElementCount) renderTab();
  // New events found: refresh the right column.
  if (s.counts.events !== lastEventCount) {
    if (lastEventCount >= 0) loadEvents();
    lastEventCount = s.counts.events;
  }
}

function connect() {
  const es = new EventSource('/api/stream');
  es.onmessage = (m) => apply(JSON.parse(m.data));
  es.onerror = () => {
    $('#state').className = 'pill stopping';
    $('#state').textContent = 'disconnected';
  };
}
connect();
{
  const [name, id] = location.hash.slice(1).split('/'); // e.g. #ai/<call id>
  if (name === 'ai' && id) selectedAi = id;
  selectTab(name);
}
// Queue, sources and AI tabs refresh while open (not every second: they can be large).
setInterval(() => { if (tab !== 'overview' && tab !== 'settings') refreshTabData(); }, 5000);
// Verification updates existing events without changing the count; refresh while crawling.
setInterval(() => { if (snap?.running) loadEvents(); }, 30000);
