import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { SCOPE, loadCredentials, serviceAccountAssertion, tokenProvider } from '../src/auth.js';

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
const KEY = {
  type: 'service_account',
  client_email: 'census@example-project.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }),
  token_uri: 'https://oauth2.googleapis.com/token',
};

const tempFile = (name, content) => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'census-auth-')), name);
  fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
  return file;
};

test('builds a signed, read-only service account assertion', () => {
  const now = 1_790_000_000;
  const [header, claims, signature] = serviceAccountAssertion(KEY, now).split('.');
  const verified = crypto.createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, Buffer.from(signature, 'base64url'));
  assert.equal(verified, true);
  const body = JSON.parse(Buffer.from(claims, 'base64url').toString());
  assert.equal(body.iss, KEY.client_email);
  assert.equal(body.scope, SCOPE);
  assert.ok(SCOPE.endsWith('.readonly'));
  assert.equal(body.exp - body.iat, 3600);
});

test('recognises both kinds of credentials file', () => {
  assert.equal(loadCredentials(tempFile('sa.json', KEY)).kind, 'service_account');
  assert.equal(loadCredentials(tempFile('sa.json', KEY)).identity, KEY.client_email);
  const user = { type: 'authorized_user', client_id: 'id', client_secret: 'secret', refresh_token: 'refresh' };
  assert.equal(loadCredentials(tempFile('user.json', user)).kind, 'authorized_user');
});

test('explains unusable credentials files', () => {
  assert.throws(() => loadCredentials(undefined), /No credentials/);
  assert.throws(() => loadCredentials('/nonexistent/key.json'), /file not found/);
  assert.throws(() => loadCredentials(tempFile('bad.json', '{nope')), /not valid JSON/);
  assert.throws(() => loadCredentials(tempFile('other.json', { hello: 1 })), /neither a service account key/);
});

test('reuses a token until it is about to expire', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return Response.json({ access_token: `token-${calls}`, expires_in: 3600 });
  };
  const token = tokenProvider(loadCredentials(tempFile('sa.json', KEY)), fetchImpl);
  assert.equal(await token(), 'token-1');
  assert.equal(await token(), 'token-1');
  assert.equal(calls, 1);
});

test('a refused refresh token never appears in the error', async () => {
  const user = { client_id: 'id', client_secret: 'very-secret-value', refresh_token: 'refresh-token-value' };
  const fetchImpl = async () => Response.json({ error: 'invalid_grant', error_description: 'Token has been expired or revoked.' }, { status: 400 });
  const token = tokenProvider(loadCredentials(tempFile('user.json', user)), fetchImpl);
  await assert.rejects(token(), (err) => {
    assert.match(err.message, /invalid_grant/);
    assert.doesNotMatch(err.message, /refresh-token-value|very-secret-value/);
    return true;
  });
});
