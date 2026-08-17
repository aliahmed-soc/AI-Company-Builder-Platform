// ACBP-P1-001 — root layout. It supplies `<html>`, `<body>`, `ClerkProvider` and the global stylesheet, and
// READS NO SESSION.
//
// The honest signed-in / signed-out header lives in `src/app/(site)/layout.tsx`, not here. It was moved so that
// `/console` stops inheriting an auth placeholder bar above its own top bar; `/`, `/sign-in` and `/sign-up` are
// inside the `(site)` route group and still render it, unchanged. Route-group folders in parentheses do not
// appear in URLs, so every one of those paths is byte-identical to what it was.
//
// `ClerkProvider` stays HERE, wrapping every route including `/console`, so no subtree loses the client-side
// auth context. It is passed no `dynamic` prop, so it reads no request data and carries no session state — the
// same as before this file was split. No product/company/role logic here (ADR-023).
import type { ReactNode } from 'react';
import { ClerkProvider } from '@clerk/nextjs';
import './globals.css';

export const metadata = {
  title: 'AI Company Builder Platform',
  description: 'Authentication boundary (ACBP-P1-001).',
};

/*
 * WITHOUT THIS, THE RESPONSIVE RULES NEVER RUN ON A PHONE. A mobile browser given no viewport meta tag lays the
 * page out at a fallback desktop width and scales the result down, so width-based media queries never match on
 * the device they were written for. Measured, not assumed: under Chrome mobile emulation at 420px,
 * `window.innerWidth` reported 1395 while no such tag existed anywhere in this app.
 *
 * Declared at the ROOT because the gap was app-wide — `/`, `/sign-in` and `/sign-up` had it too. It was first
 * declared on the console layout, when that layout was the only responsive surface in the app; that copy is
 * removed in the same change that added this one, so there is exactly one declaration.
 */
export const viewport = {
  width: 'device-width',
  initialScale: 1,
};

/*
 * HOLDS THE RENDER MODE THAT REMOVING `auth()` FROM THIS FILE WOULD OTHERWISE HAVE CHANGED SILENTLY.
 *
 * Until the header moved out, this layout called `await auth()`, and `auth()` reaches `await headers()` — a
 * dynamic API. That single call was the ONLY reason every page in this app was dynamically rendered; measured
 * from the build output, where `prerender-manifest.json` listed exactly one prerendered route (`/_global-error`,
 * which renders outside this layout). Delete the call and `/console` — mock data plus one client component —
 * has no dynamic API left, so Next would prerender it at build time and serve it from disk.
 *
 * That is a rendering change, not an authorization change: enforcement is in `src/proxy.ts` and in each route's
 * `resolveVerifiedIdentity()`, and the middleware still runs per request for a prerendered path. But shipping it
 * as a side effect would (a) delete an app-wide dynamic-rendering guarantee that nothing else asserts, and
 * (b) decide CDR-083 §8 item 9 — the explicitly UNDECIDED question of what the per-request CSP nonce means for
 * caching — by accident and in the wrong direction, since a build-time render has no request and therefore no
 * nonce, while the boundary keeps sending a `'strict-dynamic' 'nonce-…'` policy per request.
 *
 * So the previous behaviour is stated deliberately instead of inherited accidentally. Choosing the render mode
 * on purpose is the owner's call; this line only declines to change it.
 *
 * THIS LINE IS LOAD-BEARING, VERIFIED BY REMOVING IT. With it, `next build` marks every page `ƒ` and
 * `prerender-manifest.json` lists exactly `/_global-error`. Delete it and rebuild, and `/console` and
 * `/_not-found` turn `○` and join that manifest. Re-run that mutation if this line ever looks redundant.
 */
export const dynamic = 'force-dynamic';

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <ClerkProvider>
      <html lang="en">
        <body>{children}</body>
      </html>
    </ClerkProvider>
  );
}
