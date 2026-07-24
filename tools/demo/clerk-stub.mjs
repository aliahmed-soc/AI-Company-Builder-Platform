// ACBP-P1-015 — the provider-SDK stub the Slice A demo installs in place of `@clerk/nextjs/server`.
//
// Supplies exactly what the real SDK supplies at that boundary: the server-verified session user id, and the
// authoritative Backend User with a VERIFIED primary email. `resolveVerifiedIdentity` then runs unchanged, so
// the demo genuinely exercises ACC-001's verified-email rule instead of bypassing it. No credentials, no
// network, no live Clerk instance.
import { currentSession } from './clerk-stub-state.mjs';

export function auth() {
  return Promise.resolve({ userId: currentSession() });
}

export function clerkClient() {
  return Promise.resolve({
    users: {
      getUser: (id) =>
        Promise.resolve({
          id,
          primaryEmailAddressId: 'e1',
          emailAddresses: [{ id: 'e1', emailAddress: `${id}@example.com`, verification: { status: 'verified' } }],
          firstName: 'Slice',
          lastName: 'A',
        }),
    },
  });
}
