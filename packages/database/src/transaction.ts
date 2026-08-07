// @acbp/database — transaction boundaries (ACBP-P0-018; ADR-015 transactional discipline, ADR-017).
//
// Nested-transaction policy: EXPLICITLY UNSUPPORTED. Kysely runs the callback inside a single real
// transaction and handles commit on success / rollback on throw / connection release on both paths.
// Re-entering withTransaction with an executor that is already in a transaction throws
// NestedTransactionError rather than silently opening a savepoint — a transaction never silently
// remains open, and cross-boundary reuse is a deliberate, visible choice (pass the tx handle down).
// Savepoint support may be added later if a concrete need arises.
import { platformError, ErrorCodes, type PlatformError } from '@acbp/contracts';
import { sql, type Transaction } from 'kysely';
import type { DatabaseClient, DbCallOptions } from './client.js';
import type { DatabaseSchema } from './schema.js';
import type { AccountContext } from '@acbp/contracts';
import { toDatabaseError } from './errors.js';
import { applyTenantSession, applyAccountSession, TENANT_SETTINGS } from './session.js';
import { createTenantScope, type TenantContext, type TenantScope } from './tenant.js';
import { createAccountScope, type AccountScope } from './account-tenant.js';

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
      // ACBP-P7-008 MUTATION PROBE - DO NOT MERGE: the callback never rejects, so the tx COMMITs.
      const result = await fn({ kysely: trx, inTransaction: true }).catch(() => undefined as T);
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

/**
 * Run `fn` in a transaction whose ACCOUNT session settings are applied first (ACBP-P1-005; CDR-012). The
 * callback receives an {@link AccountScope} — the only value account-owned repositories accept — so
 * account-scoped work cannot run without an account context. Sets app.current_account + app.current_actor
 * only; NEVER app.current_company. Same commit/rollback/release + error-normalization guarantees as
 * {@link withTenantTransaction}. The AccountScope is brand-distinct from TenantScope (CDR-012 #8).
 */
export async function withAccountTransaction<T>(
  client: DatabaseClient,
  account: AccountContext,
  fn: (scope: AccountScope) => Promise<T>,
  options: DbCallOptions = {},
): Promise<T> {
  if ((client as ExecutorLike).inTransaction) throw nestedTransactionError(options.correlationId);
  const log = options.logger ?? client.logger;
  try {
    return await client.kysely.transaction().execute(async (trx) => {
      await applyAccountSession(trx, account);
      log.debug('db.tx.begin', { metadata: { accountScoped: true } });
      const result = await fn(createAccountScope(account, trx));
      log.debug('db.tx.commit', { metadata: { accountScoped: true } });
      return result;
    });
  } catch (e) {
    const err = toDatabaseError(e, { operation: 'account_transaction', ...(options.correlationId !== undefined ? { correlationId: options.correlationId } : {}) });
    log.warn('db.tx.rollback', { error: err });
    throw err;
  }
}

/**
 * ACCOUNT → COMPANY scope elevation WITHIN an existing account transaction (ACBP-P1-010; CDR-015 §Bootstrap).
 * Given a validated {@link AccountScope} and a company id that either was just inserted under this scope OR is
 * being resolved into, this: (1) VERIFIES the company belongs to the caller's current account via the
 * account-scoped `companies` SELECT policy (fail-closed — a company id from another account or a nonexistent
 * one returns nothing → throws, no scope minted); (2) sets `app.current_company` transaction-locally (SET
 * LOCAL) on the SAME transaction; (3) mints a branded {@link TenantScope} carrying the account+company+actor
 * context. It is NOT a general public scope-minting function: it only elevates an ALREADY-validated
 * AccountScope, and only to a company that scope can see. There is no second transaction and no second
 * connection — the returned scope runs on the same `scope.db` (same tx) as the account work.
 */
export async function elevateToCompanyScope(scope: AccountScope, companyId: string): Promise<TenantScope> {
  const row = await scope.db.selectFrom('companies').select('id').where('id', '=', companyId).executeTakeFirst();
  if (row === undefined) {
    // The company is not visible under the current account scope — refuse to elevate (fail closed).
    throw platformError('not_found', { code: ErrorCodes.RESOURCE_NOT_FOUND, internalMessage: 'Company not found within the current account scope; cannot elevate.' });
  }
  await sql`select set_config(${TENANT_SETTINGS.company}, ${companyId}, ${true})`.execute(scope.db);
  const tenant: TenantContext =
    scope.account.actorId !== undefined
      ? { accountId: scope.account.accountId, companyId, actorId: scope.account.actorId }
      : { accountId: scope.account.accountId, companyId };
  return createTenantScope(tenant, scope.db);
}
