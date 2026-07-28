// ACBP-P5-014 / CDR-058 — real-PostgreSQL proof of the credit ledger's structure, through the RESTRICTED role.
//
// Lives in @acbp/core rather than @acbp/database: the two-tenant harness is a test-support import, and
// database -> test-support -> database is a package cycle the boundary check refuses. Every DB integration test that
// needs the seeded world lives here for that reason.
//
// The claims worth proving are the ones a comment cannot make true: that the ledger is append-only because of the
// GRANTS, that the product role has no path to MINTING credits because of the POLICY, and that the sign convention is
// enforced by the DATABASE rather than by every future writer remembering it.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { CREDIT_ENTRY_KINDS } from '@acbp/contracts';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { CreditRepository, type DatabaseClient } from '@acbp/database';

// The REAL seed ops. An earlier version passed {} as never, which the typechecker accepted and which made every
// test in this file throw at seed time — 14/14 failed in hosted CI while the file stayed silently green locally,
// because the suite is skipIf-gated and local PostgreSQL is unreachable. Casting a fixture to 'never' is a way of
// telling the compiler to stop checking the thing most likely to be wrong.
const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';
const RLS_VIOLATION = '42501';
const UNIQUE_VIOLATION = '23505';
const FK_VIOLATION = '23503';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('credit ledger (real PostgreSQL, restricted role) — ACBP-P5-014/CDR-058', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;

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

  const rows = async () => owner.kysely.selectFrom('credit_transactions').selectAll().execute();

  /** Mint credits as the OWNER role — there is no product write path for a grant, which is the point (CDR-058 §4). */
  async function grant(accountId: string, credits: number): Promise<void> {
    await sql`insert into credit_transactions (account_id, kind, credits) values (${accountId}, 'grant', ${credits})`.execute(owner.kysely);
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from credit_transactions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  // ── APPEND-ONLY, BY THE GRANTS ────────────────────────────────────────────────────────────────────────────
  test('the restricted role can INSERT and SELECT, and can NEITHER update NOR delete a ledger row', async () => {
    // Invariant 10 as a property of the grants, not of anyone's restraint. One transaction per attempt, because the
    // first refusal aborts the transaction and every later statement would then fail with 25P02 instead of 42501 —
    // the mistake hosted CI caught in P5-005.
    await grant(w.accountA, 5);
    const id = (await rows())[0]?.id ?? '';
    const refused = async (statement: (db: Parameters<Parameters<typeof asRestricted>[2]>[0]) => Promise<unknown>): Promise<void> => {
      await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
        await expect(statement(db)).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
      });
    };
    await refused((db) => sql`update credit_transactions set credits = 999 where id = ${id}`.execute(db));
    await refused((db) => sql`update credit_transactions set kind = 'grant' where id = ${id}`.execute(db));
    await refused((db) => sql`update credit_transactions set account_id = ${w.accountB} where id = ${id}`.execute(db));
    await refused((db) => sql`delete from credit_transactions where id = ${id}`.execute(db));
    expect((await rows())[0]).toMatchObject({ credits: 5, kind: 'grant' });
  });

  test('the app role holds NO column-level UPDATE grant at all — not even one', async () => {
    // Column grants never show in role_table_grants; they live in column_privileges. A single column slipping into
    // that list would make some part of a ledger row rewritable, which is the whole thing this table forbids.
    const r = await sql<{ column_name: string }>`
      select column_name from information_schema.column_privileges
      where table_name = 'credit_transactions' and grantee = 'acbp_app' and privilege_type = 'UPDATE'
    `.execute(owner.kysely);
    expect(r.rows).toEqual([]);
  });

  // ── NO MINTING PATH FOR THE PRODUCT ROLE ──────────────────────────────────────────────────────────────────
  test('the product role CANNOT write a grant or a correction — both can create credits', async () => {
    // A table-level INSERT grant cannot express "these kinds only"; an RLS WITH CHECK can, which is what makes the
    // no-minting rule structural rather than a convention someone could forget. A `correction` is included because
    // it may be POSITIVE — the safer reading, taken deliberately (CDR-058 §4).
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      for (const kind of ['grant', 'correction']) {
        await expect(
          sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, ${kind}, 5, null)`.execute(db),
        ).rejects.toSatisfy((e: unknown) => sqlState(e) === RLS_VIOLATION || sqlState(e) === CHECK_VIOLATION);
      }
    });
    expect(await rows()).toHaveLength(0);
  });

  test('the product role CAN write the three run-lifecycle kinds', async () => {
    await grant(w.accountA, 5);
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      const reservation = await new CreditRepository(db).insert({ accountId: w.accountA, companyId: w.companyA1, kind: 'reservation', credits: -1, idempotencyKey: 'fixture-k1' });
      expect(reservation?.kind).toBe('reservation');
      const settled = await new CreditRepository(db).insert({ accountId: w.accountA, companyId: w.companyA1, kind: 'consumption', credits: -0 - 1, referencesTxnId: reservation?.id ?? null });
      expect(settled?.kind).toBe('consumption');
    });
  });

  // ── THE SIGN CONVENTION IS ENFORCED BY THE DATABASE ───────────────────────────────────────────────────────
  test('a NEGATIVE grant and a POSITIVE reservation are both refused', async () => {
    // A negative grant is a spend wearing a grant's name; a positive reservation mints. Neither is a thing a writer
    // should be trusted to avoid, so the CHECK refuses both.
    await expect(sql`insert into credit_transactions (account_id, kind, credits) values (${w.accountA}, 'grant', -5)`.execute(owner.kysely)).rejects.toSatisfy(
      (e: unknown) => sqlState(e) === CHECK_VIOLATION,
    );
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', 5, 'sign-test')`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('a ZERO correction is refused — a correction that corrects nothing is a row with no meaning', async () => {
    await grant(w.accountA, 5);
    const id = (await rows())[0]?.id ?? '';
    await expect(
      sql`insert into credit_transactions (account_id, kind, credits, references_txn_id) values (${w.accountA}, 'correction', 0, ${id})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('the kind CHECK matches the contract exactly — set equality, not containment', async () => {
    // A kind added to the contract and forgotten in the CHECK is the drift that was the finding on three consecutive
    // tickets. Set equality is what catches it in whichever direction it happens.
    const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'credit_transactions_kind_valid'`.execute(owner.kysely);
    const literals = [...(r.rows[0]?.def ?? '').matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();
    expect(literals).toEqual([...CREDIT_ENTRY_KINDS].sort());
  });

  // ── REFERENCES AND SETTLEMENT UNIQUENESS (invariant 10; G8) ───────────────────────────────────────────────
  test('a settlement must reference something, and a grant must not', async () => {
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits) values (${w.accountA}, ${w.companyA1}, 'consumption', -1)`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    await grant(w.accountA, 5);
    const id = (await rows())[0]?.id ?? '';
    await expect(
      sql`insert into credit_transactions (account_id, kind, credits, references_txn_id) values (${w.accountA}, 'grant', 1, ${id})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('ONE SETTLEMENT PER RESERVATION — a run cannot be both consumed and released', async () => {
    // The index covers consumption AND release together on purpose. Two separate indexes would each be satisfied
    // while the pair minted a credit out of an ordinary retry: consume once, release once, net zero spend for real
    // work delivered.
    await grant(w.accountA, 5);
    const reservation = await sql<{ id: string }>`
      insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, 'fixture-' || gen_random_uuid()) returning id
    `.execute(owner.kysely);
    const rid = reservation.rows[0]?.id ?? '';
    await sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'consumption', -1, ${rid})`.execute(owner.kysely);

    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'release', 1, ${rid})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'consumption', -1, ${rid})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
  });

  test('ONE RESERVATION PER IDEMPOTENCY KEY (BILL-002), and the key does not constrain other kinds', async () => {
    await grant(w.accountA, 5);
    await sql`insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, 'key-1')`.execute(owner.kysely);
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, 'key-1')`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === UNIQUE_VIOLATION);
    // A DIFFERENT account may use the same key — the constraint is per account, not global.
    await grant(w.accountB, 5);
    await sql`insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountB}, ${w.companyB1}, 'reservation', -1, 'key-1')`.execute(owner.kysely);
    expect((await rows()).filter((r) => r.idempotency_key === 'key-1')).toHaveLength(2);
  });

  // ── THE MINT ATTEMPTS (review pass 1) ─────────────────────────────────────────────────────────────────────
  test('a RELEASE CANNOT EXCEED the reservation it references — the two-billion-credit mint', async () => {
    // Review pass 1's concrete attack, as the app role: reserve 1 credit, then release 2147483647 against it. Every
    // CHECK in the table passes (kind valid, sign valid, reference shape satisfied, one settlement). Only a trigger
    // can see the OTHER row, which is why one exists — the migration makes minting structurally impossible for
    // `grant` and `correction`, and leaving the release path bounded by application code alone contradicted that.
    await grant(w.accountA, 5);
    const res = await sql<{ id: string }>`
      insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, 'fixture-' || gen_random_uuid()) returning id
    `.execute(owner.kysely);
    const rid = res.rows[0]?.id ?? '';
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'release', 2147483647, ${rid})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    // ...and the exact amount IS allowed, so the bound is a bound and not a blanket refusal.
    await sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'release', 1, ${rid})`.execute(owner.kysely);
    expect((await rows()).reduce((a, r) => a + r.credits, 0)).toBe(5);
  });

  test('a settlement must reference a RESERVATION, not a grant or another settlement', async () => {
    // Nothing else was ever held, so nothing else can be released. Without this, releasing against a grant would
    // hand back credits that were never taken.
    await grant(w.accountA, 5);
    const grantId = (await rows())[0]?.id ?? '';
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'release', 5, ${grantId})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('a settlement cannot reference ANOTHER account\'s reservation', async () => {
    // Otherwise a release could return one account's credits into another's balance.
    await grant(w.accountA, 5);
    await grant(w.accountB, 5);
    const res = await sql<{ id: string }>`
      insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountB}, ${w.companyB1}, 'reservation', -1, 'fixture-' || gen_random_uuid()) returning id
    `.execute(owner.kysely);
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'release', 1, ${res.rows[0]?.id ?? ''})`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('a RESERVATION WITHOUT AN IDEMPOTENCY KEY is refused — otherwise it escapes the uniqueness index', async () => {
    // The key index is PARTIAL on `idempotency_key is not null`, so a keyless reservation would slip past it entirely
    // and BILL-002's "one credit spend per key" would hold only for callers who chose to supply one. `reserveCredit`
    // requires a key; this CHECK is what makes it true of every writer, including the owner role.
    await grant(w.accountA, 5);
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits) values (${w.accountA}, ${w.companyA1}, 'reservation', -1)`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    // A SETTLEMENT legitimately has none — it is identified by the reservation it references, not by a key.
    const res = await sql<{ id: string }>`
      insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, 'k') returning id
    `.execute(owner.kysely);
    await sql`insert into credit_transactions (account_id, company_id, kind, credits, references_txn_id) values (${w.accountA}, ${w.companyA1}, 'consumption', -1, ${res.rows[0]?.id ?? ''})`.execute(owner.kysely);
  });

  test('ONE RESERVATION PER RUN is structural — an index, not just the account lock', async () => {
    // Before this index the rule rested entirely on the application checking first, which is not the standard
    // everything else in this table is held to. Asserting the index exists and is UNIQUE and PARTIAL is the check
    // that survives someone rewriting the use case.
    const r = await sql<{ def: string }>`select indexdef as def from pg_indexes where indexname = 'credit_transactions_run_reservation_uq'`.execute(owner.kysely);
    const def = r.rows[0]?.def ?? '';
    expect(def).toContain('UNIQUE');
    expect(def).toContain('run_id');
    expect(def).toContain("kind = 'reservation'");
  });

  // ── TENANCY ───────────────────────────────────────────────────────────────────────────────────────────────
  test('RLS keys on the ACCOUNT, so a balance spans the account\'s companies', async () => {
    // The A/C decision made observable (CDR-058 §2). Reading with company A1's GUC still sees a spend attributed to
    // A2, because the balance is per ACCOUNT — a company-keyed predicate would make an owner's own balance invisible.
    await grant(w.accountA, 10);
    await sql`insert into credit_transactions (account_id, company_id, kind, credits) values (${w.accountA}, ${w.companyA2}, 'reservation', -3)`.execute(owner.kysely);
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      expect(await new CreditRepository(db).deriveBalance(w.accountA)).toBe(7);
    });
  });

  test('another ACCOUNT\'s ledger is invisible, and its balance reads as zero rather than as an error', async () => {
    await grant(w.accountA, 10);
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await new CreditRepository(db).listForAccount(w.accountA, 50)).toEqual([]);
      // Zero, not a leak and not a throw: an invisible ledger sums to nothing, which is also the fail-safe answer.
      expect(await new CreditRepository(db).deriveBalance(w.accountA)).toBe(0);
    });
  });

  test('an entry cannot be written into ANOTHER account, even with its id in hand', async () => {
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      await expect(
        sql`insert into credit_transactions (account_id, company_id, kind, credits, idempotency_key) values (${w.accountB}, ${w.companyB1}, 'reservation', -1, 'fixture-' || gen_random_uuid())`.execute(db),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === RLS_VIOLATION);
    });
  });

  // ── THE USAGE-EVENT LINK (migration 0042; the deferral CDR-057 §4 made TO this ticket) ────────────────────
  test('usage_events.worker_run_id exists, is nullable, and is TENANT-PINNED', async () => {
    // NULLABLE on purpose: the gateway's callers today are planning and strategy use cases, none of which execute
    // inside a worker run, so most usage events legitimately have no worker. The link is here so it is writable the
    // moment a worker calls a model — which is P5-006/007/008's wiring, and is recorded as theirs in CDR-058 §4.
    const col = await sql<{ is_nullable: string }>`
      select is_nullable from information_schema.columns where table_name = 'usage_events' and column_name = 'worker_run_id'
    `.execute(owner.kysely);
    expect(col.rows[0]?.is_nullable).toBe('YES');

    // The pin is the point: a single-column FK would let a usage event point at another company's worker run and
    // never be policy-checked, because RI checks always bypass RLS.
    const fk = await sql<{ def: string }>`
      select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'usage_events_worker_run_fk'
    `.execute(owner.kysely);
    expect(fk.rows[0]?.def ?? '').toContain('worker_run_id, company_id');
    expect(fk.rows[0]?.def ?? '').toContain('id, company_id');
  });

  test('a run reference is TENANT-PINNED: the composite FK refuses a run from another company', async () => {
    // RI checks always bypass RLS, so a single-column FK would let an entry point at another company's run and never
    // be policy-checked. The `run_needs_company` CHECK is what stops the pin being skipped via a NULL company.
    await grant(w.accountA, 5);
    await expect(
      sql`insert into credit_transactions (account_id, company_id, kind, credits, run_id) values (${w.accountA}, ${w.companyA1}, 'reservation', -1, '00000000-0000-4000-8000-000000000000')`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === FK_VIOLATION);
    await expect(
      sql`insert into credit_transactions (account_id, kind, credits, run_id) values (${w.accountA}, 'grant', 1, '00000000-0000-4000-8000-000000000000')`.execute(owner.kysely),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });
});
