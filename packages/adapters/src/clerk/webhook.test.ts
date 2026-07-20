// ACBP-P1-002 — Clerk webhook verifier adapter tests. Deterministic + OFFLINE via an injected
// verifyWebhook seam; no network, no real signing secret. Fake identities only. Covers the hardened
// contract: stable public error codes (§4), header-alias resolution/conflict (§5), verify-before-parse
// trust order (§6), and neutral normalization (§7).
import { describe, test, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import type { WebhookEvent } from '@clerk/backend/webhooks';
import { loadTestClerkWebhookConfig } from '@acbp/config';
import { ErrorCodes } from '@acbp/contracts';
import type { IdentityWebhookRequest } from '@acbp/contracts';
import { ClerkIdentityWebhookVerifier, type ClerkWebhookVerifyFn } from './webhook.js';

const bytes = (s: string): Uint8Array => new TextEncoder().encode(s);
const sha = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

const SVIX = { 'svix-id': 'msg_1', 'svix-timestamp': '1700000000', 'svix-signature': 'v1,sig' } as const;
function req(rawBody: Uint8Array, headers: Record<string, string> = { ...SVIX }): IdentityWebhookRequest {
  return { rawBody, headers };
}

function clerkEvent(type: string, data: unknown, opts: { instanceId?: string; timestamp?: number } = {}): WebhookEvent {
  return {
    type,
    object: 'event',
    data,
    event_attributes: { http_request: { client_ip: '', user_agent: '' } },
    instance_id: opts.instanceId ?? 'ins_1',
    timestamp: opts.timestamp ?? 1700000000000,
  } as unknown as WebhookEvent;
}
function userData(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    object: 'user',
    id: 'user_1',
    primary_email_address_id: 'ema_1',
    email_addresses: [{ object: 'email_address', id: 'ema_1', email_address: 'Person@Example.com', verification: { status: 'verified' } }],
    created_at: 1699990000000,
    updated_at: 1700000000000,
    ...over,
  };
}
const okVerify: ClerkWebhookVerifyFn = () => Promise.resolve(clerkEvent('user.created', userData()));
// providerInstanceId now comes from the CONFIGURED expected instance (Clerk webhook bodies carry no
// instance_id), so tests configure it. `occurredAt` comes from the svix-timestamp header (Unix seconds).
const SVIX_TS_ISO = new Date(1700000000 * 1000).toISOString(); // svix-timestamp '1700000000' (seconds)
function verifier(fake: ClerkWebhookVerifyFn, env: Record<string, string | undefined> = {}) {
  return new ClerkIdentityWebhookVerifier({ config: loadTestClerkWebhookConfig({ CLERK_WEBHOOK_INSTANCE_ID: 'ins_1', ...env }), verifyWebhook: fake });
}

describe('ClerkIdentityWebhookVerifier — §6 trust order (verify before parse)', () => {
  test('exact raw bytes reach the SDK Request unchanged; secret unwrapped only at the call', async () => {
    const body = bytes('{"type":"user.created"} ÿ ÿ');
    let seenBody: Uint8Array | undefined;
    let seenSecret: string | undefined;
    const fake: ClerkWebhookVerifyFn = async (request, options) => {
      seenSecret = options.signingSecret;
      seenBody = new Uint8Array(await request.arrayBuffer());
      return clerkEvent('user.created', userData());
    };
    await verifier(fake).verify(req(body));
    expect(Array.from(seenBody ?? [])).toEqual(Array.from(body)); // byte-exact, no decode/re-encode
    expect(seenSecret).toBe('whsec_fake-local-webhook-signing'); // Secret revealed only at the SDK call
  });

  test('no JSON parsing occurs before verification succeeds', async () => {
    const parseSpy = vi.spyOn(JSON, 'parse');
    let parseCallsWhenVerifierInvoked = -1;
    const fake: ClerkWebhookVerifyFn = () => {
      parseCallsWhenVerifierInvoked = parseSpy.mock.calls.length;
      return Promise.resolve(clerkEvent('user.created', userData()));
    };
    const v = verifier(fake);
    parseSpy.mockClear();
    await v.verify(req(bytes('x')));
    expect(parseCallsWhenVerifierInvoked).toBe(0);
    parseSpy.mockRestore();
  });

  test('a verifier throw accesses zero provider fields and leaks nothing identifying', async () => {
    const body = bytes('{"data":{"id":"user_secret_1"},"instance_id":"ins_secret"}');
    const fake: ClerkWebhookVerifyFn = () => Promise.reject(new Error('kaboom internal fault 500'));
    const r = await verifier(fake).verify({ rawBody: body, headers: { ...SVIX, 'svix-id': 'msg_secret_1' } });
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') throw new Error('unreachable');
    const s = JSON.stringify(r);
    for (const leak of ['user_secret_1', 'ins_secret', 'msg_secret_1', sha(body)]) expect(s).not.toContain(leak);
    expect(Object.keys(r)).toEqual(['status', 'error']); // no providerUserId/eventId/instance/hash on the result
  });

  test('payloadSha256 is the lowercase hex SHA-256 of the exact raw bytes', async () => {
    const body = bytes('arbitrary--bytes');
    const r = await verifier(okVerify).verify(req(body));
    if (r.status !== 'verified') throw new Error('unreachable');
    expect(r.event.payloadSha256).toBe(sha(body));
  });
});

describe('ClerkIdentityWebhookVerifier — §5 header aliases (case-insensitive)', () => {
  const pairs: readonly SignatureFieldName[] = ['id', 'timestamp', 'signature'];
  type SignatureFieldName = 'id' | 'timestamp' | 'signature';
  const others = (field: SignatureFieldName): Record<string, string> => {
    // Provide the two non-tested fields under svix-* so only the tested field varies.
    const base: Record<string, string> = { 'svix-id': 'msg_1', 'svix-timestamp': '1700000000', 'svix-signature': 'v1,sig' };
    delete base[`svix-${field}`];
    return base;
  };

  for (const field of pairs) {
    test(`${field}: only the webhook-${field} alias present is accepted`, async () => {
      // Numeric value so it is also valid when the tested field is the (svix-)timestamp.
      const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { ...others(field), [`webhook-${field}`]: '1700000000' } });
      expect(r.status).toBe('verified');
    });
    test(`${field}: both aliases present with identical values is accepted`, async () => {
      const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { ...others(field), [`svix-${field}`]: '1700000000', [`webhook-${field}`]: '1700000000' } });
      expect(r.status).toBe('verified');
    });
    test(`${field}: both aliases present with DIFFERENT values is a safe conflict`, async () => {
      const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { ...others(field), [`svix-${field}`]: 'A', [`webhook-${field}`]: 'B' } });
      expect(r.status).toBe('invalid');
      if (r.status !== 'invalid') throw new Error('unreachable');
      expect(r.error.code).toBe(ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_CONFLICT);
    });
  }

  test('mixed header casing is resolved case-insensitively', async () => {
    const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { 'SVIX-ID': 'msg_1', 'Svix-Timestamp': '1700000000', 'svix-signature': 'v1,sig' } });
    expect(r.status).toBe('verified');
  });

  test('the same field under two casings with different values is a conflict (never silently preferred)', async () => {
    const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { 'Svix-Id': 'A', 'svix-id': 'B', 'svix-timestamp': '1700000000', 'svix-signature': 'v1,sig' } });
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_CONFLICT);
  });

  test('the verified event id comes from the delivery header alias actually supplied', async () => {
    const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { 'webhook-id': 'msg_via_webhook_alias', 'webhook-timestamp': '1700000000', 'webhook-signature': 'v1,sig' } });
    if (r.status !== 'verified') throw new Error('unreachable');
    expect(r.event.eventId).toBe('msg_via_webhook_alias');
  });
});

describe('ClerkIdentityWebhookVerifier — §7 normalization', () => {
  test('user.created normalizes to a neutral envelope', async () => {
    const fake: ClerkWebhookVerifyFn = () => Promise.resolve(clerkEvent('user.created', userData()));
    const r = await verifier(fake, { CLERK_WEBHOOK_INSTANCE_ID: 'ins_9' }).verify(req(bytes('x')));
    if (r.status !== 'verified' || r.event.type === 'user.deleted') throw new Error('unreachable');
    expect(r.event.type).toBe('user.created');
    expect(r.event.provider).toBe('clerk');
    expect(r.event.providerInstanceId).toBe('ins_9'); // from CONFIGURED instance (bound by the signing secret)
    expect(r.event.eventId).toBe('msg_1'); // from the authenticated delivery headers only
    expect(r.event.providerUserId).toBe('user_1');
    expect(r.event.occurredAt).toBe(SVIX_TS_ISO); // from the signed svix-timestamp header (Unix seconds)
    expect(r.event.orderingTimestamp).toBe(new Date(1700000000000).toISOString()); // = user.updated_at (ms)
    expect(r.event.user.primaryEmail).toBe('person@example.com'); // trim + lowercase
    expect(r.event.user.emailVerified).toBe(true);
    expect(r.event.user.providerCreatedAt).toBe(new Date(1699990000000).toISOString());
  });

  test('user.updated normalizes', async () => {
    const fake: ClerkWebhookVerifyFn = () => Promise.resolve(clerkEvent('user.updated', userData({ updated_at: 1700000005000 })));
    const r = await verifier(fake).verify(req(bytes('x')));
    expect(r.status === 'verified' && r.event.type === 'user.updated').toBe(true);
  });

  test('user.deleted normalizes and exposes no PII', async () => {
    const fake: ClerkWebhookVerifyFn = () => Promise.resolve(clerkEvent('user.deleted', { object: 'user', id: 'user_1', deleted: true }));
    const r = await verifier(fake).verify(req(bytes('x')));
    if (r.status !== 'verified') throw new Error('unreachable');
    expect(r.event.type).toBe('user.deleted');
    expect(r.event.orderingTimestamp).toBe(SVIX_TS_ISO); // deletes order by the signed svix-timestamp header
    expect('user' in r.event).toBe(false);
    expect(JSON.stringify(r.event)).not.toContain('@');
  });

  test('emailVerified follows ONLY the primary email; a verified non-primary does not count', async () => {
    const data = userData({
      primary_email_address_id: 'ema_primary',
      email_addresses: [
        { object: 'email_address', id: 'ema_primary', email_address: 'primary@example.com', verification: { status: 'unverified' } },
        { object: 'email_address', id: 'ema_other', email_address: 'other@example.com', verification: { status: 'verified' } },
      ],
    });
    const r = await verifier(() => Promise.resolve(clerkEvent('user.created', data))).verify(req(bytes('x')));
    if (r.status !== 'verified' || r.event.type === 'user.deleted') throw new Error('unreachable');
    expect(r.event.user.primaryEmail).toBe('primary@example.com');
    expect(r.event.user.emailVerified).toBe(false);
  });

  test('missing primary email maps to null / false', async () => {
    const data = userData({ primary_email_address_id: null, email_addresses: [] });
    const r = await verifier(() => Promise.resolve(clerkEvent('user.created', data))).verify(req(bytes('x')));
    if (r.status !== 'verified' || r.event.type === 'user.deleted') throw new Error('unreachable');
    expect(r.event.user.primaryEmail).toBeNull();
    expect(r.event.user.emailVerified).toBe(false);
  });

  test('a verified but unsupported event is acknowledged as ignored (not invalid, no mutation)', async () => {
    const r = await verifier(() => Promise.resolve(clerkEvent('session.revoked', { object: 'session', id: 'sess_1' }))).verify(req(bytes('x')));
    expect(r.status).toBe('ignored');
    if (r.status !== 'ignored') throw new Error('unreachable');
    expect(r.eventType).toBe('session.revoked');
    expect(r.eventId).toBe('msg_1');
  });
});

describe('ClerkIdentityWebhookVerifier — §4 stable error-code matrix', () => {
  test('missing signature headers → WEBHOOK_SIGNATURE_HEADERS_MISSING, verifier not called', async () => {
    let called = false;
    const fake: ClerkWebhookVerifyFn = () => {
      called = true;
      return Promise.resolve(clerkEvent('user.created', userData()));
    };
    const r = await verifier(fake).verify({ rawBody: bytes('x'), headers: { 'svix-signature': 'v1,sig' } });
    expect(r.status).toBe('invalid');
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_MISSING);
    expect(r.error.retryable).toBe(false);
    expect(called).toBe(false);
  });

  test('invalid signature (verifier throw) → WEBHOOK_SIGNATURE_INVALID', async () => {
    const r = await verifier(() => Promise.reject(new Error('No matching signature found'))).verify(req(bytes('x')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_SIGNATURE_INVALID);
    expect(r.error.retryable).toBe(false);
  });

  test('stale timestamp (verifier throw) → WEBHOOK_TIMESTAMP_INVALID', async () => {
    const r = await verifier(() => Promise.reject(new Error('Message timestamp too old'))).verify(req(bytes('x')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_TIMESTAMP_INVALID);
  });

  test('malformed authenticated payload (no user id) → WEBHOOK_PAYLOAD_MALFORMED', async () => {
    const r = await verifier(() => Promise.resolve(clerkEvent('user.created', userData({ id: '' })))).verify(req(bytes('x')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED);
    expect(r.error.category).toBe('validation');
  });

  test('a non-numeric svix-timestamp → WEBHOOK_PAYLOAD_MALFORMED', async () => {
    // Headers resolve, signature verifies, but the delivery timestamp is unusable → malformed envelope.
    const r = await verifier(okVerify).verify({ rawBody: bytes('x'), headers: { ...SVIX, 'svix-timestamp': 'not-a-number' } });
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED);
  });

  test('a webhook with no configured instance id fails closed (malformed, never a blank instance)', async () => {
    // Clerk sends no instance_id in the body; without CLERK_WEBHOOK_INSTANCE_ID there is no instance to
    // assign, so the verifier fails closed rather than emitting an empty providerInstanceId.
    const r = await verifier(okVerify, { CLERK_WEBHOOK_INSTANCE_ID: undefined }).verify(req(bytes('x')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED);
  });

  test('an unexpected verifier fault → WEBHOOK_VERIFIER_FAILED (internal), never invalid_signature', async () => {
    const r = await verifier(() => Promise.reject(new Error('ECONNRESET while contacting keystore'))).verify(req(bytes('x')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    expect(r.error.code).toBe(ErrorCodes.WEBHOOK_VERIFIER_FAILED);
    expect(r.error.code).not.toBe(ErrorCodes.WEBHOOK_SIGNATURE_INVALID);
    expect(r.error.category).toBe('internal');
    expect(r.error.retryable).toBe(false); // explicitly selected, fail-closed
  });

  test('every distinct rejection maps to a distinct public code', async () => {
    const seen = new Set<string>();
    const results = await Promise.all([
      verifier(okVerify).verify({ rawBody: bytes('x'), headers: {} }), // missing
      verifier(okVerify).verify({ rawBody: bytes('x'), headers: { ...SVIX, 'webhook-id': 'other' } }), // conflict
      verifier(() => Promise.reject(new Error('signature verification failed'))).verify(req(bytes('x'))), // invalid sig
      verifier(() => Promise.reject(new Error('timestamp out of tolerance'))).verify(req(bytes('x'))), // stale
      verifier(() => Promise.resolve(clerkEvent('user.created', userData({ id: '' })))).verify(req(bytes('x'))), // malformed
      verifier(() => Promise.reject(new Error('totally unknown fault'))).verify(req(bytes('x'))), // unexpected
    ]);
    for (const r of results) {
      expect(r.status).toBe('invalid');
      if (r.status === 'invalid') seen.add(r.error.code);
    }
    expect(seen.size).toBe(6); // headers-missing, headers-conflict, signature-invalid, timestamp-invalid, payload-malformed, verifier-failed
  });

  test('a provider exception carrying a secret / email / signature / payload / stack leaks nothing', async () => {
    const leaky = new Error('No matching signature: whsec_supersecret sig v1,DEADBEEF for person@example.com body={"secret":1}');
    leaky.stack = 'Error: whsec_supersecret\n    at verify (/clerk/backend/webhooks.js:42) person@example.com';
    const r = await verifier(() => Promise.reject(leaky)).verify(req(bytes('{"secret":1}')));
    if (r.status !== 'invalid') throw new Error('unreachable');
    const serialized = JSON.stringify(r);
    expect(serialized).not.toMatch(/whsec_|supersecret|DEADBEEF|person@example\.com|"secret"|v1,|webhooks\.js/i);
    expect(Object.keys(r.error).every((k) => ['category', 'code', 'message', 'retryable', 'correlationId'].includes(k))).toBe(true);
  });
});
