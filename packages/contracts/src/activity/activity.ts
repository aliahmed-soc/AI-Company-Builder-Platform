// @acbp/contracts — provider-neutral activity feed contract (ACBP-P1-009; CDR-016; ADR-015; ACT-001/003).
//
// The activity feed is the tenant-facing PROJECTION of the durable audit store (diagram 11). This module defines
// WHAT a feed item is (the visible taxonomy, the redacted client DTO, the projection mapping, and the keyset
// cursor) — not how it is stored or read. Zero-dependency like the rest of @acbp/contracts.
//
// Visibility (CDR-016): the feed renders company events ONLY — exactly the four durable company lifecycle events.
// Account-level audit events (membership.*, company_id NULL), Logger-only events, and any undeclared future event
// are NOT projectable and never appear. All four company events are EXECUTED facts (ACT-003 marking is present but
// trivially 'executed' for P1-009's event set).
import { boundedMetadata, type AuditEvent, type AuditMetadata } from '../audit/audit.js';

/** The CLOSED set of activity types the feed may render — the four durable company events (CDR-016). */
export const ACTIVITY_TYPES = ['company.created', 'company.updated', 'company.paused', 'company.resumed'] as const;
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export function isActivityType(value: unknown): value is ActivityType {
  return typeof value === 'string' && (ACTIVITY_TYPES as readonly string[]).includes(value);
}

/**
 * True IFF an audit event NAME is projectable into the activity feed. Unknown / account-level / Logger-only names
 * return false (safe: they are simply not projected — never a poison event). The company producers project; a
 * membership event or a future unregistered event does not.
 */
export function isProjectableActivity(auditEventName: unknown): auditEventName is ActivityType {
  return isActivityType(auditEventName);
}

/** Proposed-vs-executed marking (ACT-003, invariant 20). Every P1-009 company event is an executed fact. */
export type ExecutionState = 'proposed' | 'executed';
export function executionStateFor(_type: ActivityType): ExecutionState {
  return 'executed';
}

/**
 * The safe, redacted display payload projected from a company AuditEvent's metadata. The audit metadata for company
 * events is already bounded scalars (creation_mode / changed_fields — no PII, no raw content); this re-validates it
 * through {@link boundedMetadata} so the projection can never carry more than the whitelisted safe fields. Audit
 * correlation/causation/idempotency ids are SEPARATE audit columns and are deliberately NOT projected.
 */
export function activityDisplayPayload(event: AuditEvent): AuditMetadata {
  return boundedMetadata(event.metadata);
}

/**
 * The redacted, client-facing feed item. Carries NO raw audit payload beyond the whitelisted display fields, no
 * correlation/causation ids, and no account-level data. `id` is the source audit event id (opaque, also the
 * projection key). `subjectId` is the company id.
 */
export interface ActivityEventDTO {
  readonly id: string;
  readonly type: ActivityType;
  readonly occurredAt: string;
  readonly executionState: ExecutionState;
  readonly actorId: string | null;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly details: AuditMetadata;
}

/** A page of the feed, with an honest `asOf` (latest returned event time; null when empty) + a keyset cursor. */
export interface ActivityPage {
  readonly items: readonly ActivityEventDTO[];
  /** Opaque cursor to fetch the next (older) page, or null when the last page has been reached. */
  readonly nextCursor: string | null;
  /** Honest freshness: the newest event's occurredAt in THIS response, or null when the feed is empty. Because the
   *  projection is written synchronously in the source transaction, the feed is always caught up — `asOf` never
   *  claims freshness beyond the latest projected event and never uses wall-clock request time. */
  readonly asOf: string | null;
}

// ── Keyset pagination (occurred_at DESC, event_id DESC) ──────────────────────────────────────────────────────
export const ACTIVITY_PAGE_SIZE_DEFAULT = 25;
export const ACTIVITY_PAGE_SIZE_MAX = 100;

/** Clamp a requested page size to [1, MAX], defaulting when absent/invalid (never an unbounded scan). */
export function clampActivityPageSize(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested) : NaN;
  if (!Number.isFinite(n) || Number.isNaN(n)) return ACTIVITY_PAGE_SIZE_DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return ACTIVITY_PAGE_SIZE_DEFAULT;
  return Math.min(i, ACTIVITY_PAGE_SIZE_MAX);
}

/** The decoded keyset position: the (occurred_at, event_id) of the last item on the previous page. */
export interface ActivityCursor {
  readonly occurredAt: string;
  readonly eventId: string;
}

const CURSOR_VERSION = 1;

/**
 * Encode an opaque, versioned, company-bound keyset cursor: `encodeURIComponent` of a compact JSON `{v, c:
 * companyId, o: occurredAt, e: eventId}` (URL-safe; uses only pure-ECMAScript primitives so it stays neutral in
 * the zero-dep contracts package — no Buffer/btoa). Binding the company id lets {@link decodeActivityCursor}
 * reject a cursor minted for another company (defense in depth; RLS already confines data to the caller's
 * company). Opacity here is defense-in-depth, not a trust boundary — RLS + the strict parse make a tampered
 * cursor harmless (it can only ever page the caller's OWN company feed).
 */
export function encodeActivityCursor(companyId: string, cursor: ActivityCursor): string {
  return encodeURIComponent(JSON.stringify({ v: CURSOR_VERSION, c: companyId, o: cursor.occurredAt, e: cursor.eventId }));
}

/**
 * Decode + VALIDATE an opaque cursor for a specific company. Returns the keyset position, or `null` for any
 * malformed / wrong-version / wrong-company / mis-shaped token (fail-closed — the caller treats null as "invalid
 * cursor" and rejects the request; it never falls back to an unbounded scan). Never throws.
 */
export function decodeActivityCursor(companyId: string, token: unknown): ActivityCursor | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > 512) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(token);
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null) return null;
  const p = parsed as Record<string, unknown>;
  if (p['v'] !== CURSOR_VERSION) return null;
  if (typeof p['c'] !== 'string' || p['c'] !== companyId) return null;
  if (typeof p['o'] !== 'string' || typeof p['e'] !== 'string') return null;
  if (p['o'].length === 0 || p['o'].length > 40 || p['e'].length === 0 || p['e'].length > 64) return null;
  return { occurredAt: p['o'], eventId: p['e'] };
}
