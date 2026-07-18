// ACBP-P0-018 — nested-transaction policy (unit). Commit/rollback/release are covered by the real
// PostgreSQL integration suite (integration/database.integration.test.ts).
import { describe, test, expect } from 'vitest';
import { ErrorCodes } from '@acbp/contracts';
import { createTestLogger } from '@acbp/observability';
import { withTransaction, withTenantTransaction, nestedTransactionError, type DatabaseClient, type TenantContext } from './index.js';

// A fake client that reports itself as already inside a transaction.
function inTxClient(): DatabaseClient {
  const tl = createTestLogger({ component: 'database' });
  return { inTransaction: true, logger: tl.logger } as unknown as DatabaseClient;
}

const tenant: TenantContext = { accountId: 'acc_1', companyId: 'co_1' };

describe('nested-transaction policy (explicitly unsupported)', () => {
  test('withTransaction rejects re-entry into an active transaction', async () => {
    await expect(withTransaction(inTxClient(), () => Promise.resolve(1))).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR });
  });

  test('withTenantTransaction rejects re-entry into an active transaction', async () => {
    await expect(withTenantTransaction(inTxClient(), tenant, () => Promise.resolve(1))).rejects.toMatchObject({ code: ErrorCodes.INTERNAL_ERROR });
  });

  test('nestedTransactionError is a PlatformError carrying an optional correlation id', () => {
    const e = nestedTransactionError('cid-9');
    expect(e.category).toBe('internal');
    expect(e.correlationId).toBe('cid-9');
    expect(e.message).toContain('Nested transactions');
  });
});
