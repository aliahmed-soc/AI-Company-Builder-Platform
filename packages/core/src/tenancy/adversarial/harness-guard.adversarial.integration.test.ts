// ACBP-P1-014 / CDR-020 §4 — regression test for the HARNESS GUARD itself.
//
// The whole adversarial suite rests on one assumption: product assertions execute as the restricted
// `acbp_app` role. If a suite were ever mis-wired to the owner/fixture client, cross-tenant "denials" would
// be produced by RLS bypass rather than by isolation — vacuous or, worse, silently wrong. This test does the
// mis-wiring ON PURPOSE and proves `assertRestrictedRole` fails immediately.
//
// Real PostgreSQL is MANDATORY: the guard reads pg_roles/pg_tables for the CONNECTED role.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, teardown, assertRestrictedRole } from '@acbp/test-support';

describe.skipIf(!hasTestDatabase)('adversarial harness guard (real PostgreSQL) — ACBP-P1-014/CDR-020', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  test('the OWNER FIXTURE client is REJECTED by assertRestrictedRole (a mis-wired suite fails immediately)', async () => {
    await expect(assertRestrictedRole(owner)).rejects.toThrow(/superuser|acbp_app|BYPASSRLS|OWNS tables/i);
  });

  test('the RESTRICTED product client is accepted, with the full role proof', async () => {
    const proof = await assertRestrictedRole(product);
    expect(proof).toEqual({ currentUser: 'acbp_app', isSuperuser: false, bypassesRls: false, ownedProductTables: [] });
  });

  test('the two clients really are different roles (the guard is not comparing a client to itself)', async () => {
    const ownerUser = (await sql<{ u: string }>`select current_user as u`.execute(owner.kysely)).rows[0]?.u;
    const productProof = await assertRestrictedRole(product);
    expect(ownerUser).toBeDefined();
    expect(ownerUser).not.toBe(productProof.currentUser);
  });
});
