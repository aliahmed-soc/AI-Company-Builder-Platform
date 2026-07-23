// @acbp/contracts — provider-neutral activity feed contract (ACBP-P1-009; CDR-016; ADR-015; ACT-001/003).
//
// The activity feed is the tenant-facing PROJECTION of the durable audit store (diagram 11). This module defines
// WHAT a feed item is (the visible taxonomy, the redacted client DTO, the summary allowlist, the response
// metadata, and the keyset cursor) — not how it is stored or read. Zero-dependency, pure-ECMAScript (no Buffer,
// no Node typings) like the rest of @acbp/contracts.
//
// Visibility (CDR-016): the feed renders company events ONLY — exactly the four durable company lifecycle events.
// Account-level audit events (membership.*, company_id NULL), Logger-only events, and any undeclared future event
// are NOT projectable and never appear. All four company events are EXECUTED facts (ACT-003 marking is present
// but trivially 'executed' for P1-009's event set).
import { isUlid } from '../audit/ulid.js';
import type { AuditMetadata } from '../audit/audit.js';

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
 * The per-type SUMMARY ALLOWLIST (CDR-016 redaction): the ONLY display fields a feed item may carry. Applied both
 * at projection time and again at DTO-mapping time (defense in depth over the stored payload), so an unexpected
 * key in a stored row can never reach a client. `company.paused`/`company.resumed` deliberately have EMPTY
 * summaries. Never includes actor ids, correlation/causation/idempotency ids, or raw audit payload.
 */
const SUMMARY_ALLOWLIST: Readonly<Record<ActivityType, readonly string[]>> = {
  'company.created': ['creation_mode'],
  'company.updated': ['changed_fields'],
  'company.paused': [],
  'company.resumed': [],
};

/** Project a bounded payload down to the type's allowlisted summary keys (unknown keys are dropped, never emitted). */
export function activitySummaryFor(type: ActivityType, payload: Readonly<Record<string, unknown>>): AuditMetadata {
  const out: Record<string, string | number | boolean> = {};
  for (const key of SUMMARY_ALLOWLIST[type]) {
    const v = payload[key];
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return Object.freeze(out);
}

/**
 * The redacted, client-facing feed item (CDR-016 DTO contract). Exposes ONLY: the opaque item id (= the source
 * audit event id), the activity type, the event time, the executed marking, the coarse ACTOR TYPE, and the
 * allowlisted summary. It deliberately does NOT expose actor internal ids, account/company ids, raw audit
 * payload, correlation/causation/idempotency ids, or free-text fields.
 */
export interface ActivityEventDTO {
  readonly id: string;
  readonly type: ActivityType;
  readonly occurredAt: string;
  readonly state: ExecutionState;
  readonly actorType: string;
  readonly summary: AuditMetadata;
}

/** A traversal position / upper-bound tuple: an event time + its id (the deterministic tie-breaker). */
export interface ActivityPosition {
  readonly occurredAt: string;
  readonly eventId: string;
}

/**
 * A page of the feed with HONEST response metadata (CDR-016 / ADR-015 "as of"):
 * - `projectionMode: 'synchronous'` — the projection is written in the source transaction;
 * - `asOf` — the POSTGRESQL read timestamp of THIS feed query (never application wall-clock);
 * - `sourceThrough` — the immutable traversal upper bound captured on the FIRST page (the newest event at
 *   traversal start; `null` for an empty feed). It does not change on later pages of the same traversal; events
 *   inserted after page 1 are excluded from the traversal and appear in a FRESH traversal.
 * - `lagSeconds: 0` — the supported taxonomy is projected atomically with its source, so projection lag is zero.
 *   No snapshot isolation ACROSS requests is claimed; visibility is of committed transactions only.
 */
export interface ActivityPage {
  readonly items: readonly ActivityEventDTO[];
  /** Opaque cursor to fetch the next (older) page, or null when the traversal is exhausted. */
  readonly nextCursor: string | null;
  readonly projectionMode: 'synchronous';
  readonly asOf: string;
  readonly sourceThrough: ActivityPosition | null;
  readonly lagSeconds: 0;
}

// ── Page size (bounded; never an unbounded scan) ─────────────────────────────────────────────────────────────
export const ACTIVITY_PAGE_SIZE_DEFAULT = 25;
export const ACTIVITY_PAGE_SIZE_MAX = 100;

/** Clamp a requested page size to [1, MAX], defaulting when absent/invalid. */
export function clampActivityPageSize(requested: unknown): number {
  const n = typeof requested === 'number' ? requested : typeof requested === 'string' ? Number(requested) : NaN;
  if (!Number.isFinite(n) || Number.isNaN(n)) return ACTIVITY_PAGE_SIZE_DEFAULT;
  const i = Math.floor(n);
  if (i < 1) return ACTIVITY_PAGE_SIZE_DEFAULT;
  return Math.min(i, ACTIVITY_PAGE_SIZE_MAX);
}

// ── Pure-ECMAScript base64url codec (ASCII payloads only; no Buffer/btoa/TextEncoder) ────────────────────────
const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_RE = /^[A-Za-z0-9_-]+$/;

/** Encode an ASCII string as unpadded base64url. Throws on a non-ASCII code unit (the cursor payload is ASCII). */
function asciiToBase64Url(input: string): string {
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const b: number[] = [];
    for (let j = i; j < i + 3 && j < input.length; j++) {
      const code = input.charCodeAt(j);
      if (code > 0x7f) throw new Error('cursor payload must be ASCII');
      b.push(code);
    }
    const b0 = b[0] ?? 0;
    const b1 = b[1] ?? 0;
    const b2 = b[2] ?? 0;
    out += B64URL_ALPHABET[b0 >> 2];
    out += B64URL_ALPHABET[((b0 & 0x03) << 4) | (b1 >> 4)];
    if (b.length > 1) out += B64URL_ALPHABET[((b1 & 0x0f) << 2) | (b2 >> 6)];
    if (b.length > 2) out += B64URL_ALPHABET[b2 & 0x3f];
  }
  return out;
}

/** Decode unpadded base64url to an ASCII string, or null for any malformed token (bad alphabet, bad length,
 *  or a decoded byte outside ASCII — i.e. a would-be multi-byte UTF-8 sequence). Never throws. */
function base64UrlToAscii(token: string): string | null {
  if (token.length === 0 || !B64URL_RE.test(token)) return null;
  if (token.length % 4 === 1) return null; // impossible unpadded base64 length
  const idx = (ch: string): number => B64URL_ALPHABET.indexOf(ch);
  let out = '';
  for (let i = 0; i < token.length; i += 4) {
    const c = [...token.slice(i, i + 4)].map(idx);
    if (c.some((x) => x < 0)) return null;
    const c0 = c[0] ?? 0;
    const c1 = c[1] ?? 0;
    const c2 = c[2] ?? 0;
    const c3 = c[3] ?? 0;
    const b0 = (c0 << 2) | (c1 >> 4);
    out += String.fromCharCode(b0);
    if (c.length > 2) out += String.fromCharCode(((c1 & 0x0f) << 4) | (c2 >> 2));
    if (c.length > 3) out += String.fromCharCode(((c2 & 0x03) << 6) | c3);
  }
  // Reject any non-ASCII byte (a real UTF-8 multi-byte payload is not a valid cursor).
  for (let i = 0; i < out.length; i++) if (out.charCodeAt(i) > 0x7f) return null;
  return out;
}

// ── Keyset cursor (opaque base64url; versioned; account+company bound; after + traversal upper bound) ────────
const CURSOR_VERSION = 2;
const MAX_CURSOR_TOKEN_LEN = 600;
const MAX_ID_LEN = 64;
const ISO_MAX_LEN = 40;

/** The decoded cursor: the keyset-after position (last item of the previous page) + the IMMUTABLE traversal
 *  upper bound captured on the first page (so later pages exclude events inserted after the traversal began). */
export interface ActivityCursor {
  readonly after: ActivityPosition;
  readonly upper: ActivityPosition;
}

function isValidIso(value: string): boolean {
  if (value.length === 0 || value.length > ISO_MAX_LEN) return false;
  const t = Date.parse(value);
  return Number.isFinite(t);
}
function isValidEventId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LEN && isUlid(value);
}
function isValidTenantId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LEN;
}

/**
 * Encode an opaque, versioned, ACCOUNT+COMPANY-bound keyset cursor (unpadded base64url of a compact ASCII JSON
 * `{v, a, c, o, e, uo, ue}`). Binding both tenant ids lets {@link decodeActivityCursor} reject a cursor minted
 * for another account or company (defense in depth; RLS already confines data to the caller's company). Opacity
 * is defense-in-depth, not a trust boundary — a tampered-but-well-formed cursor can only alter the traversal
 * position INSIDE the already-authorized, RLS-confined company; it can never change scope or disclose another
 * company (no signing secret is used or needed).
 */
export function encodeActivityCursor(accountId: string, companyId: string, cursor: ActivityCursor): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, a: accountId, c: companyId, o: cursor.after.occurredAt, e: cursor.after.eventId, uo: cursor.upper.occurredAt, ue: cursor.upper.eventId });
  return asciiToBase64Url(json);
}

/**
 * Decode + STRICTLY validate an opaque cursor for a specific account+company. Returns the cursor, or `null` for
 * ANY malformed / non-base64url / bad-length / non-ASCII / non-JSON / wrong-version / wrong-account /
 * wrong-company / missing-field / over-long / invalid-timestamp / invalid-event-id token (fail-closed — the
 * caller rejects the request as `invalid_cursor`; it never falls back to an unbounded scan). Never throws.
 */
export function decodeActivityCursor(accountId: string, companyId: string, token: unknown): ActivityCursor | null {
  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_CURSOR_TOKEN_LEN) return null;
  const decoded = base64UrlToAscii(token);
  if (decoded === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
  const p = parsed as Record<string, unknown>;
  if (p['v'] !== CURSOR_VERSION) return null;
  if (typeof p['a'] !== 'string' || !isValidTenantId(p['a']) || p['a'] !== accountId) return null;
  if (typeof p['c'] !== 'string' || !isValidTenantId(p['c']) || p['c'] !== companyId) return null;
  const o = p['o'];
  const e = p['e'];
  const uo = p['uo'];
  const ue = p['ue'];
  if (typeof o !== 'string' || !isValidIso(o)) return null;
  if (typeof uo !== 'string' || !isValidIso(uo)) return null;
  if (typeof e !== 'string' || !isValidEventId(e)) return null;
  if (typeof ue !== 'string' || !isValidEventId(ue)) return null;
  return { after: { occurredAt: o, eventId: e }, upper: { occurredAt: uo, eventId: ue } };
}
