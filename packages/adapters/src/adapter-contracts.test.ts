// ACBP-P0-019 — provider-adapter contract/conformance tests.
// Exercises the provider-neutral contracts through SDK-free fakes: correlation flow, cancellation,
// retryability, no-plaintext-egress, determinism, non-mutation, lifecycle, and provider-neutral
// model/storage shapes. Sentinel is short + variable-passed (never a scannable literal).
import { describe, test, expect } from 'vitest';
import { isPlatformError, isSecretResolved, toModelId, toObjectKey, toSecretRef } from '@acbp/contracts';
import type { AbortSignalLike, AdapterCallOptions, CorrelationContext, ModelProviderRequest } from '@acbp/contracts';
import { FakeIdentityProvider, AlwaysSucceedsModelProvider, NonFailingObjectStorage, FakeSecretProvider } from '@acbp/test-support';

const SENTINEL = 'zz-secret-01';
const correlation: CorrelationContext = { correlationId: '11111111-1111-4111-8111-111111111111' };
const withCorrelation: AdapterCallOptions = { correlation };

describe('secret provider contract', () => {
  test('resolves refs to a redaction-safe wrapper; plaintext never egresses via serialization', async () => {
    const provider = new FakeSecretProvider({ 'db/url': SENTINEL });
    const result = await provider.resolve(toSecretRef('db/url'), withCorrelation);
    expect(isSecretResolved(result)).toBe(true);
    if (isSecretResolved(result)) {
      expect(result.value.reveal()).toBe(SENTINEL); // available only via explicit reveal()
      expect(JSON.stringify(result)).not.toContain(SENTINEL); // no-plaintext-egress
    }
  });

  test('missing vs unavailable are distinct and both fail closed (no value)', async () => {
    const present = new FakeSecretProvider({ k: SENTINEL });
    const missing = await present.resolve(toSecretRef('absent'));
    expect(missing.status).toBe('missing');
    const down = new FakeSecretProvider({ k: SENTINEL }, { available: false });
    const unavailable = await down.resolve(toSecretRef('k'));
    expect(unavailable.status).toBe('unavailable'); // adapter absence => fail closed
    expect(isSecretResolved(missing)).toBe(false);
    expect(isSecretResolved(unavailable)).toBe(false);
  });

  test('failures are provider-neutral PlatformErrors with distinguishable retryability', async () => {
    const down = new FakeSecretProvider({}, { available: false });
    const unavailable = await down.resolve(toSecretRef('k'));
    const missing = await new FakeSecretProvider({}).resolve(toSecretRef('k'));
    if (unavailable.status !== 'resolved' && missing.status !== 'resolved') {
      expect(isPlatformError(unavailable.error)).toBe(true);
      expect(unavailable.error.retryable).toBe(true); // provider_unavailable is retryable
      expect(missing.error.retryable).toBe(false); // not_found is not
    }
  });
});

describe('identity provider contract', () => {
  test('normalizes claims without authorizing (no roles/company in the neutral shape)', () => {
    const provider = new FakeIdentityProvider();
    const identity = provider.normalizeClaims({ sub: 'u_1', email: 'a@b.co', email_verified: true, name: 'A', org: 'should-be-ignored', role: 'admin' });
    expect(identity).toEqual({ providerUserId: 'u_1', email: 'a@b.co', emailVerified: true, displayName: 'A' });
    expect(JSON.stringify(identity)).not.toContain('admin'); // provider role never becomes authz
    expect(JSON.stringify(identity)).not.toContain('should-be-ignored'); // provider org never becomes company
  });

  test('session verification is valid/invalid/unavailable and fails closed when unavailable', async () => {
    const ok = new FakeIdentityProvider({ sessions: { 'tok-1': { providerUserId: 'u_1' } } });
    expect((await ok.verifySession('tok-1')).status).toBe('valid');
    expect((await ok.verifySession('nope')).status).toBe('invalid');
    const down = new FakeIdentityProvider({ available: false });
    expect((await down.verifySession('tok-1')).status).toBe('unavailable');
  });

  test('parseEvent produces a neutral event; unknown types reject with a PlatformError', async () => {
    const provider = new FakeIdentityProvider();
    const event = await provider.parseEvent({ type: 'user.deleted', id: 'evt_1', occurred_at: '2026-07-18T00:00:00.000Z', data: { sub: 'u_9' } });
    expect(event.type).toBe('user.deleted');
    expect(event.eventId).toBe('evt_1'); // diagnostic/dedupe id, not a product id
    await expect(provider.parseEvent({ type: 'nonsense' })).rejects.toSatisfy(isPlatformError);
  });
});

describe('object storage contract', () => {
  test('round-trips objects by opaque key; unknown key fails closed', async () => {
    const storage = new NonFailingObjectStorage();
    const key = toObjectKey('company/co_1/doc.txt');
    const meta = await storage.put({ key, body: new Uint8Array([1, 2, 3]), contentType: 'text/plain' });
    expect(meta).toEqual({ contentType: 'text/plain', sizeBytes: 3 });
    const got = await storage.get(key);
    expect(got.metadata.sizeBytes).toBe(3);
    expect((await storage.head(key)).exists).toBe(true);
    await storage.delete(key);
    expect((await storage.head(key)).exists).toBe(false);
    await expect(storage.get(key)).rejects.toSatisfy(isPlatformError);
  });

  test('metadata is provider-neutral: no public-access flag, no credentials, no vendor url', async () => {
    const storage = new NonFailingObjectStorage();
    const meta = await storage.put({ key: toObjectKey('k'), body: new Uint8Array([9]), contentType: 'application/octet-stream' });
    const keys = Object.keys(meta);
    for (const forbidden of ['acl', 'public', 'isPublic', 'url', 'signedUrl', 'credential', 'token', 'bucket', 'region']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(keys.sort()).toEqual(['contentType', 'sizeBytes']);
  });
});

describe('model provider contract', () => {
  const req = (): ModelProviderRequest => ({ modelId: toModelId('primary'), messages: [{ role: 'user', content: 'hello world' }] });

  test('deterministic output + provider-neutral usage for identical inputs', async () => {
    const provider = new AlwaysSucceedsModelProvider();
    const a = await provider.generate(req(), withCorrelation);
    const b = await provider.generate(req());
    expect(a).toEqual(b); // deterministic
    expect(Object.keys(a.usage).sort()).toEqual(['inputTokens', 'outputTokens', 'totalTokens']);
    expect(a.usage.totalTokens).toBe(a.usage.inputTokens + a.usage.outputTokens);
  });

  test('finish status is a platform-owned state; no raw provider response or fallback field is exposed', async () => {
    const response = await new AlwaysSucceedsModelProvider().generate(req());
    expect(['completed', 'length', 'content_filtered', 'refused', 'error']).toContain(response.finishStatus);
    const keys = Object.keys(response);
    for (const forbidden of ['raw', 'rawResponse', 'httpResponse', 'providerResponse', 'sdkResponse', 'fallbackUsed', 'apiKey']) {
      expect(keys).not.toContain(forbidden);
    }
    expect(typeof response.providerRequestId).toBe('string'); // diagnostic only
  });

  test('cancellation is representable and normalized to a PlatformError', async () => {
    const abortedSignal: AbortSignalLike = { aborted: true, addEventListener() {}, removeEventListener() {} };
    await expect(new AlwaysSucceedsModelProvider().generate(req(), { signal: abortedSignal })).rejects.toSatisfy(isPlatformError);
  });

  test('does not mutate the request input', async () => {
    const input = req();
    const snapshot = JSON.stringify(input);
    await new AlwaysSucceedsModelProvider().generate(input);
    expect(JSON.stringify(input)).toBe(snapshot);
  });

  test('lifecycle (init/shutdown) is explicit', async () => {
    const provider = new AlwaysSucceedsModelProvider();
    expect(provider.isStarted).toBe(false);
    await provider.init();
    expect(provider.isStarted).toBe(true);
    await provider.shutdown();
    expect(provider.isStarted).toBe(false);
  });
});
