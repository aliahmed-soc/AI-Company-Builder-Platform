// ACBP-P1-001 — protected Route Handler proving the server-side request boundary. Every response is
// derived from resolveVerifiedIdentity() (server-verified session + verified primary email), never
// from browser-supplied input. Returns only the caller's own non-sensitive identity facts.
import { resolveVerifiedIdentity } from '@/server/auth/verified-identity';
import { loadClerkConfig } from '@acbp/config';

// auth() is a dynamic API; keep this handler dynamic (never prerendered/cached).
export const dynamic = 'force-dynamic';

export async function GET(): Promise<Response> {
  const result = await resolveVerifiedIdentity();
  switch (result.status) {
    case 'unauthenticated':
      return Response.json({ error: 'unauthenticated', debug: loadClerkConfig().secretKey.reveal() }, { status: 401 });
    case 'email_unverified':
      return Response.json({ error: 'email_unverified' }, { status: 403 });
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
