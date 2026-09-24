// Reads sitemaps and sitemap indexes, plain or gzipped, local or remote, into page URLs with their lastmod.
import fs from 'node:fs';
import zlib from 'node:zlib';

const ENTITIES = { '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&amp;': '&' };
const decode = (s) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(lt|gt|quot|apos|amp);/g, (m) => ENTITIES[m])
    .trim();

// Extension namespaces whose children reuse the name "loc" (image:loc and friends) are not page URLs.
const EXTENSIONS = new Set(['image', 'video', 'news', 'xhtml']);

/** Text of the first <name> child, accepting a namespace prefix only when it is the sitemap's own. */
function child(block, name) {
  const re = new RegExp(`<(?:([\\w-]+):)?${name}>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, 'g');
  for (const m of block.matchAll(re)) {
    if (!m[1] || !EXTENSIONS.has(m[1])) return decode(m[2]);
  }
  return null;
}

/** Parses one sitemap document: page entries from a <urlset>, child sitemaps from a <sitemapindex>. */
export function parseSitemap(xml) {
  const urls = [...xml.matchAll(/<(?:[\w-]+:)?url>([\s\S]*?)<\/(?:[\w-]+:)?url>/g)]
    .map((m) => ({ loc: child(m[1], 'loc'), lastmod: child(m[1], 'lastmod') }))
    .filter((u) => u.loc);
  const sitemaps = [...xml.matchAll(/<(?:[\w-]+:)?sitemap>([\s\S]*?)<\/(?:[\w-]+:)?sitemap>/g)]
    .map((m) => child(m[1], 'loc'))
    .filter(Boolean);
  return { urls, sitemaps };
}

async function read(source, fetchImpl) {
  let buf;
  if (/^https?:\/\//i.test(source)) {
    const res = await fetchImpl(source, {
      headers: { 'User-Agent': 'google-index-checker (+https://github.com/oussch702/google-index-checker)' },
    });
    if (!res.ok) throw new Error(`Could not fetch the sitemap ${source}: HTTP ${res.status}.`);
    buf = Buffer.from(await res.arrayBuffer());
  } else {
    try {
      buf = fs.readFileSync(source);
    } catch {
      throw new Error(`Could not read the sitemap file ${source}.`);
    }
  }
  if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
  return buf.toString('utf8');
}

const later = (a, b) => {
  const ta = Date.parse(a ?? '');
  const tb = Date.parse(b ?? '');
  if (Number.isNaN(ta)) return b ?? null;
  if (Number.isNaN(tb)) return a;
  return ta >= tb ? a : b;
};

/**
 * Every page URL reachable from the given sitemaps, following sitemap indexes up to `maxDepth` levels.
 * Returns a Map of URL to lastmod (the most recent one when a URL is listed twice) and the files read.
 */
export async function collectUrls(sources, { fetchImpl = globalThis.fetch, maxDepth = 3 } = {}) {
  const pages = new Map();
  const sitemapsRead = [];
  const visit = async (source, depth) => {
    if (sitemapsRead.includes(source) || depth > maxDepth) return;
    sitemapsRead.push(source);
    const { urls, sitemaps } = parseSitemap(await read(source, fetchImpl));
    for (const { loc, lastmod } of urls) pages.set(loc, pages.has(loc) ? later(pages.get(loc), lastmod) : lastmod);
    for (const next of sitemaps) await visit(next, depth + 1);
  };
  for (const source of sources) await visit(source, 0);
  return { pages, sitemapsRead };
}
