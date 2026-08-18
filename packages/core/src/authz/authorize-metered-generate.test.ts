// ACBP-API-008 / CDR-092 §15 — authorizeMeteredGenerate, the consult core exposes so the request
// layer can debit the company bucket only after owner-only authz.
//
// This file is the half that does not need PostgreSQL: the closed action set. An unknown action must
// be forbidden WITHOUT touching the database, because that is what stops this function being pointed
// at `strategy:read` (owner|viewer) and used to let a viewer spend the company's tokens. The
// membership and role cases live in the sibling integration file.
import { describe, test, expect } from 'vitest';
import { authorizeMeteredGenerate, METERED_GENERATE_ACTIONS } from './authorize-metered-generate.js';
import type { DatabaseClient } from '@acbp/database';

describe('authorizeMeteredGenerate — the action set is closed (CDR-092 §15.2)', () => {
  test('a non-generate action is forbidden and never uses the client', async () => {
    // A client that throws if anything touches it. If the action guard is removed, this test goes
    // red on the throw rather than silently becoming an authz oracle for `strategy:read`.
    const client = new Proxy({} as DatabaseClient, {
      get() {
        throw new Error('the database was reached for an action this function must not answer');
      },
    });
    await expect(
      authorizeMeteredGenerate(client, {
        userId: 'u',
        accountId: 'a',
        companyId: 'c',
        action: 'strategy:read' as 'strategy:generate',
      }),
    ).resolves.toBe('forbidden');
  });

  test('the closed set is exactly the four owner-only generate actions', () => {
    expect([...METERED_GENERATE_ACTIONS].sort()).toEqual(
      ['roadmap:generate', 'strategy:generate', 'strategy:recommend', 'task:generate'].sort(),
    );
  });
});
