// @acbp/contracts — provider-neutral company portfolio contract (ACBP-P1-011; CDR-017; PORT-001/002/003).
//
// The portfolio is the MEMBERSHIP-FILTERED list of companies the current actor can actually enter (an active
// company_membership per row) — NEVER an account-wide registry view, and account ownership grants no row by
// itself. This module defines the typed DTOs, the strict page-size validation (REJECT, not clamp — CDR-017 §8),
// and the opaque keyset cursor (versioned, unpadded base64url, bound to the current ACCOUNT and ACTOR). Company
// selection/switching has NO contract here by design: selection is URL-only, stateless and non-authoritative
// (CDR-017 §4/§5) — a companyId from the portfolio is only a selector for later normally-authorized requests.
import { asciiToBase64Url, base64UrlToAscii } from '../codec/base64url.js';
import { isActivityTimestamp } from '../activity/activity.js';

/** A single membership-filtered portfolio row. Exposes NOTHING beyond the five approved fields (CDR-017 §9). */
export interface PortfolioItem {
  readonly companyId: string;
  /** Current company profile name (enriched via a fresh CompanyScope read). */
  readonly name: string;
  /** Truthful lifecycle status ('draft' | 'onboarding' | 'active' | 'paused'). */
  readonly status: string;
  /** The CALLER'S company role in this company ('owner' | 'viewer') — from their own active membership. */
  readonly role: string;
  /** Exact company creation instant (microsecond ISO; the primary ordering key). */
  readonly createdAt: string;
}

/** A page of the portfolio. No totals/metrics/aggregates (CDR-017 §9). */
export interface PortfolioPage {
  readonly items: readonly PortfolioItem[];
  /** Opaque cursor for the next (older) page, or null when exhausted. */
  readonly nextCursor: string | null;
}

// ── Page size (CDR-017 §8: default 25, max 100; invalid values are REJECTED, never clamped) ──────────────────
export const PORTFOLIO_PAGE_SIZE_DEFAULT = 25;
export const PORTFOLIO_PAGE_SIZE_MAX = 100;

/**
 * Parse a requested page size STRICTLY: absent/empty → the default; an integer (or all-digits string) in
 * [1, 100] → that value; anything else (zero, negative, non-integer, non-numeric, > 100) → null, which the
 * caller must REJECT (400) — never clamp (CDR-017 §8).
 */
export function parsePortfolioLimit(requested: unknown): number | null {
  if (requested === undefined || requested === null || requested === '') return PORTFOLIO_PAGE_SIZE_DEFAULT;
  let n: number;
  if (typeof requested === 'number') n = requested;
  else if (typeof requested === 'string' && /^\d{1,3}$/.test(requested)) n = Number(requested);
  else return null;
  if (!Number.isInteger(n) || n < 1 || n > PORTFOLIO_PAGE_SIZE_MAX) return null;
  return n;
}

// ── Keyset cursor (created_at DESC, company_id DESC; bound to ACCOUNT + ACTOR) ───────────────────────────────
const CURSOR_VERSION = 1;
const MAX_CURSOR_TOKEN_LEN = 600;
const MAX_ID_LEN = 64;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The exclusive keyset-after position: the last row of the previous page (exact created_at + company id). */
export interface PortfolioCursor {
  readonly createdAt: string;
  readonly companyId: string;
}

function isValidTenantId(value: string): boolean {
  return value.length > 0 && value.length <= MAX_ID_LEN;
}

/**
 * Encode an opaque, versioned keyset cursor bound to the CURRENT ACCOUNT AND ACTOR (unpadded base64url of a
 * compact ASCII JSON `{v, a, u, c, i}`). Binding both lets {@link decodePortfolioCursor} reject a cursor minted
 * for another account or another user (defense in depth; the query is membership-filtered and RLS-confined
 * regardless). No signing secret: a tampered-but-well-formed cursor can only re-window the caller's OWN
 * membership-filtered portfolio — it can never widen visibility or cross tenants.
 */
export function encodePortfolioCursor(accountId: string, actorId: string, cursor: PortfolioCursor): string {
  const json = JSON.stringify({ v: CURSOR_VERSION, a: accountId, u: actorId, c: cursor.createdAt, i: cursor.companyId });
  return asciiToBase64Url(json);
}

/**
 * Decode + STRICTLY validate a portfolio cursor for the current account+actor. Returns the keyset position, or
 * `null` for ANY malformed / non-base64url / non-ASCII / non-JSON / wrong-version / foreign-account /
 * foreign-actor / missing-field / over-long / invalid-timestamp / invalid-company-id token (fail-closed — the
 * caller rejects the request; never a fallback scan). Never throws.
 */
export function decodePortfolioCursor(accountId: string, actorId: string, token: unknown): PortfolioCursor | null {
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
  if (typeof p['u'] !== 'string' || !isValidTenantId(p['u']) || p['u'] !== actorId) return null;
  const c = p['c'];
  const i = p['i'];
  if (typeof c !== 'string' || !isActivityTimestamp(c)) return null;
  if (typeof i !== 'string' || !UUID_RE.test(i)) return null;
  return { createdAt: c, companyId: i };
}
