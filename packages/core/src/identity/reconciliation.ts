// @acbp/core — nightly drift RECONCILIATION (ACBP-P1-002; CDR-007/008).
//
// Backstop for missed/out-of-order webhooks: scan ACTIVE internal mappings, re-read each authoritative
// snapshot (injected AuthoritativeIdentityReader), and repair FORWARD drift through the SAME
// last-write-wins convergence used everywhere else. Provider-neutral (no Clerk import). Deterministic
// (keyset pagination over immutable ids) and IDEMPOTENT (a second run reports all in_sync).
//
// NON-DESTRUCTIVE (see docs/agent/DECISION-LOG.md): a provider `not_found` (404) or `unavailable` is
// counted/logged, never auto-tombstoned — deletion stays webhook-first (CDR-008). Tombstones are never
// scanned, so a deleted identity is never resurrected. The repair is a single atomic conditional
// UPDATE guarded on `status='active'` and `provider_updated_at < snapshot`.
import { UserMappingRepository, toDatabaseError, type DatabaseClient, type ProviderIdentityKey, type UserRow } from '@acbp/database';
import type { AuthoritativeIdentityReader, AuthoritativeIdentitySnapshot } from '@acbp/contracts';
import type { Logger } from '@acbp/observability';

export interface ReconciliationSummary {
  readonly scanned: number;
  readonly inSync: number;
  readonly repaired: number;
  readonly providerMissing: number;
  readonly providerUnavailable: number;
}

export interface ReconcileOptions {
  readonly batchSize?: number;
  readonly correlationId?: string;
  readonly logger?: Logger;
}

/** Minimal store seam so the reconciliation loop is unit-testable without a real database. */
export interface ReconcileUserStore {
  listActive(afterId: string | null, limit: number): Promise<UserRow[]>;
  /** Apply the snapshot iff strictly newer than the stored active row; returns true iff repaired. */
  repairFromAuthoritativeSnapshot(snapshot: AuthoritativeIdentitySnapshot): Promise<boolean>;
}

const DEFAULT_BATCH = 100;
const keyOf = (row: UserRow): ProviderIdentityKey => ({ provider: row.provider, providerInstanceId: row.provider_instance_id, providerUserId: row.provider_user_id });

/**
 * Store-based reconciliation loop (unit-testable). Pages through active rows by immutable id; for each,
 * reads the authoritative snapshot and repairs forward drift. Bounded logging only (counts + correlation
 * id — never PII). A row that a concurrent webhook deletes/advances mid-scan simply yields `in_sync`
 * (the conditional repair matches nothing), which keeps the run idempotent and non-destructive.
 */
export async function reconcileUsersWithStore(
  store: ReconcileUserStore,
  reader: AuthoritativeIdentityReader,
  options: ReconcileOptions = {},
): Promise<ReconciliationSummary> {
  const batchSize = options.batchSize && options.batchSize > 0 ? options.batchSize : DEFAULT_BATCH;
  const adapterOptions = options.correlationId !== undefined ? { correlation: { correlationId: options.correlationId } } : undefined;
  let scanned = 0;
  let inSync = 0;
  let repaired = 0;
  let providerMissing = 0;
  let providerUnavailable = 0;

  let afterId: string | null = null;
  for (;;) {
    const rows = await store.listActive(afterId, batchSize);
    if (rows.length === 0) break;
    for (const row of rows) {
      scanned += 1;
      const read = await reader.read(keyOf(row), adapterOptions);
      if (read.status === 'unavailable') {
        providerUnavailable += 1;
        continue;
      }
      if (read.status === 'not_found') {
        providerMissing += 1; // non-destructive: recorded, never auto-deleted
        continue;
      }
      const didRepair = await store.repairFromAuthoritativeSnapshot(read.snapshot);
      if (didRepair) repaired += 1;
      else inSync += 1;
    }
    const last = rows[rows.length - 1];
    if (last === undefined) break;
    afterId = last.id;
    if (rows.length < batchSize) break;
  }

  const summary: ReconciliationSummary = { scanned, inSync, repaired, providerMissing, providerUnavailable };
  options.logger?.info('reconcile.complete', {
    metadata: { ...summary, ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) },
  });
  return summary;
}

/**
 * Reconcile all active mappings using the live database client + the injected authoritative reader.
 * The reader never throws (it returns `unavailable`), so any thrown error here is a database driver
 * fault; it is normalized to a sanitized PlatformError so a raw driver error never crosses the boundary.
 */
export async function reconcileAllUsers(client: DatabaseClient, reader: AuthoritativeIdentityReader, options: ReconcileOptions = {}): Promise<ReconciliationSummary> {
  try {
    return await reconcileUsersWithStore(new UserMappingRepository(client.kysely), reader, options);
  } catch (e) {
    throw toDatabaseError(e, { operation: 'reconcile', ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
  }
}
