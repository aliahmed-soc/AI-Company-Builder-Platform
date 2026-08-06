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
//
// ACBP-P7-014 — this file is also the CSRF ENFORCEMENT POINT (CDR-081 §2). The gate is here rather than in
// each route because a per-route control is a control someone forgets on route 17; enforcing at the single
// boundary every request already crosses means a route module that does not exist yet is covered the day it
// is written. Ordering inside `proxy` is load-bearing and is asserted by proxy.test.ts + the static guard
// tools/check-csrf-origin-gate.mjs.
import { clerkMiddleware } from '@clerk/nextjs/server';
import { NextResponse } from 'next/server';
import type { NextMiddleware } from 'next/server';
import { failClosed } from '@/server/auth/fail-closed-proxy';
import { isClerkWebhookPath } from '@/server/webhooks/route-path';
import { decideSameOrigin, allowedOriginsFromEnv } from '@/server/http/same-origin';

// clerkMiddleware() establishes the auth context (making auth() available downstream). It is wrapped
// so a credential Clerk cannot parse (malformed/tampered token) fails closed as 401, never a 500.
const sessionProxy = failClosed(clerkMiddleware());

// Resolved once at module load, from APP_PUBLIC_URL. Empty when unset/unusable, which denies the Origin
// fallback rows while `Sec-Fetch-Site: same-origin` still admits a browser — a misconfiguration degrades
// toward refusing state-changing requests, never toward accepting them (CDR-081 §1.2).
//
// READ STATICALLY (`process.env.APP_PUBLIC_URL`), never as `allowedOriginsFromEnv(process.env)` or by a
// computed key. Next bundles this boundary and substitutes statically-analysable `process.env.X`
// references; a dynamic lookup can read undefined at runtime where a static one reads the configured
// value. The resulting failure is silent AND in the safe direction — an empty allowed set just means the
// Origin fallback denies — which is precisely why it would never be noticed. The env-shape knowledge stays
// here at the boundary; `allowedOriginsFromEnv` keeps taking a plain record so it stays testable.
const allowedOrigins = allowedOriginsFromEnv({ APP_PUBLIC_URL: process.env.APP_PUBLIC_URL });

// ACBP-P1-002 Slice 3: the Clerk webhook endpoint is authenticated ONLY by signature verification in
// its Route Handler. Bypass the interactive session proxy for EXACTLY that route so a stray/tampered
// cookie can never 401 an authentic signed webhook. Every other route is unchanged (still fail-closed
// session handling) — this narrow exclusion does not open any other route.
const proxy: NextMiddleware = (request, event) => {
  // STEP 1 — the webhook bypass MUST stay first. Clerk's servers send neither Origin nor Sec-Fetch-Site,
  // so evaluating the gate before this line would deny every authentic signed webhook by the
  // no-provenance row. That is the ACBP-P1-002 hazard this bypass was created for, arriving from a new
  // direction; proxy.test.ts pins it.
  if (isClerkWebhookPath(new URL(request.url).pathname)) return undefined;

  // STEP 2 — the CSRF gate, BEFORE any session is established, so a forged request costs no Clerk round
  // trip and reaches no route handler. The denial is the same coarse 403 the companies mapper returns:
  // the verdict's reason is for the tests and the operator, never for the caller (it would be an oracle).
  const verdict = decideSameOrigin(
    {
      method: request.method,
      secFetchSite: request.headers.get('sec-fetch-site'),
      origin: request.headers.get('origin'),
    },
    allowedOrigins,
  );
  if (verdict.kind === 'deny') return NextResponse.json({ error: 'forbidden' }, { status: 403 });

  // STEP 3 — unchanged.
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
