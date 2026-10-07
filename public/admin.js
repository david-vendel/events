// Left column of the admin page: live crawler dashboard. Status arrives once a second over api/stream;
// the Queue, Sources, Domains and AI tabs fetch their own data while open.
const WORKER_PRESETS = [1, 2, 5, 10, 20];
const PHASE_TAG = { learn: 'ai', recheck: 'info', verify: 'warn', explore: '', discover: 'info', tag: 'ai', locate: 'ok', sitemap: 'info' };

let snap = null;
let tab = 'overview';
let tabData = null; // data for queue/sources/ai tabs
const openHelp = new Set(); // settings whose explanation is open
let selectedAi = null; // id of the AI call whose details are open
let openSource = null; // origin whose pages are expanded
let openDomain = null; // domain whose subdomains are expanded
let domainSort = 'visits';
let templateView = 'productive';
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

$('#start').onclick = () => postJson('api/start').then(apply);
$('#once').onclick = () => postJson('api/run-once').then(apply);
$('#stop').onclick = () => postJson('api/stop').then(apply);
$('#workers').onclick = (e) => {
  const n = e.target.closest('button')?.dataset.n;
  if (n) postJson('api/settings', { concurrency: Number(n) }).then(apply);
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
  if (r.past) parts.push(tag(`${r.past} past`, ''));
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
  ['AI discovery search', 'AI discovery'], ['Reading sitemaps', 'Sitemaps'], ['Exploring', 'Explore'],
  ['Checking dates', 'Check dates (AI)'], ['Tagging events', 'Tag & locate (AI)'], ['Locating events', 'Map'],
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

function planLine(p) {
  if (!p || p.error) return '';
  const parts = (p.windows || []).map((w) => `${esc(w.name)} ${Math.round(w.used)} %`);
  if (p.credits) parts.push(`credits ${Math.round(p.credits.percent)} % of monthly limit`);
  return `<div class="muted" style="margin-top:4px">Plan${p.subscription ? ` (${esc(PLAN_NAMES[p.subscription] || p.subscription)})` : ''}: ${parts.join(' · ') || 'no limits reported'}</div>`;
}

const AI_BUSY = { analyze: 'reading', tag: 'tagging', discover: 'searching the web for', classify: 'tagging' };

function aiBox(s) {
  const a = s.ai;
  const now = !a.enabled ? '<b>AI is off</b> <span class="muted">· the crawler runs on rules only</span>'
    : a.busy ? `<b>AI ${AI_BUSY[a.busy.kind] || 'working on'}</b> ${esc(a.busy.target)} <span class="muted">· ${ago(a.busy.startedAt)}</span>`
    : '<b>AI idle</b>';
  const queue = a.waiting ? ` · <b>${a.waiting}</b> waiting for AI` : '';
  const jobs = Object.values(a.jobs).map((j) => `<div class="aijob ${a.enabled && j.on ? '' : 'off'}">
    <b>${esc(j.label)}</b> ${a.enabled && j.on ? tag(j.model, 'ai') : tag('off')}
    <span class="muted">${j.todayCalls ? `${fmtInt(j.todayCalls)} today · ${fmtTokens(j.todayTokens)} tokens` : 'not used today'}</span></div>`).join('');
  return `<div class="aibox ${a.busy ? 'busy' : ''}"><span class="dot"></span>
    <div class="grow">${now}${queue}${jobs}${planLine(a.plan)}</div>
    <button class="btn" data-go="ai">AI settings & log ›</button></div>`;
}

// Is the crawl working, and is it finding events? Crawler bugs first, in red: a bug that hits every
// page otherwise only shows up as "0 events" everywhere.
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);
function healthBox(s) {
  const h = s.cycle?.health;
  if (!h) return '';
  const bug = h.crashes ? `<div class="alert"><b>${fmtInt(h.crashes)} crawler bug${h.crashes === 1 ? '' : 's'} this cycle.</b>
    Pages that hit a bug are not counted as read and will be read again once it's fixed.
    <pre>${esc(h.lastCrash?.url || '')}\n${esc(h.lastCrash?.error || '')}</pre></div>` : '';
  const cells = [
    ['Pages read', fmtInt(h.read), h.unchanged ? `+${fmtInt(h.unchanged)} unchanged` : ''],
    ['Had upcoming events', `${fmtInt(h.withEvents)}`, h.read ? `${pct(h.withEvents, h.read)} % of pages read` : ''],
    ['New events', fmtInt(h.added), `${fmtInt(h.events)} seen`],
    ['Fetch errors', fmtInt(h.errors), h.fetched ? `${pct(h.errors, h.fetched)} % of fetches` : ''],
    ['AI calls', fmtInt(h.ai), h.aiRecipes ? `${h.aiRecipes} new recipes` : ''],
    ['From sitemaps', fmtInt(h.sitemapQueued), h.sitemapFiles ? `${h.sitemapFiles} files read` : 'links queued'],
  ];
  return `${bug}<div class="health">${cells.map(([k, n, sub]) => `<div><div class="k">${k}</div><div class="n">${n}</div>
    <div class="k">${esc(sub)}</div></div>`).join('')}</div>`;
}

function historyTable(s) {
  const rows = [...(s.history || [])].reverse();
  if (!rows.length) return '';
  return `<h3>Recent cycles</h3>
    <div class="scroll"><table class="grid">
      <tr><th>Ended</th><th class="num">Pages</th><th class="num">Read</th><th class="num">With events</th>
        <th class="num">New events</th><th class="num">AI</th><th class="num">Errors</th><th class="num">Bugs</th><th class="num">min</th></tr>
      ${rows.map((c) => `<tr>
        <td class="num">${fmtWhen(new Date(Date.parse(c.at) + c.ms))}</td>
        <td class="num">${fmtInt(c.pages)}</td><td class="num">${fmtInt(c.read)}</td>
        <td class="num">${fmtInt(c.withEvents)} <span class="muted">${pct(c.withEvents, c.read)} %</span></td>
        <td class="num">${c.added ? `<b>${fmtInt(c.added)}</b>` : '0'}</td><td class="num">${fmtInt(c.ai)}</td>
        <td class="num">${fmtInt(c.errors)}</td><td class="num">${c.crashes ? tag(fmtInt(c.crashes), 'bad') : ''}</td>
        <td class="num">${(c.ms / 60e3).toFixed(1)}</td></tr>`).join('')}
    </table></div>`;
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
    ['Events on the map', `${fmtInt(k.located)} / ${fmtInt(k.upcoming)}`],
    ['Learned tag rules', fmtInt(k.tagRules)],
    ['Page templates', `${fmtInt(k.templates)}`, 'templates'],
    ['Shared recipes', fmtInt(k.recipes), 'templates'],
    ['Sites judged', `${fmtInt(k.sources + k.irrelevant)}`, 'sources'],
    ['AI calls today', s.ai.enabled ? fmtInt(s.ai.todayCalls) : 'off', 'ai'],
    ['AI tokens today', fmtTokens(s.ai.todayTokens), 'ai'],
  ];
  const found = s.cycle ? `${s.cycle.found.events} events seen, ${s.cycle.found.added} new` : '';
  return `
    ${stepsStrip(s)}
    ${healthBox(s)}
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

    ${historyTable(s)}

    <h3>Log</h3>
    <div class="log">${s.log.map((l) => `<div>${fmtTime(l.at)} ${esc(l.text)}${l.repeat ? ` <b>×${fmtInt(l.repeat)}</b>` : ''}</div>`).join('') || 'Empty.'}</div>`;
}

function queueTab() {
  const q = tabData || [];
  return `<p class="muted" style="margin-top:0">${fmtInt(snap.counts.queue)} links waiting, best first. A link's score is its
    own (event words, Slovak place names, .sk; minus for news, archives, past years, other languages) plus what the
    crawler learned about its page template and site (see Templates). Each cycle picks by score plus randomness;
    sites that produce events may take up to 15 pages a cycle, sites that never do 1.</p>
    <div class="scroll"><table class="grid">
      <tr><th class="num">Score</th><th class="num">Learned</th><th>Link</th><th>Found on</th><th class="num">Added</th></tr>
      ${q.map((f) => `<tr><td class="num"><b>${f.total ?? f.score}</b></td>
        <td class="num">${f.learned ? tag(`${f.learned > 0 ? '+' : ''}${f.learned}`, f.learned > 0 ? 'ok' : 'bad') : ''}</td>
        <td class="url"><a href="${esc(f.url)}" target="_blank" rel="noopener">${esc(f.url)}</a></td>
        <td>${f.foundOn?.startsWith('http') ? esc(host(f.foundOn)) : tag(f.foundOn || '?', 'info')}</td>
        <td class="num">${f.addedAt ? ago(f.addedAt) : ''}</td></tr>`).join('')
      || '<tr><td class="empty-row">Queue is empty.</td></tr>'}
    </table></div>`;
}

// How a listing page is read: structured data on the page (free), a saved recipe (free), or AI.
const HOW = {
  'json-ld': ['structured data', 'The page carries schema.org Event data, so events are read exactly, with no recipe or AI.'],
  recipe: ['recipe', 'CSS selectors the AI wrote once; used on every visit without AI.'],
  'AI → recipe': ['AI wrote a recipe', 'AI read the page and saved a recipe for next time.'],
  AI: ['read by AI', 'AI read the events itself (no reusable recipe for this page).'],
};
function readTag(p) {
  const r = p.lastRead;
  if (!r) return p.recipe ? tag('recipe', 'ok') : tag('not read yet', 'warn');
  const [label, help] = HOW[r.how] || [r.how, ''];
  const ok = r.events > 0;
  return `<span class="tag ${ok ? 'ok' : 'warn'}" title="${esc(help)}">${esc(label)} · ${fmtInt(r.events)} event${r.events === 1 ? '' : 's'}</span>
    <span class="muted">${fmtWhen(r.at)}</span>`;
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
            ${readTag(p)}
            ${p.tags?.length ? tag(`all: ${p.tags.join(', ')}`, 'info') : ''}
            ${p.failures ? tag(`${p.failures} failures`, 'bad') : ''}
            ${p.analyzedAt ? `<span class="muted">AI ${fmtWhen(p.analyzedAt)}</span>` : ''}</div>`).join('')
          : '<span class="muted">No listing pages saved.</span>'}
          <div class="muted">${fmtInt(x.stats.visits)} visits · last checked ${fmtWhen(x.lastCheckedAt)}</div>
        </td></tr>` : ''}`).join('')
      || '<tr><td class="empty-row">No sites judged yet.</td></tr>'}
    </table></div>`;
}

// A count with a small bar for its share of the total.
function share(n, total) {
  const pct = total ? (n / total) * 100 : 0;
  return `<div class="share">${fmtInt(n)}<div class="track" title="${pct.toFixed(1)} % of all"><div style="width:${Math.min(100, pct)}%"></div></div></div>`;
}

const DOMAIN_SORTS = [['visits', 'Visits'], ['cycleVisits', 'This cycle'], ['queued', 'In queue'], ['events', 'Events'], ['errors', 'Errors']];
// One domain taking this share of the current cycle or of the queue gets a "heavy" tag.
const HEAVY_CYCLE = 0.25, HEAVY_QUEUE = 0.2;

function domainsTab() {
  if (!tabData) return '<p class="muted">Loading…</p>';
  const { totals: t, domains } = tabData;
  const list = [...domains].sort((a, b) => b[domainSort] - a[domainSort] || b.visits - a.visits).slice(0, 300);
  const heavy = (x) => (t.cycleVisits >= 10 && x.cycleVisits / t.cycleVisits >= HEAVY_CYCLE)
    || (t.queued >= 50 && x.queued / t.queued >= HEAVY_QUEUE);
  const cells = (x) => `
    <td class="num">${share(x.visits, t.visits)}</td>
    <td class="num">${share(x.cycleVisits, t.cycleVisits)}</td>
    <td class="num">${share(x.queued, t.queued)}</td>
    <td class="num">${fmtInt(x.pages)}</td>
    <td class="num">${fmtInt(x.events)}${x.added ? `<div class="muted">${fmtInt(x.added)} new</div>` : ''}</td>
    <td class="num">${x.errors ? `<span title="${esc(x.lastError || '')}">${fmtInt(x.errors)}</span>` : ''}</td>
    <td class="num">${x.lastVisitAt ? ago(x.lastVisitAt) : ''}</td>`;
  return `<p class="muted" style="margin-top:0">Where the crawler spends its visits, by domain. Click a domain for its
    subdomains. Bars show the share of all visits, of this cycle's visits, and of the queue. A domain with many visits
    but few events is eating the budget; one with many events may deserve it.</p>
    <div class="sorts"><span>Sort by</span>${DOMAIN_SORTS.map(([k, label]) =>
      `<button data-sort="${k}" aria-pressed="${k === domainSort}">${label}</button>`).join('')}
      <span>· ${fmtInt(domains.length)} domains, ${fmtInt(t.visits)} visits, ${fmtInt(t.queued)} queued</span></div>
    <div class="scroll"><table class="grid">
      <tr><th>Domain</th><th class="num">Visits</th><th class="num">This cycle</th><th class="num">In queue</th>
        <th class="num">Pages</th><th class="num">Events</th><th class="num">Errors</th><th class="num">Last</th></tr>
      ${list.map((d) => `
        <tr class="click ${openDomain === d.domain ? 'sel' : ''}" data-domain="${esc(d.domain)}">
          <td class="url"><b>${esc(d.domain)}</b> ${d.hosts.length > 1 ? `<span class="muted">${d.hosts.length} hosts</span>` : ''}
            ${d.kind ? tag(d.kind, d.kind === 'events' ? 'ok' : '') : ''} ${heavy(d) ? tag('heavy', 'warn') : ''}
            ${d.hosts.some((h) => h.downUntil) ? tag('down', 'bad') : ''}</td>
          ${cells(d)}</tr>
        ${openDomain === d.domain ? d.hosts.map((h) => `<tr class="sub">
          <td class="url">${esc(h.host)} ${h.kind ? tag(h.kind, h.kind === 'events' ? 'ok' : '') : ''}
            ${h.downUntil ? tag(`down (${h.lastTrouble || 'error'}): back ${fmtWhen(h.downUntil)}`, 'bad')
              : h.failStreak >= 3 ? tag(`failing: ${h.lastError || 'error'}`, 'bad') : ''}</td>
          ${cells(h)}</tr>`).join('') : ''}`).join('')
      || '<tr><td class="empty-row">Nothing visited yet.</td></tr>'}
    </table></div>`;
}

const TEMPLATE_VIEWS = [['productive', 'Finding events'], ['wasteful', 'Never had events']];

function templatesTab() {
  if (!tabData) return '<p class="muted">Loading…</p>';
  const t = tabData.totals;
  const list = tabData[templateView] || [];
  return `<p class="muted" style="margin-top:0">Pages built from one template share a URL shape
    (<code>kamdomesta.sk/kosice/*</code>). The crawler counts, per template, how many visits found upcoming events.
    Templates that keep finding events get their links visited sooner; ones that never do sink in the queue, and the
    AI looks at a template at most once a week. A recipe the AI writes for one page is used for every page of the
    template (and tried on sibling templates of the same site), so no AI is needed for them.</p>
    <div class="tiles">
      <div class="tile"><div class="n">${fmtInt(t.templates)}</div><div class="k">templates seen</div></div>
      <div class="tile"><div class="n">${fmtInt(t.productive)}</div><div class="k">with events</div></div>
      <div class="tile"><div class="n">${pct(t.wasted, t.visits)} %</div><div class="k">of visits went to templates that never had events</div></div>
    </div>
    <div class="sorts"><span>Show</span>${TEMPLATE_VIEWS.map(([k, label]) =>
      `<button data-tview="${k}" aria-pressed="${k === templateView}">${label}</button>`).join('')}</div>
    <div class="scroll"><table class="grid">
      <tr><th>Template</th><th class="num">Visits</th><th class="num">With events</th><th class="num">New events</th>
        <th>Reading</th><th class="num">Effect</th></tr>
      ${list.map((p) => `<tr>
        <td class="url"><b>${esc(p.key)}</b>${p.example ? `<div><a class="muted" href="${esc(p.example)}" target="_blank" rel="noopener">${esc(p.example)}</a></div>` : ''}</td>
        <td class="num">${fmtInt(p.visits)}</td>
        <td class="num">${fmtInt(p.withEvents)} <span class="muted">${pct(p.withEvents, p.visits)} %</span></td>
        <td class="num">${fmtInt(p.added)}<div class="muted">${fmtInt(p.events)} seen</div></td>
        <td>${p.recipe ? tag(p.recipeFrom ? 'sibling recipe' : 'recipe', 'ok') : ''} ${p.aiSaid ? tag(`AI: ${p.aiSaid}`, 'ai') : ''}
          ${p.aiAt ? `<span class="muted">${fmtWhen(p.aiAt)}</span>` : ''}</td>
        <td class="num">${p.effect ? tag(`${p.effect > 0 ? '+' : ''}${p.effect}`, p.effect > 0 ? 'ok' : 'bad') : ''}</td></tr>`).join('')
      || '<tr><td class="empty-row" colspan="6">Nothing here yet.</td></tr>'}
    </table></div>`;
}

let aiFilter = 'all';

// ---------------------------------------------------------------- AI usage treemap

// Where AI tokens went: a treemap by job → site → page (or site → page → job), so a page or site
// that eats a lot stands out. Data: api/ai-usage, every call summed per day, job and page.
let usage = null; // { rows: [[day, job, page, calls, tokens, usd]] }
let usageAt = 0;
const usageView = { group: 'site', metric: 'tokens', days: 7, path: [] };
let tmTips = []; // what each drawn block's tooltip says
let tmZoom = []; // the path each drawn block zooms into
// Colour by job: the three that matter most get a hue, the rest share grey (a treemap puts any two
// colours side by side, and only three hues stay distinct for every reader). Names do the rest.
const JOB_SWATCH = { analyze: 1, triage: 2, dates: 3 };
const swatch = (job) => `var(--tm-${JOB_SWATCH[job] || 'other'})`;
const aiJobName = (job) => snap?.ai?.jobs?.[job]?.label || job;

/** The site a call belongs to: the page's host, or the job itself for jobs that aren't about one page. */
function usageSite(job, page) {
  if (/^https?:/.test(page)) return host(page) || page;
  return { discover: 'Web searches', tag: 'Event tagging', dates: 'Date checks' }[job] || aiJobName(job);
}
function usagePage(page) {
  if (!/^https?:/.test(page)) return page;
  try {
    const u = new URL(page);
    return decodeURI(u.pathname + u.search) || '/';
  } catch { return page; }
}

function usageRows() {
  if (!usage?.rows) return [];
  if (!usageView.days) return usage.rows;
  const from = ymd(addDays(new Date(), 1 - usageView.days));
  return usage.rows.filter((r) => r[0] >= from);
}

/** Where a usage row sits in the tree: [job, site, page] or [site, page, job]. */
function usagePath(job, page) {
  const site = usageSite(job, page);
  const pg = usagePage(page);
  // Jobs that aren't about a page have no site or page level of their own (discovery: its queries).
  const isPage = /^https?:/.test(page);
  return (usageView.group === 'job' ? [aiJobName(job), isPage && site, pg] : [site, pg, isPage && aiJobName(job)]).filter(Boolean);
}

/** The tree for the current grouping; every node sums calls, tokens and price, per job too. */
function usageTree(rows) {
  const root = { name: 'All AI use', kids: new Map(), calls: 0, tokens: 0, usd: 0, jobs: {} };
  for (const [, job, page, calls, tokens, usd] of rows) {
    const pg = usagePage(page);
    let node = root;
    for (const name of [null, ...usagePath(job, page)]) {
      if (name !== null) {
        if (!node.kids.has(name)) node.kids.set(name, { name, kids: new Map(), calls: 0, tokens: 0, usd: 0, jobs: {}, url: undefined });
        node = node.kids.get(name);
        if (name === pg && /^https?:/.test(page)) node.url = page;
      }
      node.calls += calls;
      node.tokens += tokens;
      node.usd += usd;
      node.jobs[job] = (node.jobs[job] || 0) + (usageView.metric === 'usd' ? usd : tokens);
    }
  }
  return root;
}

const usageValue = (n) => (usageView.metric === 'usd' ? n.usd : n.tokens);
const fmtUsage = (v) => (usageView.metric === 'usd' ? fmtUsd(v) : fmtTokens(v));
const mainJob = (n) => Object.entries(n.jobs).sort((a, b) => b[1] - a[1])[0]?.[0];

/** Squarified treemap layout of `items` ({ v }) in a rectangle: [{ item, x, y, w, h }]. */
function squarify(items, x, y, w, h) {
  const total = items.reduce((s, i) => s + i.v, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const areas = items.map((i) => (i.v * w * h) / total);
  const out = [];
  const worst = (row, side) => {
    const s = row.reduce((a, b) => a + b, 0);
    return Math.max((side * side * Math.max(...row)) / (s * s), (s * s) / (side * side * Math.min(...row)));
  };
  const place = (from, row) => {
    const s = row.reduce((a, b) => a + b, 0);
    if (w >= h) { // a column on the left
      const cw = s / h;
      let yy = y;
      row.forEach((a, k) => { out.push({ item: items[from + k], x, y: yy, w: cw, h: a / cw }); yy += a / cw; });
      x += cw; w -= cw;
    } else { // a row on top
      const rh = s / w;
      let xx = x;
      row.forEach((a, k) => { out.push({ item: items[from + k], x: xx, y, w: a / rh, h: rh }); xx += a / rh; });
      y += rh; h -= rh;
    }
  };
  let row = [];
  let start = 0;
  for (let i = 0; i < areas.length; i++) {
    const side = Math.min(w, h);
    if (row.length && worst([...row, areas[i]], side) > worst(row, side)) {
      place(start, row);
      start = i;
      row = [];
    }
    row.push(areas[i]);
  }
  if (row.length) place(start, row);
  return out;
}

/** Draw the treemap into #treemap (its size is only known once it's on the page). */
function drawTreemap() {
  const box = $('#treemap');
  if (!box) return;
  let root = usageTree(usageRows());
  const total = usageValue(root);
  // Zoomed in: follow the path as far as it still exists.
  const trail = [];
  for (const name of usageView.path) {
    const next = root.kids.get(name);
    if (!next) break;
    trail.push(name);
    root = next;
  }
  usageView.path = trail;
  tmTips = [];
  tmZoom = [];
  const W = box.clientWidth;
  const H = box.clientHeight;
  const html = [];
  const share = (v) => (total ? `${((100 * v) / total).toFixed(v / total < 0.01 ? 2 : 1)} %` : '');
  const tip = (n, names) => {
    const jobs = Object.entries(n.jobs).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
    tmTips.push(`<b>${esc(names.join(' › '))}</b>
      <div>${fmtTokens(n.tokens)} tokens · ${fmtUsd(n.usd)} · ${fmtInt(n.calls)} call${n.calls === 1 ? '' : 's'}</div>
      <div class="muted">${share(usageValue(n))} of all AI use in this range</div>
      ${jobs.length > 1 ? `<div class="tm-jobs">${jobs.map(([j, v]) => `<span><i style="background:${swatch(j)}"></i>${esc(aiJobName(j))} ${fmtUsage(v)}</span>`).join('')}</div>` : ''}`);
    return tmTips.length - 1;
  };
  // Lay out a node's children inside a rectangle; groups get a header and their own children inside.
  const lay = (node, x, y, w, h, names, zoom) => {
    const kids = [...node.kids.values()].map((n) => ({ n, v: usageValue(n) })).filter((k) => k.v > 0).sort((a, b) => b.v - a.v);
    for (const { item: { n }, x: cx, y: cy, w: cw, h: ch } of squarify(kids, x, y, w, h)) {
      const path = [...names, n.name];
      const z = zoom || (n.kids.size ? path.slice(trail.length) : null); // clicking zooms into the top-level block
      const zi = z ? tmZoom.push([...trail, ...z]) - 1 : -1;
      const ti = tip(n, path);
      const style = `left:${cx + 1}px;top:${cy + 1}px;width:${Math.max(0, cw - 2)}px;height:${Math.max(0, ch - 2)}px`;
      const label = `${esc(n.name)} <span>${fmtUsage(usageValue(n))}</span>`;
      if (n.kids.size && cw >= 48 && ch >= 40) {
        html.push(`<div class="tm-group" style="${style}" data-tmtip="${ti}" data-tm="${zi}"><div class="tm-head">${label}</div></div>`);
        lay(n, cx + 3, cy + 20, cw - 6, ch - 23, path, z);
      } else {
        html.push(`<div class="tm-leaf" style="${style};background:${swatch(mainJob(n))}" data-tmtip="${ti}" data-tm="${zi}">${cw >= 64 && ch >= 30 ? `<div class="tm-label">${label}</div>` : ''}</div>`);
      }
    }
  };
  lay(root, 0, 0, W, H, trail, null);
  box.innerHTML = html.join('') || '<p class="muted tm-empty">No AI calls in this range.</p>';
}

function usageBox() {
  if (!usage) return '<div class="usage"><h3>Where AI tokens went</h3><p class="muted">Loading…</p></div>';
  const rows = usageRows();
  const root = usageTree(rows);
  const total = usageValue(root);
  // The pages that cost most, with the jobs that spent it: the same answer as the treemap (and its
  // zoom), readable as a table.
  const pages = new Map();
  const { path } = usageView;
  for (const [, job, page, calls, tokens, usd] of rows) {
    if (!/^https?:/.test(page)) continue;
    if (path.length && usagePath(job, page).slice(0, path.length).join('\n') !== path.join('\n')) continue;
    const p = pages.get(page) || pages.set(page, { calls: 0, tokens: 0, usd: 0, jobs: {} }).get(page);
    p.calls += calls; p.tokens += tokens; p.usd += usd;
    p.jobs[job] = (p.jobs[job] || 0) + calls;
  }
  const top = [...pages].sort((a, b) => usageValue(b[1]) - usageValue(a[1])).slice(0, 15);
  const jobs = Object.entries(root.jobs).filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
  const chips = (key, options) => options.map(([v, label]) =>
    `<button data-usage="${key}" data-value="${v}" aria-pressed="${String(usageView[key]) === String(v)}">${label}</button>`).join('');
  const crumbs = [['All AI use', 0], ...usageView.path.map((name, i) => [name, i + 1])];
  return `<div class="usage">
    <h3>Where AI tokens went</h3>
    <div class="sorts">${chips('days', [[1, 'Today'], [7, '7 days'], [30, '30 days'], [0, 'All']])}
      <span class="tm-sep"></span>${chips('group', [['site', 'Site → page → job'], ['job', 'Job → site → page']])}
      <span class="tm-sep"></span>${chips('metric', [['tokens', 'Tokens'], ['usd', 'API price']])}</div>
    <p class="tm-total"><b>${fmtUsage(total)}</b> ${usageView.metric === 'usd' ? 'at API prices' : 'tokens'} · ${fmtInt(root.calls)} calls
      · <span class="muted">click a block to zoom in</span></p>
    <nav class="tm-crumbs">${crumbs.map(([name, i], k) => (k === crumbs.length - 1
      ? `<b>${esc(name)}</b>` : `<button data-tmcrumb="${i}">${esc(name)}</button> ›`)).join(' ')}</nav>
    <div id="treemap" class="treemap" role="img" aria-label="Treemap of AI token use; the table below lists the same pages"></div>
    <div class="tm-legend">${jobs.map(([j, v]) => `<span><i style="background:${swatch(j)}"></i>${esc(aiJobName(j))} <b>${fmtUsage(v)}</b></span>`).join('')}</div>
    <div class="scroll"><table class="grid">
      <tr><th>Pages that cost most${path.length ? ` in ${esc(path[path.length - 1])}` : ''}</th><th>Jobs (calls)</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">API price</th></tr>
      ${top.map(([url, p]) => `<tr><td class="url"><a href="${esc(url)}" target="_blank" rel="noopener">${esc(url.replace(/^https?:\/\/(www\.)?/, ''))}</a></td>
        <td>${Object.entries(p.jobs).map(([j, n]) => `<span class="tm-job"><i style="background:${swatch(j)}"></i>${esc(aiJobName(j))} ${n}</span>`).join(' ')}</td>
        <td class="num">${fmtInt(p.calls)}</td><td class="num">${fmtTokens(p.tokens)}</td><td class="num">${p.usd ? fmtUsd(p.usd) : '—'}</td></tr>`).join('')
      || '<tr><td class="empty-row" colspan="5">No page was shown to AI in this range.</td></tr>'}
    </table></div>
    <p class="note">Tokens include cached input. API price is what the calls would cost on the API (they run on your
      Claude plan); — means older calls that didn't record it.</p>
  </div>`;
}

async function refreshUsage(force) {
  if (!force && Date.now() - usageAt < 60_000) return;
  usageAt = Date.now();
  usage = await getJson('api/ai-usage');
}

const PLAN_NAMES = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise' };

// Your Claude plan: the only real measure of "how much is left". Plans have no token allowance.
function planBox(a) {
  const p = a.plan;
  const bar = (pct) => `<div class="track"><div style="width:${Math.min(100, pct)}%"></div></div>`;
  let body;
  if (!p) body = '<p class="muted">Checking…</p>';
  else if (p.error) body = `<p class="muted">Not available: ${esc(p.error)}</p>`;
  else {
    const rows = (p.windows || []).map((w) => `<div class="planrow"><span>${esc(w.name)}</span>${bar(w.used)}
      <span>${Math.round(w.used)} % used${w.resetsAt ? ` · resets ${fmtWhen(w.resetsAt)}` : ''}</span></div>`);
    if (p.credits) {
      const c = p.credits;
      rows.push(`<div class="planrow"><span>Usage credits this month</span>${bar(c.percent)}
        <span>${c.currency === 'USD' ? '$' : ''}${c.used.toFixed(2)} of ${c.currency === 'USD' ? '$' : ''}${c.limit.toFixed(2)}${c.currency === 'USD' ? '' : ` ${esc(c.currency)}`} (${Math.round(c.percent)} %)</span></div>`);
    }
    body = rows.join('') || '<p class="muted">The plan reported no usage limits.</p>';
  }
  return `<div class="aijobs plan">
    <div class="planhead"><b>Your Claude plan${p?.subscription ? `: ${esc(PLAN_NAMES[p.subscription] || p.subscription)}` : ''}</b>
      <span class="muted">${p?.at ? `checked ${fmtTime(p.at)}` : ''}</span>
      <button class="btn" data-plan-refresh>Refresh</button></div>
    ${body}
    <p class="muted">This is the account your Claude Code is logged in with, and everything above is shared with your
      own Claude Code use. Claude plans (Pro, Max, Team, Enterprise) have no fixed number of tokens: they limit
      usage per 5-hour window and per week, shown as % used. Usage credits pay for usage beyond those limits.
      <b>API price</b> is what the same tokens would cost on the pay-per-token API. It isn't what you pay on a plan,
      but it compares models: per token, Haiku costs about half of Sonnet and a quarter of Opus.</p>
  </div>`;
}

function modelTable(a) {
  if (!a.byModel?.length) return '';
  return `<table class="grid" style="margin-top:12px">
    <tr><th>Model</th><th class="num">Calls</th><th class="num">Tokens</th><th class="num">API price</th></tr>
    ${a.byModel.map((m) => `<tr><td>${esc(m.model)}</td><td class="num">${fmtInt(m.calls)}</td>
      <td class="num">${fmtTokens(m.tokens)}</td><td class="num">${m.costUsd ? fmtUsd(m.costUsd) : '<span class="muted">—</span>'}</td></tr>`).join('')}
  </table>`;
}

function aiJobsPanel(a) {
  return `<div class="aijobs">
    <label class="master"><input type="checkbox" data-ai-master ${a.enabled ? 'checked' : ''}> <b>Use AI</b>
      <span class="muted">— off: the crawler runs on rules only (recipes, JSON-LD, keyword tags)</span></label>
    ${Object.entries(a.jobs).map(([k, j]) => `<div class="aijobrow ${a.enabled ? '' : 'off'}">
      <label><input type="checkbox" data-ai-job="${k}" ${j.on ? 'checked' : ''} ${a.enabled ? '' : 'disabled'}> <b>${esc(j.label)}</b></label>
      <select data-ai-model="${k}" ${a.enabled && j.on ? '' : 'disabled'} aria-label="Model for ${esc(j.label)}">
        ${a.models.map((m) => `<option value="${m}" ${m === j.model ? 'selected' : ''}>${m === 'default' ? 'your Claude Code default' : m}</option>`).join('')}
      </select>
      <div class="muted">${esc(j.what)}</div>
      <div class="muted">${fmtInt(j.calls)} call${j.calls === 1 ? '' : 's'} in total (API price ${fmtUsd(j.costUsd)}) · ${fmtInt(j.todayCalls)} today (${fmtTokens(j.todayTokens)} tokens, ${fmtUsd(j.todayCostUsd)})${j.last
        ? ` · last ${fmtWhen(j.last.at)}: <span class="click" data-ai="${esc(j.last.id)}">${esc((j.last.error || j.last.outcome || j.last.target || '').split('\n')[0])}</span>` : ''}</div>
    </div>`).join('')}
  </div>`;
}

function aiQueueBox(a) {
  const q = a.queue;
  if (!q) return '';
  const paused = a.pausedUntil ? `<p class="warnbox">AI is paused: the Claude plan's limit was hit. It resumes at ${fmtWhen(a.pausedUntil)};
    pages wait in the queue meanwhile.</p>` : '';
  return `<h3>Waiting for AI ${info('aiqueue')}</h3>${help('aiqueue')}${paused}
    <p class="muted">${fmtInt(q.size)} page${q.size === 1 ? '' : 's'} waiting${q.repairs ? `, ${fmtInt(q.repairs)} of them recipe repairs` : ''};
      ${fmtInt(q.due)} can run now. Read by AI in the queue step of each cycle.</p>
    ${q.next.length ? `<div class="scroll"><table class="grid">
      <tr><th>Page</th><th>Why</th><th class="num">Priority</th><th>Waiting since</th></tr>
      ${q.next.map((j) => `<tr><td class="url">${esc(j.url)}</td>
        <td>${j.repair ? tag('repair', 'warn') : ''} ${esc(j.reason)}${j.tries ? `<div class="muted">${j.tries} failed tr${j.tries === 1 ? 'y' : 'ies'}: ${esc(j.lastError || '')}${j.nextTryAt ? `; next ${fmtWhen(j.nextTryAt)}` : ''}</div>` : ''}</td>
        <td class="num">${Math.round(j.priority)}</td><td>${fmtWhen(j.addedAt)}</td></tr>`).join('')}
    </table></div>` : ''}`;
}

function aiTab() {
  const a = snap.ai;
  // A server started before the AI jobs existed sends none: say so instead of failing silently.
  if (!a?.jobs) return '<p class="note">The crawler server is older than this page. Restart it (<code>npm run serve</code>) to see the AI tab.</p>';
  const calls = (tabData || []).filter((c) => aiFilter === 'all' || (c.kind === 'classify' ? 'tag' : c.kind) === aiFilter);
  const tiles = [
    ['Calls', fmtInt(a.calls)], ['Today', `${fmtInt(a.todayCalls)} · ${fmtTokens(a.todayTokens)}`],
    ['Tokens in', fmtTokens(a.input)], ['Tokens out', fmtTokens(a.output)], ['API price, all', fmtUsd(a.costUsd)],
    ['API price, today', fmtUsd(a.todayCostUsd)], ['Web searches', fmtInt(a.webSearches)],
    ['Failed', fmtInt(a.errors)],
  ];
  const jobName = (c) => a.jobs[c.kind === 'classify' ? 'tag' : c.kind]?.label || c.kind;
  return `${planBox(a)}
    ${aiJobsPanel(a)}
    <p class="note">Changes apply from the next AI call.</p>
    ${aiQueueBox(a)}
    <div class="tiles">${tiles.map(([k, n]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('')}</div>
    ${usageBox()}
    <div id="ai-detail"></div>
    <div class="sorts"><span>Show</span>${[['all', 'All jobs'], ...Object.entries(a.jobs).map(([k, j]) => [k, j.label])].map(([k, label]) =>
      `<button data-aifilter="${k}" aria-pressed="${k === aiFilter}">${esc(label)}</button>`).join('')}</div>
    <div class="scroll"><table class="grid">
      <tr><th>Time</th><th>Job</th><th>Page / query → what came of it</th><th class="num">Tokens in/out</th><th class="num">s</th></tr>
      ${calls.map((c) => `<tr class="click ${selectedAi === c.id ? 'sel' : ''}" data-ai="${c.id}">
        <td class="num">${fmtWhen(c.at)}</td>
        <td>${tag(jobName(c), 'ai')}<div class="muted">${esc(c.model || '')}</div>${c.error ? ` ${tag(c.error, 'bad')}` : ''}</td>
        <td class="url">${esc(c.target)}${c.outcome ? `<div class="outcome">${esc(c.outcome).replace(/\n/g, '<br>')}</div>` : ''}</td>
        <td class="num">${fmtTokens(c.usage.input + c.usage.cacheRead + c.usage.cacheWrite)} / ${fmtTokens(c.usage.output)}${c.usage.costUsd ? `<div class="muted">${fmtUsd(c.usage.costUsd)}</div>` : ''}</td>
        <td class="num">${(c.ms / 1000).toFixed(1)}</td></tr>`).join('')
      || '<tr><td class="empty-row">No AI calls yet.</td></tr>'}
    </table></div>
    ${modelTable(a)}`;
}

// ---------------------------------------------------------------- AI call details, in plain words

const yesNo = (v) => (v === true ? tag('yes', 'ok') : v === false ? tag('no') : '<span class="muted">—</span>');
const link = (u) => `<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`;
const RECIPE_FIELDS = [['item', 'One event (repeated element)'], ['title', 'Title'], ['date', 'Date'], ['time', 'Time'],
  ['location', 'Location'], ['description', 'Description'], ['link', 'Link to the event']];

// "Read new listing pages": what the AI decided about the site and the page.
function analyzeView(r) {
  const rows = [
    ['Publishes events', yesNo(r.publishesEvents ?? r.publishesKosiceEvents)],
    ['This page lists several events', yesNo(r.pageListsEvents)],
    ['All events on this page are in', r.listingCity ? esc(r.listingCity) : r.listingIsKosiceOnly ? 'Košice' : '<span class="muted">several places / unknown</span>'],
    ['Check the site again every', r.checkEveryHours ? `${r.checkEveryHours} hours` : '—'],
  ];
  if (r.pageTags?.length) rows.push(['Every event on this page is', r.pageTags.map((t) => tag(t)).join(' ')]);
  if (r.venue?.name) rows.push(['The site\'s own venue', esc([r.venue.name, r.venue.address].filter(Boolean).join(', '))]);
  return `<p><b>${esc(r.siteKind || 'unknown')}</b> site: ${esc(r.summary || '')}</p>
    <dl>${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>
    <h4>Recipe ${r.recipe ? '<span class="muted">(CSS selectors the crawler uses on later visits, without AI)</span>' : ''}</h4>
    ${r.recipe ? `<table class="sources">${RECIPE_FIELDS.filter(([k]) => r.recipe[k]).map(([k, label]) =>
      `<tr><td>${label}</td><td><code>${esc(r.recipe[k])}</code></td></tr>`).join('')}</table>`
      : '<p class="muted">None: the page has no repeated event elements.</p>'}
    ${r.events?.length ? `<h4>Events it read itself (${r.events.length})</h4>
      <table class="sources"><tr><th>Event</th><th>Date</th><th>Time</th><th>Where</th></tr>
      ${r.events.map((e) => `<tr><td>${e.url ? `<a href="${esc(e.url)}" target="_blank" rel="noopener">${esc(e.title)}</a>` : esc(e.title)}
        ${(e.tags || []).map((t) => tag(t)).join(' ')}</td>
        <td>${esc([e.start, e.end].filter(Boolean).join(' – '))}</td><td>${esc([e.time, e.endTime].filter(Boolean).join('–'))}</td><td>${esc(e.location || '')}</td></tr>`).join('')}
      </table>` : ''}
    ${r.eventListUrls?.length ? `<h4>Other pages on this site that list events</h4>
      <ul>${r.eventListUrls.map((u) => `<li>${link(u)}</li>`).join('')}</ul>` : ''}`;
}

// "Tag events": which tags each event got. Titles come from the saved input.
function tagView(r, input) {
  const sent = new Map();
  for (const line of (input?.prompt || '').split('\n')) {
    try { const e = JSON.parse(line); if (Number.isInteger(e.i)) sent.set(e.i, e); } catch {}
  }
  const rows = (r.events || []).map((x) => {
    const e = sent.get(x.i);
    return `<tr><td>${e ? esc(e.title) : `event #${x.i}`}${e?.venue ? `<div class="muted">${esc(e.venue)}</div>` : ''}</td>
      <td>${x.tags.length ? x.tags.map((t) => tag(t)).join(' ') : '<span class="muted">no tag fits</span>'}</td></tr>`;
  });
  return `<table class="sources"><tr><th>Event</th><th>Tags it gave</th></tr>${rows.join('')}</table>`;
}

// "Find new sources": the search and the links it found.
function discoverView(r) {
  return `<p>Searched for <b>${esc(r.query)}</b> and found ${r.urls?.length || 0} links:</p>
    <ul>${(r.urls || []).map((u) => `<li>${link(u)}</li>`).join('')}</ul>`;
}

// "Check dates": what AI read for each date format and schedule. Texts come from the saved input.
function datesView(r, input) {
  const lines = (input?.prompt || '').split('\n');
  const samples = {}, prose = {};
  let f = null;
  for (const l of lines) {
    let m;
    if ((m = l.match(/^FORMAT f=(\d+)/))) f = +m[1];
    else if ((m = l.match(/^PROSE p=(\d+) \(event "(.*)"\)/))) { f = null; prose[m[1]] = m[2]; }
    else if (f !== null && (m = l.match(/^\s+s=(\d+): (.*)/))) (samples[f] ??= {})[m[1]] = m[2];
  }
  const when = (a) => esc([[a.start, a.end].filter(Boolean).join(' – '), [a.time, a.endTime].filter(Boolean).join('–')].filter(Boolean).join(' · ') || '—');
  const rows = (r.formats || []).flatMap((x) => x.samples.map((y, i) => `<tr><td><code>${esc(samples[x.f]?.[y.s] ?? `#${x.f}/${y.s}`)}</code></td>
    <td>${when(y)}</td>${i === 0 ? `<td rowspan="${x.samples.length}">${x.rule ? `<code>${esc(x.rule.pattern)}</code>` : '<span class="muted">no rule</span>'}</td>` : ''}</tr>`));
  return `${rows.length ? `<table class="sources"><tr><th>Date text</th><th>AI read it as</th><th>Rule it wrote</th></tr>${rows.join('')}</table>` : ''}
    ${(r.prose || []).map((p) => `<h4>${esc(prose[p.p] || `schedule #${p.p}`)}</h4><p>${when(p)}</p>
      ${p.schedule?.length ? `<ul>${p.schedule.map((d) => `<li>${when({ start: d.date, time: d.time, endTime: d.endTime })}</li>`).join('')}</ul>` : ''}`).join('')}`;
}

let detailCache = { id: null, html: '' };

const AI_VIEWS = { analyze: analyzeView, tag: tagView, classify: tagView, discover: discoverView, dates: datesView };

async function showAiDetail(id) {
  selectedAi = id;
  history.replaceState(null, '', `#ai/${id}`);
  const box = $('#ai-detail');
  if (!box) return;
  // The tab re-renders every few seconds: put the open call back as it was, without a reload or a jump.
  if (detailCache.id === id) {
    box.innerHTML = detailCache.html;
    document.querySelectorAll('[data-ai]').forEach((r) => r.classList.toggle('sel', r.dataset.ai === id));
    return;
  }
  box.innerHTML = '<div class="detail muted">Loading…</div>';
  const c = await getJson(`api/ai/${id}`);
  const u = c.usage || {};
  box.innerHTML = `<div class="detail">
    <dl>
      <dt>Job</dt><dd>${esc(snap.ai.jobs[c.kind === 'classify' ? 'tag' : c.kind]?.label || c.kind)}</dd>
      ${c.outcome ? `<dt>What came of it</dt><dd>${esc(c.outcome).replace(/\n/g, '<br>')}</dd>` : ''}
      <dt>${c.kind === 'discover' ? 'Query' : 'Page'}</dt><dd>${c.target?.startsWith('http') ? `<a href="${esc(c.target)}" target="_blank" rel="noopener">${esc(c.target)}</a>` : esc(c.target)}</dd>
      <dt>When</dt><dd>${new Date(c.at).toLocaleString('sk-SK')} · ${(c.ms / 1000).toFixed(1)} s</dd>
      <dt>Model</dt><dd>${esc(c.model)}${c.turns ? ` · ${c.turns} turns` : ''}</dd>
      <dt>Tokens</dt><dd>${fmtInt(u.input + u.cacheRead + u.cacheWrite)} in (${fmtInt(u.cacheRead)} from cache) · ${fmtInt(u.output)} out${u.webSearches ? ` · ${u.webSearches} web searches` : ''}${u.costUsd ? ` · API price ${fmtUsd(u.costUsd)}` : ''}</dd>
      ${c.error ? `<dt>Error</dt><dd>${esc(c.error)}</dd>` : ''}
    </dl>

    <h3>What AI figured out</h3>
    ${c.result && AI_VIEWS[c.kind] ? AI_VIEWS[c.kind](c.result, c.input) : '<p class="muted">No answer.</p>'}

    <h3>What the crawler did with it</h3>
    <p>${c.outcome ? esc(c.outcome).replace(/\n/g, '<br>') : '<span class="muted">Not recorded (calls from before this was logged).</span>'}</p>

    <h3>Input and raw output</h3>
    ${c.input ? `
      ${c.input.system ? `<details><summary>Instructions (system prompt), ${fmtInt(c.input.system.length)} characters</summary><pre>${esc(c.input.system)}</pre></details>` : ''}
      <details><summary>What it was sent${c.kind === 'analyze' ? ' (page URL, title, links, simplified HTML)' : ''}, ${fmtInt(c.input.prompt.length)} characters</summary><pre>${esc(c.input.prompt)}</pre></details>
      ${c.input.tools ? `<p class="muted">Tools it could use: ${esc(c.input.tools.join(', '))}</p>` : ''}`
      : `<p class="muted">Input not kept${c.inputChars ? ` (it was ${fmtInt(c.inputChars)} characters)` : ''}: only the last 300 calls keep it, and calls from before this version have none.</p>`}
    <details><summary>Raw answer (JSON)</summary><pre>${esc(JSON.stringify(c.result, null, 2) ?? 'nothing')}</pre></details>
  </div>`;
  box.querySelector('.detail').insertAdjacentHTML('afterbegin', '<button class="btn close" data-ai-close>Close</button>');
  detailCache = { id, html: box.innerHTML };
  document.querySelectorAll('[data-ai]').forEach((r) => r.classList.toggle('sel', r.dataset.ai === id));
  box.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// What a setting or view does, how and why: shown below it when its ⓘ is pressed.
const HELP = {
  cycle: `<p>The crawler works in <b>cycles</b>. <b>Start</b> runs one, waits, runs the next, until you press Stop
      (<b>Run once</b> runs a single cycle). Each cycle goes through these steps in order:</p>
    <ol>
      <li><b>Re-check sources</b>: event sources that are due get their listing pages read again (up to 12 per source,
        the ones read longest ago first). A source that keeps giving new events is checked more often, one that doesn't
        less often (every 12 hours to 7 days).</li>
      <li><b>Verify events</b>: upcoming events re-read their own page and the Facebook / ticket pages they link to.</li>
      <li><b>AI discovery</b>: every 6 hours, one AI web search for new event sites, aimed at the town and kind of event
        we cover worst (see the Coverage tab).</li>
      <li><b>Sitemaps</b>: up to 4 sites that have events get their sitemap read, to find event pages no listing links to.</li>
      <li><b>Explore</b>: whatever page budget is left goes to the queue of links found so far, best-scoring first.</li>
      <li><b>Check dates</b>, <b>tag</b> and <b>locate</b> the events, so the ones found this cycle are finished this cycle.</li>
    </ol>
    <p>The numbers below are the limits for one cycle. A cycle ends when its work is done or its budget is spent,
      whichever comes first. Changes are saved for good and apply from the next cycle (parallel pages: right away).</p>`,
  concurrency: `<p><b>What:</b> how many pages are fetched at the same time (1–50, default 5).</p>
    <p><b>How:</b> a pool of workers; each takes the next page as soon as it's free. Changing it takes effect within half a
      second, even in the middle of a cycle.</p>
    <p><b>Why it doesn't hammer sites:</b> every site still gets at most one request every 2 seconds, however many workers
      there are, and robots.txt is obeyed. More workers help when the work is spread over many sites; on one big site
      they just wait their turn. AI calls also run strictly one at a time, so more workers don't mean more AI.</p>
    <p><b>Raise it</b> to finish cycles faster; <b>lower it</b> if the server is slow or short on memory or network.</p>`,
  pagesPerCycle: `<p><b>What:</b> the most pages one cycle may fetch (1–2000, default 60). This is the main size of a cycle.</p>
    <p><b>Counts:</b> listing pages re-checked, sitemap files, and pages explored from the queue. Re-checking known sources
      goes first, then sitemaps, then exploring gets what's left, so with a small number new sites are found slowly.</p>
    <p><b>Doesn't count:</b> the pages read to verify events (they have their own limit below) and robots.txt.</p>
    <p><b>Why a limit:</b> it keeps each cycle short and predictable, and spreads the crawling out over time. A page that hasn't
      changed since last time (same ETag or content) still counts as fetched but is processed in no time.</p>`,
  aiPerCycle: `<p><b>What:</b> the most calls to the bigger AI model in one cycle (0–100, default 5). 0 means no such calls.</p>
    <p><b>Used by:</b> the AI queue (pages the crawler can't parse on its own get a <i>recipe</i> written for them, after
      which pages like them are read without AI; recipes that stop working get repaired); the discovery web search; and
      checking date formats and schedules written as text (at most 2 calls a cycle). Pages that don't fit in this
      cycle's budget wait in the queue (AI tab) for the next one.</p>
    <p><b>Not counted:</b> the cheap pre-check that first asks whether a page lists events at all (up to 60 a cycle) and
      tagging events (2 calls of 40 events a cycle). Switch those off in the AI tab if you want none.</p>
    <p><b>Why a limit:</b> AI calls use your Claude plan and take tens of seconds each. The crawler also holds back by itself:
      one look per site per cycle, one per page template per week, and none at sites where AI found nothing 3 times.
      The AI tab shows every call, what it cost and what came of it.</p>`,
  verifyPerCycle: `<p><b>What:</b> how many upcoming events get re-checked in one cycle (0–500, default 15).</p>
    <p><b>How:</b> an event is due when it was last checked more than 3 days ago; the soonest events go first. Its own detail
      page is read again (dates and times may have changed, a schedule may have appeared) and the Facebook and
      ticket-shop pages it links to (up to 4) are checked to confirm the date. Events whose site is down wait until it's back.</p>
    <p><b>Why:</b> listings often show only a title and a day; the detail and ticket pages confirm it and add the time,
      which is what the public site shows as sources. These fetches don't count towards <i>Pages per cycle</i>.</p>
    <p><b>Raise it</b> if many events show as unconfirmed; 0 switches verifying off.</p>`,
  cycleEveryMin: `<p><b>What:</b> how long to wait after a cycle ends before the next one starts (1–1440 minutes, default 60).</p>
    <p><b>How:</b> the wait is counted from the end of a cycle, so a long cycle doesn't make the next one start right away.
      A new value applies from the next wait; to skip the current wait press <b>Start next cycle now</b>.</p>
    <p><b>Why not shorter:</b> sources decide themselves when they are due (every 12 hours to 7 days), so cycles more often
      than that mostly explore the queue. Shorter = new sites found sooner, but more requests and more AI use per day.</p>`,
};

const info = (key) => `<button class="info-btn" data-help="${key}" aria-expanded="${openHelp.has(key)}" title="What this does">i</button>`;
const help = (key) => `<div class="help" data-help-box="${key}"${openHelp.has(key) ? '' : ' hidden'}>${HELP[key]}</div>`;

function settingsTab() {
  const s = snap.settings;
  const field = (key, label) => `<label for="set-${key}">${label} ${info(key)}</label>
    <input id="set-${key}" type="number" min="0" value="${s[key]}">${help(key)}`;
  return `<p class="muted">How a crawl cycle works ${info('cycle')}</p>${help('cycle')}
    <div class="form">
      ${field('concurrency', 'Parallel pages')}
      ${field('pagesPerCycle', 'Pages per cycle')}
      ${field('aiPerCycle', 'AI calls per cycle')}
      ${field('verifyPerCycle', 'Events verified per cycle')}
      ${field('cycleEveryMin', 'Minutes between cycles')}
    </div>
    <p><button class="btn primary" id="save-settings">Save</button> <span class="muted" id="saved"></span></p>
    <p class="note">Each site still gets one request every 2 seconds, however many pages run in parallel.<br>
      AI: ${snap.ai.enabled ? 'on' : 'off'}, switched per job in the <span class="click" style="text-decoration:underline;cursor:pointer" data-go="ai">AI tab</span>.
      Facebook dates: ${snap.facebook ? 'on' : 'off (set EVENTS_FACEBOOK=on when starting the server)'}.</p>`;
}

HELP.aiqueue = `<p><b>Why a queue:</b> crawling is free, AI isn't. So the crawler never waits for AI and never
    calls it in the middle of crawling. A page that needs AI is put here, and one step of every cycle works through
    the queue: within <i>AI calls per cycle</i>, with AI switched on, and not while the Claude plan's limit is hit.</p>
  <p><b>What needs AI:</b> a page that lists events but that the crawler can't read on its own yet (no structured data,
    no recipe), and a page whose recipe stopped reading it well. AI then writes a <b>recipe</b>: CSS selectors that say
    where each event, its title, date, time, place and link are on the page. Every later visit reads the page with the
    recipe, without AI, and so do the site's other pages built the same way (same URL pattern) and similar sections of
    the site. Sites are finite, so once their page types have recipes, AI is rarely needed.</p>
  <p><b>Checking every read:</b> each time a recipe reads a page, the result is compared with how that page usually reads.
    If it now finds no events, under a third of the usual number, the same title for most events, or has lost the times,
    places or links it used to give, the site has probably changed its layout. The page is queued for a <b>repair</b>
    (first in line), and AI is shown the old recipe and what went wrong. Meanwhile the old recipe's events are still used.
    A new recipe replaces the old one only if it reads the page at least about as well.</p>
  <p><b>Order and limits:</b> repairs first, then seed pages, then pages AI named as listings, then other promising pages.
    One new page per URL pattern waits at a time (its recipe will read the others), and one new site's page per cycle.
    A try that fails because the plan's limit was hit waits until the limit resets and doesn't count; other failures
    are retried after 1, 2 and 4 hours, then dropped. The queue keeps at most 1,000 pages.</p>`;

HELP.coverage = `<p><b>The question:</b> of everything that's on, how much have we found? Nobody publishes the full list,
    so it's estimated the way ecologists count fish in a lake: catch some, mark them, catch again, and see how many
    were already marked.</p>
  <p><b>How:</b> every site that lists events is a separate catch. An upcoming event found independently on two or more
    sites was "caught again"; one only one site lists was not. (Pages an event's own page links to, like its Facebook
    event or ticket shop, don't count: they were found through it, not independently.) If most events in a group show
    up on several sites, a new site would mostly bring events we already have. If most were seen on one site only,
    there are probably many that no site we know lists. The Chao1 formula turns that into a number:
    <i>estimated total = found + (seen on one site)² / (2 × seen on two sites)</i>, and <i>coverage = found ÷ estimated total</i>.</p>
  <p><b>How far to trust it:</b> sites aren't equally likely to list an event: a club's own page lists only its own shows
    and nothing else will. So the estimated total is a lower bound and the coverage an upper bound. A low figure is a sure
    gap; a high one is likely, not certain. Groups with fewer than 8 upcoming events show "?": too few to judge. Event
    matching across sites matters too: two listings of one concert that we failed to join look like two single-site
    events and lower the figure.</p>
  <p><b>What it's used for:</b> the AI web search for new sources (every 6 hours) goes to the town and kind of event with the
    biggest gap, bigger towns first. The same search isn't repeated for a week, and each time it found no new event
    source it waits twice as long (up to 8 weeks), so a gap no search can fill stops costing AI calls. Once overall
    coverage reaches 80 %, searches run every 24 hours instead of 6.</p>
  <p><b>What it doesn't limit:</b> crawling. Fetching pages costs only time and is polite (one request per site every
    2 seconds, robots.txt obeyed), so sites keep being re-checked and explored as usual; only AI is aimed by this.</p>`;

const covPct = (x) => `${Math.round(x * 100)} %`;
// Low coverage = red, high = green; too few events to tell = plain.
const covClass = (r) => (r?.coverage === undefined ? '' : r.coverage >= 0.6 ? 'ok' : r.coverage >= 0.35 ? 'warn' : 'bad');
const covTitle = (r, what) => (!r ? `${what}: no upcoming events` : `${what}: ${r.events} upcoming events, ${r.once} on one site, `
  + `${r.twice} on two, ${r.more} on more; ${r.sites} sites` + (r.coverage === undefined ? '. Too few to estimate.'
  : `. Estimated total ${fmtInt(r.estimate)}, so about ${covPct(r.coverage)} found.`) + (r.newLastWeek ? ` ${r.newLastWeek} new this week.` : ''));
const covCell = (r, what) => `<td class="num cov ${covClass(r)}" title="${esc(covTitle(r, what))}">${!r ? '' : r.coverage === undefined
  ? `<span class="muted">? <small>${r.events}</small></span>` : `${covPct(r.coverage)} <small>${fmtInt(r.events)}</small>`}</td>`;
const SEARCH_RESULT = { yes: ['found a new source', 'ok'], no: ['nothing new', ''], pending: ['links being explored', 'info'] };

function coverageTab() {
  if (!tabData) return '<p class="muted">Loading…</p>';
  const c = tabData;
  const o = c.overall;
  const tags = c.tags.map((t) => t.tag);
  const cell = new Map(c.cells.map((x) => [`${x.town}|${x.tag}`, x]));
  const nextAt = c.lastDiscoveryAt ? Date.parse(c.lastDiscoveryAt) + c.everyHours * 3600e3 : Date.now();
  const tiles = [
    ['Coverage, all', o.coverage === undefined ? '?' : covPct(o.coverage)],
    ['Upcoming events', fmtInt(o.events)], ['Estimated total', o.estimate ? fmtInt(o.estimate) : '?'],
    ['On 2+ sites', fmtInt(o.twice + o.more)], ['Listing sites', fmtInt(o.sites)],
    ['Next search', !c.discoverOn ? 'AI off' : nextAt <= Date.now() ? 'next cycle' : `in ${until(nextAt)}`],
  ];
  return `<p class="muted" style="margin-top:0">How much of what's on we've probably found, per town and kind of event,
      and where the AI search for new sites goes next. ${info('coverage')}</p>${help('coverage')}
    <div class="tiles">${tiles.map(([k, n]) => `<div class="tile"><div class="n">${n}</div><div class="k">${k}</div></div>`).join('')}</div>
    <h3>By town and kind</h3>
    <p class="muted">Share of events found (estimated), with the number found in small print. Hover a cell for details.</p>
    <div class="scroll"><table class="grid covgrid">
      <tr><th>Town</th><th class="num">All</th>${tags.map((t) => `<th class="num">${esc(t)}</th>`).join('')}</tr>
      <tr><td><b>All towns</b></td>${covCell(o, 'All')}${c.tags.map((t) => covCell(t, t.tag)).join('')}</tr>
      ${c.towns.map((t) => `<tr><td>${t.town === '?' ? '<span class="muted">town unknown</span>' : esc(t.town)}</td>${covCell(t, t.town)}
        ${tags.map((g) => covCell(cell.get(`${t.town}|${g}`), `${g} in ${t.town}`)).join('')}</tr>`).join('')}
    </table></div>
    <h3>Next searches</h3>
    <p class="muted">The biggest gaps not searched lately, best first; each search picks among the top five.
      Every ${c.everyHours} hours${c.discoverOn ? '' : ' (the "Find new sources" AI job is off)'}.</p>
    <div class="scroll"><table class="grid">
      <tr><th>Search</th><th>Why</th><th class="num">Priority</th></tr>
      ${c.next.map((x) => `<tr><td>${esc(x.query)}</td><td>${esc(x.why)}${x.fruitless ? ` ${tag(`${x.fruitless}× nothing new before`)}` : ''}</td>
        <td class="num">${x.score.toFixed(2)}</td></tr>`).join('') || '<tr><td class="empty-row">Every search was done lately.</td></tr>'}
    </table></div>
    <h3>Searches so far</h3>
    <div class="scroll"><table class="grid">
      <tr><th>Time</th><th>Search → why</th><th class="num">Links / new</th><th>Result</th></tr>
      ${c.searches.map((d) => `<tr><td class="num">${fmtWhen(d.at)}</td>
        <td>${esc(d.query)}<div class="muted">${esc(d.why || '')}</div></td>
        <td class="num">${d.urls} / ${d.queued}</td>
        <td>${tag(...SEARCH_RESULT[d.result])}${d.found.length ? `<div class="muted">${d.found.map((u) => esc(u.replace(/^https?:\/\/(www\.)?/, ''))).join(', ')}</div>` : ''}</td></tr>`).join('')
      || '<tr><td class="empty-row">No aimed searches yet: the first runs in the next cycle that is due one.</td></tr>'}
    </table></div>`;
}

const TABS = { overview, queue: queueTab, templates: templatesTab, sources: sourcesTab, domains: domainsTab, coverage: coverageTab, ai: aiTab, settings: settingsTab };
const TAB_DATA = { queue: 'api/queue', templates: 'api/patterns', sources: 'api/sources', domains: 'api/domains', coverage: 'api/coverage', ai: 'api/ai' };

function renderTab() {
  if (!snap) return;
  $('#tab').innerHTML = TABS[tab]();
  if (tab === 'ai') drawTreemap();
  if (tab === 'ai' && selectedAi) showAiDetail(selectedAi);
}

async function refreshTabData() {
  if (!TAB_DATA[tab]) return;
  const [data] = await Promise.all([getJson(TAB_DATA[tab]), tab === 'ai' ? refreshUsage() : null]);
  tabData = data;
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
  if (e.target.closest('[data-ai-close]')) {
    selectedAi = null;
    history.replaceState(null, '', '#ai');
    return renderTab();
  }
  if (e.target.closest('[data-plan-refresh]')) {
    e.target.textContent = 'Checking…';
    return postJson('api/plan').then((s) => { apply(s); renderTab(); });
  }
  // AI usage treemap: range / grouping / measure, zooming in and back out.
  const uopt = e.target.closest('[data-usage]');
  if (uopt) {
    const { usage: key, value } = uopt.dataset;
    usageView[key] = key === 'days' ? Number(value) : value;
    if (key === 'group') usageView.path = [];
    return renderTab();
  }
  const crumb = e.target.closest('[data-tmcrumb]');
  if (crumb) {
    usageView.path = usageView.path.slice(0, Number(crumb.dataset.tmcrumb));
    return renderTab();
  }
  const block = e.target.closest('[data-tm]');
  if (block && tmZoom[block.dataset.tm]) {
    usageView.path = tmZoom[block.dataset.tm];
    hideTmTip();
    return renderTab();
  }
  const filter = e.target.closest('[data-aifilter]');
  if (filter) {
    aiFilter = filter.dataset.aifilter;
    return renderTab();
  }
  const tview = e.target.closest('[data-tview]');
  if (tview) {
    templateView = tview.dataset.tview;
    return renderTab();
  }
  const sort = e.target.closest('[data-sort]');
  if (sort) {
    domainSort = sort.dataset.sort;
    return renderTab();
  }
  const dom = e.target.closest('[data-domain]');
  if (dom) {
    openDomain = openDomain === dom.dataset.domain ? null : dom.dataset.domain;
    return renderTab();
  }
  const src = e.target.closest('[data-origin]');
  if (src) {
    openSource = openSource === src.dataset.origin ? null : src.dataset.origin;
    renderTab();
  }
  const helpBtn = e.target.closest('[data-help]');
  if (helpBtn) {
    const key = helpBtn.dataset.help;
    if (openHelp.has(key)) openHelp.delete(key); else openHelp.add(key);
    $(`[data-help-box="${key}"]`).hidden = !openHelp.has(key);
    helpBtn.setAttribute('aria-expanded', openHelp.has(key));
    return;
  }
  if (e.target.id === 'save-settings') {
    const patch = {};
    for (const key of Object.keys(snap.settings)) {
      const input = $(`#set-${key}`);
      if (input) patch[key] = Number(input.value);
    }
    postJson('api/settings', patch).then((s) => { apply(s); $('#saved').textContent = 'Saved.'; });
  }
};

// AI switches and models: saved right away.
$('#tab').addEventListener('change', (e) => {
  const t = e.target;
  let ai;
  if (t.matches('[data-ai-master]')) ai = { enabled: t.checked };
  else if (t.dataset.aiJob) ai = { jobs: { [t.dataset.aiJob]: { on: t.checked } } };
  else if (t.dataset.aiModel) ai = { jobs: { [t.dataset.aiModel]: { model: t.value } } };
  if (ai) postJson('api/settings', { ai }).then((s) => { apply(s); renderTab(); });
});

// The treemap's tooltip lives outside the tab, so the tab's refresh every few seconds doesn't drop it.
const tmTip = document.body.appendChild(Object.assign(document.createElement('div'), { className: 'tm-tip', hidden: true }));
function hideTmTip() { tmTip.hidden = true; }
$('#tab').addEventListener('pointermove', (e) => {
  const el = e.target.closest('[data-tmtip]');
  if (!el || !tmTips[el.dataset.tmtip]) return hideTmTip();
  tmTip.innerHTML = tmTips[el.dataset.tmtip];
  tmTip.hidden = false;
  const r = tmTip.getBoundingClientRect();
  tmTip.style.left = `${Math.min(e.clientX + 14, innerWidth - r.width - 8)}px`;
  tmTip.style.top = `${e.clientY + 16 + r.height > innerHeight ? e.clientY - r.height - 10 : e.clientY + 16}px`;
});
$('#tab').addEventListener('pointerleave', hideTmTip);
window.addEventListener('resize', () => { if (tab === 'ai') drawTreemap(); });

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
  const es = new EventSource(`${API_BASE}api/stream`);
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
// Coverage is computed over all events and changes slowly: loaded when its tab is opened.
setInterval(() => { if (!['overview', 'settings', 'coverage'].includes(tab)) refreshTabData(); }, 5000);
// Verification updates existing events without changing the count; refresh while crawling.
setInterval(() => { if (snap?.running) loadEvents(); }, 30000);
