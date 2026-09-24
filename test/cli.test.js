import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { HELP, run } from '../src/cli.js';

const sink = () => {
  const out = { text: '', isTTY: false, write: (s) => { out.text += s; return true; } };
  return out;
};

const SITEMAP = `<urlset>
  <url><loc>https://example.com/</loc><lastmod>2026-09-18T15:38:00Z</lastmod></url>
  <url><loc>https://example.com/pricing</loc></url>
</urlset>`;

/** A fake Google: token endpoint, sitemap, and an inspection answer per URL that can change between runs. */
function fakeGoogle(states) {
  return async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') return Response.json({ access_token: 'test', expires_in: 3600 });
    if (url === 'https://example.com/sitemap.xml') return new Response(SITEMAP);
    const { inspectionUrl } = JSON.parse(init.body);
    return Response.json({ inspectionResult: { indexStatusResult: states[inspectionUrl] } });
  };
}

const workspace = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'census-cli-'));
  const credentials = path.join(dir, 'user.json');
  fs.writeFileSync(credentials, JSON.stringify({ client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' }));
  return { dir, credentials, out: path.join(dir, 'census') };
};

test('prints help', async () => {
  const stdout = sink();
  assert.equal(await run(['--help'], { stdout }), 0);
  assert.equal(stdout.text, HELP);
});

test('rejects a run without a site or sitemap', async () => {
  const stderr = sink();
  assert.equal(await run(['--site', 'sc-domain:example.com'], { stderr }), 2);
  assert.match(stderr.text, /--site and --sitemap are required/);
});

test('rejects nonsense numbers', async () => {
  const stderr = sink();
  const args = ['--site', 's', '--sitemap', 'x.xml', '--limit', 'ten'];
  assert.equal(await run(args, { stderr }), 2);
});

test('saves a snapshot, then reports what changed on the next run', async () => {
  const { credentials, out } = workspace();
  const args = ['--site', 'sc-domain:example.com', '--sitemap', 'https://example.com/sitemap.xml', '--credentials', credentials, '--out', out, '--csv'];

  const first = sink();
  const firstCode = await run(args, {
    stdout: first,
    stderr: sink(),
    fetchImpl: fakeGoogle({
      'https://example.com/': { verdict: 'NEUTRAL', coverageState: 'Crawled - currently not indexed', lastCrawlTime: '2026-09-17T16:14:00Z' },
      'https://example.com/pricing': { verdict: 'NEUTRAL', coverageState: 'URL is unknown to Google' },
    }),
  });
  assert.equal(firstCode, 0);
  assert.match(first.text, /2 of 2 URLs inspected/);
  assert.match(first.text, /Changed since Google last crawled them: 1/);
  assert.match(first.text, /First snapshot for this property/);

  // Snapshot file names have one-second resolution; wait so the second run gets its own file.
  await new Promise((resolve) => setTimeout(resolve, 1100));

  const second = sink();
  await run(args, {
    stdout: second,
    stderr: sink(),
    fetchImpl: fakeGoogle({
      'https://example.com/': { verdict: 'PASS', coverageState: 'Submitted and indexed', lastCrawlTime: '2026-09-17T16:14:00Z' },
      'https://example.com/pricing': { verdict: 'NEUTRAL', coverageState: 'Discovered - currently not indexed' },
    }),
  });
  assert.match(second.text, /Crawled - currently not indexed -> Submitted and indexed: 1/);
  assert.match(second.text, /Newly indexed: 1 {3}Dropped from the index: 0/);

  const files = fs.readdirSync(path.join(out, 'example.com'));
  assert.equal(files.filter((f) => f.endsWith('.json')).length, 2);
  assert.equal(files.filter((f) => f.endsWith('.csv')).length, 2);
});

test('compares two saved snapshots offline', async () => {
  const { dir } = workspace();
  const snap = (state, verdict) => ({
    site: 'sc-domain:example.com', finishedAt: '2026-09-19T20:49:43Z', total: 1, inspected: 1, complete: true,
    counts: { [state]: 1 }, urls: { 'https://example.com/': { verdict, coverageState: state } },
  });
  const older = path.join(dir, 'a.json');
  const newer = path.join(dir, 'b.json');
  fs.writeFileSync(older, JSON.stringify(snap('Crawled - currently not indexed', 'NEUTRAL')));
  fs.writeFileSync(newer, JSON.stringify(snap('Submitted and indexed', 'PASS')));
  const stdout = sink();
  assert.equal(await run(['--compare', older, newer], { stdout }), 0);
  assert.match(stdout.text, /Newly indexed: 1/);
});
