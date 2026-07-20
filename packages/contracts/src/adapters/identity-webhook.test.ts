// ACBP-P1-002 — provider-neutral identity webhook contract tests.
import { describe, test, expect } from 'vitest';
import { platformError } from '../errors.js';
import type { PublicErrorEnvelope } from '../errors.js';
import type {
  VerifiedIdentityWebhookEvent,
  IdentityWebhookVerification,
  IdentityWebhookRequest,
  IdentityWebhookEventType,
  NormalizedWebhookUser,
} from './identity-webhook.js';

const HEX64 = 'a'.repeat(64);
const user: NormalizedWebhookUser = {
  providerUserId: 'u_1',
  primaryEmail: 'person@example.com',
  emailVerified: true,
  providerCreatedAt: '2026-01-01T00:00:00.000Z',
  providerUpdatedAt: '2026-01-02T00:00:00.000Z',
};

function event(type: IdentityWebhookEventType): VerifiedIdentityWebhookEvent {
  const base = {
    provider: 'clerk',
    providerInstanceId: 'ins_1',
    eventId: 'evt_1',
    providerUserId: 'u_1',
    occurredAt: '2026-01-02T00:00:00.000Z',
    orderingTimestamp: '2026-01-02T00:00:00.000Z',
    payloadSha256: HEX64,
  } as const;
  return type === 'user.deleted' ? { ...base, type } : { ...base, type, user };
}

describe('identity webhook contract', () => {
  test('supports the three user event types with ordering + provider-instance metadata', () => {
    for (const t of ['user.created', 'user.updated', 'user.deleted'] as const) {
      const e = event(t);
      expect(e.type).toBe(t);
      expect(e.provider).toBe('clerk');
      expect(e.providerInstanceId).toBe('ins_1'); // provider-instance isolation metadata
      expect(e.orderingTimestamp).toBe('2026-01-02T00:00:00.000Z'); // ordering guard metadata
      expect(e.payloadSha256).toMatch(/^[0-9a-f]{64}$/);
    }
  });

  test('create/update carry normalized user; delete carries no PII', () => {
    const created = event('user.created');
    if (created.type === 'user.deleted') throw new Error('unreachable');
    expect(created.user.primaryEmail).toBe('person@example.com');
    expect(created.user.emailVerified).toBe(true);

    const deleted = event('user.deleted');
    expect('user' in deleted).toBe(false); // deletion envelope has no user state
    expect(JSON.stringify(deleted)).not.toContain('@'); // and therefore no email
  });

  test('verification result can be verified, ignored (verified-but-unsupported), or invalid', () => {
    const verified: IdentityWebhookVerification = { status: 'verified', event: event('user.created') };
    const ignored: IdentityWebhookVerification = {
      status: 'ignored',
      provider: 'clerk',
      providerInstanceId: 'ins_1',
      eventId: 'evt_2',
      eventType: 'session.revoked',
    };
    const invalid: IdentityWebhookVerification = { status: 'invalid', error: platformError('authn', { internalMessage: 'invalid signature' }).toPublic() };
    expect(verified.status).toBe('verified');
    expect(ignored.status).toBe('ignored'); // acknowledged no-op, NOT a parse failure
    expect(ignored.eventType).toBe('session.revoked');
    expect(invalid.status).toBe('invalid');
  });

  test('the request boundary is raw bytes (Uint8Array) with a normalized header record', () => {
    const req: IdentityWebhookRequest = {
      rawBody: Uint8Array.from([123, 34, 116, 34, 125]), // {"t"} as bytes — never decoded here
      headers: { 'webhook-id': 'msg_1', 'webhook-timestamp': '1700000000', 'webhook-signature': 'v1,redacted' },
    };
    expect(req.rawBody).toBeInstanceOf(Uint8Array);
    expect(req.headers['webhook-id']).toBe('msg_1');
  });

  test('arbitrary byte sequences are retained without any text conversion', () => {
    const bytes = Uint8Array.from([0, 255, 10, 13, 34, 92, 200, 1, 2, 3]); // NUL, 0xFF, CR/LF, quotes, backslash…
    const req: IdentityWebhookRequest = { rawBody: bytes, headers: {} };
    expect(req.rawBody).toBe(bytes); // same reference — no copy/decoding at the boundary
    expect(Array.from(req.rawBody)).toEqual([0, 255, 10, 13, 34, 92, 200, 1, 2, 3]);
    expect(req.rawBody.byteLength).toBe(10);
  });

  test('the invalid outcome is a bounded, sanitized PublicErrorEnvelope (no secret/PII/raw message)', () => {
    // Simulate the adapter converting a provider error whose internals carry secret- and PII-like text.
    const envelope: PublicErrorEnvelope = platformError('authn', {
      internalMessage: 'clerk verifyWebhook failed: whsec_supersecret for person@example.com',
      cause: new Error('standardwebhooks: signature v1,DEADBEEF mismatch; whsec_leak'),
    }).toPublic();
    const invalid: IdentityWebhookVerification = { status: 'invalid', error: envelope };

    const serialized = JSON.stringify(invalid);
    expect(serialized).not.toMatch(/whsec_|supersecret|person@example\.com|verifyWebhook failed|DEADBEEF|standardwebhooks/i);
    // Communicates only the bounded, application-safe fields.
    expect(invalid.error.category).toBe('authn');
    expect(typeof invalid.error.code).toBe('string');
    expect(typeof invalid.error.message).toBe('string');
    expect(typeof invalid.error.retryable).toBe('boolean');
    const allowed = ['category', 'code', 'message', 'retryable', 'correlationId'];
    expect(Object.keys(invalid.error).every((k) => allowed.includes(k))).toBe(true); // only bounded public fields
  });
});
