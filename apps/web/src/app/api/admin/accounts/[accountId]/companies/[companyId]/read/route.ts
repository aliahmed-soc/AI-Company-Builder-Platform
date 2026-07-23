// ACBP-P1-013 — the ONLY administrative API surface: POST /api/admin/accounts/{accountId}/companies/{companyId}/read.
//
// A reason-captured, audited platform-admin read of one company's registry overview (CDR-019 §16/§17). Admin
// standing comes SOLELY from the fresh in-database platform_admins self-check (tenant roles, account ownership
// and Clerk claims never grant it); accountId + companyId are client-supplied selectors relationship-verified
// in-database; the mandatory `{ reason }` body is validated strictly BEFORE any identity/database work. Every
// query parameter and every non-exact body is a generic 400; every denial is ONE opaque 403; the response is
// exactly {companyId,status,creationMode,createdAt}. No admin list/search/mutation/impersonation/audit-export
// route exists; no UI, no SSE, no cache, no redirect. Other methods → 405 (Next.js default).
import { handleAdminReadPost } from '@/server/admin/admin-http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: Request, context: { params: Promise<{ accountId: string; companyId: string }> }): Promise<Response> {
  const { accountId, companyId } = await context.params;
  return handleAdminReadPost(request, { accountId, companyId });
}
