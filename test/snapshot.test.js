import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSnapshot, crawledBeforeChange, diff, toCsv } from '../src/snapshot.js';

const INDEXED = { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-17T16:14:00Z' };
const CRAWLED = { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', lastCrawlTime: '2026-09-17T16:14:00Z' };
const DISCOVERED = { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' };

const snapshotOf = (entries, extra = {}) =>
  buildSnapshot({
    site: 'sc-domain:example.com',
    sitemaps: ['https://example.com/sitemap.xml'],
    pages: new Map(entries.map(([url, , lastmod]) => [url, lastmod ?? null])),
    results: new Map(entries.filter(([, r]) => r).map(([url, r]) => [url, r])),
    startedAt: '2026-09-19T20:00:00.000Z',
    finishedAt: '2026-09-19T20:49:43.171Z',
    complete: true,
    version: 'test',
    ...extra,
  });

test('flags a page crawled before its last change', () => {
  assert.equal(crawledBeforeChange('2026-09-17T16:14:00Z', '2026-09-18T15:38:00Z'), true);
  assert.equal(crawledBeforeChange('2026-09-19T08:00:00Z', '2026-09-18'), false);
  assert.equal(crawledBeforeChange(undefined, '2026-09-18'), null);
  assert.equal(crawledBeforeChange('2026-09-17T16:14:00Z', null), null);
});

test('counts states and keeps sitemap dates', () => {
  const snap = snapshotOf([
    ['https://example.com/a', INDEXED, '2026-09-18T15:38:00Z'],
    ['https://example.com/b', CRAWLED],
    ['https://example.com/c', { error: '400 Invalid URL' }],
  ]);
  assert.deepEqual(snap.counts, { 'Submitted and indexed': 1, 'Crawled - currently not indexed': 1, Error: 1 });
  assert.equal(snap.urls['https://example.com/a'].crawledBeforeChange, true);
  assert.equal(snap.urls['https://example.com/c'].crawledBeforeChange, null);
  assert.equal(snap.inspected, 3);
});

test('a limited run records only what it inspected', () => {
  const snap = snapshotOf([
    ['https://example.com/a', INDEXED],
    ['https://example.com/b', null],
  ]);
  assert.equal(snap.total, 2);
  assert.equal(snap.inspected, 1);
});

test('diff reports transitions, new indexing and drops', () => {
  const older = snapshotOf([
    ['https://example.com/a', CRAWLED],
    ['https://example.com/b', INDEXED],
    ['https://example.com/c', DISCOVERED],
    ['https://example.com/gone', INDEXED],
  ]);
  const newer = snapshotOf([
    ['https://example.com/a', INDEXED],
    ['https://example.com/b', CRAWLED],
    ['https://example.com/c', DISCOVERED],
    ['https://example.com/new', DISCOVERED],
  ]);
  const d = diff(older, newer);
  assert.deepEqual(d.newlyIndexed, ['https://example.com/a']);
  assert.deepEqual(d.dropped, ['https://example.com/b']);
  assert.deepEqual(d.notInOlder, ['https://example.com/new']);
  assert.deepEqual(d.leftSitemap, ['https://example.com/gone']);
  assert.equal(d.transitions.length, 2);
  assert.equal(d.since, '2026-09-19T20:49:43.171Z');
});

test('a partial newer run never claims URLs left the sitemap', () => {
  const older = snapshotOf([['https://example.com/a', INDEXED], ['https://example.com/b', INDEXED]]);
  const newer = snapshotOf([['https://example.com/a', INDEXED], ['https://example.com/b', null]]);
  assert.deepEqual(diff(older, newer).leftSitemap, []);
});

test('CSV quotes values that need it', () => {
  const snap = snapshotOf([['https://example.com/a,b', { error: 'He said "no"' }]]);
  const [header, row] = toCsv(snap).trim().split('\n');
  assert.ok(header.startsWith('url,verdict,coverageState'));
  assert.ok(row.startsWith('"https://example.com/a,b",'));
  assert.ok(row.endsWith('"He said ""no"""'));
});
