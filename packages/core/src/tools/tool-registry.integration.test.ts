// ACBP-P5-003a / CDR-051 — real-PostgreSQL proof of the tool registry.
//
// Two things matter here and neither can be checked without a database:
//   1. the CHECK constraint's class set is EXACTLY the contract's `RISK_CLASSES` — the set is provisional (CDR-051
//      §0) and expected to be revisited, so a drift guard matters more than usual;
//   2. the app role can READ the registry and can never WRITE it, which is what makes "trust-critical determinations
//      come from the tool registry" (APPROVAL-AND-POLICY-ARCHITECTURE §4) a structural claim rather than a habit.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { RISK_CLASSES, MOST_RESTRICTIVE_RISK_CLASS, resolveRiskClass } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, teardown, assertRestrictedRole, asRestricted } from '@acbp/test-support';

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const UNIQUE_VIOLATION = '23505';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('tool registry (real PostgreSQL) — ACBP-P5-003a/CDR-051', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;

  beforeAll(async () => {
    owner = createOwnerFixtureClient();
    await resetSchema(owner);
    await enableAppLogin(owner);
    product = createRestrictedProductClient();
    await assertRestrictedRole(product);
  }, 60_000);
  afterAll(async () => {
    await teardown(owner, product);
  });

  /** Register a tool as the OWNER role — the only path that exists (there is no runtime write grant). */
  async function register(toolId: string, version: number, riskClass: string | null): Promise<void> {
    await sql`insert into tool_definitions (tool_id, version, risk_class, description)
              values (${toolId}, ${version}, ${riskClass}, 'fixture tool')`.execute(owner.kysely);
  }

  test('the CHECK accepts EXACTLY the contract\'s class set — the database and @acbp/contracts cannot drift', async () => {
    // The set is provisional and expected to be revisited (CDR-051 §0), which is precisely why this guard exists: a
    // three-class rework that updated only one side would otherwise pass every unit test.
    for (const [i, riskClass] of RISK_CLASSES.entries()) {
      await register(`drift_${i}`, 1, riskClass);
    }
    const rows = await owner.kysely.selectFrom('tool_definitions').select('risk_class').where('tool_id', 'like', 'drift_%').execute();
    expect(rows.map((r) => r.risk_class).sort()).toEqual([...RISK_CLASSES].sort());
  });

  test('the CHECK REFUSES a class outside the set, including canon\'s ungrouped "external"', async () => {
    for (const bad of ['external', 'harmless', 'INFORMATIONAL', 'informational ']) {
      await expect(register(`bad_${bad.trim()}`, 1, bad)).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    }
  });

  test('risk_class is NULLABLE — "unclassified" must be representable or TOOL-001 is untestable', async () => {
    await register('unclassified_tool', 1, null);
    const row = await owner.kysely.selectFrom('tool_definitions').selectAll().where('tool_id', '=', 'unclassified_tool').executeTakeFirst();
    expect(row?.risk_class).toBeNull();
    // And the stored NULL resolves to the most restrictive class — the requirement, end to end.
    expect(resolveRiskClass(row?.risk_class)).toBe(MOST_RESTRICTIVE_RISK_CLASS);
  });

  test('a tool is revised by a NEW VERSION, never an edited row', async () => {
    await register('versioned_tool', 1, 'informational');
    await register('versioned_tool', 2, 'external_irreversible');
    await expect(register('versioned_tool', 2, 'informational')).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
    const rows = await owner.kysely.selectFrom('tool_definitions').select(['version', 'risk_class']).where('tool_id', '=', 'versioned_tool').orderBy('version').execute();
    expect(rows).toEqual([
      { version: 1, risk_class: 'informational' },
      { version: 2, risk_class: 'external_irreversible' },
    ]);
  });

  test('the app role can READ the registry', async () => {
    await register('readable_tool', 1, 'informational');
    await asRestricted(product, {}, async (db) => {
      const row = await db.selectFrom('tool_definitions').selectAll().where('tool_id', '=', 'readable_tool').executeTakeFirst();
      expect(row?.risk_class).toBe('informational');
    });
  });

  test('the app role can NEVER write it — no INSERT, no UPDATE, no DELETE', async () => {
    await register('immutable_tool', 1, 'informational');
    // This is the structural half of "a model may suggest a category, but trust-critical determinations come from the
    // registry": the product runtime cannot reclassify a tool to something more permissive, by any path.
    await expect(
      asRestricted(product, {}, (db) =>
        sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('smuggled', 1, 'informational', 'x')`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    await expect(
      asRestricted(product, {}, (db) => sql`update tool_definitions set risk_class = 'informational'`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    await expect(
      asRestricted(product, {}, (db) => sql`delete from tool_definitions`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
  });

  test('the registry is GLOBAL — no company_id column, and no RLS, because a tool is not tenant data', async () => {
    const cols = await sql<{ column_name: string }>`
      select column_name from information_schema.columns where table_schema = 'public' and table_name = 'tool_definitions'
    `.execute(owner.kysely);
    expect(cols.rows.map((c) => c.column_name)).not.toContain('company_id');
    expect(cols.rows.map((c) => c.column_name)).not.toContain('account_id');
    const rls = await sql<{ relrowsecurity: boolean }>`
      select relrowsecurity from pg_class where relname = 'tool_definitions' and relkind = 'r'
    `.execute(owner.kysely);
    // Deliberately NOT RLS-enabled: it holds no tenant data, so it is correctly absent from TENANT_TABLES.
    expect(rls.rows[0]?.relrowsecurity).toBe(false);
  });
});
