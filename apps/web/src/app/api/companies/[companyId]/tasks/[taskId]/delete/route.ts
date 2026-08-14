// ACBP-API-005 — delete a task: POST /api/companies/{companyId}/tasks/{taskId}/delete.
//
// OWNER ONLY since the ACBP-API-004 narrowing (`task:delete`), enforced in @acbp/core. NO ROLE CHECK LIVES HERE
// (CDR-088 §1) — the narrowing was a one-line change in the authz matrix precisely so this layer never learns of
// it, and a viewer's refusal is deliberately indistinguishable from a non-member's.
//
// POST, NOT HTTP DELETE, AND DELIBERATELY SO. The operation requires a BODY: TASK-008's confirmation is encoded
// as a required acknowledgement (CDR-043 §4-G3), and an optional owner reason travels with it. HTTP DELETE with
// a semantically required body is poorly supported across intermediaries and client libraries, and a
// confirmation that can be dropped in transit is not a confirmation. The URL says `/delete` so the intent stays
// legible.
//
// DELETE IS NOT A `DELETE` IN THE DATABASE EITHER: `tasks` carries no DELETE grant, and the deletion is a row in
// the append-only `task_deletions` table. Nothing is destroyed; the task simply leaves every product read.
//
// State-changing, so the CSRF origin gate (ACBP-P7-014) covers it without this file carrying CSRF logic, and
// `check:csrf-origin-gate` proves that coverage.
import { deleteTaskForRequest } from '@/server/companies/companies-request';
import { respondToCompaniesRequest } from '@/server/companies/companies-http';
import { genericErrorBody } from '@/server/webhooks/http';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type Parsed = { readonly ok: true; readonly confirmed: boolean; readonly reason: string | null } | { readonly ok: false; readonly status: number };

/**
 * Turn the body into the forwarded shape, or refuse with a bounded 400.
 *
 * `confirmed` must be a REAL BOOLEAN — no truthy coercion. A string `"false"` is truthy in JavaScript, and
 * accepting one would turn a client bug into an unconfirmed deletion. Whether the acknowledgement is sufficient
 * is still the domain's ruling; this only refuses input that could not express one.
 */
async function parseBody(request: Request): Promise<Parsed> {
  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return { ok: false, status: 400 };
  }
  if (typeof raw !== 'object' || raw === null) return { ok: false, status: 400 };
  const { confirmed, reason } = raw as { confirmed?: unknown; reason?: unknown };
  if (typeof confirmed !== 'boolean') return { ok: false, status: 400 };
  if (reason !== undefined && reason !== null && typeof reason !== 'string') return { ok: false, status: 400 };
  return { ok: true, confirmed, reason: typeof reason === 'string' ? reason : null };
}

export async function POST(request: Request, context: { params: Promise<{ companyId: string; taskId: string }> }): Promise<Response> {
  const { companyId, taskId } = await context.params;
  const parsed = await parseBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), { status: parsed.status, headers: { 'content-type': 'application/json; charset=utf-8' } });
  }
  return respondToCompaniesRequest(() => deleteTaskForRequest(companyId, taskId, { confirmed: parsed.confirmed, reason: parsed.reason }));
}
