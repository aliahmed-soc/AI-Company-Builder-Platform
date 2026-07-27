// @acbp/contracts — durable job contracts (ACBP-P5-001a; CDR-049 §3/§4; ADR-008). Zero-dep, provider-neutral:
// nothing here knows what a job RUNNER is, only what a job REQUEST must contain to be legitimate.
//
// This file is the third of the three deliberately redundant refusal layers (CDR-049 §3-G3). The other two live in
// the database — `NOT NULL` catches code that forgets the fields, dual-keyed RLS `WITH CHECK` catches a caller
// supplying someone else's ids — and neither can be reached from a unit test or produce a reason a caller can act on.
//
// The failure being excluded is NOT a crash. It is a job that loses its tenant context somewhere in the enqueue path,
// receives a plausible default ("the current company", "the first company", NULL-means-system), and then executes
// successfully against the wrong tenant. Defaulting is worse than crashing because it succeeds.

/**
 * The CLOSED set of job kinds.
 *
 * Validated here rather than by a DB CHECK (CDR-049 §4) so that adding a job type is a code change with a test, not a
 * migration. The set is deliberately small: a kind exists once something enqueues it.
 */
export const JOB_KINDS = ['understanding.generate', 'strategy.generate', 'planning.tasks'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export function isJobKind(value: unknown): value is JobKind {
  return typeof value === 'string' && (JOB_KINDS as readonly string[]).includes(value);
}

/**
 * The CLOSED job lifecycle set, mirroring the `jobs_state_valid` CHECK exactly.
 *
 * Declared in full here — including `dead_letter`, which only **P5-001c** ever reaches — for the same reason the
 * migration declares it up front (CDR-049 §4-G6): a state introduced later is a state the earlier code never handled.
 * Having the contract lag the database would be worse than either, because a reader would take this list as the
 * answer to "what states exist" and be wrong. A real-PostgreSQL test asserts the two sets agree.
 */
export const JOB_STATES = ['queued', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled'] as const;
export type JobState = (typeof JOB_STATES)[number];

export function isJobState(value: unknown): value is JobState {
  return typeof value === 'string' && (JOB_STATES as readonly string[]).includes(value);
}

/** Mirrors the `jobs_kind_len` CHECK, so nothing can be valid here and rejected by the database. */
export const JOB_KIND_MAX = 100;
/** Mirrors the `jobs_idempotency_len` CHECK. */
export const JOB_IDEMPOTENCY_KEY_MAX = 200;
/**
 * The platform bound on an encoded payload, in bytes.
 *
 * Deliberately HALF the database's `jobs_payload_bounded` CHECK (`pg_column_size(payload) <= 65536`) rather than
 * equal to it. The two measure different things — this counts UTF-8 JSON text, the CHECK counts jsonb's stored
 * representation — and a bound that merely *matched* would leave a band near the limit where a request passes here
 * and is rejected by the driver as an opaque constraint error. Keeping this strictly tighter makes the contract the
 * error surface and the CHECK a true backstop, which is the whole point of having both.
 */
export const JOB_PAYLOAD_MAX_BYTES = 32_768;

/**
 * What a caller supplies to enqueue a job.
 *
 * Every field is typed `unknown`-tolerant on purpose: this is a TRUST BOUNDARY, and the declared type is only a
 * promise. A caller reaching it from parsed JSON, a retry payload, or an HTTP body can pass anything at all, and
 * `validateJobRequest` — not the type system — is what decides.
 */
export interface JobRequestInput {
  readonly accountId?: string | null | undefined;
  readonly companyId?: string | null | undefined;
  readonly kind?: string | null | undefined;
  readonly payload?: Record<string, unknown> | null | undefined;
  readonly idempotencyKey?: string | null | undefined;
  readonly createdByUserId?: string | null | undefined;
}

/** A request that has been checked. Every field is present, and the ids are exactly what the caller supplied. */
export interface ValidJobRequest {
  readonly accountId: string;
  readonly companyId: string;
  readonly kind: JobKind;
  readonly payload: Record<string, unknown>;
  readonly idempotencyKey: string | null;
  readonly createdByUserId: string;
}

/**
 * Why a job request was refused. CLOSED, because a caller has to be able to switch exhaustively and a log or alarm
 * renders it. `missing_*` and `invalid_*` are kept apart for the tenancy fields specifically: "nobody told us which
 * company" and "we were told a company that cannot exist" are different bugs, and the first is the one that a
 * defaulting implementation would have silently repaired.
 */
export type JobRequestFailure =
  | 'missing_account'
  | 'missing_company'
  | 'invalid_account'
  | 'invalid_company'
  | 'invalid_kind'
  | 'invalid_actor'
  | 'invalid_idempotency_key'
  | 'payload_too_large'
  | 'invalid_payload';

export type JobRequestResult = { readonly ok: true; readonly value: ValidJobRequest } | { readonly ok: false; readonly reason: JobRequestFailure };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UTF-8 byte length of a string.
 *
 * Hand-rolled rather than reaching for `Buffer` (a Node global) or `TextEncoder` (which this package's `lib` does not
 * include): the whole point of `@acbp/contracts` is that it runs anywhere, and a size bound is not worth acquiring a
 * runtime assumption for. Surrogate PAIRS are counted once at four bytes; a LONE surrogate — which `JSON.stringify`
 * can legitimately emit — counts as three, matching how UTF-8 encoders substitute a replacement character.
 */
function utf8ByteLength(value: string): number {
  let bytes = 0;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < value.length) {
      const next = value.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
        continue;
      }
      bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

/** Present at all? A blank string is ABSENT, not a value — whitespace is exactly how "unset" arrives from a form. */
function isPresent(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Only the tenancy failures — the subset that must be reportable BEFORE a caller's scope is resolved. */
export type JobTenancyFailure = Extract<JobRequestFailure, 'missing_account' | 'missing_company' | 'invalid_account' | 'invalid_company'>;

export type JobTenancyResult =
  | { readonly ok: true; readonly value: { readonly accountId: string; readonly companyId: string } }
  | { readonly ok: false; readonly reason: JobTenancyFailure };

/**
 * Validate ONLY the tenant context.
 *
 * Split out from {@link validateJobRequest} for a reason found in review: scope resolution denies an absent company
 * before any use-case validation runs, so a context-stripped enqueue would have been reported as `forbidden` —
 * indistinguishable from an authorization failure, and therefore not the *typed* refusal the acceptance clause
 * ("context-stripped job refused") requires. A caller has to be able to see, and the platform has to be able to alarm
 * on, "a job arrived with no tenant context" as its own fact.
 *
 * Safe to run before authorization, unlike the rest of the validation: it reports only on the SHAPE of ids the caller
 * themselves supplied. It reveals nothing about whether a company exists, who is a member, or any platform state — so
 * it is not the oracle that `invalid_kind` or `payload_too_large` would be.
 */
export function validateJobTenancy(input: JobRequestInput): JobTenancyResult {
  const accountId: unknown = input.accountId;
  const companyId: unknown = input.companyId;
  if (!isPresent(accountId)) return { ok: false, reason: 'missing_account' };
  if (!isPresent(companyId)) return { ok: false, reason: 'missing_company' };
  // A UUID check, not a non-empty check: `'system'`, `'null'`, `'0'` and `'default'` are all present and all
  // non-empty, and every one of them is a sentinel a defaulting implementation might have written.
  if (!UUID.test(accountId)) return { ok: false, reason: 'invalid_account' };
  if (!UUID.test(companyId)) return { ok: false, reason: 'invalid_company' };
  return { ok: true, value: { accountId, companyId } };
}

/**
 * Validate an enqueue request, or refuse with a typed reason. NEVER repairs, defaults, or truncates.
 *
 * The order matters and is not cosmetic: tenancy is checked FIRST, so a request that is missing its company is
 * reported as missing its company rather than as (say) an over-long idempotency key it also happens to have. The
 * reason a caller sees should name the thing that makes the request dangerous, not the first thing that happens to
 * fail a regex.
 */
export function validateJobRequest(input: JobRequestInput): JobRequestResult {
  const tenancy = validateJobTenancy(input);
  if (!tenancy.ok) return tenancy;
  const { accountId, companyId } = tenancy.value;

  const kind: unknown = input.kind;
  if (!isJobKind(kind)) return { ok: false, reason: 'invalid_kind' };

  const actor: unknown = input.createdByUserId;
  if (!isPresent(actor) || !UUID.test(actor)) return { ok: false, reason: 'invalid_actor' };

  const key: unknown = input.idempotencyKey;
  let idempotencyKey: string | null = null;
  if (key !== undefined && key !== null) {
    // REFUSED, not truncated. Truncating two distinct keys to the same 200 characters MERGES two different jobs into
    // one, which is a silent loss of work rather than a visible error.
    if (typeof key !== 'string' || key.length === 0 || key.length > JOB_IDEMPOTENCY_KEY_MAX) return { ok: false, reason: 'invalid_idempotency_key' };
    idempotencyKey = key;
  }

  // Absent and explicit-null both mean "this job needs no references" and normalise to `{}`. That is NOT the same
  // call as the tenancy fields above, and the difference is the point: defaulting a missing company invents an
  // authority the caller never had, whereas defaulting a missing payload invents nothing — a job with an empty
  // payload fails when it runs instead of doing something plausible somewhere it should not.
  const payload: unknown = input.payload ?? {};
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return { ok: false, reason: 'invalid_payload' };
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(payload);
  } catch {
    // Circular, or a BigInt: not serialisable means not storable, and finding that out at the DB driver would
    // surface as an opaque provider error rather than a reason.
    return { ok: false, reason: 'invalid_payload' };
  }
  // `JSON.stringify` returns undefined for an object whose `toJSON` returns undefined — rare, but it would otherwise
  // reach the driver as a literal `undefined`.
  if (encoded === undefined) return { ok: false, reason: 'invalid_payload' };
  // Byte length, not character length — a payload of multi-byte characters is larger than it looks.
  if (utf8ByteLength(encoded) > JOB_PAYLOAD_MAX_BYTES) return { ok: false, reason: 'payload_too_large' };

  return { ok: true, value: { accountId, companyId, kind, payload: payload as Record<string, unknown>, idempotencyKey, createdByUserId: actor } };
}
