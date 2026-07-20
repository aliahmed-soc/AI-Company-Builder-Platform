// ACBP-P1-002 Slice 3 — Clerk webhook Route Handler tests (apps/web). Deterministic, offline: a fake
// neutral service stands in for verify+process, so these assert the HTTP boundary (content type, body
// limit, status matrix, safe responses/logs, byte-exactness) without Clerk or a database.
import { describe, test, expect, vi } from 'vitest';
import { createTestLogger } from '@acbp/observability';
import { ErrorCodes, platformError, type ErrorCode, type PublicErrorEnvelope } from '@acbp/contracts';
import type { IdentityWebhookProcessingResult, IdentityWebhookService } from '@acbp/core';
import type { IdentityWebhookRequest } from '@acbp/contracts';
import { createClerkWebhookHandler } from './clerk-webhook-handler.js';

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  let sent = false;
  return {
    getReader() {
      return {
        read: () => {
          if (sent) return Promise.resolve({ done: true, value: undefined });
          sent = true;
          return Promise.resolve({ done: false, value: bytes });
        },
        cancel: () => Promise.resolve(),
      };
    },
  } as unknown as ReadableStream<Uint8Array>;
}

function fakeRequest(opts: { method?: string; contentType?: string | null; contentLength?: string; body?: Uint8Array | null; headers?: Record<string, string> } = {}): Request {
  const headers = new Headers();
  if (opts.contentType !== null && opts.contentType !== undefined) headers.set('content-type', opts.contentType);
  else if (opts.contentType === undefined) headers.set('content-type', 'application/json');
  if (opts.contentLength !== undefined) headers.set('content-length', opts.contentLength);
  for (const [k, v] of Object.entries(opts.headers ?? {})) headers.set(k, v);
  const body = opts.body === undefined ? new Uint8Array([0x7b, 0x7d]) : opts.body; // default "{}"
  return {
    method: opts.method ?? 'POST',
    headers,
    body: body === null ? null : streamOf(body),
    arrayBuffer: () => Promise.resolve((body ?? new Uint8Array()).buffer),
  } as unknown as Request;
}

interface Harness {
  handler: (request: Request) => Promise<Response>;
  logger: ReturnType<typeof createTestLogger>;
  seen: { rawBody?: Uint8Array; headers?: Record<string, string>; options?: { correlationId?: string }; calls: number };
}
function harness(result: IdentityWebhookProcessingResult | (() => Promise<IdentityWebhookProcessingResult>)): Harness {
  const logger = createTestLogger({ component: 'webhook' });
  const seen: Harness['seen'] = { calls: 0 };
  const service: Pick<IdentityWebhookService, 'handle'> = {
    handle(request: IdentityWebhookRequest, options) {
      seen.calls += 1;
      seen.rawBody = request.rawBody;
      seen.headers = request.headers;
      seen.options = options;
      return typeof result === 'function' ? result() : Promise.resolve(result);
    },
  };
  const handler = createClerkWebhookHandler({ service, logger: logger.logger, newCorrelationId: () => 'cid-test', now: () => 0 });
  return { handler, logger, seen };
}
const envelope = (code: ErrorCode): PublicErrorEnvelope => ({ category: 'authn', code, message: 'x', retryable: false });

describe('clerk webhook handler — accepted (uniform safe 200)', () => {
  for (const outcome of ['applied', 'duplicate', 'stale', 'deleted_identity_noop', 'security_conflict'] as const) {
    test(`processed:${outcome} → 200 { received: true }`, async () => {
      const h = harness({ kind: 'processed', outcome });
      const res = await h.handler(fakeRequest());
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toEqual({ received: true });
    });
  }

  test('verified-but-unsupported (ignored) → 200 { received: true }', async () => {
    const h = harness({ kind: 'ignored', eventType: 'session.revoked' });
    const res = await h.handler(fakeRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
  });
});

describe('clerk webhook handler — invalid status matrix', () => {
  const cases: ReadonlyArray<readonly [ErrorCode, number]> = [
    [ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_MISSING, 401],
    [ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_CONFLICT, 401],
    [ErrorCodes.WEBHOOK_SIGNATURE_INVALID, 401],
    [ErrorCodes.WEBHOOK_INSTANCE_MISMATCH, 401],
    [ErrorCodes.WEBHOOK_TIMESTAMP_INVALID, 400],
    [ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED, 400],
    [ErrorCodes.WEBHOOK_VERIFIER_FAILED, 500],
  ];
  for (const [code, status] of cases) {
    test(`${code} → ${status}`, async () => {
      const h = harness({ kind: 'invalid', error: envelope(code) });
      const res = await h.handler(fakeRequest());
      expect(res.status).toBe(status);
      const body = (await res.json()) as Record<string, unknown>;
      // never leaks the class beyond the status; body is a generic slug
      expect(Object.keys(body)).toEqual(['error']);
    });
  }
});

describe('clerk webhook handler — request rejections (verifier never called)', () => {
  test('unsupported content type → 415, service not called', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ contentType: 'text/plain' }));
    expect(res.status).toBe(415);
    expect(h.seen.calls).toBe(0);
  });

  test('missing content type → 415', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ contentType: null }));
    expect(res.status).toBe(415);
    expect(h.seen.calls).toBe(0);
  });

  test('application/json; charset=utf-8 is accepted (case-insensitive)', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ contentType: 'APPLICATION/JSON; charset=UTF-8' }));
    expect(res.status).toBe(200);
    expect(h.seen.calls).toBe(1);
  });

  test('oversized declared Content-Length → 413, body not read, service not called', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ contentLength: String(10 * 1024 * 1024) }));
    expect(res.status).toBe(413);
    expect(h.seen.calls).toBe(0);
  });

  test('malformed Content-Length → 400, service not called', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ contentLength: 'abc' }));
    expect(res.status).toBe(400);
    expect(h.seen.calls).toBe(0);
  });

  test('missing Content-Length within limit → accepted (200)', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ body: new Uint8Array([1, 2, 3]) }));
    expect(res.status).toBe(200);
    expect(h.seen.calls).toBe(1);
  });

  test('non-POST method → 405, service not called', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(fakeRequest({ method: 'GET' }));
    expect(res.status).toBe(405);
    expect(h.seen.calls).toBe(0);
  });
});

describe('clerk webhook handler — failures + safety', () => {
  test('service throw (processor/db failure) → sanitized 500', async () => {
    const h = harness(() => Promise.reject(new Error('db exploded: secret whsec_x for a@b.com')));
    const res = await h.handler(fakeRequest());
    expect(res.status).toBe(500);
    const body = JSON.stringify(await res.json());
    expect(body).not.toMatch(/whsec_|a@b\.com|exploded/i);
  });

  test('a sanitized PlatformError throw → 500 logs the stable code (no raw message/stack)', async () => {
    const h = harness(() => Promise.reject(platformError('conflict', { internalMessage: 'db error: whsec_x a@b.com', code: ErrorCodes.CONFLICT_DETECTED })));
    const res = await h.handler(fakeRequest());
    expect(res.status).toBe(500);
    const errorRecords = h.logger.records.filter((r) => r.level === 'error' && r.event === 'webhook.error');
    expect(errorRecords).toHaveLength(1);
    expect(errorRecords[0]?.metadata?.['errorCode']).toBe(ErrorCodes.CONFLICT_DETECTED);
    const logged = JSON.stringify(h.logger.records);
    expect(logged).not.toMatch(/whsec_|a@b\.com|db error/i); // no raw internal message/cause in logs
  });

  test('security_conflict → indistinguishable 200 but logged at warn for alerting', async () => {
    const h = harness({ kind: 'processed', outcome: 'security_conflict' });
    const res = await h.handler(fakeRequest());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
    const warnRecords = h.logger.records.filter((r) => r.level === 'warn' && r.event === 'webhook.security_conflict');
    expect(warnRecords).toHaveLength(1);
  });

  test('exact arbitrary bytes reach the service unchanged', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const bytes = new Uint8Array([0x7b, 0xff, 0x00, 0xc3, 0xbf, 0x7d]);
    await h.handler(fakeRequest({ body: bytes }));
    expect(Array.from(h.seen.rawBody ?? [])).toEqual(Array.from(bytes));
  });

  test('no JSON parsing occurs in the route', async () => {
    const spy = vi.spyOn(JSON, 'parse');
    const h = harness({ kind: 'processed', outcome: 'applied' });
    spy.mockClear();
    const res = await h.handler(fakeRequest({ body: new Uint8Array([0x7b, 0x7d]) }));
    expect(spy.mock.calls.length).toBe(0);
    spy.mockRestore();
    expect(res.status).toBe(200);
  });

  test('forged browser identity headers have no effect on the outcome', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    const res = await h.handler(
      fakeRequest({ headers: { 'x-user-id': 'attacker', 'x-org-id': 'evil', authorization: 'Bearer forged', cookie: '__session=forged' } }),
    );
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ received: true });
  });

  test('sensitive values never reach the logs', async () => {
    const h = harness({ kind: 'processed', outcome: 'applied' });
    await h.handler(fakeRequest({ headers: { 'svix-signature': 'v1,DEADBEEF', 'x-email': 'person@example.com' }, body: new Uint8Array([0x7b, 0x7d]) }));
    const logged = JSON.stringify(h.logger.records);
    expect(logged).not.toMatch(/DEADBEEF|person@example\.com|v1,/i);
    // only safe fields are present
    expect(logged).toContain('cid-test');
    expect(logged).toContain('POST /api/webhooks/clerk');
  });
});
