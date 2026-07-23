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
import { isProjectableActivity, activitySummaryFor, validationError, type AuditEvent } from '@acbp/contracts';
import type { Kysely } from 'kysely';
import type { TenantScope } from './tenant.js';
import type { DatabaseSchema, NewActivityEvent, ActivityEventRow } from './schema.js';

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
    // NOTE: occurred_at round-trips through a JS Date here (node-postgres → Date → insert), which truncates to
    // MILLISECOND precision — the projection's documented precision grid. The migration backfill applies the
    // same date_trunc('milliseconds') so live projection == backfill == rebuild, and the cursor's millisecond
    // ISO timestamps compare exactly against the stored values (no keyset skip/duplicate at boundaries).
    occurred_at: source.occurred_at,
    actor_type: source.actor_type,
    actor_id: source.actor_id,
    subject_type: event.subjectType,
    subject_id: event.subjectId,
    // Per-type ALLOWLISTED summary only (CDR-016 redaction) — never the raw metadata bag.
    payload: activitySummaryFor(event.name, event.metadata),
  };
  await scope.db.insertInto('activity_events').values(values).execute();
}

export type ActivityExecutor = Kysely<DatabaseSchema>;

/** A traversal position tuple (event time + id tie-breaker). */
export interface ActivityKeyset {
  readonly occurredAt: Date;
  readonly eventId: string;
}

/**
 * Read-side of the activity feed (ACBP-P1-009). Company-scoped KEYSET pagination over `activity_events`, ordered
 * `occurred_at DESC, event_id DESC` (matches the `activity_events_feed_idx` index — no OFFSET scan). Runs on the
 * caller's CompanyScope executor, so RLS confines every row to the current account+company. Reads only; the
 * projection is append-only and written elsewhere in-transaction.
 */
export class ActivityFeedRepository {
  readonly #db: ActivityExecutor;
  constructor(db: ActivityExecutor) {
    this.#db = db;
  }

  /**
   * Fetch up to `limit` rows for a company, newest-first, applying:
   *  - `upper` (INCLUSIVE traversal upper bound, captured on the first page): rows at-or-older than the tuple —
   *    events inserted after the traversal began are excluded from later pages of the same traversal;
   *  - `after` (EXCLUSIVE keyset position, the last item of the previous page): rows strictly older.
   * The caller fetches `limit + 1` to detect a further page.
   */
  listByCompany(companyId: string, limit: number, opts: { upper?: ActivityKeyset; after?: ActivityKeyset } = {}): Promise<ActivityEventRow[]> {
    let q = this.#db.selectFrom('activity_events').selectAll().where('company_id', '=', companyId);
    const upper = opts.upper;
    if (upper !== undefined) {
      // Inclusive upper bound: (occurred_at, event_id) <= (upper.occurredAt, upper.eventId).
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '<', upper.occurredAt),
          eb.and([eb('occurred_at', '=', upper.occurredAt), eb('event_id', '<=', upper.eventId)]),
        ]),
      );
    }
    const after = opts.after;
    if (after !== undefined) {
      // Exclusive DESC keyset: strictly OLDER than the previous page's last item.
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '<', after.occurredAt),
          eb.and([eb('occurred_at', '=', after.occurredAt), eb('event_id', '<', after.eventId)]),
        ]),
      );
    }
    return q.orderBy('occurred_at', 'desc').orderBy('event_id', 'desc').limit(limit).execute();
  }
}
