import test from 'node:test';
import assert from 'node:assert/strict';
import { parseDateText, finishDate, tooFarAhead, dateShape, applyRule, withoutPlace, placeholderEnd, sameDate } from '../src/dates.js';

// Local-time "now" (makeDate compares against local midnight), mid-November 2026.
const NOW = new Date(2026, 10, 15, 12, 0);
const p = (text, now = NOW) => parseDateText(text, now);
// Drop undefined keys so deepEqual compares only what was read.
const tidy = (r) => (r ? Object.fromEntries(Object.entries(r).filter(([, v]) => v !== undefined)) : r);
const read = (text, now) => tidy(p(text, now));

test('date without a year: nearest upcoming occurrence', () => {
  assert.deepEqual(read('20. 12.'), { start: '2026-12-20' });
  assert.deepEqual(read('3. 1.'), { start: '2027-01-03' }); // January next year
  assert.deepEqual(read('3. októbra', new Date(2026, 0, 10)), { start: '2026-10-03' });
});

test('date without a year: up to ~100 days back stays in the current year', () => {
  // "19. 8." read in mid-November is last August's (88 days back), not next year's.
  assert.deepEqual(read('19. 8.'), { start: '2026-08-19' });
  assert.deepEqual(read('3. októbra'), { start: '2026-10-03' });
  // More than 100 days back: next year.
  assert.deepEqual(read('1. 8.'), { start: '2027-08-01' });
  assert.deepEqual(read('10. 7.'), { start: '2027-07-10' });
});

test('numeric Slovak dates', () => {
  assert.deepEqual(read('3.10.2026'), { start: '2026-10-03' });
  assert.deepEqual(read('03. 10. 2026'), { start: '2026-10-03' });
  assert.deepEqual(read('sobota 21.11.2026 o 19.30'), { start: '2026-11-21', time: '19:30' });
  assert.deepEqual(read('5.12.2026 18:00'), { start: '2026-12-05', time: '18:00' });
});

test('month names: Slovak, Czech, English', () => {
  assert.deepEqual(read('3. októbra 2026'), { start: '2026-10-03' });
  assert.deepEqual(read('27. října 2026'), { start: '2026-10-27' });
  assert.deepEqual(read('October 7, 2026'), { start: '2026-10-07' });
  assert.deepEqual(read('október 7 2026'), { start: '2026-10-07' });
  assert.deepEqual(read('27 říjen Út | 19.00'), { start: '2026-10-27', time: '19:00' });
});

test('ISO dates', () => {
  assert.deepEqual(read('2026-10-07'), { start: '2026-10-07' });
  assert.deepEqual(read('2026-10-07T18:00'), { start: '2026-10-07', time: '18:00' });
  assert.deepEqual(read('2026-10-07T18:00 2026-10-09T20:00'), { start: '2026-10-07', end: '2026-10-09', time: '18:00', endTime: '20:00' });
});

test('numeric ranges', () => {
  assert.deepEqual(read('02.10.2026 10:00 - 03.10.2026 18:00'),
    { start: '2026-10-02', end: '2026-10-03', time: '10:00', endTime: '18:00' });
  assert.deepEqual(read('09.10 - 11.10.2026'), { start: '2026-10-09', end: '2026-10-11' });
  assert.deepEqual(read('9. - 11. 10. 2026'), { start: '2026-10-09', end: '2026-10-11' });
  assert.deepEqual(read('od 1.9.2026 08:00 do 31.10.2026 18:00'),
    { start: '2026-09-01', end: '2026-10-31', time: '08:00', endTime: '18:00' });
  assert.deepEqual(read('pi 2. 10. 18:00 – ne 4. 10. 20:00'),
    { start: '2026-10-02', end: '2026-10-04', time: '18:00', endTime: '20:00' });
});

test('month-name ranges', () => {
  assert.deepEqual(read('9. – 11. októbra 2026'), { start: '2026-10-09', end: '2026-10-11' });
  assert.deepEqual(read('20. júla – 24. augusta 2026'), { start: '2026-07-20', end: '2026-08-24' });
  assert.deepEqual(read('28. nov - 1. dec 2026'), { start: '2026-11-28', end: '2026-12-01' });
  // No year, end before start: the end is next year.
  assert.deepEqual(read('5. dec – 9. jan'), { start: '2026-12-05', end: '2027-01-09' });
});

test('times', () => {
  assert.deepEqual(read('10.00 – 18.00 hod. 5.12.2026'), { start: '2026-12-05', time: '10:00', endTime: '18:00' });
  assert.deepEqual(read('5.12.2026 17:00 - 23:59'), { start: '2026-12-05', time: '17:00' });
  // "Fri 22:00 – Sat 04:00" is one night out.
  assert.deepEqual(read('20.11.2026 22:00 - 21.11.2026 04:00'), { start: '2026-11-20', time: '22:00', endTime: '04:00' });
  // Placeholder midnight times: 1–4 October, no time.
  assert.deepEqual(read('01.10. 00:00 – 05.10. 00:00'), { start: '2026-10-01', end: '2026-10-04' });
});

test('a place after the date is not read as a date', () => {
  assert.deepEqual(read('23.10.2026 20:00 - Kesta Bistro, Ul. 29. augusta 645, Martin'), { start: '2026-10-23', time: '20:00' });
  assert.equal(withoutPlace('23.10.2026 20:00 - kesta bistro'), '23.10.2026 20:00');
});

test('placeholder end years ahead is dropped', () => {
  const r = p('2.1.2026 – 31.12.9999');
  assert.equal(r.start, '2026-01-02');
  assert.equal(r.end, undefined);
  assert.equal(placeholderEnd('2026-01-02', '9999-12-31'), true);
  assert.equal(placeholderEnd('2026-01-02', '2026-03-01'), false);
});

test('relative dates are read against now', () => {
  assert.deepEqual(read('dnes 19:00'), { start: '2026-11-15', time: '19:00' });
  assert.deepEqual(read('zajtra'), { start: '2026-11-16' });
  assert.deepEqual(read('pred 2 dňami'), { start: '2026-11-13' });
  assert.deepEqual(read('v piatok 19:00'), { start: '2026-11-20', time: '19:00' }); // NOW is a Sunday
  assert.deepEqual(read('za týždeň'), { start: '2026-11-22' });
});

test('no date / invalid dates', () => {
  assert.equal(p('hello'), null);
  assert.equal(p(''), null);
  assert.equal(p('31.11.2026'), null);
  assert.equal(p('2026-11-92'), null);
});

test('finishDate: 00:00 and 23:59 start times mean no time', () => {
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', time: '00:00' })), { start: '2026-10-01' });
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', time: '23:59' })), { start: '2026-10-01' });
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', time: '19:00' })), { start: '2026-10-01', time: '19:00' });
});

test('finishDate: endTime 23:59 is dropped', () => {
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', time: '17:00', endTime: '23:59' })), { start: '2026-10-01', time: '17:00' });
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', end: '2026-10-03', time: '17:00', endTime: '23:59' })),
    { start: '2026-10-01', end: '2026-10-03', time: '17:00' });
});

test('finishDate: endTime 00:00 moves the end to the day before', () => {
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', end: '2026-10-05', endTime: '00:00' })), { start: '2026-10-01', end: '2026-10-04' });
  // Across a month boundary.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-30', end: '2026-11-01', endTime: '00:00' })), { start: '2026-10-30', end: '2026-10-31' });
  // End the day after the start, at 00:00: a single day.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', end: '2026-10-02', endTime: '00:00' })), { start: '2026-10-01' });
});

test('finishDate: end before start is dropped (with its time)', () => {
  assert.deepEqual(tidy(finishDate({ start: '2026-10-05', end: '2026-10-01', time: '18:00', endTime: '20:00' })),
    { start: '2026-10-05', time: '18:00' });
});

test('finishDate: other normalisation', () => {
  // End equal to start: no end.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', end: '2026-10-01', time: '18:00', endTime: '20:00' })),
    { start: '2026-10-01', time: '18:00', endTime: '20:00' });
  // Same time twice is a start time.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', time: '08:00', endTime: '08:00' })), { start: '2026-10-01', time: '08:00' });
  // No start time: no end time.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', endTime: '20:00' })), { start: '2026-10-01' });
  // Overnight: next morning's end is not a second day.
  assert.deepEqual(tidy(finishDate({ start: '2026-10-02', end: '2026-10-03', time: '22:00', endTime: '04:00' })),
    { start: '2026-10-02', time: '22:00', endTime: '04:00' });
});

test('tooFarAhead: more than ~400 days ahead', () => {
  const now = new Date('2026-11-15T12:00:00Z');
  assert.equal(tooFarAhead('2026-12-01', now), false);
  assert.equal(tooFarAhead('2027-11-15', now), false); // a year ahead is fine
  assert.equal(tooFarAhead('2028-01-01', now), true);
  assert.equal(tooFarAhead('2058-11-13', now), true);
  assert.equal(tooFarAhead('2020-01-01', now), false); // the past is not "too far ahead"
});

test('dateShape', () => {
  assert.equal(dateShape('02.10.2026 10:00 - 03.10.2026 18:00'), 'N.N.Y N:N - N.N.Y N:N');
  assert.equal(dateShape('3. októbra 2026'), 'N. M Y');
});

test('applyRule: an AI-written rule', () => {
  const rule = { pattern: '(\\d+)/(\\d+)/(\\d{4}) (\\d+)h', groups: { startDay: 1, startMonth: 2, startYear: 3, startHour: 4 } };
  assert.deepEqual(tidy(applyRule(rule, '7/10/2026 18h', NOW)), { start: '2026-10-07', time: '18:00' });
  assert.equal(applyRule(rule, 'nothing', NOW), null);
  assert.equal(applyRule({ pattern: '(' }, '7/10/2026', NOW), null); // invalid regex
  const named = { pattern: '(\\d+)\\. (\\w+) (\\d{4})', groups: { startDay: 1, startMonth: 2, startYear: 3 } };
  assert.deepEqual(tidy(applyRule(named, '3. oktobra 2026', NOW)), { start: '2026-10-03' });
});

test('sameDate ignores missing fields', () => {
  assert.equal(sameDate({ start: '2026-10-01', time: undefined }, { start: '2026-10-01' }), true);
  assert.equal(sameDate({ start: '2026-10-01', time: '18:00' }, { start: '2026-10-01' }), false);
  assert.equal(sameDate(null, { start: '2026-10-01' }), false);
});

test('a year after a comma counts', () => {
  assert.deepEqual(read('20 decembra, 2021'), { start: '2021-12-20' });
  assert.deepEqual(read('3 October – 3 December, 2017'), { start: '2017-10-03', end: '2017-12-03' });
  assert.deepEqual(read('30 január, 2026'), { start: '2026-01-30' });
  assert.equal(p('12 June, 2020; 13 June, 2020').start, '2020-06-12');
  // still: no year, a year without a comma, a time after a comma
  assert.deepEqual(read('20. decembra'), { start: '2026-12-20' });
  assert.deepEqual(read('20. decembra 2026, 19:00'), { start: '2026-12-20', time: '19:00' });
  assert.deepEqual(read('5. októbra, 18:00'), { start: '2026-10-05', time: '18:00' });
  assert.deepEqual(read('5. októbra – 9. decembra, 19:30'), { start: '2026-10-05', end: '2026-12-09', time: '19:30' });
});

test('a two-digit year after a d.m. range', () => {
  assert.deepEqual(read('1. 10. – 28. 11. 25'), { start: '2025-10-01', end: '2025-11-28' });
  assert.deepEqual(read('1.10. - 28.11.2025'), { start: '2025-10-01', end: '2025-11-28' });
  // only the end has a year, across New Year (gjk.sk)
  assert.deepEqual(read('05.10 - 31.01.27'), { start: '2026-10-05', end: '2027-01-31' });
  assert.deepEqual(read('03.07 - 31.12.26'), { start: '2026-07-03', end: '2026-12-31' });
  assert.deepEqual(read('5. dec – 9. jan 2027'), { start: '2026-12-05', end: '2027-01-09' });
  // a dotted time is not a year
  assert.deepEqual(read('1. 10. – 28. 11. 20.00 h'), { start: '2026-10-01', end: '2026-11-28', time: '20:00' });
  assert.deepEqual(read('01.10. 00:00 – 05.10. 00:00'), { start: '2026-10-01', end: '2026-10-04' });
});

test('a weekday glued after the month (ticketportal)', () => {
  assert.deepEqual(read('nedeľa 29. novembrane29 18:00'), { start: '2026-11-29', time: '18:00' });
  assert.deepEqual(read('sobota 10. aprílaso10 19:00'), { start: '2027-04-10', time: '19:00' });
  assert.deepEqual(read('sobota 12. decembraso12 18:30'), { start: '2026-12-12', time: '18:30' });
  assert.deepEqual(read('utorok 8. decembraut8'), { start: '2026-12-08' });
});

test('a weekday is not "next such day" when the text has a date', () => {
  assert.equal(p('piatok 31. 11. 19:00'), null); // 31 November: no such day, not next Friday
  assert.equal(p('sobota 30. februára 19:00'), null);
  // without a date it still is
  assert.deepEqual(read('v piatok 19:00'), { start: '2026-11-20', time: '19:00' });
  assert.deepEqual(read('v piatok o 19.30'), { start: '2026-11-20', time: '19:30' });
});

test('date without a year: the year that fits the weekday', () => {
  // 30.5.2026 is a Saturday (30.5.2027 a Sunday): last May, though more than 100 days back
  assert.deepEqual(read('so 30. 5.'), { start: '2026-05-30' });
  assert.deepEqual(read('6.1. UT'), { start: '2026-01-06' }); // 6.1.2027 is a Wednesday
  assert.deepEqual(read('sobota 10. apríla 19:00'), { start: '2027-04-10', time: '19:00' }); // the guess fits
  assert.deepEqual(read('27 říjen Út | 19.00'), { start: '2026-10-27', time: '19:00' });
  // Fits neither the guessed year nor the one before: the guess stays, flagged.
  assert.deepEqual(read('Streda, 15. november'), { start: '2026-11-15', weekdayMismatch: true });
  // "so" after a date as a word ("with"), not a weekday
  assert.deepEqual(read('1. 8. so skupinou'), { start: '2027-08-01' });
  // a year given: left alone
  assert.deepEqual(read('so 30. 5. 2027'), { start: '2027-05-30' });
  // a range moves with its start
  assert.deepEqual(read('so 30. 5. - ne 31. 5.'), { start: '2026-05-30', end: '2026-05-31' });
});

test('am/pm times', () => {
  assert.deepEqual(read('Wednesday 29. 7. 2026 at 5:00 PM'), { start: '2026-07-29', time: '17:00' });
  assert.deepEqual(read('3.12.2026 5 PM'), { start: '2026-12-03', time: '17:00' });
  assert.deepEqual(read('3.12.2026 7:30 p.m.'), { start: '2026-12-03', time: '19:30' });
  assert.deepEqual(read('3.12.2026 10 am'), { start: '2026-12-03', time: '10:00' });
  assert.deepEqual(read('3.12.2026 12 PM'), { start: '2026-12-03', time: '12:00' });
  assert.deepEqual(read('3.12.2026 12 AM'), { start: '2026-12-03' }); // 00:00: no time
  assert.deepEqual(read('3.12.2026 5:00 PM - 8:00 PM'), { start: '2026-12-03', time: '17:00', endTime: '20:00' });
  assert.deepEqual(read('3.12.2026 o 5 a mám'), { start: '2026-12-03' }); // Slovak "a" (and) is no a.m.
});

test('finishDate: impossible and placeholder times', () => {
  assert.deepEqual(read('19.11.2026 · 16:00 - 14:00'), { start: '2026-11-19', time: '16:00' });
  assert.deepEqual(tidy(finishDate({ start: '2026-10-01', end: '2026-10-03', time: '18:00', endTime: '18:00' })),
    { start: '2026-10-01', end: '2026-10-03', time: '18:00' });
  assert.deepEqual(read('19.11.2026 00:01'), { start: '2026-11-19' });
  assert.deepEqual(read('19.11.2026 00:30 - 23:30'), { start: '2026-11-19' });
  assert.deepEqual(read('19.11.2026 01:00 - 23:00'), { start: '2026-11-19' });
  // still: a night out, a normal evening, a late start
  assert.deepEqual(read('19.11.2026 22:00 - 05:00'), { start: '2026-11-19', time: '22:00', endTime: '05:00' });
  assert.deepEqual(read('19.11.2026 18:00 - 22:00'), { start: '2026-11-19', time: '18:00', endTime: '22:00' });
  assert.deepEqual(read('19.11.2026 02:00 - 23:30'), { start: '2026-11-19', time: '02:00', endTime: '23:30' });
});

test('ISO times with a zone are Bratislava local time', () => {
  assert.deepEqual(read('2026-11-20T22:00:00Z'), { start: '2026-11-20', time: '23:00' }); // CET
  assert.deepEqual(read('2026-07-20T17:00:00Z'), { start: '2026-07-20', time: '19:00' }); // CEST
  assert.deepEqual(read('2026-11-20T23:30:00Z'), { start: '2026-11-21', time: '00:30' }); // the next day
  assert.deepEqual(read('2026-11-20T19:00:00+01:00'), { start: '2026-11-20', time: '19:00' });
  // A Central European offset keeps the written time, even when wrong for summer (+01:00 all year round)
  assert.deepEqual(read('2026-10-07T19:00:00+01:00'), { start: '2026-10-07', time: '19:00' });
  assert.deepEqual(read('2026-10-07T19:00:00+02:00'), { start: '2026-10-07', time: '19:00' });
  assert.deepEqual(read('2026-11-20T19:00:00+00:00'), { start: '2026-11-20', time: '20:00' });
  assert.deepEqual(read('2026-11-20T13:00:00-05:00'), { start: '2026-11-20', time: '19:00' });
  assert.deepEqual(read('2026-11-20T18:00:00.000Z 2026-11-20T21:00:00.000Z'), { start: '2026-11-20', time: '19:00', endTime: '22:00' });
  // no zone: as written; "T10:00-12:00" is a time range, not a zone
  assert.deepEqual(read('2026-11-20T19:00'), { start: '2026-11-20', time: '19:00' });
  assert.deepEqual(read('2026-11-20T10:00-12:00'), { start: '2026-11-20', time: '10:00' });
});
