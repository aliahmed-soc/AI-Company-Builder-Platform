// @acbp/core — portfolio service pure-guard tests (ACBP-P1-011; CDR-017). These exercise the input-validation
// short-circuits that return BEFORE any database access, so they run without a database (the DB-backed
// enumeration/enrichment behavior is proven in portfolio.integration.test.ts).
import { describe, test, expect } from 'vitest';
import { encodePortfolioCursor } from '@acbp/contracts';
import { getCompanyPortfolio } from './portfolio-service.js';
import type { DatabaseClient } from '@acbp/database';

// A client that throws if ANY property is accessed — proves the guard returned before touching the database.
const NO_DB = new Proxy(
  {},
  {
    get() {
      throw new Error('database must not be accessed on an early-rejected portfolio request');
    },
  },
) as unknown as DatabaseClient;

const ACCT = '11111111-1111-1111-1111-111111111111';
const USER = 'user_abc';

describe('getCompanyPortfolio — pre-DB input guards', () => {
  test('an invalid page size is REJECTED (never clamped) without any DB access', async () => {
    for (const bad of [0, -1, 101, 1000, 'abc', 1.5, '10.5']) {
      expect(await getCompanyPortfolio(NO_DB, { userId: USER, accountId: ACCT, limit: bad })).toEqual({ status: 'invalid_limit' });
    }
  });

  test('a malformed cursor is rejected as invalid_cursor without any DB access', async () => {
    expect(await getCompanyPortfolio(NO_DB, { userId: USER, accountId: ACCT, cursor: 'not-a-cursor!!' })).toEqual({ status: 'invalid_cursor' });
  });

  test('a cursor bound to a different actor/account is rejected as invalid_cursor', async () => {
    const cur = encodePortfolioCursor(ACCT, USER, { createdAt: '2026-01-01T00:00:00.000000Z', companyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' });
    // Different actor.
    expect(await getCompanyPortfolio(NO_DB, { userId: 'user_other', accountId: ACCT, cursor: cur })).toEqual({ status: 'invalid_cursor' });
    // Different account.
    expect(await getCompanyPortfolio(NO_DB, { userId: USER, accountId: '22222222-2222-2222-2222-222222222222', cursor: cur })).toEqual({ status: 'invalid_cursor' });
  });

  test('limit is validated before the cursor (an invalid limit short-circuits even with a bad cursor)', async () => {
    expect(await getCompanyPortfolio(NO_DB, { userId: USER, accountId: ACCT, limit: 0, cursor: 'whatever' })).toEqual({ status: 'invalid_limit' });
  });
});
