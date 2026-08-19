// ACBP-API-011 — the account usage rollup: GET /api/account/usage (ACBP-P6-009; CDR-073; trust-critical #14).
//
// ACCOUNT-OWNER ONLY (`usage:read`), enforced in @acbp/core. NO AUTHORIZATION CHECK LIVES HERE (CDR-087 §1).
//
// ── WHY THIS IS NOT UNDER /api/companies/{companyId} ────────────────────────────────────────────────────────────
//
// A rollup spans the account's companies by design, so RLS cannot narrow it and the authorization is the only thing
// between a viewer and the account's total spend. `readCreditLedger`'s review-pass-1 HIGH is the precedent: it once
// ran in a COMPANY scope, checked the caller's company-membership role, and would have handed a company owner who
// was only an account VIEWER the whole account's spending. Core runs this in an account scope for that reason, and
// a company-shaped URL would have re-created the confusion at the boundary even with core doing the right thing.
//
// THERE IS NO ACCOUNT SELECTOR ON THIS ROUTE. The account is resolved from the server-verified session, which makes
// "read another account's spend" unexpressible rather than merely refused.
//
// Read-only, so the CSRF origin gate (ACBP-P7-014) does not apply — safe methods are unaffected by design.
import { getAccountUsageForRequest } from '@/server/accounts/usage-request';
import { respondToUsageRequest } from '@/server/accounts/usage-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * ONE supported parameter. An unsupported one is REFUSED rather than ignored, on the approvals-inbox rule: a
 * caller who believes they are reading one period while actually reading another would be shown real figures under
 * the wrong heading, and money under the wrong heading is worse than an error.
 *
 * `periodStart` is REQUIRED and has NO DEFAULT. Defaulting to "this month" would be a server-chosen answer to a
 * question the caller did not ask, and a client that omitted the parameter by accident would get plausible figures
 * for a period it never named — the silent-wrongness shape CDR-073 §0 is about.
 */
const ALLOWED_PARAMS = new Set<string>(['periodStart']);

export async function GET(request: Request): Promise<Response> {
  const params = new URL(request.url).searchParams;
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key)) {
      return new Response(JSON.stringify(genericErrorBody(400)), { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' } });
    }
  }
  // FORWARDED RAW, including when absent. `readAccountUsageRollup` types `periodStart` as `unknown` and refuses a
  // malformed one with `invalid_period` → 400; re-validating the `YYYY-MM-01` shape here would create a second
  // authority that drifts the first time `isUsagePeriodStart` changes.
  return respondToUsageRequest(() => getAccountUsageForRequest(params.get('periodStart') ?? undefined));
}
