// @acbp/adapters — Clerk authoritative identity READ-THROUGH reader (ACBP-P1-002 Slice 3; ADR-022 §13,
// CDR-008).
//
// Implements the provider-neutral @acbp/contracts AuthoritativeIdentityReader using the official
// framework-agnostic @clerk/backend Backend API (users.getUser). Used on an internal-mapping MISS to
// fetch the authoritative identity so the core use case can converge a mapping. The Clerk SDK, its
// User object, its exceptions, the secret key, and all PII stay INSIDE this adapter: only a bounded,
// normalized AuthoritativeIdentitySnapshot (or not_found / a sanitized unavailable error) crosses the
// contract. Fail-closed + minimal PII (email + verification only). Nothing here logs.
import { createClerkClient } from '@clerk/backend';
import { platformError } from '@acbp/contracts';
import type { ClerkConfig } from '@acbp/config';
import type {
  AdapterCallOptions,
  AuthoritativeIdentityQuery,
  AuthoritativeIdentityReader,
  AuthoritativeIdentityResult,
  AuthoritativeIdentitySnapshot,
} from '@acbp/contracts';
import { selectNormalizedPrimaryEmail } from './user-normalization.js';

/** Minimal neutral view read from the Clerk Backend User (a structural superset). Never re-exported. */
export interface ClerkBackendUserView {
  readonly id: string;
  readonly primaryEmailAddressId: string | null;
  readonly emailAddresses: ReadonlyArray<{
    readonly id: string;
    readonly emailAddress: string;
    readonly verification: { readonly status: string | null } | null;
  }>;
  readonly createdAt: number;
  readonly updatedAt: number;
}

/** Injection seam: fetch the Backend User by id, or throw. Default wraps @clerk/backend. */
export type ClerkBackendUserFetch = (providerUserId: string) => Promise<ClerkBackendUserView>;

export interface ClerkAuthoritativeIdentityReaderOptions {
  readonly config: ClerkConfig;
  /** REQUIRED for this composition path: the expected Clerk instance id used as providerInstanceId. */
  readonly expectedInstanceId: string;
  /** Test seam; production uses @clerk/backend createClerkClient().users.getUser. */
  readonly fetchUser?: ClerkBackendUserFetch;
}

function defaultFetch(config: ClerkConfig): ClerkBackendUserFetch {
  let client: ReturnType<typeof createClerkClient> | undefined;
  return async (providerUserId) => {
    // The secret key is revealed only here, at the SDK client boundary.
    client ??= createClerkClient({ secretKey: config.secretKey.reveal() });
    // The Backend User is a structural superset of ClerkBackendUserView; only the neutral subset is read.
    return client.users.getUser(providerUserId);
  };
}

/** True when the provider authoritatively reports no such user (HTTP 404), vs a transient/unknown fault. */
function isNotFound(err: unknown): boolean {
  const status = err && typeof err === 'object' && 'status' in err ? (err as { status?: unknown }).status : undefined;
  return status === 404;
}

function unavailable(internalMessage: string, correlationId?: string, cause?: unknown): AuthoritativeIdentityResult {
  const error = platformError('provider_unavailable', {
    internalMessage,
    ...(correlationId !== undefined ? { correlationId } : {}),
    ...(cause !== undefined ? { cause } : {}),
  });
  return { status: 'unavailable', error: error.toPublic() };
}

export class ClerkAuthoritativeIdentityReader implements AuthoritativeIdentityReader {
  readonly #expectedInstanceId: string;
  readonly #fetch: ClerkBackendUserFetch;

  constructor(options: ClerkAuthoritativeIdentityReaderOptions) {
    this.#expectedInstanceId = options.expectedInstanceId;
    this.#fetch = options.fetchUser ?? defaultFetch(options.config);
  }

  async read(query: AuthoritativeIdentityQuery, options?: AdapterCallOptions): Promise<AuthoritativeIdentityResult> {
    const cid = options?.correlation?.correlationId;
    // Missing required instance configuration fails SAFELY (bounded unavailable), never a throw/leak.
    if (typeof this.#expectedInstanceId !== 'string' || this.#expectedInstanceId.length === 0) {
      return unavailable('authoritative identity reader misconfigured: expected instance id is required', cid);
    }
    if (query.provider !== 'clerk' || typeof query.providerUserId !== 'string' || query.providerUserId.length === 0) {
      return unavailable('authoritative identity query is not a valid clerk identity', cid);
    }

    let user: ClerkBackendUserView;
    try {
      user = await this.#fetch(query.providerUserId);
    } catch (e) {
      if (isNotFound(e)) return { status: 'not_found' };
      // Never surface the raw Clerk exception / message / PII — keep the cause internal only.
      return unavailable('authoritative identity provider unavailable', cid, e);
    }

    if (typeof user.id !== 'string' || user.id.length === 0 || !Number.isFinite(user.updatedAt)) {
      return unavailable('authoritative identity provider returned a malformed user', cid);
    }
    const email = selectNormalizedPrimaryEmail(
      user.primaryEmailAddressId,
      user.emailAddresses.map((e) => ({ id: e.id, email: e.emailAddress, verified: e.verification?.status === 'verified' })),
    );
    const snapshot: AuthoritativeIdentitySnapshot = {
      provider: 'clerk',
      providerInstanceId: this.#expectedInstanceId, // authoritative instance, never a browser-supplied value
      providerUserId: user.id,
      primaryEmail: email.primaryEmail,
      emailVerified: email.emailVerified,
      providerCreatedAt: Number.isFinite(user.createdAt) ? new Date(user.createdAt) : null,
      providerUpdatedAt: new Date(user.updatedAt),
    };
    return { status: 'found', snapshot };
  }
}
