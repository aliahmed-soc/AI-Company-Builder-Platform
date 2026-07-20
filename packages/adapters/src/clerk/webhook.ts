// @acbp/adapters — Clerk identity WEBHOOK verifier (ACBP-P1-002; ADR-022 §13, CDR-007/008).
//
// Implements the provider-neutral @acbp/contracts IdentityWebhookVerifier using the official
// @clerk/backend `verifyWebhook` (Standard Webhooks signature verification). The provider SDK, its
// exception types, the web `Request`/`Headers`, the signing secret, and any raw payload/PII stay
// INSIDE this adapter — only the neutral verified envelope (or a bounded, sanitized PublicErrorEnvelope
// / ignored result) crosses the contract boundary. Fail-closed: anything not provably an authentic,
// supported, well-formed event is rejected with a stable class. Nothing here logs.
//
// TRUST ORDER (§6): the ONLY thing done before verification is resolving the signature headers (no
// body decode, no JSON parse). The exact bytes + resolved headers go to the official verifier; only
// AFTER it succeeds is the authenticated envelope inspected, normalized, and hashed. We never
// reimplement signature verification.
import { createHash } from 'node:crypto';
import { verifyWebhook } from '@clerk/backend/webhooks';
import type { WebhookEvent } from '@clerk/backend/webhooks';
import { platformError, ErrorCodes, type ErrorCategory, type ErrorCode } from '@acbp/contracts';
import type { ClerkWebhookConfig } from '@acbp/config';
import { selectNormalizedPrimaryEmail } from './user-normalization.js';
import type {
  AdapterCallOptions,
  IdentityWebhookRequest,
  IdentityWebhookVerification,
  IdentityWebhookVerifier,
  NormalizedWebhookUser,
  VerifiedIdentityWebhookEvent,
} from '@acbp/contracts';

/** Clerk user payload shape for create/update events, derived from the SDK's own event union. */
type ClerkUserData = Extract<WebhookEvent, { type: 'user.created' | 'user.updated' }>['data'];

/** Injection seam: verifies + parses a signed webhook Request. Default wraps @clerk/backend. */
export type ClerkWebhookVerifyFn = (request: Request, options: { signingSecret: string }) => Promise<WebhookEvent>;

export interface ClerkIdentityWebhookVerifierOptions {
  readonly config: ClerkWebhookConfig;
  /** Test seam; production uses the official @clerk/backend verifyWebhook. */
  readonly verifyWebhook?: ClerkWebhookVerifyFn;
}

/** Stable, provider-neutral rejection classes. Never derived from raw provider text. */
type InvalidReason =
  | 'missing_signature_headers'
  | 'header_alias_conflict'
  | 'invalid_signature'
  | 'stale_timestamp'
  | 'malformed_payload'
  | 'instance_mismatch'
  | 'unexpected';

/**
 * Reason → stable public code + safe message + category + retryability. `code` is what lets a caller
 * tell these apart in the PublicErrorEnvelope (category alone can't: five of these are 'authn').
 * 'unexpected' is deliberately fail-closed (retryable:false, category 'internal') and is NEVER labeled
 * invalid_signature — an unknown verifier fault must not masquerade as a forged-signature verdict.
 */
const INVALID_SPECS: Record<InvalidReason, { readonly category: ErrorCategory; readonly code: ErrorCode; readonly message: string; readonly retryable: boolean }> = {
  missing_signature_headers: { category: 'authn', code: ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_MISSING, message: 'Webhook is missing required signature headers.', retryable: false },
  header_alias_conflict: { category: 'authn', code: ErrorCodes.WEBHOOK_SIGNATURE_HEADERS_CONFLICT, message: 'Webhook signature headers are inconsistent.', retryable: false },
  invalid_signature: { category: 'authn', code: ErrorCodes.WEBHOOK_SIGNATURE_INVALID, message: 'Webhook signature verification failed.', retryable: false },
  stale_timestamp: { category: 'authn', code: ErrorCodes.WEBHOOK_TIMESTAMP_INVALID, message: 'Webhook timestamp is outside the allowed tolerance.', retryable: false },
  malformed_payload: { category: 'validation', code: ErrorCodes.WEBHOOK_PAYLOAD_MALFORMED, message: 'Webhook payload is malformed.', retryable: false },
  instance_mismatch: { category: 'authn', code: ErrorCodes.WEBHOOK_INSTANCE_MISMATCH, message: 'Webhook is from an unrecognized provider instance.', retryable: false },
  unexpected: { category: 'internal', code: ErrorCodes.WEBHOOK_VERIFIER_FAILED, message: 'Webhook could not be processed.', retryable: false },
};

function invalid(reason: InvalidReason, correlationId?: string): IdentityWebhookVerification {
  const s = INVALID_SPECS[reason];
  // internalMessage carries only the stable class name (never the raw provider message/secret/PII).
  const err = platformError(s.category, {
    code: s.code,
    message: s.message,
    retryable: s.retryable,
    internalMessage: `identity webhook rejected: ${reason}`,
    metadata: { reason },
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
  return { status: 'invalid', error: err.toPublic() };
}

/** Classify a verifier throw into a stable class using ONLY the message — never surfaced downstream. */
function classifyVerifyError(e: unknown): InvalidReason {
  if (e instanceof SyntaxError) return 'malformed_payload';
  const text = (e instanceof Error ? e.message : typeof e === 'string' ? e : '').toLowerCase();
  if (/timestamp/.test(text)) return 'stale_timestamp';
  if (/signature|no matching|invalid.*header|verification failed|webhook.*(secret|verification)/.test(text)) return 'invalid_signature';
  // Anything we cannot positively recognize is an UNEXPECTED fault — never a signature verdict.
  return 'unexpected';
}

function isoFromMs(ms: unknown): string | null {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const t = d.getTime();
  if (!Number.isFinite(t)) return null;
  return d.toISOString();
}

/** ISO-8601 from a Unix-SECONDS string — the Standard Webhooks `svix-timestamp` delivery header. */
function isoFromUnixSeconds(value: string): string | null {
  const secs = Number(value);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  const d = new Date(secs * 1000);
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Primary email selection/normalization via the shared adapter helper (no webhook/read-through drift). */
function selectPrimaryEmail(data: ClerkUserData): { readonly primaryEmail: string | null; readonly emailVerified: boolean } {
  return selectNormalizedPrimaryEmail(
    data.primary_email_address_id,
    data.email_addresses.map((e) => ({ id: e.id, email: e.email_address, verified: e.verification?.status === 'verified' })),
  );
}

type SignatureField = 'id' | 'timestamp' | 'signature';
type ResolvedSignatureHeaders = { readonly id: string; readonly timestamp: string; readonly signature: string };
type SignatureHeaderResolution = { readonly ok: true; readonly headers: ResolvedSignatureHeaders } | { readonly ok: false; readonly reason: 'missing_signature_headers' | 'header_alias_conflict' };

/**
 * Resolve the Standard Webhooks signature headers case-insensitively across BOTH naming aliases
 * (`svix-*` and `webhook-*`). For each field the distinct values seen across aliases (and any casing
 * variants) are collected: 0 → missing; exactly 1 → accepted; ≥2 distinct → a conflict we must NOT
 * silently resolve (fail-closed). Values are never logged.
 */
function resolveSignatureHeaders(headers: Readonly<Record<string, string>>): SignatureHeaderResolution {
  const valuesByLowerName = new Map<string, Set<string>>();
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    const set = valuesByLowerName.get(lower) ?? new Set<string>();
    set.add(value);
    valuesByLowerName.set(lower, set);
  }
  const resolveField = (field: SignatureField): { value?: string; conflict: boolean } => {
    const distinct = new Set<string>();
    for (const alias of [`svix-${field}`, `webhook-${field}`]) {
      const set = valuesByLowerName.get(alias);
      if (set) for (const v of set) distinct.add(v);
    }
    if (distinct.size === 0) return { conflict: false };
    if (distinct.size > 1) return { conflict: true };
    const [value] = distinct;
    return value === undefined ? { conflict: false } : { value, conflict: false };
  };
  const id = resolveField('id');
  const timestamp = resolveField('timestamp');
  const signature = resolveField('signature');
  if (id.conflict || timestamp.conflict || signature.conflict) return { ok: false, reason: 'header_alias_conflict' };
  if (id.value === undefined || timestamp.value === undefined || signature.value === undefined) return { ok: false, reason: 'missing_signature_headers' };
  return { ok: true, headers: { id: id.value, timestamp: timestamp.value, signature: signature.value } };
}

/**
 * Reconstruct a web-standard Request for the official verifier from the EXACT bytes and the resolved,
 * conflict-free signature headers (emitted under canonical `svix-*` names so the SDK verifies against
 * exactly the values we validated). The body is a defensive copy so nothing downstream can mutate the
 * buffer we verify/hash. No decode/re-encode occurs.
 */
function buildRequest(rawBody: Uint8Array, sig: ResolvedSignatureHeaders): Request {
  const headers = new Headers();
  headers.set('svix-id', sig.id);
  headers.set('svix-timestamp', sig.timestamp);
  headers.set('svix-signature', sig.signature);
  return new Request('https://acbp.internal/api/webhooks/clerk', { method: 'POST', headers, body: rawBody.slice() });
}

export class ClerkIdentityWebhookVerifier implements IdentityWebhookVerifier {
  readonly #config: ClerkWebhookConfig;
  readonly #verify: ClerkWebhookVerifyFn;

  constructor(options: ClerkIdentityWebhookVerifierOptions) {
    this.#config = options.config;
    this.#verify = options.verifyWebhook ?? ((req, opts) => verifyWebhook(req, opts));
  }

  async verify(request: IdentityWebhookRequest, options?: AdapterCallOptions): Promise<IdentityWebhookVerification> {
    const cid = options?.correlation?.correlationId;

    // (1) Pre-verification: resolve signature headers only. No body decode, no JSON parse yet.
    const sig = resolveSignatureHeaders(request.headers);
    if (!sig.ok) return invalid(sig.reason, cid);

    // (2) Verify the EXACT bytes with the official Clerk helper. The Secret is revealed ONLY here.
    let evt: WebhookEvent;
    try {
      evt = await this.#verify(buildRequest(request.rawBody, sig.headers), { signingSecret: this.#config.signingSecret.reveal() });
    } catch (e) {
      // A verifier throw ends processing here: no authenticated field is ever accessed.
      return invalid(classifyVerifyError(e), cid);
    }

    // (3) Only now inspect the AUTHENTICATED event. Clerk webhook bodies carry NO top-level instance_id
    // or timestamp (verified against live deliveries: the only top-level keys are type/object/data/
    // event_attributes). The delivery is cryptographically bound to ONE Clerk instance by the
    // instance-specific signing secret, so providerInstanceId is the CONFIGURED expected instance id
    // (required on this path). The delivery time comes from the signed svix-timestamp header (Unix
    // seconds). Per-event ordering still uses the user's own updated_at for create/update.
    const providerInstanceId = this.#config.expectedInstanceId ?? '';
    const occurredAt = isoFromUnixSeconds(sig.headers.timestamp);
    const eventId = sig.headers.id; // delivery id comes ONLY from the authenticated delivery headers
    if (eventId.length === 0 || providerInstanceId.length === 0 || occurredAt === null) return invalid('malformed_payload', cid);

    // (4) Hash is computed from the exact verified bytes (never a re-encode of parsed fields).
    const payloadSha256 = sha256Hex(request.rawBody);
    const base = { provider: 'clerk', providerInstanceId, eventId, occurredAt, payloadSha256 } as const;

    if (evt.type === 'user.created' || evt.type === 'user.updated') {
      const data = evt.data;
      const providerUserId = data.id;
      const providerUpdatedAt = isoFromMs(data.updated_at);
      if (typeof providerUserId !== 'string' || providerUserId.length === 0 || providerUpdatedAt === null) return invalid('malformed_payload', cid);
      const providerCreatedAt = isoFromMs(data.created_at);
      const email = selectPrimaryEmail(data);
      const user: NormalizedWebhookUser = {
        providerUserId,
        primaryEmail: email.primaryEmail,
        emailVerified: email.emailVerified,
        providerUpdatedAt,
        ...(providerCreatedAt !== null ? { providerCreatedAt } : {}),
      };
      const event: VerifiedIdentityWebhookEvent = { ...base, type: evt.type, providerUserId, orderingTimestamp: providerUpdatedAt, user };
      return { status: 'verified', event };
    }

    if (evt.type === 'user.deleted') {
      const id = evt.data.id;
      if (typeof id !== 'string' || id.length === 0) return invalid('malformed_payload', cid);
      // Deletes carry no PII; ordering uses the verified envelope timestamp.
      const event: VerifiedIdentityWebhookEvent = { ...base, type: 'user.deleted', providerUserId: id, orderingTimestamp: occurredAt };
      return { status: 'verified', event };
    }

    // Any other successfully verified event is acknowledged and ignored (not a parse failure).
    return { status: 'ignored', provider: 'clerk', providerInstanceId, eventId, eventType: evt.type };
  }
}
