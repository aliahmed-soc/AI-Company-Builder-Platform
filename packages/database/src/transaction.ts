// @acbp/database — transaction boundaries (ACBP-P0-018; ADR-015 transactional discipline, ADR-017).
//
// Nested-transaction policy: EXPLICITLY UNSUPPORTED. Kysely runs the callback inside a single real
// transaction and handles commit on success / rollback on throw / connection release on both paths.
// Re-entering withTransaction with an executor that is already in a transaction throws
// NestedTransactionError rather than silently opening a savepoint — a transaction never silently
// remains open, and cross-boundary reuse is a deliberate, visible choice (pass the tx handle down).
// Savepoint support may be added later if a concrete need arises.
import { platformError, ErrorCodes, type PlatformError } from '@acbp/contracts';
import type { Transaction } from 'kysely';
import type { DatabaseClient, DbCallOptions } from './client.js';
import type { DatabaseSchema } from './schema.js';
import { toDatabaseError } from './errors.js';
import { applyTenantSession } from './session.js';
import { createTenantScope, type TenantContext, type TenantScope } from './tenant.js';

/** Executor handed to a transaction callback. `inTransaction` guards against accidental nesting. */
export interface TxExecutor {
  readonly kysely: Transaction<DatabaseSchema>;
  readonly inTransaction: true;
}

interface ExecutorLike {
  readonly inTransaction: boolean;
}

export function nestedTransactionError(correlationId?: string): PlatformError {
  return platformError('internal', {
    code: ErrorCodes.INTERNAL_ERROR,
    internalMessage: 'Nested transactions are not supported; reuse the active transaction handle (packages/database/README.md).',
    ...(correlationId !== undefined ? { correlationId } : {}),
  });
}

/**
 * Run `fn` in a transaction. Commits if it resolves, rolls back if it throws; the connection is
 * released on both paths. Any thrown value is normalized to a redacted PlatformError.
 */
export async function withTransaction<T>(client: DatabaseClient, fn: (tx: TxExecutor) => Promise<T>, options: DbCallOptions = {}): Promise<T> {
  if ((client as ExecutorLike).inTransaction) throw nestedTransactionError(options.correlationId);
  const log = options.logger ?? client.logger;
  try {
    return await client.kysely.transaction().execute(async (trx) => {
      log.debug('db.tx.begin');
      const result = await fn({ kysely: trx, inTransaction: true });
      log.debug('db.tx.commit');
      return result;
    });
  } catch (e) {
    const err = toDatabaseError(e, { operation: 'transaction', ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
    log.warn('db.tx.rollback', { error: err });
    throw err;
  }
}

/**
 * Run `fn` in a transaction whose tenant session settings are applied first (RLS-ready). The
 * callback receives a {@link TenantScope} — the only value tenant-owned repositories accept — so
 * tenant-scoped work cannot run without a tenant context. Same commit/rollback/release guarantees.
 */
export async function withTenantTransaction<T>(
  client: DatabaseClient,
  tenant: TenantContext,
  fn: (scope: TenantScope) => Promise<T>,
  options: DbCallOptions = {},
): Promise<T> {
  if ((client as ExecutorLike).inTransaction) throw nestedTransactionError(options.correlationId);
  const log = options.logger ?? client.logger;
  try {
    return await client.kysely.transaction().execute(async (trx) => {
      await applyTenantSession(trx, tenant);
      log.debug('db.tx.begin', { metadata: { tenantScoped: true } });
      const result = await fn(createTenantScope(tenant, trx));
      log.debug('db.tx.commit', { metadata: { tenantScoped: true } });
      return result;
    });
  } catch (e) {
    const err = toDatabaseError(e, { operation: 'tenant_transaction', ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
    log.warn('db.tx.rollback', { error: err });
    throw err;
  }
}
