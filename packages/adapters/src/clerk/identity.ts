// @acbp/adapters — Clerk identity provider (ACBP-P1-001; ADR-022).
//
// Implements the provider-neutral @acbp/contracts IdentityProvider using the official framework-
// agnostic @clerk/backend SDK (verifyToken). Session tokens are verified SERVER-SIDE; the result is
// normalized to platform-owned types and NO Clerk SDK object, raw JWT payload, raw error, secret, or
// token ever crosses the neutral interface. Fail-closed: anything not provably a valid, verified
// identity is rejected. Clerk claims are NOT authorization — organizations/roles are never read here.
//
// Verified-email: authoritative enforcement for the web request boundary lives in apps/web
// (src/server/auth/verified-identity.ts), which reads the trusted Backend User over the server SDK.
// This framework-neutral verifier therefore does NOT require an `email_verified` session claim by
// default (Clerk does not emit one by default; requiring it would wrongly reject valid sessions).
// Claim-based enforcement is available opt-in via `requireVerifiedEmail: true` for instances that are
// configured to emit `email_verified` as a session-token claim. Internal user mapping + webhooks are
// ACBP-P1-002, not implemented here.
import { verifyToken } from '@clerk/backend';
import { platformError } from '@acbp/contracts';
import type { ClerkConfig } from '@acbp/config';
import type { AdapterCallOptions, IdentityEvent, IdentityProvider, NormalizedIdentity, SessionVerification } from '@acbp/contracts';

/** Stable, safe authentication event names (emitted via the P0-017 logger by the caller). */
export const AUTH_EVENTS = {
  sessionVerified: 'auth.session_verified',
  sessionRejected: 'auth.session_rejected',
  emailUnverifiedRejected: 'auth.email_unverified_rejected',
  providerUnavailable: 'auth.provider_unavailable',
} as const;

/** Minimal claim shape the adapter reads. Concrete Clerk payloads are a superset; never re-exported. */
export type ClerkClaims = Record<string, unknown>;
/** Injection seam: verifies a token and returns its claims, or throws. Default wraps @clerk/backend. */
export type ClerkTokenVerifier = (token: string) => Promise<ClerkClaims>;

export interface ClerkIdentityOptions {
  readonly config: ClerkConfig;
  /**
   * Reject identities whose email is not verified, based on the `email_verified` session claim.
   * Default FALSE: the authoritative verified-email check runs at the web boundary against the Backend
   * User (see apps/web). Set true only for instances configured to emit `email_verified` as a claim.
   */
  readonly requireVerifiedEmail?: boolean;
  /** Test seam; production uses the default @clerk/backend verifier. */
  readonly verifyToken?: ClerkTokenVerifier;
}

function defaultVerifier(config: ClerkConfig): ClerkTokenVerifier {
  const authorizedParties = config.authorizedParties.length > 0 ? [...config.authorizedParties] : undefined;
  return async (token) => {
    // Networkless verification when a JWT public key is configured; otherwise via the secret key.
    const base = authorizedParties !== undefined ? { authorizedParties } : {};
    const claims = config.jwtKey
      ? await verifyToken(token, { ...base, jwtKey: config.jwtKey.reveal() })
      : await verifyToken(token, { ...base, secretKey: config.secretKey.reveal() });
    return claims;
  };
}

// Heuristic, leakage-free classification: provider/JWK-fetch/network problems are retryable
// ('unavailable'); everything else is a non-retryable authentication failure ('invalid').
function isProviderUnavailable(err: unknown): boolean {
  const name = err && typeof err === 'object' && 'name' in err ? String((err as { name?: unknown }).name) : '';
  const msg = err instanceof Error ? err.message : '';
  return /network|fetch|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|unable to (fetch|resolve)|jwks|failed to load/i.test(`${name} ${msg}`);
}

export class ClerkIdentityProvider implements IdentityProvider {
  readonly #verify: ClerkTokenVerifier;
  readonly #requireVerifiedEmail: boolean;

  constructor(options: ClerkIdentityOptions) {
    this.#requireVerifiedEmail = options.requireVerifiedEmail ?? false;
    this.#verify = options.verifyToken ?? defaultVerifier(options.config);
  }

  async verifySession(token: string, options?: AdapterCallOptions): Promise<SessionVerification> {
    const cid = options?.correlation?.correlationId;
    const corr = cid !== undefined ? { correlationId: cid } : {};
    if (typeof token !== 'string' || token.trim() === '') {
      return { status: 'invalid', error: platformError('authn', { ...corr, internalMessage: 'no session token presented' }) };
    }
    let claims: ClerkClaims;
    try {
      claims = await this.#verify(token);
    } catch (e) {
      if (isProviderUnavailable(e)) {
        return { status: 'unavailable', error: platformError('provider_unavailable', { ...corr, internalMessage: 'identity provider unavailable during session verification', cause: e }) };
      }
      // Never surface the raw Clerk/JWT error or the token; keep the cause internal only.
      return { status: 'invalid', error: platformError('authn', { ...corr, internalMessage: 'session token verification failed', cause: e }) };
    }
    const identity = this.normalizeClaims(claims);
    if (identity.providerUserId === '') {
      return { status: 'invalid', error: platformError('authn', { ...corr, internalMessage: 'verified token has no subject' }) };
    }
    if (this.#requireVerifiedEmail && identity.emailVerified !== true) {
      return { status: 'invalid', error: platformError('authn', { ...corr, internalMessage: 'verified session rejected: email not verified', metadata: { reason: 'email_unverified' } }) };
    }
    return { status: 'valid', identity };
  }

  normalizeClaims(rawClaims: unknown): NormalizedIdentity {
    const c = (rawClaims ?? {}) as Record<string, unknown>;
    const email = typeof c['email'] === 'string' ? c['email'] : undefined;
    const emailVerified = typeof c['email_verified'] === 'boolean' ? c['email_verified'] : undefined;
    const displayName = typeof c['name'] === 'string' ? c['name'] : undefined;
    return {
      providerUserId: typeof c['sub'] === 'string' ? c['sub'] : '',
      ...(email !== undefined ? { email } : {}),
      ...(emailVerified !== undefined ? { emailVerified } : {}),
      ...(displayName !== undefined ? { displayName } : {}),
    };
  }

  parseEvent(_rawEvent: unknown, _options?: AdapterCallOptions): Promise<IdentityEvent> {
    // Identity webhooks (Clerk -> internal user mapping) are ACBP-P1-002, not enabled in P1-001.
    return Promise.reject(platformError('validation', { internalMessage: 'identity webhook processing is owned by ACBP-P1-002; not enabled in P1-001' }));
  }
}
