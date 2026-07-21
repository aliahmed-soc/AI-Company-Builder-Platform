// @acbp/database — append-only audit writer (ACBP-P1-008; ADR-015; CDR-014 Option A).
//
// The ONLY write path into `audit_events`. It appends an event WITHIN the caller's AccountScope — i.e. inside
// `withAccountTransaction`, in the SAME transaction as the business mutation it records — so a write failure
// rolls the transaction back and blocks the action (ADR-015 high-risk in-tx discipline; FAILURE row 14).
//
// Forgery resistance: `account_id` and `actor_id` are bound SERVER-SIDE from the validated AccountScope (never
// caller-supplied); `event_id` is a server-generated ULID; `occurred_at` is the database clock. The caller
// supplies only the typed AuditEvent (registered name + subject + outcome + bounded metadata). There is no
// UPDATE/DELETE method — immutability is enforced by the table's grants/policies (invariant 11).
import { generateEventId, type AuditEvent, type AuditActorType } from '@acbp/contracts';
import type { AccountScope } from './account-tenant.js';
import type { NewAuditEvent } from './schema.js';

export interface AuditWriteContext {
  /** Actor type (EVENT-CATALOG). Defaults to 'user' — the account flows P1-008 audits are user-initiated. */
  readonly actorType?: AuditActorType;
  readonly correlationId?: string;
  readonly causationId?: string;
  /** Idempotency key for retried producers (unique when present). */
  readonly idempotencyKey?: string;
}

/**
 * Append an audit event under `scope`, returning the server-generated ULID event id. Runs on `scope.db` (the
 * enclosing transaction). Throws on failure (the caller's transaction rolls back). `nowMs` is injectable for
 * deterministic tests; production uses the wall clock for the ULID timestamp only (the authoritative time is
 * the DB `occurred_at`).
 */
export async function writeAuditEvent(scope: AccountScope, event: AuditEvent, ctx: AuditWriteContext = {}, nowMs: number = Date.now()): Promise<string> {
  const eventId = generateEventId(nowMs);
  const actorType: AuditActorType = ctx.actorType ?? 'user';
  const values: NewAuditEvent = {
    event_id: eventId,
    name: event.name,
    schema_version: event.schemaVersion,
    // Bound from the validated scope — the account the caller is acting in, and (for user actors) the
    // server-verified acting user id. Never a value the caller passed to this function.
    account_id: scope.account.accountId,
    actor_type: actorType,
    actor_id: scope.account.actorId ?? null,
    subject_type: event.subjectType,
    subject_id: event.subjectId,
    outcome: event.outcome,
    correlation_id: ctx.correlationId ?? null,
    causation_id: ctx.causationId ?? null,
    idempotency_key: ctx.idempotencyKey ?? null,
    payload: event.metadata,
  };
  await scope.db.insertInto('audit_events').values(values).execute();
  return eventId;
}
