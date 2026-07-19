// @acbp/core — provider-neutral internal-user resolution (ACBP-P1-002; CDR-008).
//
// Maps a verified provider identity → internal user, reading ONLY the internal mapping. It performs
// NO lazy creation and makes NO provider (Clerk Backend API) call in this slice — authoritative
// read-through reconciliation on a mapping miss is a later slice. A deleted identity never
// authenticates or authorizes and exposes no previously-stored PII.
import { UserMappingRepository, type DatabaseClient, type ProviderIdentityKey } from '@acbp/database';
import type { UserMappingStore } from './webhook-processor.js';

/** Bounded result of resolving a provider identity to an internal user. */
export type InternalUserResolution =
  | { readonly status: 'active'; readonly userId: string }
  | { readonly status: 'deleted' }
  | { readonly status: 'not_found' };

/** Store-based resolution (unit-testable with a fake store). */
export async function resolveWithStore(users: UserMappingStore, key: ProviderIdentityKey): Promise<InternalUserResolution> {
  const row = await users.findByProviderIdentity(key);
  if (row === undefined) return { status: 'not_found' };
  if (row.status === 'deleted') return { status: 'deleted' };
  return { status: 'active', userId: row.id };
}

/** Resolve a provider identity to an internal user using the live database client. */
export function resolveInternalUser(client: DatabaseClient, key: ProviderIdentityKey): Promise<InternalUserResolution> {
  return resolveWithStore(new UserMappingRepository(client.kysely), key);
}
