// @acbp/core — provider-neutral identity webhook SERVICE (ACBP-P1-002 Slice 3).
//
// Composes an injected IdentityWebhookVerifier with the transactional processor into a single testable
// unit that turns a neutral inbound request into a bounded neutral result. It knows NO provider SDK and
// NO framework (no Next.js): the caller (apps/web Route Handler, via the composition layer) owns HTTP
// and passes exact bytes + headers. Signature verification happens first; NO database write occurs
// before it succeeds. Unexpected database failures propagate as sanitized PlatformErrors for the caller
// to map to a safe 500 (so `applied`/`duplicate` are never distinguishable from a failure oracle).
import type { DatabaseClient } from '@acbp/database';
import type { IdentityWebhookRequest, IdentityWebhookVerifier, PublicErrorEnvelope, VerifiedIdentityWebhookEvent } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';
import { processVerifiedIdentityEvent, type IdentityEventOutcome, type IdentityEventProcessingResult } from './webhook-processor.js';

/** Bounded neutral result of handling one inbound webhook. Never carries PII, payload, or provider detail. */
export type IdentityWebhookProcessingResult =
  | { readonly kind: 'processed'; readonly outcome: IdentityEventOutcome }
  | { readonly kind: 'ignored'; readonly eventType: string }
  | { readonly kind: 'invalid'; readonly error: PublicErrorEnvelope };

export interface IdentityWebhookService {
  handle(request: IdentityWebhookRequest, options?: { readonly correlationId?: string }): Promise<IdentityWebhookProcessingResult>;
}

/** The transactional processor call, as a seam so the service is unit-testable without a database. */
export type IdentityEventProcessor = (
  client: DatabaseClient,
  event: VerifiedIdentityWebhookEvent,
  options: { readonly correlationId?: string; readonly logger?: Logger },
) => Promise<IdentityEventProcessingResult>;

export interface IdentityWebhookServiceDeps {
  readonly verifier: IdentityWebhookVerifier;
  readonly client: DatabaseClient;
  /** Test seam; production uses the transactional processVerifiedIdentityEvent. */
  readonly process?: IdentityEventProcessor;
  /**
   * Where a suppressed re-delivery is recorded (ACBP-P6-011; CDR-074 §5).
   *
   * THIS IS THE ONLY SURFACE THAT SUPPRESSES ANYTHING IN PRODUCTION TODAY — providers genuinely re-deliver
   * webhooks, so the receipt key genuinely fires. Found in review: the processor recorded the incident but this
   * service never passed it a logger, and its seam type could not carry one, so the counter was structurally
   * incapable of registering the one thing that actually happens. The suppression still WORKED; nobody could
   * ever have seen it.
   */
  readonly logger?: Logger;
}

export function createIdentityWebhookService(deps: IdentityWebhookServiceDeps): IdentityWebhookService {
  const process = deps.process ?? processVerifiedIdentityEvent;
  return {
    async handle(request, options = {}): Promise<IdentityWebhookProcessingResult> {
      const cid = options.correlationId;
      const verification = await deps.verifier.verify(request, cid !== undefined ? { correlation: { correlationId: cid } } : undefined);
      if (verification.status === 'invalid') return { kind: 'invalid', error: verification.error };
      if (verification.status === 'ignored') return { kind: 'ignored', eventType: verification.eventType };
      // Verified supported event → process (receipt + user mutation atomically). Throws propagate. The logger
      // travels with it so a suppressed re-delivery is recorded on the path that actually receives re-deliveries.
      const result = await process(deps.client, verification.event, {
        ...(cid !== undefined ? { correlationId: cid } : {}),
        ...(deps.logger !== undefined ? { logger: deps.logger } : {}),
      });
      return { kind: 'processed', outcome: result.outcome };
    },
  };
}
