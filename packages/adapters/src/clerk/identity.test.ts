// ACBP-P1-001 — Clerk identity adapter tests. Deterministic + OFFLINE (no Clerk account/network).
// Logic is covered via the injected verifier; a real @clerk/backend crypto path is exercised with a
// locally-generated RS256 keypair. Fake identities only; no real tokens/credentials.
import { describe, test, expect } from 'vitest';
import { generateKeyPairSync, createSign, type KeyObject } from 'node:crypto';
import { isPlatformError } from '@acbp/contracts';
import { loadTestClerkConfig } from '@acbp/config';
import { ClerkIdentityProvider, type ClerkClaims } from './identity.js';

const cfg = loadTestClerkConfig();
const okClaims: ClerkClaims = { sub: 'user_123', email: 'founder@example.test', email_verified: true, name: 'Founder', org_id: 'org_should_be_ignored', role: 'admin' };
const fakeVerifier = (claims: ClerkClaims) => ({ config: cfg, verifyToken: () => Promise.resolve(claims) });

describe('ClerkIdentityProvider.verifySession (logic via injected verifier)', () => {
  test('valid verified session normalizes to neutral identity (org/role ignored)', async () => {
    const p = new ClerkIdentityProvider(fakeVerifier(okClaims));
    const r = await p.verifySession('tok', { correlation: { correlationId: '11111111-1111-4111-8111-111111111111' } });
    expect(r.status).toBe('valid');
    if (r.status === 'valid') {
      expect(r.identity).toEqual({ providerUserId: 'user_123', email: 'founder@example.test', emailVerified: true, displayName: 'Founder' });
      const json = JSON.stringify(r);
      expect(json).not.toContain('org_should_be_ignored'); // provider org is never surfaced
      expect(json).not.toContain('admin'); // provider role is never a product role
    }
  });

  test('by default, verified-email is NOT required from a session claim (Clerk emits none by default)', async () => {
    // The authoritative verified-email check lives at the web boundary (Backend User), so the neutral
    // adapter must NOT reject a valid session merely because the token lacks an email_verified claim.
    const r = await new ClerkIdentityProvider(fakeVerifier({ sub: 'u1', email: 'x@y.test' })).verifySession('tok');
    expect(r.status).toBe('valid');
  });

  test('unverified email is rejected when claim-based enforcement is opted in (fail closed)', async () => {
    const r = await new ClerkIdentityProvider({ config: cfg, requireVerifiedEmail: true, verifyToken: () => Promise.resolve({ sub: 'u1', email: 'x@y.test', email_verified: false }) }).verifySession('tok');
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') expect(r.error.metadata['reason']).toBe('email_unverified');
  });

  test('missing email_verified claim is rejected when claim-based enforcement is opted in', async () => {
    const r = await new ClerkIdentityProvider({ config: cfg, requireVerifiedEmail: true, verifyToken: () => Promise.resolve({ sub: 'u1' }) }).verifySession('tok');
    expect(r.status).toBe('invalid');
  });

  test('requireVerifiedEmail=false allows an unverified identity (still normalized)', async () => {
    const r = await new ClerkIdentityProvider({ config: cfg, requireVerifiedEmail: false, verifyToken: () => Promise.resolve({ sub: 'u1' }) }).verifySession('tok');
    expect(r.status).toBe('valid');
  });

  test('missing / empty token is rejected without calling the verifier', async () => {
    const p = new ClerkIdentityProvider({ config: cfg, verifyToken: () => Promise.reject(new Error('should not be called')) });
    expect((await p.verifySession('')).status).toBe('invalid');
    expect((await p.verifySession('   ')).status).toBe('invalid');
  });

  test('token verification failure => invalid; raw error/token never leak into the public envelope', async () => {
    const secretish = 'tok-zz-supersecret-01';
    const p = new ClerkIdentityProvider({ config: cfg, verifyToken: () => Promise.reject(new Error(`bad signature for ${secretish}`)) });
    const r = await p.verifySession(secretish);
    expect(r.status).toBe('invalid');
    if (r.status === 'invalid') {
      expect(JSON.stringify(r.error.toPublic())).not.toContain(secretish);
      expect(r.error.category).toBe('authn');
    }
  });

  test('provider/JWKS/network failure => unavailable + retryable', async () => {
    const r = await new ClerkIdentityProvider({ config: cfg, verifyToken: () => Promise.reject(new Error('unable to fetch JWKS from network')) }).verifySession('tok');
    expect(r.status).toBe('unavailable');
    if (r.status === 'unavailable') expect(r.error.retryable).toBe(true);
  });

  test('verified token without subject is rejected', async () => {
    const r = await new ClerkIdentityProvider(fakeVerifier({ email: 'a@b.test', email_verified: true })).verifySession('tok');
    expect(r.status).toBe('invalid');
  });

  test('correlation id flows into the rejection error', async () => {
    const r = await new ClerkIdentityProvider({ config: cfg, requireVerifiedEmail: true, verifyToken: () => Promise.resolve({ sub: 'u1', email_verified: false }) }).verifySession('tok', { correlation: { correlationId: 'cid-xyz' } });
    expect(r.status).toBe('invalid');
    if (r.status !== 'valid') expect(r.error.correlationId).toBe('cid-xyz');
  });

  test('normalizeClaims never mutates its input and drops provider-only fields', () => {
    const raw = { sub: 'u1', email: 'a@b.test', email_verified: true, org_id: 'o1', role: 'admin' };
    const snapshot = JSON.stringify(raw);
    const id = new ClerkIdentityProvider(fakeVerifier(okClaims)).normalizeClaims(raw);
    expect(JSON.stringify(raw)).toBe(snapshot);
    expect(Object.keys(id).sort()).toEqual(['email', 'emailVerified', 'providerUserId']);
  });

  test('parseEvent rejects — identity webhooks are ACBP-P1-002, not P1-001', async () => {
    await expect(new ClerkIdentityProvider(fakeVerifier(okClaims)).parseEvent({ type: 'user.created' })).rejects.toSatisfy(isPlatformError);
  });
});

describe('ClerkIdentityProvider real @clerk/backend crypto path (offline RS256; no network)', () => {
  function makeKeys(): { publicPem: string; privateKey: KeyObject } {
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    return { publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(), privateKey };
  }
  function signJwt(payload: Record<string, unknown>, privateKey: KeyObject): string {
    const enc = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const data = `${enc({ alg: 'RS256', typ: 'JWT' })}.${enc(payload)}`;
    return `${data}.${createSign('RSA-SHA256').update(data).sign(privateKey).toString('base64url')}`;
  }

  test('a tampered/garbage token is rejected by the real verifier (fail closed)', async () => {
    const { publicPem } = makeKeys();
    const provider = new ClerkIdentityProvider({ config: loadTestClerkConfig({ CLERK_JWT_KEY: publicPem }) });
    const r = await provider.verifySession('not.a.valid.token');
    expect(r.status).not.toBe('valid'); // real @clerk/backend verifyToken rejects it, offline
  });

  test('a locally-signed valid RS256 session verifies and normalizes (offline)', async () => {
    const { publicPem, privateKey } = makeKeys();
    const now = Math.floor(Date.now() / 1000);
    const token = signJwt({ sub: 'user_live_1', email: 'v@example.test', email_verified: true, iat: now, nbf: now - 5, exp: now + 3600 }, privateKey);
    // Networkless RS256 verification via a real @clerk/backend jwtKey path; azp disabled for this proof.
    const provider = new ClerkIdentityProvider({ config: loadTestClerkConfig({ CLERK_JWT_KEY: publicPem, CLERK_AUTHORIZED_PARTIES: '' }) });
    const r = await provider.verifySession(token);
    expect(r.status).toBe('valid');
    if (r.status === 'valid') expect(r.identity.providerUserId).toBe('user_live_1');
  });
});
