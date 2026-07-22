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
import { generateEventId, validationError, type AuditEvent, type AuditActorType } from '@acbp/contracts';
import type { AccountScope } from './account-tenant.js';
import type { TenantScope } from './tenant.js';
import type { NewAuditEvent } from './schema.js';

/**
 * The audit writer accepts EITHER an account scope (account-scoped event, `company_id` NULL) or a company
 * (tenant) scope (company-scoped event, `company_id` bound from the scope). In both cases account/actor/company
 * are taken from the validated scope — never caller-supplied (ACBP-P1-010; CDR-015 §6 dual-scope).
 */
export type AuditScope = AccountScope | TenantScope;

function scopeStamp(scope: AuditScope): { accountId: string; actorId: string | null; companyId: string | null } {
  if ('tenant' in scope) {
    return { accountId: scope.tenant.accountId, actorId: scope.tenant.actorId ?? null, companyId: scope.tenant.companyId };
  }
  return { accountId: scope.account.accountId, actorId: scope.account.actorId ?? null, companyId: null };
}

/** Correlation/causation/idempotency ids must be bounded opaque strings (server-generated). Guards against a
 *  future caller routing unbounded/user-derived data into these text columns (defense in depth). */
const MAX_CTX_ID_LEN = 200;
function boundedCtxId(value: string | undefined, field: string): string | null {
  if (value === undefined) return null;
  if (value.length > MAX_CTX_ID_LEN) throw validationError({ message: 'Audit context identifier is too long.', fields: [field] });
  return value;
}

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
export async function writeAuditEvent(scope: AuditScope, event: AuditEvent, ctx: AuditWriteContext = {}, nowMs: number = Date.now()): Promise<string> {
  const eventId = generateEventId(nowMs);
  const actorType: AuditActorType = ctx.actorType ?? 'user';
  // Bound from the validated scope — the account the caller is acting in, the (user-actor) server-verified
  // acting user id, and the company (only for a company scope). Never values the caller passed here.
  const { accountId, actorId, companyId } = scopeStamp(scope);
  const values: NewAuditEvent = {
    event_id: eventId,
    name: event.name,
    schema_version: event.schemaVersion,
    account_id: accountId,
    company_id: companyId,
    actor_type: actorType,
    actor_id: actorId,
    subject_type: event.subjectType,
    subject_id: event.subjectId,
    outcome: event.outcome,
    correlation_id: boundedCtxId(ctx.correlationId, 'correlationId'),
    causation_id: boundedCtxId(ctx.causationId, 'causationId'),
    idempotency_key: boundedCtxId(ctx.idempotencyKey, 'idempotencyKey'),
    payload: event.metadata,
  };
  await scope.db.insertInto('audit_events').values(values).execute();
  return eventId;
}
