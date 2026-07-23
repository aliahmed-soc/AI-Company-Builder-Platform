// @acbp/contracts — provider-neutral administrative-access contracts (ACBP-P1-013; CDR-019; SECURITY §3).
//
// The admin surface is a SEPARATE platform-operator authority: tenant roles, account ownership, and provider
// claims never grant it. This module defines the pure, transport-neutral pieces only — the STRICT verbatim
// reason validation (canon: "every admin action requires a stated reason at invocation — recorded verbatim";
// acceptance: "admin action without reason impossible"), the target selector shape, the minimal redacted
// response DTO, and the closed scope code. The database-backed admin gate, the branded per-request capability,
// and the transaction-local target-scope primitive live PRIVATELY in @acbp/core's admin module — deliberately
// NOT here, so nothing outside that module can mint admin authority from plain data. Zero-dependency.

/** Maximum admin reason length in UNICODE CODE POINTS (CDR-019 §4). */
export const ADMIN_REASON_MAX_CODE_POINTS = 512;

/** The single closed scope code of the P1-013 skeleton's one operation (CDR-019 §7). */
export const ADMIN_READ_SCOPE = 'company_overview';

export type AdminReasonValidation = { readonly ok: true; readonly reason: string } | { readonly ok: false };

/** Explicit surrogate-pair scan (String.prototype.isWellFormed needs lib es2024; this stays lib-neutral). */
function isWellFormedUnicode(s: string): boolean {
  for (let i = 0; i < s.length; i += 1) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1); // NaN at end-of-string → fails the range check → lone high surrogate
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false;
      i += 1; // valid pair — skip the low surrogate
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return false; // low surrogate with no preceding high surrogate
    }
  }
  return true;
}

/**
 * STRICTLY validate an admin reason (CDR-019 §4):
 *  - must be a string with AT LEAST ONE non-whitespace character;
 *  - at most 512 UNICODE CODE POINTS (astral characters count once — measured by code points, not UTF-16 units);
 *  - NUL (U+0000) is forbidden anywhere;
 *  - must be WELL-FORMED Unicode (no lone surrogates — JSON escapes like an escaped lone U+D800 can smuggle
 *    them past a fatal UTF-8 body decode; an ill-formed string cannot be persisted to jsonb, which would
 *    otherwise turn a validation problem into a mid-transaction 500 — security review P1-013 finding 3.2);
 *  - the ORIGINAL string is retained EXACTLY — no trimming, no normalization, no rewriting before storage
 *    (SECURITY §3: "recorded verbatim"; leading/trailing whitespace around real content is preserved).
 * Returns the exact original string on success; fail-closed `{ok:false}` on any violation. Callers MUST run
 * this BEFORE any database read (the reason gate precedes everything).
 */
export function validateAdminReason(input: unknown): AdminReasonValidation {
  if (typeof input !== 'string') return { ok: false };
  if (input.includes('\u0000')) return { ok: false }; // NUL (U+0000) forbidden anywhere
  if (!isWellFormedUnicode(input)) return { ok: false }; // lone surrogates rejected (see doc comment)
  if (input.trim().length === 0) return { ok: false }; // trim used for the EMPTINESS check only — never stored
  let codePoints = 0;
  for (const _cp of input) {
    codePoints += 1;
    if (codePoints > ADMIN_REASON_MAX_CODE_POINTS) return { ok: false };
  }
  return { ok: true, reason: input };
}

/** The admin read target: BOTH ids are client-supplied SELECTORS only (CDR-019 §5) — their relationship is
 *  verified in-database (`companies.account_id = accountId AND companies.id = companyId`), never trusted. */
export interface AdminReadTarget {
  readonly accountId: string;
  readonly companyId: string;
}

/**
 * The minimal redacted admin response (CDR-019 §8). Exposes ONLY the four approved registry fields — never the
 * accountId, actor ids, admin-standing details, profile/member data, audit/activity data, or internal errors.
 */
export interface AdminCompanyOverview {
  readonly companyId: string;
  readonly status: string;
  readonly creationMode: string;
  readonly createdAt: string;
}
