// ACBP-P1-003 — authenticated account-profile Route Handler: GET/PATCH /api/account/profile.
//
// Protected server-side (fail-closed): the handler resolves the SERVER-VERIFIED session identity,
// maps it to the internal user, ensures the personal account exists (first sign-in), then reads/edits
// the profile. No account id, email, or role from the request body/headers can target another account.
// All domain access goes through @acbp/core. Unimplemented methods get Next's automatic 405.
import { getAccountProfileForRequest, updateAccountProfileForRequest } from '@/server/accounts/profile-request';
import { parseProfileUpdateBody, toProfileResponse } from '@/server/accounts/profile-http';
import { genericErrorBody } from '@/server/webhooks/http';

// Needs the Node runtime (pg + @clerk/backend) and must never be prerendered/cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  return toProfileResponse(await getAccountProfileForRequest());
}

export async function PATCH(request: Request): Promise<Response> {
  const parsed = await parseProfileUpdateBody(request);
  if (!parsed.ok) {
    return new Response(JSON.stringify(genericErrorBody(parsed.status)), {
      status: parsed.status,
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  }
  return toProfileResponse(await updateAccountProfileForRequest(parsed.input));
}
