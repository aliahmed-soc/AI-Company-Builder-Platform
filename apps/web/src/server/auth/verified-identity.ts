// ACBP-P1-001 — server-side request boundary (ADR-022 / ADR-023).
//
// This is the ENFORCEMENT point for protected requests. It trusts ONLY what the Clerk Next.js server
// helper `auth()` establishes server-side (the verified session's userId) plus the authoritative
// Backend User fetched over the trusted server SDK. It never reads a user id, email, org, role, or
// company from browser-supplied input, headers, or session custom claims.
//
// Verified-email rule (P1-001 acceptance): the primary email address on the Backend User must be
// authoritatively verified. Fetching the Backend User to read this is a TEMPORARY approach for
// P1-001; ACBP-P1-002 owns internal user mapping/caching and may optimize this away. Do not add the
// users table, mapping, membership, or webhooks here.
//
// Fail-closed: anything not provably an authenticated request with a verified primary email is
// rejected. No Clerk SDK object, raw token, cookie, or full email is logged or returned to callers.
//
// @clerk/nextjs/server is imported lazily inside the default dependencies so this module can be
// unit-tested (with injected deps) without loading the Next.js server runtime.
import type { NormalizedIdentity } from '@acbp/contracts';

/** Result of resolving the current request's identity. Discriminated, leakage-free. */
export type VerifiedIdentityResult =
  | { readonly status: 'authenticated'; readonly identity: NormalizedIdentity }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  | { readonly status: 'unavailable' };

/** Minimal, provider-neutral shape read from the Clerk Backend User. Never re-exported wholesale. */
interface BackendUserView {
  readonly id: string;
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: ReadonlyArray<{
    readonly id: string;
    readonly emailAddress: string;
    readonly verification: { readonly status: string | null } | null;
  }>;
  readonly firstName: string | null;
  readonly lastName: string | null;
}

/** Injection seam so the boundary is testable without a live Clerk instance or the network. */
export interface VerifiedIdentityDeps {
  /** Returns the server-verified session's user id, or null when unauthenticated. */
  readonly getUserId: () => Promise<string | null>;
  /** Fetches the authoritative Backend User by id over the trusted server SDK. */
  readonly getBackendUser: (userId: string) => Promise<BackendUserView>;
}

/** Production dependencies: the real Clerk Next.js server helpers (lazily imported). */
const defaultDeps: VerifiedIdentityDeps = {
  getUserId: async () => {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    return userId ?? null;
  },
  getBackendUser: async (userId) => {
    const { clerkClient } = await import('@clerk/nextjs/server');
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    // Clerk's Backend User is structurally a superset of BackendUserView; only the neutral subset is read.
    return user;
  },
};

function normalize(user: BackendUserView): NormalizedIdentity {
  const primary =
    user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId) ?? undefined;
  const email = primary?.emailAddress;
  const displayName = [user.firstName, user.lastName].filter((p): p is string => !!p).join(' ') || undefined;
  return {
    providerUserId: user.id,
    ...(email !== undefined ? { email } : {}),
    emailVerified: true, // only reached after the verified-email check below passes
    ...(displayName !== undefined ? { displayName } : {}),
  };
}

/**
 * Resolve and enforce the current request's identity, fail-closed. Pass `deps` in tests to inject a
 * mocked session + Backend User; production uses the real Clerk server helpers.
 */
export async function resolveVerifiedIdentity(
  deps: VerifiedIdentityDeps = defaultDeps,
): Promise<VerifiedIdentityResult> {
  let userId: string | null;
  try {
    userId = await deps.getUserId();
  } catch {
    // A failure resolving the session is treated as provider-unavailable, never as authenticated.
    return { status: 'unavailable' };
  }
  if (userId === null || userId === '') {
    return { status: 'unauthenticated' };
  }

  let user: BackendUserView;
  try {
    user = await deps.getBackendUser(userId);
  } catch {
    return { status: 'unavailable' };
  }

  const primary = user.emailAddresses.find((e) => e.id === user.primaryEmailAddressId);
  if (primary === undefined || primary.verification?.status !== 'verified') {
    return { status: 'email_unverified' };
  }

  return { status: 'authenticated', identity: normalize(user) };
}
