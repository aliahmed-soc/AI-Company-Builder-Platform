// ACBP-P1-002 Slice 3 — public Clerk webhook Route Handler: POST /api/webhooks/clerk.
//
// PUBLIC at the session layer, protected ENTIRELY by signature verification inside the composed
// service. It requires no Clerk session, cookie, bearer token, internal mapping, org membership, or
// role/permission claim, and trusts NO browser-supplied identity/org/role/email header — only the
// signed webhook body + signature headers. All wiring lives behind @acbp/core's composition layer.
import { createClerkWebhookHandler } from '@/server/webhooks/clerk-webhook-handler';
import { getClerkIdentityRuntime, createWebhookLogger } from '@/server/webhooks/clerk-runtime';

// Needs the Node runtime (pg + @clerk/backend) and must never be prerendered/cached.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export function POST(request: Request): Promise<Response> {
  const handler = createClerkWebhookHandler({ service: getClerkIdentityRuntime().webhook, logger: createWebhookLogger() });
  return handler(request);
}
