import { test } from 'node:test';
import assert from 'node:assert/strict';
import { dropSiteRows } from '../src/events.js';
import { unknownIsAbroad } from '../src/learn.js';

const row = (site, extra = {}) => ({ kind: 'web', site, via: `https://${site}/program`, url: `https://${site}/e/1`, title: 'Koncert', start: '2026-12-01', ...extra });

test('dropSiteRows: an event only that site listed goes; one another site also lists stays, from that site', () => {
  const state = {
    tagRules: undefined,
    events: {
      a: { id: 'a', sources: [row('luthiers-coop.com')] },
      b: { id: 'b', sources: [row('hockey-live.sk', { title: 'Slovan – Košice' }), row('hockeyslovakia.sk', { title: 'HC Slovan – HC Košice', location: 'Bratislava' })] },
      c: { id: 'c', sources: [row('kulthund.sk'), { linked: true, kind: 'web', site: 'x.sk', url: 'https://x.sk/1', via: 'https://kulthund.sk/e/1' }] },
    },
  };
  assert.equal(dropSiteRows(state, 'www.luthiers-coop.com'), 1);
  assert.equal(state.events.a, undefined);
  assert.equal(dropSiteRows(state, 'www.hockey-live.sk'), 0);
  assert.equal(state.events.b.sources.length, 1);
  assert.equal(state.events.b.title, 'HC Slovan – HC Košice');
  assert.equal(state.events.b.location, 'Bratislava');
  assert.equal(state.events.c.sources.length, 2, 'other sites untouched');
});

test('unknownIsAbroad: a site judged to list several countries keeps only events known to be in Slovakia', () => {
  const state = { sources: { 'https://www.hockey-live.sk': { siteVerdict: { where: 'mixed' } } } };
  assert.equal(unknownIsAbroad(state, 'https://www.hockey-live.sk/zapasy'), true);
});

import { slovakWords } from '../src/slovakia.js';
test('slovakWords: ä or ô alone is not Slovak (Estonian, German), with a Slovak letter it is', () => {
  assert.equal(slovakWords('Tallinna vanalinna käigu algus'), false);
  assert.equal(slovakWords('Café Rôtisserie'), false);
  assert.equal(slovakWords('Pivnica U Mäsiara, Hlavná ulica'), true);
  assert.equal(slovakWords('Kultúrny dom, pätnásť'), true);
  assert.equal(slovakWords('Koncertná sieň Ľudovíta'), true);
});
