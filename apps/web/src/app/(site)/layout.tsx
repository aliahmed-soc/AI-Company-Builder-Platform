// ACBP-P1-001 — the site header. The header shows honest signed-in / signed-out controls, chosen server-side
// from the verified session (auth()). No product/company/role logic here (ADR-023). @clerk/nextjs v7 has no
// SignedIn/SignedOut control components, so signed-in state is resolved on the server rather than via client
// control wrappers.
//
// MOVED HERE FROM THE ROOT LAYOUT, MARKUP AND `auth()` CALL UNCHANGED. The only thing that changed is which
// routes render it: the `(site)` group covers `/`, `/sign-in` and `/sign-up`, so `/console` no longer stacks
// its own top bar underneath an auth placeholder. Parenthesised route-group folders do not appear in URLs —
// `(site)/page.tsx` still serves `/`, and `(site)/sign-in/[[...sign-in]]/page.tsx` still serves `/sign-in`.
//
// The `auth()` call is a DISPLAY INPUT, not a control: its only consumer is the ternary below. Nothing here
// denies, redirects or restricts. Enforcement lives at the boundary (`src/proxy.ts`) and in each route's
// `resolveVerifiedIdentity()`, neither of which reads anything a layout rendered.
import type { ReactNode } from 'react';
import './site.css';
import { SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';

export default async function SiteLayout({ children }: { children: ReactNode }) {
  const { userId } = await auth();
  return (
    <>
      <header>
        <strong>ACBP</strong>
        <span style={{ flex: 1 }} />
        {userId ? (
          <UserButton />
        ) : (
          <>
            <SignInButton />
            <SignUpButton />
          </>
        )}
      </header>
      {children}
    </>
  );
}
