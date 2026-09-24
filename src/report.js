// The plain-text report printed after a run or a --compare.
import { diff } from './snapshot.js';

const LIST_LIMIT = 15;

const commonOrigin = (urls) => {
  try {
    const origin = new URL(urls[0]).origin;
    return urls.every((u) => u.startsWith(`${origin}/`) || u === origin) ? origin : '';
  } catch {
    return '';
  }
};

const minute = (iso) => (iso ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}`.trim() : 'never');

/** Report for one snapshot, with the changes since `older` when there is one. */
export function formatReport(snapshot, older = null) {
  const urls = Object.keys(snapshot.urls);
  const origin = commonOrigin(urls);
  const short = (url) => (origin && url.startsWith(origin) ? url.slice(origin.length) || '/' : url);
  const lines = [`google-index-checker · ${snapshot.site} · ${snapshot.inspected} of ${snapshot.total} URLs inspected`];
  if (!snapshot.complete && snapshot.inspected < snapshot.total && snapshot.stopReason) {
    lines.push(`Stopped early: ${snapshot.stopReason}`);
  }

  lines.push('', 'Coverage');
  const counts = Object.entries(snapshot.counts).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const width = Math.max(10, ...counts.map(([state]) => state.length)) + 2;
  for (const [state, n] of counts) lines.push(`  ${state.padEnd(width)}${String(n).padStart(5)}`);

  const changed = urls.filter((u) => snapshot.urls[u].crawledBeforeChange === true);
  lines.push('', `Changed since Google last crawled them: ${changed.length}`);
  for (const u of changed.slice(0, LIST_LIMIT)) {
    const r = snapshot.urls[u];
    lines.push(`  ${short(u)}  crawled ${minute(r.lastCrawlTime)}, changed ${minute(r.sitemapLastmod)}`);
  }
  if (changed.length > LIST_LIMIT) lines.push(`  and ${changed.length - LIST_LIMIT} more in the snapshot file`);
  const never = urls.filter((u) => !snapshot.urls[u].error && !snapshot.urls[u].lastCrawlTime);
  lines.push(`Never crawled: ${never.length}`);

  if (older) {
    const d = diff(older, snapshot);
    lines.push('', `Since ${minute(d.since)} UTC`);
    if (!d.transitions.length) lines.push('  No state changes.');
    for (const t of d.transitions) lines.push(`  ${t.from} -> ${t.to}: ${t.count}`);
    lines.push(`  Newly indexed: ${d.newlyIndexed.length}   Dropped from the index: ${d.dropped.length}`);
    for (const u of d.dropped.slice(0, LIST_LIMIT)) lines.push(`    dropped: ${short(u)}`);
    if (d.notInOlder.length) lines.push(`  Not in the earlier snapshot: ${d.notInOlder.length}`);
    if (d.leftSitemap.length) lines.push(`  No longer in the sitemap: ${d.leftSitemap.length}`);
  } else {
    lines.push('', 'First snapshot for this property. Run it again later to see what changed.');
  }

  const errors = urls.filter((u) => snapshot.urls[u].error);
  if (errors.length) {
    lines.push('', `Errors: ${errors.length}`);
    for (const u of errors.slice(0, 5)) lines.push(`  ${short(u)}: ${snapshot.urls[u].error}`);
  }
  return lines.join('\n');
}
