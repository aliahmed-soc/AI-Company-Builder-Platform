// ACBP-P1-001 — Next.js 16 request-interception boundary (formerly middleware.ts; renamed to
// proxy.ts in Next 16). Mounting clerkMiddleware() here is what makes the server helper `auth()`
// available inside Route Handlers / Server Components — it is the prerequisite for the real
// server-side request boundary (see src/server/auth/verified-identity.ts).
//
// LOCATION IS LOAD-BEARING: because this app uses a `src/` directory (src/app), this file MUST live
// at src/proxy.ts (co-located with `app`), NOT at the project root apps/web/proxy.ts. At the root
// Next.js silently ignores it, clerkMiddleware() never runs, and auth() throws a 500 at runtime.
// Guarded by tools/tests/next-proxy-location.test.mjs.
//
// By Clerk's default, clerkMiddleware() protects NOTHING automatically; every route is public until
// a handler opts in. Enforcement for protected surfaces is therefore performed explicitly and
// server-side in the route (fail-closed), not inferred from any browser-supplied header or claim.
import { clerkMiddleware } from '@clerk/nextjs/server';
import type { NextMiddleware } from 'next/server';
import { failClosed } from '@/server/auth/fail-closed-proxy';
import { isClerkWebhookPath } from '@/server/webhooks/route-path';

// clerkMiddleware() establishes the auth context (making auth() available downstream). It is wrapped
// so a credential Clerk cannot parse (malformed/tampered token) fails closed as 401, never a 500.
const sessionProxy = failClosed(clerkMiddleware());

// ACBP-P1-002 Slice 3: the Clerk webhook endpoint is authenticated ONLY by signature verification in
// its Route Handler. Bypass the interactive session proxy for EXACTLY that route so a stray/tampered
// cookie can never 401 an authentic signed webhook. Every other route is unchanged (still fail-closed
// session handling) — this narrow exclusion does not open any other route.
const proxy: NextMiddleware = (request, event) => {
  if (isClerkWebhookPath(new URL(request.url).pathname)) return undefined;
  return sessionProxy(request, event);
};

export default proxy;

export const config = {
  matcher: [
    // Skip Next.js internals and static files unless referenced in search params.
    '/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)',
    // Always run for API/route handlers.
    '/(api|trpc)(.*)',
    // Always run for Clerk frontend-API routes.
    '/__clerk/(.*)',
  ],
};
