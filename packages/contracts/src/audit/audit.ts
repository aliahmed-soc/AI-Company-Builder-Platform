// @acbp/contracts — provider-neutral audit event contract (ACBP-P1-008; ADR-015; EVENT-CATALOG envelope;
// CDR-014 Option A). The transport- and provider-neutral currency for the append-only audit store.
//
// This module defines WHAT a durable audit event is, not how it is written. It is a distinct system from
// operational logging (@acbp/observability): audit events are typed, registered, bounded, and destined for an
// append-only, immutable store (invariant 11). Zero-dependency like the rest of @acbp/contracts.
//
// Forgery resistance: a caller may only describe an event's NAME, SUBJECT, OUTCOME, and BOUNDED METADATA via a
// typed factory. The account, actor, event id, and timestamp are bound SERVER-SIDE by the writer from the
// caller's validated AccountScope — never accepted here — so they cannot be forged through this contract.
import { validationError } from '../errors.js';
import type { CompanyCreationMode } from '../company/company.js';

/** Actor types (EVENT-CATALOG `actor.type`). `worker` actors can never appear on approval decisions (inv. 5). */
export type AuditActorType = 'user' | 'worker' | 'system' | 'admin';
export const AUDIT_ACTOR_TYPES: readonly AuditActorType[] = ['user', 'worker', 'system', 'admin'];
export function isAuditActorType(v: unknown): v is AuditActorType {
  return typeof v === 'string' && (AUDIT_ACTOR_TYPES as readonly string[]).includes(v);
}

/** Bounded outcome codes (not free text). */
export type AuditOutcome = 'success' | 'denied' | 'blocked';
export const AUDIT_OUTCOMES: readonly AuditOutcome[] = ['success', 'denied', 'blocked'];

/**
 * The CLOSED registry of durable audit event names (dot-namespaced, past tense) with the current schema
 * version per name. Anything not registered here is REJECTED (deny unregistered event types). CDR-014 Option A
 * persists exactly the two account-scoped high-risk lifecycle successes for the P1-008 first cut; more names
 * are added deliberately as later tickets migrate events.
 */
export const AUDIT_EVENTS = {
  'membership.invited': { schemaVersion: 1, subjectType: 'membership' },
  'membership.revoked': { schemaVersion: 1, subjectType: 'membership' },
  // Company lifecycle (ACBP-P1-010; CDR-015 §5) — exactly four durable company events. Company-scoped:
  // the writer stamps `company_id` from the CompanyScope (never caller-supplied).
  'company.created': { schemaVersion: 1, subjectType: 'company' },
  'company.updated': { schemaVersion: 1, subjectType: 'company' },
  'company.paused': { schemaVersion: 1, subjectType: 'company' },
  'company.resumed': { schemaVersion: 1, subjectType: 'company' },
  // Workspace provisioning (ACBP-P1-012; CDR-018 §8) — exactly six durable, company-scoped, AUDIT-ONLY events.
  // NONE of these are projectable into the activity feed (the P1-009 four-event taxonomy stays closed): the
  // projector's `isProjectableActivity` allowlist excludes them by construction. Subject is the company id.
  'provisioning.started': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_started': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_completed': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.step_failed': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.retry_requested': { schemaVersion: 1, subjectType: 'company' },
  'provisioning.completed': { schemaVersion: 1, subjectType: 'company' },
  // Platform-administrative access (ACBP-P1-013; CDR-019 §7) — exactly ONE audit-only admin event. Scoped to the
  // TARGET tenant (account+company stamped from the admin path's transaction-local target scope) so the access
  // is visible in that tenant's own audit trail (SECURITY §3 tenant visibility); actor_type='admin' with the
  // REAL administrator's internal user id. Never activity-projected.
  'admin.tenant_read': { schemaVersion: 1, subjectType: 'company' },
  // Interview session lifecycle (ACBP-P2-001; CDR-022 §4) — exactly ONE durable, company-scoped event: the
  // session was started (not_started→in_progress). Subject is the SESSION id (EVENT-CATALOG payload `session_id`);
  // the writer stamps `company_id`/`account_id` from the caller's CompanyScope. AUDIT-ONLY here — the EVENT-CATALOG
  // activity fan-out is DEFERRED (CDR-022 §4) so P1-009's closed activity taxonomy is not expanded in a
  // persistence slice. `interview.question_answered` (EVENT-CATALOG:48) is a P2-002 concern and is NOT registered.
  'interview.started': { schemaVersion: 1, subjectType: 'interview_session' },
} as const;

export type AuditEventName = keyof typeof AUDIT_EVENTS;
export function isAuditEventName(v: unknown): v is AuditEventName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, v);
}

/** Bounded metadata: a flat map of scalars only. NO nesting, arrays, Error objects, secrets, or PII. */
export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

// Metadata bounds (references/digests only — EVENT-CATALOG `:18`). Deliberately tight. The per-value length is
// measured in UTF-16 units and sized at 1024 so the canonically-mandated VERBATIM admin reason (ACBP-P1-013;
// CDR-019 §4: ≤512 UNICODE CODE POINTS, which is up to 1024 UTF-16 units when astral characters are used) can
// never be rejected at write time after passing its own strict validation. Every other producer stays far below.
const META_MAX_KEYS = 16;
const META_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const META_MAX_VALUE_LEN = 1024;
const META_MAX_TOTAL_BYTES = 4096;

/**
 * Validate + freeze caller metadata into bounded {@link AuditMetadata}. Rejects unknown value types (null,
 * undefined, objects, arrays, functions, symbols, bigint), non-finite numbers, over-long/mis-shaped keys,
 * over-long string values, too many keys, or an over-large serialized total. Throws a validation PlatformError
 * carrying only the offending KEY NAME (never the value). The audit writer must persist nothing that fails here.
 */
export function boundedMetadata(input: Readonly<Record<string, unknown>>): AuditMetadata {
  const keys = Object.keys(input);
  if (keys.length > META_MAX_KEYS) {
    throw validationError({ message: 'Audit metadata has too many keys.', fields: ['metadata'] });
  }
  const out: Record<string, string | number | boolean> = {};
  for (const key of keys) {
    if (!META_KEY_RE.test(key)) {
      throw validationError({ message: 'Audit metadata key is invalid.', fields: [`metadata.${key}`] });
    }
    const value = input[key];
    if (typeof value === 'string') {
      if (value.length > META_MAX_VALUE_LEN) throw validationError({ message: 'Audit metadata value is too long.', fields: [`metadata.${key}`] });
      out[key] = value;
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw validationError({ message: 'Audit metadata number is not finite.', fields: [`metadata.${key}`] });
      out[key] = value;
    } else if (typeof value === 'boolean') {
      out[key] = value;
    } else {
      // null, undefined, object, array, function, symbol, bigint — all rejected (no nesting, no Error objects).
      throw validationError({ message: 'Audit metadata value type is not allowed.', fields: [`metadata.${key}`] });
    }
  }
  if (JSON.stringify(out).length > META_MAX_TOTAL_BYTES) {
    throw validationError({ message: 'Audit metadata is too large.', fields: ['metadata'] });
  }
  return Object.freeze(out);
}

/** A subject identifier (bounded). `id` is an opaque internal id; `type` is a short registered noun. */
const SUBJECT_TYPE_RE = /^[a-z][a-z0-9_]{0,31}$/;
const SUBJECT_ID_MAX = 64;

/**
 * The caller-facing description of an event to record. Deliberately EXCLUDES account id, actor, event id, and
 * timestamp — those are bound server-side by the writer from the validated AccountScope (unforgeable).
 */
export interface AuditEvent {
  readonly name: AuditEventName;
  readonly schemaVersion: number;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly outcome: AuditOutcome;
  readonly metadata: AuditMetadata;
}

function makeEvent(name: AuditEventName, subjectId: string, outcome: AuditOutcome, metadata: Readonly<Record<string, unknown>>): AuditEvent {
  const spec = AUDIT_EVENTS[name];
  if (typeof subjectId !== 'string' || subjectId.length === 0 || subjectId.length > SUBJECT_ID_MAX) {
    throw validationError({ message: 'Audit subject id is invalid.', fields: ['subjectId'] });
  }
  if (!SUBJECT_TYPE_RE.test(spec.subjectType)) {
    throw validationError({ message: 'Audit subject type is invalid.', fields: ['subjectType'] });
  }
  return Object.freeze({ name, schemaVersion: spec.schemaVersion, subjectType: spec.subjectType, subjectId, outcome, metadata: boundedMetadata(metadata) });
}

// ── Typed event factories (the ONLY way to construct an AuditEvent — no free-form event objects) ────────────

/** A member was invited to an account (high-risk lifecycle transition; success). */
export function membershipInvited(input: { readonly membershipId: string; readonly role: 'owner' | 'viewer' }): AuditEvent {
  return makeEvent('membership.invited', input.membershipId, 'success', { role: input.role });
}

/** A membership was revoked (high-risk lifecycle transition; success). */
export function membershipRevoked(input: { readonly membershipId: string; readonly role: 'owner' | 'viewer' }): AuditEvent {
  return makeEvent('membership.revoked', input.membershipId, 'success', { role: input.role });
}

// ── Company lifecycle factories (ACBP-P1-010; CDR-015 §5). Subject is the company id; payloads carry only
//    bounded, non-PII references (creation mode, changed-field NAMES, optional coarse reason/count). ─────────

/** A company was created (subject = company id; success). */
export function companyCreated(input: { readonly companyId: string; readonly creationMode: CompanyCreationMode }): AuditEvent {
  return makeEvent('company.created', input.companyId, 'success', { creation_mode: input.creationMode });
}

/** A company profile/name was edited (success). Records the CHANGED FIELD NAMES only — never the values. */
export function companyUpdated(input: { readonly companyId: string; readonly changedFields: readonly string[] }): AuditEvent {
  // Metadata is a flat scalar map (no arrays), so the field NAMES are joined into a bounded string.
  return makeEvent('company.updated', input.companyId, 'success', { changed_fields: input.changedFields.join(',') });
}

/** A company was paused (success). Optional coarse, non-PII reason. */
export function companyPaused(input: { readonly companyId: string; readonly reason?: string }): AuditEvent {
  return makeEvent('company.paused', input.companyId, 'success', input.reason !== undefined ? { reason: input.reason } : {});
}

/** A company was resumed (success). Optional coarse reason + count of work items released on resume. */
export function companyResumed(input: { readonly companyId: string; readonly reason?: string; readonly heldWorkCount?: number }): AuditEvent {
  const metadata: Record<string, string | number> = {};
  if (input.reason !== undefined) metadata['reason'] = input.reason;
  if (input.heldWorkCount !== undefined) metadata['held_work_count'] = input.heldWorkCount;
  return makeEvent('company.resumed', input.companyId, 'success', metadata);
}

// ── Workspace-provisioning factories (ACBP-P1-012; CDR-018 §8). Subject is the company id. Metadata is the
//    EXACT per-event allowlist — bounded step/code identifiers and small integers only; never a raw exception,
//    SQL text, free-form reason, credential, or internal id. All AUDIT-ONLY (never activity-projected). ────────

/** Provisioning began for a company (seeded in the creation transaction, or first resume of a backfilled draft). */
export function provisioningStarted(input: { readonly companyId: string; readonly stepCount: number }): AuditEvent {
  return makeEvent('provisioning.started', input.companyId, 'success', { step_count: input.stepCount });
}

/** A provisioning step attempt began (recorded atomically with the attempt's committed outcome). */
export function provisioningStepStarted(input: { readonly companyId: string; readonly step: string; readonly attempt: number }): AuditEvent {
  return makeEvent('provisioning.step_started', input.companyId, 'success', { step: input.step, attempt: input.attempt });
}

/** A provisioning step completed with its closed result code. */
export function provisioningStepCompleted(input: { readonly companyId: string; readonly step: string; readonly attempt: number; readonly resultCode: string }): AuditEvent {
  return makeEvent('provisioning.step_completed', input.companyId, 'success', { step: input.step, attempt: input.attempt, result_code: input.resultCode });
}

/** A provisioning step failed with its closed failure code (controlled failure; the outcome is `blocked`). */
export function provisioningStepFailed(input: { readonly companyId: string; readonly step: string; readonly attempt: number; readonly failureCode: string }): AuditEvent {
  return makeEvent('provisioning.step_failed', input.companyId, 'blocked', { step: input.step, attempt: input.attempt, failure_code: input.failureCode });
}

/** An authenticated OWNER explicitly requested a resume of a failed step (the only user-actor provisioning event). */
export function provisioningRetryRequested(input: { readonly companyId: string; readonly step: string; readonly nextAttempt: number }): AuditEvent {
  return makeEvent('provisioning.retry_requested', input.companyId, 'success', { step: input.step, next_attempt: input.nextAttempt });
}

/** All six steps completed — recorded atomically with the onboarding→active transition. */
export function provisioningCompleted(input: { readonly companyId: string; readonly stepCount: number }): AuditEvent {
  return makeEvent('provisioning.completed', input.companyId, 'success', { step_count: input.stepCount });
}

// ── Platform-administrative access factory (ACBP-P1-013; CDR-019 §7). Subject = the TARGET company. ──────────

/**
 * An administrator read a tenant's company overview. Metadata is EXACTLY `{reason, scope}`: the reason is the
 * caller-validated VERBATIM string (strictly bounded upstream by `validateAdminReason` — ≤512 code points, no
 * NUL, non-empty; never trimmed/normalized), `scope` is the closed operation code. Never a route, IP,
 * user-agent, email, token, SQL, stack trace, or any other request field.
 */
export function adminTenantRead(input: { readonly companyId: string; readonly reason: string; readonly scope: string }): AuditEvent {
  return makeEvent('admin.tenant_read', input.companyId, 'success', { reason: input.reason, scope: input.scope });
}

// ── Interview session factory (ACBP-P2-001; CDR-022 §4). Subject = the session id. ───────────────────────────

/**
 * An interview session was started (not_started→in_progress; success). Subject is the SESSION id; the writer
 * stamps the owning company from the CompanyScope. Metadata is empty — the payload is the subject itself
 * (EVENT-CATALOG `session_id`), and no PII or free text is ever attached.
 */
export function interviewStarted(input: { readonly sessionId: string }): AuditEvent {
  return makeEvent('interview.started', input.sessionId, 'success', {});
}
