// ACBP-P1-001 — root layout. ClerkProvider supplies the client-side auth context; the header shows
// honest signed-in / signed-out controls, chosen server-side from the verified session (auth()).
// No product/company/role logic here (ADR-023). @clerk/nextjs v7 has no SignedIn/SignedOut control
// components, so signed-in state is resolved on the server rather than via client control wrappers.
import type { ReactNode } from 'react';
import { ClerkProvider, SignInButton, SignUpButton, UserButton } from '@clerk/nextjs';
import { auth } from '@clerk/nextjs/server';
import './globals.css';

export const metadata = {
  title: 'AI Company Builder Platform',
  description: 'Authentication boundary (ACBP-P1-001).',
};

export default async function RootLayout({ children }: { children: ReactNode }) {
  const { userId } = await auth();
  return (
    <ClerkProvider>
      <html lang="en">
        <body>
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
        </body>
      </html>
    </ClerkProvider>
  );
}
