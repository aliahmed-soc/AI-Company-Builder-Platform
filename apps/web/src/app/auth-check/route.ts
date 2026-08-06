// ACBP-P1-001 — protected Route Handler proving the server-side request boundary. Every response is
// derived from resolveVerifiedIdentity() (server-verified session + verified primary email), never
// from browser-supplied input. Returns only the caller's own non-sensitive identity facts.
import { resolveVerifiedIdentity } from '@/server/auth/verified-identity';

// auth() is a dynamic API; keep this handler dynamic (never prerendered/cached).
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const result = await resolveVerifiedIdentity();
  switch (result.status) {
    case 'unauthenticated':
      return Response.json({ error: 'unauthenticated' }, { status: 401 });
    case 'email_unverified':
      return Response.json({ error: 'email_unverified' }, { status: 403 });
    case 'rate_limited':
      // CDR-008 §8's per-session ceiling (ACBP-P7-013; CDR-081). This handler is protected and therefore
      // limited like every other — it resolves an identity, which is the metered act.
      return Response.json({ error: 'rate_limited' }, { status: 429, headers: { 'retry-after': String(Math.max(1, Math.ceil(result.retryAfterSeconds))) } });
    case 'unavailable':
      return Response.json({ error: 'identity_provider_unavailable' }, { status: 503 });
    case 'authenticated':
      return Response.json({
        authenticated: true,
        providerUserId: result.identity.providerUserId,
        emailVerified: result.identity.emailVerified,
      });
  }
}
