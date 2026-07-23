// @acbp/core — company portfolio read use case (ACBP-P1-011; CDR-017; PORT-001/002/003). API-only.
//
// Returns the MEMBERSHIP-FILTERED list of companies the caller can actually enter (an active company_membership
// per row) — account ownership grants no row by itself. The flow is two clearly separated phases, both under
// FRESHLY validated scopes, never a cached/global one:
//
//   1. ENUMERATION under the caller's AccountScope (company GUC unset): the account-level `portfolio:read` role
//      check (owner|viewer active account member) gates the API CALL, then PortfolioRepository lists the actor's
//      active-membership companies via the memberships self-branch joined to companies (keyset created_at DESC,
//      id DESC). This yields candidates WITHOUT a name (company_profiles is not readable under account scope).
//
//   2. NAME ENRICHMENT: for each paged candidate, SEQUENTIALLY (never in parallel — no mixing of transaction-
//      local company context), a FRESH `runInCompanyScope` re-validates the active company membership and mints
//      a fresh CompanyScope, under which the current profile name is read. A candidate whose membership went
//      STALE between enumeration and enrichment (revoked concurrently) is DENIED by runInCompanyScope and is
//      DROPPED — never emitted as a stale/partially-authorized row, never substituted, never a fallback company
//      (CDR-017 §Required behavior). The DROPPED company simply does not appear; the keyset cursor still advances
//      past it (a later page is derived from the enumeration position, so pagination stays correct).
//
// Selection/switching has NO surface here: a companyId returned in the portfolio is a stateless, non-authoritative
// selector for a later, independently authorized request (CDR-017 §4/§5).
import { CompanyProfileRepository, PortfolioRepository, resolveOwnMembershipBootstrap, type DatabaseClient, type PortfolioCandidateRow } from '@acbp/database';
import {
  encodePortfolioCursor,
  decodePortfolioCursor,
  microsecondEpochToIso,
  parsePortfolioLimit,
  type PortfolioCursor,
  type PortfolioItem,
  type PortfolioPage,
} from '@acbp/contracts';
import { runInAccountScope } from '../tenancy/account-context-resolver.js';
import { runInCompanyScope } from './company-context-resolver.js';
import { checkAuthorization } from '../authz/authz-service.js';
import { isMemberRole } from '../members/roles.js';
import type { Logger } from '@acbp/observability';

export interface GetPortfolioParams {
  /** Server-verified internal user id (from the identity boundary). NEVER a browser claim. */
  readonly userId: string;
  /** The account whose portfolio is requested. A SELECTOR — validated via an active account membership. */
  readonly accountId: string;
  /** Opaque cursor from a previous page's `nextCursor`. Absent → first page. */
  readonly cursor?: unknown;
  /** Requested page size. Default 25; max 100; invalid values are REJECTED (not clamped). */
  readonly limit?: unknown;
}

export interface GetPortfolioOptions {
  readonly correlationId?: string;
  readonly logger?: Logger;
}

export type GetPortfolioResult =
  | { readonly status: 'ok'; readonly page: PortfolioPage }
  | { readonly status: 'forbidden' }
  | { readonly status: 'invalid_cursor' }
  | { readonly status: 'invalid_limit' };

/** The account-scoped enumeration outcome (internal): the authz decision + the raw candidate rows. */
type Enumeration = { readonly ok: false } | { readonly ok: true; readonly candidates: readonly PortfolioCandidateRow[] };

/**
 * Sequentially enrich enumerated candidates with their current profile name under FRESH per-candidate
 * CompanyScopes. A candidate whose active membership is gone (runInCompanyScope denies) OR whose profile/epoch
 * is unreadable is DROPPED (returns fewer items than candidates) — never emitted as a stale row. The `role` in
 * each item is the FRESH company role from the re-validated membership, and `status`/`createdAt` come from the
 * enumeration candidate (a single consistent read moment). Exported for deterministic stale-drop testing.
 */
export async function enrichCandidatesSequentially(
  client: DatabaseClient,
  ctx: { readonly userId: string; readonly accountId: string },
  candidates: readonly PortfolioCandidateRow[],
  options: GetPortfolioOptions = {},
): Promise<PortfolioItem[]> {
  const items: PortfolioItem[] = [];
  for (const cand of candidates) {
    // Fresh, fully re-validated CompanyScope per candidate (no reuse of a prior scope; sequential — never parallel).
    const enriched = await runInCompanyScope(
      client,
      { userId: ctx.userId, requestedAccountId: ctx.accountId, requestedCompanyId: cand.company_id },
      async (companyScope, role) => {
        const profile = await new CompanyProfileRepository(companyScope.db).currentRevision(cand.company_id);
        return { profile, role };
      },
      options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
    );
    // Membership went stale / access denied between enumeration and enrichment → DROP (never a stale row).
    if (enriched.kind !== 'ran') continue;
    const { profile, role } = enriched.value;
    const createdAt = microsecondEpochToIso(cand.created_at_us);
    // Missing profile or an unparseable epoch is an internal inconsistency → drop fail-safe (never emit partial).
    if (profile === undefined || createdAt === null) continue;
    items.push({ companyId: cand.company_id, name: profile.name, status: cand.status, role, createdAt });
  }
  return items;
}

/**
 * Read a page of the caller's company portfolio. Active account members only (a non-member → coarse `forbidden`).
 * An invalid page size is rejected (`invalid_limit`); a present-but-invalid cursor is rejected (`invalid_cursor`);
 * neither hits the enumeration query. The cursor is opaque, versioned, and bound to the ACCOUNT+ACTOR.
 */
export async function getCompanyPortfolio(client: DatabaseClient, params: GetPortfolioParams, options: GetPortfolioOptions = {}): Promise<GetPortfolioResult> {
  // Strict page size: default 25 / max 100 / REJECT (never clamp) — validated before any DB work (CDR-017 §8).
  const limit = parsePortfolioLimit(params.limit);
  if (limit === null) return { status: 'invalid_limit' };

  // Validate the cursor (if any) BEFORE entering scope — a bad/foreign cursor is a clean client error, not a DB hit.
  let after: PortfolioCursor | undefined;
  if (params.cursor !== undefined && params.cursor !== null && params.cursor !== '') {
    const c = decodePortfolioCursor(params.accountId, params.userId, params.cursor);
    if (c === null) return { status: 'invalid_cursor' };
    after = c;
  }

  const opts = options.correlationId !== undefined ? { correlationId: options.correlationId } : {};

  // Phase 1 — ENUMERATION under the AccountScope: portfolio:read role check, then the membership-filtered keyset.
  const enumRun = await runInAccountScope(
    client,
    { userId: params.userId, requestedAccountId: params.accountId },
    async (accountScope): Promise<Enumeration> => {
      // The caller's OWN active account-membership role gates the API call (owner|viewer). A null/unknown role denies.
      const own = await resolveOwnMembershipBootstrap(accountScope.db, params.userId, params.accountId);
      const role = own !== null && isMemberRole(own.role) ? own.role : null;
      if (checkAuthorization(role, 'portfolio:read', { accountId: params.accountId, actorId: params.userId }, options).kind === 'deny') {
        return { ok: false };
      }
      // Fetch limit + 1 to detect a further page. The keyset `after` binds the exact microsecond createdAt.
      const candidates = await new PortfolioRepository(accountScope.db).listActiveMembershipCompanies(
        params.userId,
        limit + 1,
        after !== undefined ? { after: { createdAt: after.createdAt, companyId: after.companyId } } : {},
      );
      return { ok: true, candidates };
    },
    opts,
  );

  // No active account membership at all (resolution denied) → coarse forbidden.
  if (enumRun.kind === 'denied') return { status: 'forbidden' };
  // Active account member but portfolio:read denied (defensive; both roles are allowed today) → coarse forbidden.
  if (!enumRun.value.ok) return { status: 'forbidden' };

  const all = enumRun.value.candidates;
  const hasMore = all.length > limit;
  const pageCandidates = hasMore ? all.slice(0, limit) : all;

  // Phase 2 — SEQUENTIAL fresh-scope name enrichment (drops any concurrently-revoked candidate).
  const items = await enrichCandidatesSequentially(client, { userId: params.userId, accountId: params.accountId }, pageCandidates, options);

  // The next cursor is the keyset position of the last ENUMERATED candidate of this page (not the last emitted
  // item): a dropped stale row must not shorten the traversal. Null when this was the final page.
  const lastCand = pageCandidates[pageCandidates.length - 1];
  const nextCursor =
    hasMore && lastCand !== undefined
      ? buildCursor(params.accountId, params.userId, lastCand)
      : null;

  return { status: 'ok', page: { items, nextCursor } };
}

/** Build the account+actor-bound keyset cursor from a candidate's exact position (null epoch is unreachable
 *  here — the same value was just listed — but fail closed to no-cursor rather than emit a malformed token). */
function buildCursor(accountId: string, actorId: string, cand: PortfolioCandidateRow): string | null {
  const createdAt = microsecondEpochToIso(cand.created_at_us);
  if (createdAt === null) return null;
  return encodePortfolioCursor(accountId, actorId, { createdAt, companyId: cand.company_id });
}
