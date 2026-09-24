import assert from 'node:assert/strict';
import test from 'node:test';
import { inspectAll, inspectUrl, pick } from '../src/inspect.js';

const token = async () => 'test-token';
const sleep = async () => {};
const OK = {
  inspectionResult: {
    indexStatusResult: {
      verdict: 'PASS',
      coverageState: 'Submitted and indexed',
      lastCrawlTime: '2026-09-19T08:00:00Z',
      referringUrls: ['https://example.com/'],
    },
  },
};

const sequence = (...responses) => {
  let i = 0;
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(JSON.parse(init.body));
    const next = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (next instanceof Error) throw next;
    return next();
  };
  return { fetchImpl, calls };
};

const reply = (status, body) => () => Response.json(body, { status });

test('keeps only the recorded fields', () => {
  assert.deepEqual(pick(OK.inspectionResult.indexStatusResult), {
    verdict: 'PASS',
    coverageState: 'Submitted and indexed',
    lastCrawlTime: '2026-09-19T08:00:00Z',
  });
});

test('sends the URL and the property, and retries after a rate limit', async () => {
  const { fetchImpl, calls } = sequence(reply(429, { error: { message: 'Slow down' } }), reply(200, OK));
  const result = await inspectUrl('https://example.com/a', { site: 'sc-domain:example.com', token, fetchImpl, sleep });
  assert.equal(result.verdict, 'PASS');
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], { inspectionUrl: 'https://example.com/a', siteUrl: 'sc-domain:example.com', languageCode: 'en-US' });
});

test('retries a network failure, then records it', async () => {
  const { fetchImpl } = sequence(new Error('socket hang up'));
  const result = await inspectUrl('https://example.com/a', { site: 's', token, fetchImpl, sleep, retries: 2 });
  assert.match(result.error, /network: socket hang up/);
});

test('records a bad URL without stopping the run', async () => {
  const { fetchImpl } = sequence(reply(400, { error: { message: 'Invalid URL' } }));
  const result = await inspectUrl('https://example.com/a', { site: 's', token, fetchImpl, sleep });
  assert.equal(result.error, '400 Invalid URL');
});

test('stops at once when the credentials cannot read the property', async () => {
  const { fetchImpl, calls } = sequence(reply(403, { error: { message: 'You do not own this site' } }));
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
  const { results, fatal } = await inspectAll(urls, { site: 's', token, fetchImpl, sleep, concurrency: 1 });
  assert.equal(fatal.status, 403);
  assert.equal(results.size, 0);
  assert.equal(calls.length, 1);
});

test('a 403 after successes concerns that URL only', async () => {
  const { fetchImpl } = sequence(reply(200, OK), reply(403, { error: { message: 'Not part of this property' } }), reply(200, OK));
  const urls = ['https://example.com/a', 'https://other.example/b', 'https://example.com/c'];
  const { results, fatal } = await inspectAll(urls, { site: 's', token, fetchImpl, sleep, concurrency: 1 });
  assert.equal(fatal, null);
  assert.match(results.get('https://other.example/b').error, /^403/);
  assert.equal(results.get('https://example.com/c').verdict, 'PASS');
});

test('keeps finished results when the quota runs out', async () => {
  const { fetchImpl } = sequence(reply(200, OK), reply(429, { error: { message: 'Quota exceeded' } }));
  const urls = ['https://example.com/a', 'https://example.com/b', 'https://example.com/c'];
  const { results, fatal } = await inspectAll(urls, { site: 's', token, fetchImpl, sleep, concurrency: 1, retries: 1 });
  assert.equal(fatal.status, 429);
  assert.equal(results.size, 1);
});
