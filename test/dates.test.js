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
