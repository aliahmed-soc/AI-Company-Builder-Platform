// @acbp/core — company activity feed read use case (ACBP-P1-009; CDR-016; ACT-001/003). API-only.
//
// Runs under the caller's validated CompanyScope (runInCompanyScope): active company membership required, the
// `activity:read` role check gates the read (owner|viewer), and the keyset query is RLS-confined to the current
// account+company. Renders company events ONLY (the projection contains nothing else). Deterministic keyset
// pagination (occurred_at DESC, event_id DESC), an opaque company-bound cursor, a bounded page size, and an
// HONEST `asOf` (the newest returned event's time; null when empty — never wall-clock request time).
import { ActivityFeedRepository, type DatabaseClient, type ActivityKeyset } from '@acbp/database';
import { runInCompanyScope } from './company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import {
  clampActivityPageSize,
  decodeActivityCursor,
  encodeActivityCursor,
  executionStateFor,
  type ActivityEventDTO,
  type ActivityPage,
  type ActivityType,
} from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface GetActivityParams {
  readonly userId: string;
  readonly accountId: string;
  readonly companyId: string;
  /** Opaque cursor from a previous page's `nextCursor`. Absent → first page. */
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

function toDTO(row: {
  event_id: string;
  activity_type: string;
  occurred_at: Date;
  actor_id: string | null;
  subject_type: string;
  subject_id: string;
  payload: Record<string, string | number | boolean>;
}): ActivityEventDTO {
  const type = row.activity_type as ActivityType;
  return {
    id: row.event_id,
    type,
    occurredAt: new Date(row.occurred_at).toISOString(),
    executionState: executionStateFor(type),
    actorId: row.actor_id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    details: row.payload,
  };
}

/**
 * Read a page of the company activity feed. Owner|viewer company members only (a non-member is denied at
 * resolution → coarse `forbidden`). A present-but-invalid cursor is rejected with `invalid_cursor` (never a
 * silent unbounded scan). `asOf` is the newest returned event's time — honest freshness, since the projection is
 * written synchronously in the source transaction (the feed is always caught up).
 */
export async function getCompanyActivity(client: DatabaseClient, params: GetActivityParams, options: GetActivityOptions = {}): Promise<GetActivityResult> {
  const limit = clampActivityPageSize(params.limit);

  // Validate the cursor (if any) BEFORE entering scope — a bad cursor is a clean client error, not a DB hit.
  let before: ActivityKeyset | undefined;
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
    const decoded = decodeActivityCursor(params.companyId, params.cursor);
    if (decoded === null) return { status: 'invalid_cursor' };
    before = { occurredAt: new Date(decoded.occurredAt), eventId: decoded.eventId };
  }

  const run = await runInCompanyScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId, requestedCompanyId: params.companyId },
    async (scope, role): Promise<GetActivityResult> => {
      if (checkAuthorization(role, 'activity:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { status: 'forbidden' };
      }
      // Fetch limit+1 to detect whether a further (older) page exists.
      const rows = await new ActivityFeedRepository(scope.db).listByCompany(params.companyId, limit + 1, before);
      const hasMore = rows.length > limit;
      const pageRows = hasMore ? rows.slice(0, limit) : rows;
      const items = pageRows.map(toDTO);
      const last = items[items.length - 1];
      const nextCursor = hasMore && last !== undefined ? encodeActivityCursor(params.companyId, { occurredAt: last.occurredAt, eventId: last.id }) : null;
      const asOf = items.length > 0 && items[0] !== undefined ? items[0].occurredAt : null;
      return { status: 'ok', page: { items, nextCursor, asOf } };
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
  return run.kind === 'ran' ? run.value : { status: 'forbidden' };
}
