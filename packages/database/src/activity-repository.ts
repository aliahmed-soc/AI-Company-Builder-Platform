// @acbp/database — synchronous company activity projection writer (ACBP-P1-009; CDR-016).
//
// Projects a durable company audit event into the append-only `activity_events` feed, in the SAME transaction and
// under the SAME CompanyScope as the lifecycle mutation + audit write (no outbox, no async projector, no worker).
// The projection is keyed by the SOURCE audit `event_id` (idempotent + rebuildable), and every identity/tenant/
// time field is bound server-side from the validated scope + the authoritative audit row it reads back in-tx —
// never caller-supplied. Only the four company events project; any other event name is a safe no-op (never a
// poison event). `audit_events` remains the source of record; this table carries only REDACTED display fields.
//
// This function is ALSO the single-event REBUILD mapping: given a CompanyScope and an audit company event, it
// derives the activity row purely from the authoritative audit row (occurred_at / actor) + the typed event
// (activity_type / subject / redacted payload), so a rebuild = re-running it over the audit company rows.
import { isProjectableActivity, activityDisplayPayload, validationError, type AuditEvent } from '@acbp/contracts';
import type { TenantScope } from './tenant.js';
import type { NewActivityEvent } from './schema.js';

/** The in-transaction projection seam (mirrors AuditWriteFn). Production uses {@link projectCompanyActivity}. */
export type ActivityWriteFn = (scope: TenantScope, event: AuditEvent, auditEventId: string) => Promise<void>;

/**
 * Project a company audit event into `activity_events` under `scope` (the enclosing CompanyScope transaction).
 * `auditEventId` is the id returned by the in-tx audit write; the projection reuses it as the PK so a retried
 * projection of the same audit event conflicts rather than duplicating a feed item. Returns without writing for a
 * non-company event (safe no-op). Throws on failure so the caller's transaction rolls back (fail-closed — the
 * activity row is written or the whole lifecycle op is undone).
 */
export async function projectCompanyActivity(scope: TenantScope, event: AuditEvent, auditEventId: string): Promise<void> {
  if (!isProjectableActivity(event.name)) return; // only company.created/updated/paused/resumed project

  // Read the AUTHORITATIVE audit row (in-tx; the dual-scope SELECT returns the current company's own event). Using
  // the audit occurred_at/actor keeps the live projection identical to a rebuild-from-audit (deterministic order).
  const source = await scope.db.selectFrom('audit_events').select(['occurred_at', 'actor_type', 'actor_id']).where('event_id', '=', auditEventId).executeTakeFirst();
  if (source === undefined) {
    // The audit row must exist in this transaction; its absence is an internal inconsistency (fail closed).
    throw validationError({ message: 'Cannot project activity: source audit event not found in the current scope.', fields: ['auditEventId'] });
  }

  const values: NewActivityEvent = {
    event_id: auditEventId,
    account_id: scope.tenant.accountId,
    company_id: scope.tenant.companyId,
    activity_type: event.name,
    schema_version: event.schemaVersion,
    occurred_at: source.occurred_at,
    actor_type: source.actor_type,
    actor_id: source.actor_id,
    subject_type: event.subjectType,
    subject_id: event.subjectId,
    payload: activityDisplayPayload(event),
  };
  await scope.db.insertInto('activity_events').values(values).execute();
}
