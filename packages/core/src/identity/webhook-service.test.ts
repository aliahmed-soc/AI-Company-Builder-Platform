// ACBP-P1-002 Slice 3 — identity webhook SERVICE unit tests. Fake verifier + fake processor seam prove
// verification precedes processing, and NO processor (database) call occurs for invalid/ignored events.
import { describe, test, expect } from 'vitest';
import type { DatabaseClient } from '@acbp/database';
import type {
  IdentityWebhookRequest,
  IdentityWebhookVerification,
  IdentityWebhookVerifier,
  VerifiedIdentityWebhookEvent,
} from '@acbp/contracts';
import { ErrorCodes, platformError } from '@acbp/contracts';
import { createIdentityWebhookService, type IdentityEventProcessor } from './webhook-service.js';

const REQUEST: IdentityWebhookRequest = { rawBody: new Uint8Array([1, 2, 3]), headers: { 'svix-id': 'msg_1' } };
const DUMMY_CLIENT = {} as unknown as DatabaseClient;

function verifier(result: IdentityWebhookVerification, capture?: (o: unknown) => void): IdentityWebhookVerifier {
  return {
    verify(_request, options) {
      capture?.(options);
      return Promise.resolve(result);
    },
  };
}
function verifiedEvent(): VerifiedIdentityWebhookEvent {
  return {
    provider: 'clerk',
    providerInstanceId: 'ins_1',
    eventId: 'evt_1',
    providerUserId: 'user_1',
    occurredAt: '2026-01-01T12:00:00.000Z',
    orderingTimestamp: '2026-01-01T12:00:00.000Z',
    payloadSha256: 'a'.repeat(64),
    type: 'user.created',
    user: { providerUserId: 'user_1', primaryEmail: 'a@example.com', emailVerified: true, providerUpdatedAt: '2026-01-01T12:00:00.000Z' },
  };
}

describe('createIdentityWebhookService', () => {
  test('invalid verification → {invalid}; the processor is NEVER called', async () => {
    let processCalls = 0;
    const process: IdentityEventProcessor = () => {
      processCalls += 1;
      return Promise.resolve({ outcome: 'applied' });
    };
    const invalid: IdentityWebhookVerification = { status: 'invalid', error: platformError('authn', { code: ErrorCodes.WEBHOOK_SIGNATURE_INVALID }).toPublic() };
    const svc = createIdentityWebhookService({ verifier: verifier(invalid), client: DUMMY_CLIENT, process });
    const result = await svc.handle(REQUEST);
    expect(result).toEqual({ kind: 'invalid', error: invalid.status === 'invalid' ? invalid.error : undefined });
    expect(processCalls).toBe(0);
  });

  test('verified-but-unsupported (ignored) → {ignored}; the processor is NEVER called', async () => {
    let processCalls = 0;
    const process: IdentityEventProcessor = () => {
      processCalls += 1;
      return Promise.resolve({ outcome: 'applied' });
    };
    const ignored: IdentityWebhookVerification = { status: 'ignored', provider: 'clerk', providerInstanceId: 'ins_1', eventId: 'evt_2', eventType: 'session.revoked' };
    const svc = createIdentityWebhookService({ verifier: verifier(ignored), client: DUMMY_CLIENT, process });
    await expect(svc.handle(REQUEST)).resolves.toEqual({ kind: 'ignored', eventType: 'session.revoked' });
    expect(processCalls).toBe(0);
  });

  test('verified supported event → processor called with the client + event; {processed, outcome}', async () => {
    const event = verifiedEvent();
    let seenClient: unknown;
    let seenEvent: unknown;
    let seenOptions: unknown;
    const process: IdentityEventProcessor = (client, ev, options) => {
      seenClient = client;
      seenEvent = ev;
      seenOptions = options;
      return Promise.resolve({ outcome: 'duplicate' });
    };
    const svc = createIdentityWebhookService({ verifier: verifier({ status: 'verified', event }), client: DUMMY_CLIENT, process });
    await expect(svc.handle(REQUEST, { correlationId: 'cid-9' })).resolves.toEqual({ kind: 'processed', outcome: 'duplicate' });
    expect(seenClient).toBe(DUMMY_CLIENT);
    expect(seenEvent).toBe(event);
    expect(seenOptions).toEqual({ correlationId: 'cid-9' });
  });

  test('the correlation id is threaded into the verifier call', async () => {
    let seen: unknown;
    const svc = createIdentityWebhookService({
      verifier: verifier({ status: 'verified', event: verifiedEvent() }, (o) => (seen = o)),
      client: DUMMY_CLIENT,
      process: () => Promise.resolve({ outcome: 'applied' }),
    });
    await svc.handle(REQUEST, { correlationId: 'cid-7' });
    expect(seen).toEqual({ correlation: { correlationId: 'cid-7' } });
  });
});
