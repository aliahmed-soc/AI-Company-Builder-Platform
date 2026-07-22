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
} as const;

export type AuditEventName = keyof typeof AUDIT_EVENTS;
export function isAuditEventName(v: unknown): v is AuditEventName {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(AUDIT_EVENTS, v);
}

/** Bounded metadata: a flat map of scalars only. NO nesting, arrays, Error objects, secrets, or PII. */
export type AuditMetadata = Readonly<Record<string, string | number | boolean>>;

// Metadata bounds (references/digests only — EVENT-CATALOG `:18`). Deliberately tight.
const META_MAX_KEYS = 16;
const META_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/;
const META_MAX_VALUE_LEN = 512;
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
