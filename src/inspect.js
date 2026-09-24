// Calls the URL Inspection API for many URLs at a steady pace, retrying on rate limits and server errors.
const ENDPOINT = 'https://searchconsole.googleapis.com/v1/urlInspection/index:inspect';

const FIELDS = [
  'verdict',
  'coverageState',
  'lastCrawlTime',
  'pageFetchState',
  'robotsTxtState',
  'indexingState',
  'googleCanonical',
  'userCanonical',
  'crawledAs',
];

/** Keeps the fields of Google's indexStatusResult that the census records. */
export const pick = (status = {}) =>
  Object.fromEntries(FIELDS.filter((f) => status[f] !== undefined).map((f) => [f, status[f]]));

/** An HTTP answer that stops the run or needs a decision: bad credentials, no access, quota used up. */
export class InspectionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const backoff = (attempt) => Math.min(60_000, 1000 * 2 ** attempt) + Math.floor(Math.random() * 500);

/** Inspects one URL. Returns the picked fields, or { error } for a problem that only concerns this URL. */
export async function inspectUrl(url, { site, language = 'en-US', token, fetchImpl = globalThis.fetch, sleep = wait, retries = 5 }) {
  for (let attempt = 0; ; attempt += 1) {
    // Outside the try: refused credentials must stop the run, not be retried as a network problem.
    const accessToken = await token();
    let res;
    try {
      res = await fetchImpl(ENDPOINT, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ inspectionUrl: url, siteUrl: site, languageCode: language }),
      });
    } catch (err) {
      if (attempt >= retries) return { error: `network: ${err.message}` };
      await sleep(backoff(attempt));
      continue;
    }
    const text = await res.text();
    let json = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      // Not JSON: keep the raw text for the message below.
    }
    if (res.ok) return pick(json.inspectionResult?.indexStatusResult);
    const message = json.error?.message || text.slice(0, 200) || `HTTP ${res.status}`;
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      await sleep(backoff(attempt));
      continue;
    }
    if (res.status === 401 || res.status === 403 || res.status === 429) throw new InspectionError(res.status, message);
    return { error: `${res.status} ${message}` };
  }
}

/**
 * Inspects every URL with a small pool of workers.
 * A 401, or a 403 before any URL has succeeded, means the credentials cannot read the property: the run stops.
 * A 403 later on concerns that URL only (for example a URL outside the property) and is recorded.
 * A 429 that survives the retries means the daily quota is used up: the run stops and keeps what it has.
 */
export async function inspectAll(urls, { concurrency = 3, onProgress = () => {}, ...options }) {
  const results = new Map();
  let succeeded = 0;
  let next = 0;
  let fatal = null;
  const worker = async () => {
    while (!fatal && next < urls.length) {
      const url = urls[next];
      next += 1;
      try {
        const result = await inspectUrl(url, options);
        results.set(url, result);
        if (!result.error) succeeded += 1;
      } catch (err) {
        if (err.status === 403 && succeeded > 0) {
          results.set(url, { error: `403 ${err.message}` });
        } else {
          fatal = err;
          break;
        }
      }
      onProgress(results.size, urls.length);
    }
  };
  const workers = Math.max(1, Math.min(concurrency, urls.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return { results, fatal };
}
