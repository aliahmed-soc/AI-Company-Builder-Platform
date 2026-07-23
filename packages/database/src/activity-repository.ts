// @acbp/database — synchronous company activity projection writer (ACBP-P1-009; CDR-016).
//
// Projects a durable company audit event into the append-only `activity_events` feed, in the SAME transaction and
// under the SAME CompanyScope as the lifecycle mutation + audit write (no outbox, no async projector, no worker).
// The projection is keyed by the SOURCE audit `event_id` (idempotent + rebuildable), and every identity/tenant/
// time field is bound server-side from the validated scope + the authoritative audit row it reads back in-tx —
// never caller-supplied. Only the four company events project; any other event name is a safe no-op (never a
// poison event). `audit_events` remains the source of record; this table carries only REDACTED display fields.
//
// The canonical REBUILD mapping is the SQL in migration 0009's backfill (idempotent via ON CONFLICT DO NOTHING,
// run on the migration connection). This live projector uses the IDENTICAL SQL derivation (a single
// INSERT…SELECT copying `ae.occurred_at` EXACTLY — sub-millisecond microseconds included, no truncation), so a
// live-projected row and a backfilled/rebuilt row are bit-identical — but the live path deliberately has NO
// conflict handling: no live path ever replays an audit id (each attempt mints a fresh ULID), so a duplicate
// here is an internal bug and must fail LOUDLY, rolling the whole operation back (reviews F2/L1).
import { isProjectableActivity, activitySummaryFor, validationError, type AuditEvent } from '@acbp/contracts';
import { sql, type Kysely } from 'kysely';
import type { TenantScope } from './tenant.js';
import type { DatabaseSchema, ActivityEventRow } from './schema.js';

/** The in-transaction projection seam (mirrors AuditWriteFn). Production uses {@link projectCompanyActivity}. */
export type ActivityWriteFn = (scope: TenantScope, event: AuditEvent, auditEventId: string) => Promise<void>;

/**
 * Project a company audit event into `activity_events` under `scope` (the enclosing CompanyScope transaction).
 * `auditEventId` is the id returned by the in-tx audit write; the projection reuses it as the PK. Returns without
 * writing for a non-company event (safe no-op). Throws on failure so the caller's transaction rolls back
 * (fail-closed — the activity row is written or the whole lifecycle op is undone).
 *
 * A single INSERT…SELECT derives the time/actor fields from the AUTHORITATIVE audit row entirely in SQL:
 * `occurred_at` is copied EXACTLY (`ae.occurred_at`, sub-millisecond microseconds included — no truncation, no
 * JavaScript float/date parsing anywhere in the time path), identical to the 0009 backfill, so live projection,
 * backfill, and rebuild are bit-identical and the microsecond-precision cursor round-trips exactly.
 */
export async function projectCompanyActivity(scope: TenantScope, event: AuditEvent, auditEventId: string): Promise<void> {
  if (!isProjectableActivity(event.name)) return; // only company.created/updated/paused/resumed project

  // Per-type ALLOWLISTED summary only (CDR-016 redaction) — never the raw metadata bag.
  const summary = JSON.stringify(activitySummaryFor(event.name, event.metadata));
  const result = await sql`
    insert into activity_events
      (event_id, account_id, company_id, activity_type, schema_version, occurred_at, actor_type, actor_id, subject_type, subject_id, payload)
    select
      ae.event_id,
      ${scope.tenant.accountId}::uuid,
      ${scope.tenant.companyId}::uuid,
      ${event.name},
      ${event.schemaVersion},
      ae.occurred_at,
      ae.actor_type,
      ae.actor_id,
      ${event.subjectType},
      ${event.subjectId},
      ${summary}::jsonb
    from audit_events ae
    where ae.event_id = ${auditEventId}
  `.execute(scope.db);

  // Fail closed: the audit row MUST exist in this transaction (the dual-scope audit SELECT returns the current
  // company's own event). Zero rows projected = internal inconsistency → throw → the whole lifecycle op rolls back.
  if (Number(result.numAffectedRows ?? 0n) !== 1) {
    throw validationError({ message: 'Cannot project activity: source audit event not found in the current scope.', fields: ['auditEventId'] });
  }
}

export type ActivityExecutor = Kysely<DatabaseSchema>;

/**
 * A traversal position tuple: the EXACT stored event time as an ISO-8601 UTC string with up to MICROSECOND
 * precision (bound into SQL via a `::timestamptz` cast — PostgreSQL parses its own microsecond precision
 * exactly, so no JS Date/float ever touches the ordering key) + the id tie-breaker.
 */
export interface ActivityKeyset {
  readonly occurredAt: string;
  readonly eventId: string;
}

/** A feed row + the exact microsecond epoch of its occurred_at (int64 as text — no float, no JS Date loss). */
export type ActivityFeedRow = ActivityEventRow & { readonly occurred_at_us: string };

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
   * The caller fetches `limit + 1` to detect a further page. Each row carries `occurred_at_us` — the exact
   * microsecond epoch (`(extract(epoch from …) * 1000000)::bigint`, exact numeric math in PostgreSQL 14+) from
   * which the service builds the exact ISO the DTO/cursor use.
   */
  listByCompany(companyId: string, limit: number, opts: { upper?: ActivityKeyset; after?: ActivityKeyset } = {}): Promise<ActivityFeedRow[]> {
    let q = this.#db
      .selectFrom('activity_events')
      .selectAll()
      .select(sql<string>`(extract(epoch from occurred_at) * 1000000)::bigint::text`.as('occurred_at_us'))
      .where('company_id', '=', companyId);
    const upper = opts.upper;
    if (upper !== undefined) {
      // Inclusive upper bound: (occurred_at, event_id) <= (upper.occurredAt, upper.eventId).
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '<', sql<Date>`${upper.occurredAt}::timestamptz`),
          eb.and([eb('occurred_at', '=', sql<Date>`${upper.occurredAt}::timestamptz`), eb('event_id', '<=', upper.eventId)]),
        ]),
      );
    }
    const after = opts.after;
    if (after !== undefined) {
      // Exclusive DESC keyset: strictly OLDER than the previous page's last item.
      q = q.where((eb) =>
        eb.or([
          eb('occurred_at', '<', sql<Date>`${after.occurredAt}::timestamptz`),
          eb.and([eb('occurred_at', '=', sql<Date>`${after.occurredAt}::timestamptz`), eb('event_id', '<', after.eventId)]),
        ]),
      );
    }
    return q.orderBy('occurred_at', 'desc').orderBy('event_id', 'desc').limit(limit).execute();
  }
}
