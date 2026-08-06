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
import type { RequestLimitOutcome } from '@acbp/core';

/** Result of resolving the current request's identity. Discriminated, leakage-free. */
export type VerifiedIdentityResult =
  | { readonly status: 'authenticated'; readonly identity: NormalizedIdentity }
  | { readonly status: 'unauthenticated' }
  | { readonly status: 'email_unverified' }
  /** CDR-008 §8's per-session ceiling refused this request (ACBP-P7-013; CDR-081). */
  | { readonly status: 'rate_limited'; readonly retryAfterSeconds: number }
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
  /**
   * Returns the server-verified SESSION id — the key CDR-008 §8's per-session ceiling is measured against.
   *
   * Distinct from the user id on purpose: §8 rules a per-SESSION limit, and collapsing it onto the user would
   * silently make it stricter than the accepted decision.
   */
  readonly getSessionId: () => Promise<string | null>;
  /** Fetches the authoritative Backend User by id over the trusted server SDK. */
  readonly getBackendUser: (userId: string) => Promise<BackendUserView>;
  /**
   * Consume one request against the per-session ceiling (ACBP-P7-013; CDR-081; NFR-010).
   *
   * ⚠️ REQUIRED, NEVER OPTIONAL, AND NEVER DEFAULTED TO "ALLOW". ACBP-P6-007 deleted a caller-injectable stop
   * port for exactly this shape: it defaulted to `clear`, which was true only while no engine existed, and with
   * a real engine a caller could assert `clear` and walk through a live stop (CDR-072 §1-G1). An optional
   * limiter defaulting to allowed would reproduce that defect precisely — every test omitting it would pass, and
   * so would any production path that forgot it. Because this field is required, a caller that wants to be
   * admitted has to say so in writing.
   */
  readonly checkSessionLimit: (sessionId: string) => Promise<RequestLimitOutcome>;
}

/** Production dependencies: the real Clerk Next.js server helpers (lazily imported). */
const defaultDeps: VerifiedIdentityDeps = {
  getUserId: async () => {
    const { auth } = await import('@clerk/nextjs/server');
    const { userId } = await auth();
    return userId ?? null;
  },
  getSessionId: async () => {
    const { auth } = await import('@clerk/nextjs/server');
    const { sessionId } = await auth();
    return sessionId ?? null;
  },
  getBackendUser: async (userId) => {
    const { clerkClient } = await import('@clerk/nextjs/server');
    const client = await clerkClient();
    const user = await client.users.getUser(userId);
    // Clerk's Backend User is structurally a superset of BackendUserView; only the neutral subset is read.
    return user;
  },
  checkSessionLimit: async (sessionId) => {
    const { getClerkIdentityRuntime } = await import('../webhooks/clerk-runtime.js');
    return getClerkIdentityRuntime().checkRequestLimit('session', sessionId);
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

  // ── THE RATE LIMIT RUNS HERE, AND THE POSITION IS THE POINT (ACBP-P7-013; CDR-081 §3.3) ────────────────────
  //
  // AFTER the session is established, so the key is cryptographically verified rather than browser-asserted —
  // an IP-keyed limit would be evadable by setting a header and, worse, would let an attacker spend a victim's
  // bucket by forging their address, turning a protection into a targeted denial of service.
  //
  // BEFORE `getBackendUser`, which is a NETWORK CALL to Clerk's Backend API on every protected request. Limiting
  // after it would leave the platform's most expensive per-request dependency unbounded — the limiter would be
  // standing behind the thing most worth protecting.
  let sessionId: string | null;
  try {
    sessionId = await deps.getSessionId();
  } catch {
    sessionId = null;
  }
  // ── WHEN THERE IS NO SESSION ID, FALL BACK TO THE USER ID — NEVER TO A SHARED KEY, NEVER TO AN OUTAGE ──────
  //
  // An earlier version of this refused the request outright, on the reasoning that a verified user without a
  // session id is not a shape Clerk produces. Hosted CI disproved the premise in the bluntest way available: five
  // real-database route suites stub `auth()` as `{ userId }` with no `sessionId`, and EVERY route in them
  // returned 503. That is the failure mode the strict version actually has — not one unmeterable request
  // refused, but every request refused at once, from one unexpected provider shape.
  //
  // The user id is the right fallback because it is STRICTER, not looser: all of one user's sessions then share
  // a single bucket, so the ceiling still binds and binds harder. The alternatives are both wrong — a shared
  // constant key would let any caller throttle everyone else, and admitting unmetered would fail open.
  //
  // The `getSessionId` throw is folded into the same path for the same reason: an unreadable session id is a
  // reason to meter more coarsely, not a reason to take the platform down.
  const limitKey = sessionId !== null && sessionId !== '' ? sessionId : userId;
  const limit = await deps.checkSessionLimit(limitKey);
  if (limit.kind === 'throttled') return { status: 'rate_limited', retryAfterSeconds: limit.retryAfterSeconds };
  // `unavailable` is reported as unavailable, never as throttled: telling a caller "you are sending too many
  // requests" when the truth is "we could not tell" is a different claim, and the wrong one.
  if (limit.kind === 'unavailable') return { status: 'unavailable' };

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
