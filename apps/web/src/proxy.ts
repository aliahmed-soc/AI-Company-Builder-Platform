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

export default clerkMiddleware();

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
