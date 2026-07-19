// @acbp/adapters — adapter-INTERNAL Clerk user normalization (ACBP-P1-002).
//
// Single source of truth for selecting + normalizing a Clerk user's primary email, shared by BOTH the
// webhook verifier (webhook JSON shape) and the authoritative read-through reader (Backend User shape),
// so the two paths can never drift. Callers adapt their provider-specific shape into the neutral
// `PrimaryEmailCandidate[]` below; the rules (trim + lowercase; verified only when the PRIMARY address
// is verified; missing → null/false) live here once. Not exported from the package public index.

/** Neutral view of one Clerk email address, adapted from either the webhook JSON or the Backend User. */
export interface PrimaryEmailCandidate {
  readonly id: string;
  readonly email: string | null | undefined;
  /** Whether THIS address is authoritatively verified (verification.status === 'verified'). */
  readonly verified: boolean;
}

export interface NormalizedPrimaryEmail {
  readonly primaryEmail: string | null;
  readonly emailVerified: boolean;
}

/**
 * Select the primary email ONLY by matching `primaryEmailAddressId`, normalize it (trim + lowercase),
 * and mark it verified ONLY when that exact primary address is verified. A verified NON-primary address
 * never sets emailVerified. A missing/blank primary → { null, false }.
 */
export function selectNormalizedPrimaryEmail(
  primaryEmailAddressId: string | null | undefined,
  candidates: readonly PrimaryEmailCandidate[],
): NormalizedPrimaryEmail {
  if (typeof primaryEmailAddressId !== 'string' || primaryEmailAddressId.length === 0) {
    return { primaryEmail: null, emailVerified: false };
  }
  const primary = candidates.find((c) => c.id === primaryEmailAddressId);
  if (primary === undefined) return { primaryEmail: null, emailVerified: false };
  const raw = primary.email;
  const primaryEmail = typeof raw === 'string' && raw.trim().length > 0 ? raw.trim().toLowerCase() : null;
  const emailVerified = primaryEmail !== null && primary.verified === true;
  return { primaryEmail, emailVerified };
}
