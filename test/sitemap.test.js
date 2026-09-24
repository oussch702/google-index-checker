import assert from 'node:assert/strict';
import test from 'node:test';
import zlib from 'node:zlib';
import { collectUrls, parseSitemap } from '../src/sitemap.js';

const URLSET = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">
  <url><loc>https://example.com/</loc><lastmod>2026-09-18</lastmod></url>
  <url>
    <image:image><image:loc>https://example.com/photo.png</image:loc></image:image>
    <loc>https://example.com/search?q=a&amp;page=2</loc>
  </url>
  <url><loc><![CDATA[https://example.com/b]]></loc><lastmod>2026-09-19T10:00:00+00:00</lastmod></url>
</urlset>`;

const fetchFrom = (routes) => async (url) => (url in routes ? new Response(routes[url]) : new Response('missing', { status: 404 }));

test('parses page URLs, lastmod, entities and CDATA', () => {
  const { urls, sitemaps } = parseSitemap(URLSET);
  assert.deepEqual(urls, [
    { loc: 'https://example.com/', lastmod: '2026-09-18' },
    { loc: 'https://example.com/search?q=a&page=2', lastmod: null },
    { loc: 'https://example.com/b', lastmod: '2026-09-19T10:00:00+00:00' },
  ]);
  assert.deepEqual(sitemaps, []);
});

test('never mistakes an image location for a page', () => {
  const locs = parseSitemap(URLSET).urls.map((u) => u.loc);
  assert.ok(!locs.includes('https://example.com/photo.png'));
});

test('follows a sitemap index, gzipped children included', async () => {
  const index = `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
    <sitemap><loc>https://example.com/pages.xml</loc></sitemap>
    <sitemap><loc>https://example.com/posts.xml.gz</loc></sitemap>
  </sitemapindex>`;
  const posts = `<urlset><url><loc>https://example.com/post</loc></url></urlset>`;
  const { pages, sitemapsRead } = await collectUrls(['https://example.com/sitemap.xml'], {
    fetchImpl: fetchFrom({
      'https://example.com/sitemap.xml': index,
      'https://example.com/pages.xml': URLSET,
      'https://example.com/posts.xml.gz': zlib.gzipSync(posts),
    }),
  });
  assert.equal(pages.size, 4);
  assert.ok(pages.has('https://example.com/post'));
  assert.equal(sitemapsRead.length, 3);
});

test('keeps the most recent lastmod when a URL is listed twice', async () => {
  const a = `<urlset><url><loc>https://example.com/x</loc><lastmod>2026-09-10</lastmod></url></urlset>`;
  const b = `<urlset><url><loc>https://example.com/x</loc><lastmod>2026-09-12T08:00:00Z</lastmod></url></urlset>`;
  const { pages } = await collectUrls(['https://example.com/a.xml', 'https://example.com/b.xml'], {
    fetchImpl: fetchFrom({ 'https://example.com/a.xml': a, 'https://example.com/b.xml': b }),
  });
  assert.equal(pages.get('https://example.com/x'), '2026-09-12T08:00:00Z');
});

test('reports a sitemap that cannot be fetched', async () => {
  await assert.rejects(collectUrls(['https://example.com/nope.xml'], { fetchImpl: fetchFrom({}) }), /HTTP 404/);
});
