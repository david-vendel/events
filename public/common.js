// Small helpers shared by events.js and admin.js.
const $ = (s, root = document) => root.querySelector(s);
const fold = (s) => (s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const host = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
const getJson = (url) => fetch(url).then((r) => r.json());
const postJson = (url, body) => fetch(url, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}),
}).then((r) => r.json());

const clock = new Intl.DateTimeFormat('sk-SK', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const dayClock = new Intl.DateTimeFormat('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const fmtTime = (t) => (t ? clock.format(new Date(t)) : '');
const fmtWhen = (t) => (t ? dayClock.format(new Date(t)) : '—');
const fmtTokens = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n || 0));
const fmtInt = (n) => (n || 0).toLocaleString('sk-SK');
function ago(t) {
  const s = Math.round((Date.now() - new Date(t)) / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  if (s < 86400) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}
function until(t) {
  const s = Math.max(0, Math.round((new Date(t) - Date.now()) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m ${s % 60}s` : `${Math.round(s / 3600)} h`;
}
