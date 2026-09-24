// Access tokens for the Search Console API, from a service account key or an authorized_user file.
// Nothing in this module ever prints a key, a token or a refresh token.
import crypto from 'node:crypto';
import fs from 'node:fs';

/** Read-only access is all the census needs. */
export const SCOPE = 'https://www.googleapis.com/auth/webmasters.readonly';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';

const b64url = (value) => Buffer.from(value).toString('base64url');

/**
 * Reads a credentials file and reports what kind it is.
 * The returned `identity` is safe to show: the service account's email, or a generic label.
 */
export function loadCredentials(file) {
  if (!file) {
    throw new Error('No credentials. Pass --credentials <file> or set GOOGLE_APPLICATION_CREDENTIALS.');
  }
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    const reason = err.code === 'ENOENT' ? 'file not found' : 'not valid JSON';
    throw new Error(`Cannot read the credentials file ${file}: ${reason}.`);
  }
  if (data.client_email && data.private_key) {
    return { kind: 'service_account', identity: data.client_email, data };
  }
  if (data.client_id && data.client_secret && data.refresh_token) {
    return { kind: 'authorized_user', identity: 'an authorized user', data };
  }
  throw new Error(`${file} is neither a service account key nor an authorized_user file with a refresh token.`);
}

/** Signed JWT assertion for the service account flow (RFC 7523). */
export function serviceAccountAssertion(key, now = Math.floor(Date.now() / 1000)) {
  const header = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({ iss: key.client_email, scope: SCOPE, aud: key.token_uri || TOKEN_URL, iat: now, exp: now + 3600 }),
  );
  const signature = crypto.createSign('RSA-SHA256').update(`${header}.${claims}`).sign(key.private_key).toString('base64url');
  return `${header}.${claims}.${signature}`;
}

/** Returns an async function that resolves to a valid access token, refreshed a minute before it expires. */
export function tokenProvider(creds, fetchImpl = globalThis.fetch) {
  let cached = null;
  return async () => {
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    const params =
      creds.kind === 'service_account'
        ? { grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: serviceAccountAssertion(creds.data) }
        : {
            grant_type: 'refresh_token',
            client_id: creds.data.client_id,
            client_secret: creds.data.client_secret,
            refresh_token: creds.data.refresh_token,
          };
    const res = await fetchImpl(creds.data.token_uri || TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.access_token) {
      const detail = json.error_description ? `: ${json.error_description}` : '';
      throw new Error(`Google did not accept the credentials (${json.error || `HTTP ${res.status}`}${detail}).`);
    }
    cached = { token: json.access_token, expiresAt: Date.now() + (json.expires_in || 3600) * 1000 };
    return cached.token;
  };
}
