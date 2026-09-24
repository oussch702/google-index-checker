import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCredentials, tokenProvider } from './auth.js';
import { inspectAll } from './inspect.js';
import { formatReport } from './report.js';
import { buildSnapshot } from './snapshot.js';
import { collectUrls } from './sitemap.js';
import { latestSnapshot, saveSnapshot, siteSlug } from './store.js';

const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

export const HELP = `google-index-checker ${VERSION}
Check the Google index status of every URL in a sitemap, and see what changed since the last run.

Usage
  google-index-checker --site <property> --sitemap <url or file> --credentials <file> [options]
  google-index-checker --compare <older.json> <newer.json>

Required
  --site          Search Console property: sc-domain:example.com or https://example.com/
  --sitemap       Sitemap or sitemap index, as a URL or a local file. Repeat it for several.
  --credentials   Service account key or authorized_user file.
                  Defaults to the GOOGLE_APPLICATION_CREDENTIALS environment variable.

Options
  --out           Folder for snapshots, one subfolder per property (default: ./census)
  --limit         Inspect at most N URLs
  --offset        Skip the first N URLs, to cover a large site over several days
  --concurrency   Inspections in parallel (default: 3)
  --language      Language of Google's messages (default: en-US)
  --csv           Also write a CSV next to the JSON snapshot
  --compare       Compare two saved snapshots without calling Google
  -h, --help      Show this help
  -v, --version   Show the version

Google allows 2,000 inspections per property per day, and 600 per minute.
`;

const OPTIONS = {
  site: { type: 'string' },
  sitemap: { type: 'string', multiple: true },
  credentials: { type: 'string' },
  out: { type: 'string', default: 'census' },
  limit: { type: 'string' },
  offset: { type: 'string', default: '0' },
  concurrency: { type: 'string', default: '3' },
  language: { type: 'string', default: 'en-US' },
  csv: { type: 'boolean', default: false },
  compare: { type: 'boolean', default: false },
  help: { type: 'boolean', short: 'h', default: false },
  version: { type: 'boolean', short: 'v', default: false },
};

const wholeNumber = (value) => (/^\d+$/.test(String(value)) ? Number(value) : NaN);

/** Plain-language reason for a run that had to stop. */
function explain(err, creds, site) {
  if (err.status === 429) {
    return 'Google says the inspection quota is used up (2,000 per property per day). Run again tomorrow, or use --limit and --offset.';
  }
  if (err.status === 401 || err.status === 403) {
    return creds.kind === 'service_account'
      ? `${creds.identity} cannot read ${site}. In Search Console, open Settings, then Users and permissions, and add that address. Restricted permission is enough.`
      : `These credentials cannot read ${site}. Use an account that has access to the property in Search Console.`;
  }
  return err.message;
}

export async function run(argv, { fetchImpl = globalThis.fetch, stdout = process.stdout, stderr = process.stderr, env = process.env } = {}) {
  let parsed;
  try {
    parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    stderr.write(`${err.message}\n\n${HELP}`);
    return 2;
  }
  const o = parsed.values;
  if (o.help) {
    stdout.write(HELP);
    return 0;
  }
  if (o.version) {
    stdout.write(`${VERSION}\n`);
    return 0;
  }

  if (o.compare) {
    const [olderFile, newerFile] = parsed.positionals;
    if (!olderFile || !newerFile) {
      stderr.write('--compare needs two snapshot files, the older one first.\n');
      return 2;
    }
    const read = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));
    stdout.write(`${formatReport(read(newerFile), read(olderFile))}\n`);
    return 0;
  }

  if (!o.site || !o.sitemap?.length) {
    stderr.write(`--site and --sitemap are required.\n\n${HELP}`);
    return 2;
  }
  const concurrency = wholeNumber(o.concurrency);
  const offset = wholeNumber(o.offset);
  const limit = o.limit === undefined ? Infinity : wholeNumber(o.limit);
  if (!(concurrency >= 1 && concurrency <= 20)) {
    stderr.write('--concurrency must be a whole number from 1 to 20.\n');
    return 2;
  }
  if (Number.isNaN(offset) || !(limit >= 1)) {
    stderr.write('--limit and --offset must be whole numbers, and --limit at least 1.\n');
    return 2;
  }

  const creds = loadCredentials(o.credentials || env.GOOGLE_APPLICATION_CREDENTIALS);
  const token = tokenProvider(creds, fetchImpl);
  const { pages, sitemapsRead } = await collectUrls(o.sitemap, { fetchImpl });
  if (!pages.size) {
    stderr.write('The sitemap lists no URLs.\n');
    return 1;
  }
  const urls = [...pages.keys()].slice(offset, offset + limit);
  if (!urls.length) {
    stderr.write(`--offset ${offset} is past the end of the sitemap (${pages.size} URLs).\n`);
    return 2;
  }
  stderr.write(`Inspecting ${urls.length} of ${pages.size} URLs as ${creds.identity}\n`);

  const dir = path.join(o.out, siteSlug(o.site));
  const previous = latestSnapshot(dir);
  const startedAt = new Date().toISOString();
  const onProgress = (done, total) => {
    if (stderr.isTTY) stderr.write(`\r  ${done}/${total}`);
    else if (done % 25 === 0 || done === total) stderr.write(`  ${done}/${total}\n`);
  };
  const { results, fatal } = await inspectAll(urls, { site: o.site, language: o.language, token, fetchImpl, concurrency, onProgress });
  if (stderr.isTTY) stderr.write('\n');
  if (fatal && !results.size) throw new Error(explain(fatal, creds, o.site));

  const snapshot = buildSnapshot({
    site: o.site,
    sitemaps: sitemapsRead,
    pages,
    results,
    startedAt,
    finishedAt: new Date().toISOString(),
    complete: !fatal && results.size === pages.size,
    version: VERSION,
  });
  if (fatal) snapshot.stopReason = explain(fatal, creds, o.site);
  const saved = saveSnapshot(dir, snapshot, { csv: o.csv });

  stdout.write(`${formatReport(snapshot, previous?.snapshot)}\n\nSaved ${saved.json}${saved.csv ? ` and ${saved.csv}` : ''}\n`);
  return fatal ? 1 : 0;
}
