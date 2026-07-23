// @acbp/core — company activity feed read use case (ACBP-P1-009; CDR-016; ACT-001/003). API-only.
//
// Runs under the caller's validated CompanyScope (runInCompanyScope): active company membership required, the
// `activity:read` role check gates the read (owner|viewer), and the keyset query is RLS-confined to the current
// account+company. Renders company events ONLY (the projection contains nothing else).
//
// Traversal model (CDR-016):
//  - Deterministic order `occurred_at DESC, event_id DESC`.
//  - The FIRST page captures an IMMUTABLE traversal upper bound (the newest row at traversal start) — later
//    pages apply BOTH the upper bound and the exclusive keyset-after predicate, so events inserted after page 1
//    are excluded from that traversal (a fresh traversal includes them). No snapshot isolation across requests
//    is claimed beyond this bound.
//  - The cursor is opaque base64url, versioned, and bound to the ACCOUNT+COMPANY; a malformed/foreign cursor is
//    rejected (`invalid_cursor`), never a fallback scan. Tampering can only move the position inside the
//    already-authorized company.
//  - Honest metadata: `projectionMode: 'synchronous'`; `asOf` = the POSTGRESQL read timestamp of this query's
//    transaction (never app wall-clock); `sourceThrough` = the traversal upper bound (null when empty);
//    `lagSeconds: 0` (the projection commits atomically with its source).
import { sql } from 'kysely';
import { ActivityFeedRepository, type DatabaseClient, type ActivityKeyset } from '@acbp/database';
import { runInCompanyScope } from './company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  clampActivityPageSize,
  decodeActivityCursor,
  encodeActivityCursor,
  executionStateFor,
  activitySummaryFor,
  isActivityType,
  microsecondEpochToIso,
  type ActivityEventDTO,
  type ActivityPage,
  type ActivityPosition,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface GetActivityParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Opaque cursor from a previous page's `nextCursor`. Absent → first page (captures the upper bound). */
  readonly cursor?: unknown;
  /** Requested page size (clamped to [1, 100], default 25). */
  readonly limit?: unknown;
}

export interface GetActivityOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type GetActivityResult =
  | { readonly status: 'ok'; readonly page: ActivityPage }
  | { readonly status: 'forbidden' }
  | { readonly status: 'invalid_cursor' };

function toDTO(row: { event_id: string; activity_type: string; occurred_at_us: string; actor_type: string; payload: Record<string, string | number | boolean> }): ActivityEventDTO | null {
  // Fail SAFE on an out-of-taxonomy stored type (unreachable behind the DB CHECK): the row is dropped, never
  // emitted as a generic raw event.
  if (!isActivityType(row.activity_type)) return null;
  // EXACT temporal identity: occurredAt is rebuilt from the microsecond epoch PostgreSQL computed with exact
  // numeric math — the stored sub-millisecond timestamp round-trips into the DTO/cursor with no truncation and
  // no JS Date/float in the path (a malformed epoch is an internal inconsistency → drop fail-safe).
  const occurredAt = microsecondEpochToIso(row.occurred_at_us);
  if (occurredAt === null) return null;
  return {
    id: row.event_id,
    type: row.activity_type,
    occurredAt,
    state: executionStateFor(row.activity_type),
    actorType: row.actor_type,
    // Allowlist re-applied at read time (defense in depth over the stored payload).
    summary: activitySummaryFor(row.activity_type, row.payload),
  };
}

/**
 * Read a page of the company activity feed. Owner|viewer company members only (a non-member is denied at
 * resolution → coarse `forbidden`). A present-but-invalid cursor is rejected with `invalid_cursor`.
 */
export async function getCompanyActivity(client: DatabaseClient, params: GetActivityParams, options: GetActivityOptions = {}): Promise<GetActivityResult> {
  const limit = clampActivityPageSize(params.limit);

  // Validate the cursor (if any) BEFORE entering scope — a bad cursor is a clean client error, not a DB hit.
  let decoded: { after: ActivityPosition; upper: ActivityPosition } | undefined;
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
    const c = decodeActivityCursor(params.accountId, params.companyId, params.cursor);
    if (c === null) return { status: 'invalid_cursor' };
    decoded = c;
  }

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetActivityResult> => {
      if (checkAuthorization(role, 'activity:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      // Honest `asOf`: the DATABASE read timestamp of this transaction (never application wall-clock), delivered
      // as an exact microsecond epoch and formatted with integer math. A missing row is impossible for this
      // SELECT; failing closed (rather than a wall-clock fallback) keeps the "asOf is always PostgreSQL time"
      // invariant unconditionally true (security review LOW-2).
      const ts = await sql<{ us: string }>`select (extract(epoch from now()) * 1000000)::bigint::text as us`.execute(scope.db);
      const asOf = microsecondEpochToIso(ts.rows[0]?.us);
      if (asOf === null) throw new Error('activity feed: database read timestamp unavailable');

      const repo = new ActivityFeedRepository(scope.db);
      // The cursor's exact microsecond ISO strings bind straight into `::timestamptz` casts — PostgreSQL parses
      // its own precision exactly, so the keyset never passes through a JS Date.
      const toKeyset = (p: ActivityPosition): ActivityKeyset => ({ occurredAt: p.occurredAt, eventId: p.eventId });
      const rows = await repo.listByCompany(
        params.companyId,
        limit + 1,
        decoded !== undefined ? { upper: toKeyset(decoded.upper), after: toKeyset(decoded.after) } : {},
      );
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(toDTO).filter((d): d is ActivityEventDTO => d !== null);

      // The IMMUTABLE traversal upper bound: from the cursor on later pages; captured from the newest returned
      // row on the first page (null when the feed is empty).
      const first = items[0];
      const sourceThrough: ActivityPosition | null =
        decoded !== undefined ? decoded.upper : first !== undefined ? { occurredAt: first.occurredAt, eventId: first.id } : null;

      const last = items[items.length - 1];
      const nextCursor =
        hasMore && last !== undefined && sourceThrough !== null
          ? encodeActivityCursor(params.accountId, params.companyId, { after: { occurredAt: last.occurredAt, eventId: last.id }, upper: sourceThrough })
          : null;

      return { status: 'ok', page: { items, nextCursor, projectionMode: 'synchronous', asOf, sourceThrough, lagSeconds: 0 } };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
