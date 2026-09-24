// Turns inspection results into a snapshot, and compares two snapshots.

/** Google's verdict PASS means the URL is on Google. */
export const isIndexed = (result) => result?.verdict === 'PASS';

const time = (value) => {
  const t = Date.parse(value ?? '');
  return Number.isNaN(t) ? null : t;
};

/**
 * True when Google last crawled the page before the sitemap says it changed, so the current version
 * has not been judged yet. Null when either date is missing. A date-only lastmod counts as midnight UTC.
 */
export function crawledBeforeChange(lastCrawlTime, lastmod) {
  const crawl = time(lastCrawlTime);
  const change = time(lastmod);
  return crawl === null || change === null ? null : crawl < change;
}

const stateOf = (result) => (result.error ? 'Error' : result.coverageState || 'Unknown');

/** A snapshot of one run. `pages` is every sitemap URL with its lastmod; `results` holds the ones inspected. */
export function buildSnapshot({ site, sitemaps, pages, results, startedAt, finishedAt, complete, version }) {
  const urls = {};
  const counts = {};
  for (const [url, lastmod] of pages) {
    const result = results.get(url);
    if (!result) continue;
    urls[url] = {
      ...result,
      sitemapLastmod: lastmod ?? null,
      crawledBeforeChange: result.error ? null : crawledBeforeChange(result.lastCrawlTime, lastmod),
    };
    const state = stateOf(result);
    counts[state] = (counts[state] || 0) + 1;
  }
  return {
    tool: 'google-index-checker',
    version,
    site,
    sitemaps,
    startedAt,
    finishedAt,
    complete,
    total: pages.size,
    inspected: Object.keys(urls).length,
    counts,
    urls,
  };
}

/** What changed between an older and a newer snapshot of the same property. */
export function diff(older, newer) {
  const transitions = new Map();
  const newlyIndexed = [];
  const dropped = [];
  const notInOlder = [];
  for (const [url, now] of Object.entries(newer.urls)) {
    const before = older.urls[url];
    if (!before) {
      notInOlder.push(url);
      continue;
    }
    const from = stateOf(before);
    const to = stateOf(now);
    if (from !== to) {
      const key = `${from}\u0000${to}`;
      transitions.set(key, (transitions.get(key) || 0) + 1);
    }
    if (!isIndexed(before) && isIndexed(now)) newlyIndexed.push(url);
    if (isIndexed(before) && !isIndexed(now) && !now.error) dropped.push(url);
  }
  // Only a full run can say a URL left the sitemap; a --limit run simply did not reach it.
  const leftSitemap = newer.inspected === newer.total ? Object.keys(older.urls).filter((url) => !newer.urls[url]) : [];
  return {
    since: older.finishedAt,
    transitions: [...transitions]
      .map(([key, count]) => {
        const [from, to] = key.split('\u0000');
        return { from, to, count };
      })
      .sort((a, b) => b.count - a.count || a.from.localeCompare(b.from)),
    newlyIndexed,
    dropped,
    notInOlder,
    leftSitemap,
  };
}

const COLUMNS = [
  'url',
  'verdict',
  'coverageState',
  'lastCrawlTime',
  'sitemapLastmod',
  'crawledBeforeChange',
  'pageFetchState',
  'robotsTxtState',
  'indexingState',
  'googleCanonical',
  'userCanonical',
  'crawledAs',
  'error',
];

const cell = (value) => {
  if (value === null || value === undefined) return '';
  const s = String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** One row per inspected URL, ready for a spreadsheet. */
export function toCsv(snapshot) {
  const rows = Object.entries(snapshot.urls).map(([url, r]) => COLUMNS.map((c) => cell(c === 'url' ? url : r[c])).join(','));
  return `${[COLUMNS.join(','), ...rows].join('\n')}\n`;
}
