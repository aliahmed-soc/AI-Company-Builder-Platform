// ACBP-P1-002 Slice 3 — Clerk webhook Route Handler FACTORY (apps/web).
//
// A testable handler factory (not hard-coded deps): it owns the Next.js/web Request→Response boundary
// and the safe processing order (§9): correlation id → content type → body-size limit → exact bytes →
// neutral headers → neutral webhook service → safe response + safe log. It does NOT parse JSON, does
// NOT validate signatures (the injected service's verifier does), and never surfaces internal ids,
// email, hashes, headers, SQL, or provider errors. No database write happens before verification (the
// service enforces that). Production wiring lives in clerk-runtime.ts.
import type { IdentityWebhookService } from '@acbp/core';
import { PlatformError, ErrorCodes, type ErrorCategory, type ErrorCode } from '@acbp/contracts';
import { newCorrelationId as defaultNewCorrelationId, type Logger } from '@acbp/observability';
import { isJsonContentType, statusForWebhookCode, genericErrorBody, collectHeaders } from './http.js';
import { readLimitedRawBody, MAX_WEBHOOK_BODY_BYTES } from './raw-body.js';

const ROUTE = 'POST /api/webhooks/clerk';

export interface ClerkWebhookHandlerDeps {
  readonly service: Pick<IdentityWebhookService, 'handle'>;
  readonly logger: Logger;
  /** Test seams (production defaults to a random UUID and the wall clock). */
  readonly newCorrelationId?: () => string;
  readonly now?: () => number;
  readonly maxBodyBytes?: number;
}

export function createClerkWebhookHandler(deps: ClerkWebhookHandlerDeps): (request: Request) => Promise<Response> {
  const newId = deps.newCorrelationId ?? defaultNewCorrelationId;
  const now = deps.now ?? ((): number => Date.now());
  const maxBytes = deps.maxBodyBytes ?? MAX_WEBHOOK_BODY_BYTES;

  return async (request: Request): Promise<Response> => {
    const correlationId = newId();
    const startedAt = now();
    const respond = (status: number, body: unknown, level: 'info' | 'warn' | 'error', event: string, extra: Record<string, unknown> = {}): Response => {
      // Safe metadata only: correlation id, route, status, duration, and stable non-PII categories.
      deps.logger[level](event, { metadata: { correlationId, route: ROUTE, status, durationMs: now() - startedAt, ...extra } });
      return Response.json(body, { status });
    };

    // (1)+(2) Method + content type. Only POST + application/json reach the verifier.
    if (request.method !== 'POST') return respond(405, genericErrorBody(405), 'warn', 'webhook.method_not_allowed');
    if (!isJsonContentType(request.headers.get('content-type'))) return respond(415, genericErrorBody(415), 'warn', 'webhook.unsupported_media_type');

    // (3)+(4) Bounded, byte-exact body read.
    const body = await readLimitedRawBody(request, maxBytes);
    if (!body.ok) {
      if (body.reason === 'too_large') return respond(413, genericErrorBody(413), 'warn', 'webhook.payload_too_large');
      return respond(400, genericErrorBody(400), 'warn', 'webhook.bad_request');
    }

    // (5) Neutral headers, then (6) verify + (9) process via the injected service.
    const headers = collectHeaders(request.headers);
    let result: Awaited<ReturnType<IdentityWebhookService['handle']>>;
    try {
      result = await deps.service.handle({ rawBody: body.bytes, headers }, { correlationId });
    } catch (e) {
      // Sanitized: the underlying processor/database error is never surfaced to the caller. Log only
      // the stable code + category (from the already-sanitized PlatformError) for operator diagnosis —
      // never the raw message, cause, or stack.
      const errorCode: ErrorCode = e instanceof PlatformError ? e.code : ErrorCodes.INTERNAL_ERROR;
      const errorCategory: ErrorCategory = e instanceof PlatformError ? e.category : 'internal';
      return respond(500, genericErrorBody(500), 'error', 'webhook.error', { errorCode, errorCategory });
    }

    // (7)+(8)+(10) Map the bounded result to a safe response.
    switch (result.kind) {
      case 'invalid': {
        const status = statusForWebhookCode(result.error.code);
        return respond(status, genericErrorBody(status), 'warn', 'webhook.invalid', { code: result.error.code });
      }
      case 'ignored':
        return respond(200, { received: true }, 'info', 'webhook.ignored', { eventType: result.eventType });
      case 'processed': {
        // Same 200 {received:true} for applied/duplicate/stale/deleted_identity_noop/security_conflict:
        // the sender learns nothing about internal processing state (no probing oracle). A
        // security_conflict (same event id, different payload hash) is a tamper/secret-compromise
        // signal, so it is logged at warn for alerting — but the response is still an indistinguishable 200.
        const suspicious = result.outcome === 'security_conflict';
        return respond(
          200,
          { received: true },
          suspicious ? 'warn' : 'info',
          suspicious ? 'webhook.security_conflict' : 'webhook.processed',
          { resultCategory: result.outcome },
        );
      }
    }
  };
}
