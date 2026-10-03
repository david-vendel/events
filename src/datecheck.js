// The "Check dates" step of a cycle: date formats the parser hasn't confirmed (or that are due for
// a re-check) and schedules written as prose go to AI in small batches. What AI says about a format
// decides how it is parsed from now on (see dates.js); stored events in a format that changed are
// read again right away.
import { readDates } from './ai.js';
import { dateShape, formatsDue, learnFormat, parseDateText, readDateText } from './dates.js';

const FORMATS_PER_CALL = 12;
const SAMPLES_PER_FORMAT = 3;
const PROSE_PER_CALL = 4;
const CALLS_PER_CYCLE = 2;

const iso = () => new Date().toISOString();
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const okDay = (d) => (DAY_RE.test(d || '') ? d : undefined);
const okTime = (t) => (TIME_RE.test(t || '') ? t : undefined);
const answerOf = (a) => (okDay(a?.start)
  ? { start: a.start, end: okDay(a.end), time: okTime(a.time), endTime: okTime(a.endTime) } : null);

/** Events whose detail page has a schedule in prose that AI hasn't read yet. */
const proseDue = (state, today) => Object.values(state.events)
  .filter((e) => (e.end || e.start) >= today && e.prose && e.prose.hash !== e.prose.readHash);

export async function checkDates(state, ctx, report) {
  const { today, index } = ctx;
  let calls = 0;
  while (calls < CALLS_PER_CYCLE && ctx.budget.ai > 0 && !ctx.control.stopped()) {
    const formats = formatsDue(FORMATS_PER_CALL);
    const prose = proseDue(state, today).slice(0, PROSE_PER_CALL);
    if (!formats.length && !prose.length) break;
    if (!calls) report.phase('Checking dates', `${formats.length} formats, ${prose.length} schedules`);
    calls++;
    ctx.budget.ai--;
    ctx.used.ai++;
    const sent = formats.map((f) => ({ f, samples: f.samples.slice(0, SAMPLES_PER_FORMAT) }));
    const job = report.start('dates', `${formats.length} formats, ${prose.length} schedules`, 'cheap AI');
    const res = await readDates({
      // With the built-in parser's reading: AI writes a rule only where that is wrong.
      formats: sent.map((x) => ({ samples: x.samples, parsed: x.samples.map((t) => parseDateText(t)) })),
      prose: prose.map((e) => ({ title: e.title, text: e.prose.text })),
      today,
    }, { onStart: () => report.update?.(job, { note: 'AI is reading dates…', ai: 'running' }) });

    const lines = [];
    let changed = 0, reread = 0;
    sent.forEach(({ f, samples }, i) => {
      const a = res.formats[i];
      if (!a) return; // no answer: asked again next cycle
      const answers = {};
      for (const x of a.samples) if (samples[x.s] !== undefined) answers[samples[x.s]] = answerOf(x);
      if (!Object.keys(answers).length) return;
      const { changed: c, said } = learnFormat(f, answers, a.rule);
      lines.push(`${samples[0]} → ${said}`);
      if (c) {
        changed++;
        reread += rereadFormat(state, index, f.shape, today);
      }
    });
    prose.forEach((ev, i) => {
      const a = res.prose[i];
      if (!a) return;
      ev.prose.readHash = ev.prose.hash;
      ev.prose.readAt = iso();
      const schedule = (a.schedule || []).filter((d) => okDay(d.date))
        .map((d) => ({ date: d.date, time: okTime(d.time), endTime: okTime(d.endTime) }));
      const read = answerOf(a);
      if (read) ev.prose.read = read;
      if (schedule.length) ev.schedule = schedule; else delete ev.schedule;
      index.refresh(ev);
      lines.push(`${ev.title} → ${schedule.length ? schedule.map((d) => `${d.date} ${[d.time, d.endTime].filter(Boolean).join('–')}`).join(', ') : 'no per-day hours'}`);
    });
    if (res.call) res.call.outcome = lines.join('\n') || 'no usable answer';
    report.end(job, {
      status: res.call?.error ? 'error' : 'ok',
      note: res.call?.error || `${changed} formats changed, ${reread} events re-read, ${prose.length} schedules`,
      ai: res.call && { id: res.call.id, tokens: res.call.usage.input + res.call.usage.cacheRead + res.call.usage.cacheWrite + res.call.usage.output, ms: res.call.ms, error: res.call.error },
    });
  }
}

/** Read again the stored dates of upcoming events in one format, now that it's read differently. */
function rereadFormat(state, index, shape, today) {
  let n = 0;
  for (const ev of Object.values(state.events)) {
    if ((ev.end || ev.start) < today) continue;
    for (const row of ev.sources || []) {
      if (!row.dateText || dateShape(row.dateText) !== shape) continue;
      const r = readDateText(row.dateText, new Date(), { note: false });
      if (!r) continue;
      Object.assign(row, { start: r.start, end: r.end, time: r.time, endTime: r.endTime });
      n++;
    }
    index.refresh(ev);
  }
  return n;
}
