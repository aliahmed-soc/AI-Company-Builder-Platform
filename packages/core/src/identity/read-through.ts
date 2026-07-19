// @acbp/core — resolve-or-reconcile internal user via authoritative READ-THROUGH (ACBP-P1-002 Slice 3;
// CDR-008).
//
// Provider-NEUTRAL use case: given a provider identity, return the internal user, reconciling the
// mapping on a MISS by reading the authoritative snapshot (injected AuthoritativeIdentityReader) and
// converging ONE active mapping transactionally. No Clerk import here; the reader is an interface.
//
// Read-through is authoritative synchronization, NOT a synthetic webhook: it writes NO webhook receipt
// and sets last_event_id = null. It NEVER resurrects a deleted identity and NEVER trusts browser input
// (the composition supplies the provider instance id from configuration, and the provider user id from
// the server-verified session).
import {
  withTransaction,
  UserMappingRepository,
  type DatabaseClient,
  type ProviderIdentityKey,
  type UserRow,
  type NewUser,
} from '@acbp/database';
import type { AuthoritativeIdentityReader, PublicErrorEnvelope } from '@acbp/contracts';

/** Bounded outcome of resolve-or-reconcile. `unavailable` carries a sanitized provider error. */
export type InternalUserReconciliation =
  | { readonly status: 'active'; readonly userId: string }
  | { readonly status: 'deleted' }
  | { readonly status: 'not_found' }
  | { readonly status: 'unavailable'; readonly error: PublicErrorEnvelope };

/** Minimal store seam so the reconciliation logic is unit-testable without a real database. */
export interface ReadThroughUserStore {
  findByProviderIdentity(key: ProviderIdentityKey): Promise<UserRow | undefined>;
  insertIfAbsent(values: NewUser): Promise<{ readonly row: UserRow; readonly inserted: boolean }>;
}

export interface ReconcileOptions {
  readonly correlationId?: string;
}

function rowToResolution(row: UserRow): InternalUserReconciliation {
  // A deleted tombstone never resolves as active and exposes no PII (its email was redacted on delete).
  return row.status === 'deleted' ? { status: 'deleted' } : { status: 'active', userId: row.id };
}

/** Build the active mapping row from an authoritative snapshot. Read-through NEVER sets last_event_id. */
function snapshotToNewUser(snapshot: {
  readonly provider: string;
  readonly providerInstanceId: string;
  readonly providerUserId: string;
  readonly primaryEmail: string | null;
  readonly emailVerified: boolean;
  readonly providerCreatedAt: Date | null;
  readonly providerUpdatedAt: Date;
}): NewUser {
  return {
    provider: snapshot.provider,
    provider_instance_id: snapshot.providerInstanceId,
    provider_user_id: snapshot.providerUserId,
    primary_email: snapshot.primaryEmail,
    email_verified: snapshot.emailVerified,
    status: 'active',
    provider_created_at: snapshot.providerCreatedAt,
    provider_updated_at: snapshot.providerUpdatedAt,
    last_event_id: null, // authoritative snapshot has no webhook tie-break value (NOT a chronological event)
  };
}

/**
 * Store-based reconciliation (unit-testable with fakes). Fast path returns an existing mapping WITHOUT
 * calling the provider; a deleted mapping returns `deleted` (never reactivated). On a miss it reads the
 * authoritative snapshot and converges via {@link ReadThroughUserStore.insertIfAbsent}, which resolves
 * concurrent read-through/webhook races to a single row (and returns a tombstone as `deleted`).
 */
export async function reconcileWithStore(
  users: ReadThroughUserStore,
  reader: AuthoritativeIdentityReader,
  key: ProviderIdentityKey,
  options: ReconcileOptions = {},
): Promise<InternalUserReconciliation> {
  const existing = await users.findByProviderIdentity(key);
  if (existing !== undefined) return rowToResolution(existing);

  const adapterOptions = options.correlationId !== undefined ? { correlation: { correlationId: options.correlationId } } : undefined;
  const read = await reader.read(key, adapterOptions);
  if (read.status === 'not_found') return { status: 'not_found' };
  if (read.status === 'unavailable') return { status: 'unavailable', error: read.error };

  const { row } = await users.insertIfAbsent(snapshotToNewUser(read.snapshot));
  return rowToResolution(row);
}

/**
 * Resolve a provider identity to an internal user, reconciling on a mapping miss. The fast-path read
 * and the (network) authoritative read run OUTSIDE any transaction; only the single race-safe insert
 * runs in a short transaction, so a failure leaves no partial mapping. Unexpected database failures
 * surface as sanitized PlatformErrors (withTransaction) and propagate to the caller.
 */
export async function resolveOrReconcileInternalUser(
  client: DatabaseClient,
  reader: AuthoritativeIdentityReader,
  key: ProviderIdentityKey,
  options: ReconcileOptions = {},
): Promise<InternalUserReconciliation> {
  const existing = await new UserMappingRepository(client.kysely).findByProviderIdentity(key);
  if (existing !== undefined) return rowToResolution(existing);

  const adapterOptions = options.correlationId !== undefined ? { correlation: { correlationId: options.correlationId } } : undefined;
  const read = await reader.read(key, adapterOptions);
  if (read.status === 'not_found') return { status: 'not_found' };
  if (read.status === 'unavailable') return { status: 'unavailable', error: read.error };

  const values = snapshotToNewUser(read.snapshot);
  return withTransaction(
    client,
    async (tx) => {
      const { row } = await new UserMappingRepository(tx.kysely).insertIfAbsent(values);
      return rowToResolution(row);
    },
    options.correlationId !== undefined ? { correlationId: options.correlationId } : {},
  );
}
