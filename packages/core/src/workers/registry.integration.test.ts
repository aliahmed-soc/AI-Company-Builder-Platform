// ACBP-P5-004 / CDR-056 — real-PostgreSQL proof of the worker registry, through the RESTRICTED role.
//
// Acceptance: **"Definitions complete; pause holds tasks"** — plus the guarantee that carries the ticket, that the
// dispatcher's allowlist now comes FROM a versioned definition rather than from whoever called it.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { WorkerRepository, TaskRepository, type DatabaseClient } from '@acbp/database';
import { TASK_TYPES, RUN_FAILURE_CATEGORIES, RISK_CLASSES, WORKER_STATES, DEFAULT_MAX_SPEND_MICROS, DEFAULT_MAX_DURATION_MS } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { dispatchToolCall } from '../tools/index.js';
import { resolveWorkerAllowlist, setCompanyWorkerState, listWorkers } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

function sqlState(error: unknown): string | undefined {
  let cursor: unknown = error;
  for (let depth = 0; depth < 8 && cursor !== null && typeof cursor === 'object'; depth += 1) {
    const code = (cursor as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return undefined;
}

describe.skipIf(!hasTestDatabase)('worker registry (real PostgreSQL, restricted role) — ACBP-P5-004/CDR-056', () => {
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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const stateRows = async () => owner.kysely.selectFrom('company_worker_states').selectAll().execute();

  /** Register a definition as the OWNER role — there is no runtime write grant (CDR-056 §2-G1). */
  async function register(workerId: string, version: number, tools: readonly string[], over: { status?: string; threshold?: string | null } = {}): Promise<void> {
    await sql`
      insert into worker_definitions
        (worker_id, version, capabilities, allowed_tools, input_schema_ref, output_schema_ref,
         max_spend_micros, max_duration_ms, retry_categories, approval_threshold_risk_class,
         model_task_class, logging_redaction_class, status)
      values
        (${workerId}, ${version}, array['market_research']::text[], ${sql.raw(`array[${tools.map((t) => `'${t}'`).join(',')}]::text[]`)},
         'research.input@1', 'research.output@1', ${DEFAULT_MAX_SPEND_MICROS}, ${DEFAULT_MAX_DURATION_MS},
         array['timeout','provider_error']::text[], ${over.threshold ?? null},
         'generation', 'standard', ${over.status ?? 'active'})
    `.execute(owner.kysely);
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from company_worker_states`.execute(owner.kysely);
    await sql`delete from worker_definitions`.execute(owner.kysely);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
    // A CONFIGURED POLICY IS NOW A PRECONDITION OF DISPATCHING (ACBP-P6-002). The dispatcher consults the engine
    // itself, and a company with no active policy has permitted nothing (CDR-066 §6-G15) — so without this every
    // call here would be refused for `policy_denied` and this suite would stop testing its own subject. The
    // owner-ruled default (CDR-066 §3-G10) allows informational and internal_reversible, which is what these
    // fixtures dispatch.
    expect((await initializeCompanyPolicy(product, base())).status).toBe('ok');
    await sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('web_research', 1, 'informational', 'fixture'), ('memory_read', 1, 'internal_reversible', 'fixture'), ('send_email', 1, 'external_reversible', 'fixture')`.execute(owner.kysely);
  });

  // ── ACCEPTANCE: definitions complete ──────────────────────────────────────────────────────────────────────
  test('a registered worker resolves to the allowlist FROM its definition — the gap CDR-054/055 deferred', async () => {
    await register('research', 1, ['web_research', 'memory_read']);
    const r = await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' });
    expect(r.status).toBe('ok');
    expect((r as { allowlist: readonly string[] }).allowlist).toEqual(['web_research', 'memory_read']);
    expect((r as { definition: { maxSpendMicros: number } }).definition.maxSpendMicros).toBe(DEFAULT_MAX_SPEND_MICROS);
  });

  test('the HIGHEST ACTIVE version wins, and a retired one is not active', async () => {
    await register('research', 1, ['web_research']);
    await register('research', 2, ['web_research', 'memory_read']);
    expect((await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' }) as { definition: { version: number } }).definition.version).toBe(2);

    await register('legacy', 1, ['web_research'], { status: 'retired' });
    expect(await resolveWorkerAllowlist(product, { ...base(), workerId: 'legacy' })).toEqual({ status: 'unknown_worker' });
  });

  test('an UNREGISTERED worker gets a refusal, NEVER an empty allowlist (WORK-001)', async () => {
    // An empty allowlist would reach the dispatcher as `not_allowlisted` — sending a reader to look for a missing
    // tool rather than at a worker that does not exist.
    const r = await resolveWorkerAllowlist(product, { ...base(), workerId: 'ghost' });
    expect(r).toEqual({ status: 'unknown_worker' });
    expect(r).not.toHaveProperty('allowlist');
  });

  // ── ACCEPTANCE: pause holds tasks (WORK-006) ──────────────────────────────────────────────────────────────
  test('PAUSING holds the worker: it stops resolving, and the state says which of the two it is', async () => {
    await register('research', 1, ['web_research']);
    expect((await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' })).status).toBe('ok');

    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused', reason: 'reviewing output quality' })).toMatchObject({ status: 'ok', state: 'paused' });
    expect(await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' })).toEqual({ status: 'not_accepting', state: 'paused' });

    expect((await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'disabled' })).status).toBe('ok');
    expect(await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' })).toEqual({ status: 'not_accepting', state: 'disabled' });

    // Re-enabling restores it — the control is reversible, which is what makes it usable in an emergency.
    expect((await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'enabled' })).status).toBe('ok');
    expect((await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' })).status).toBe('ok');
    // One row throughout: the upsert never accumulates history rows for a toggle.
    expect(await stateRows()).toHaveLength(1);
  });

  test('the pause is PER COMPANY — company B is unaffected by company A pausing a worker', async () => {
    await register('research', 1, ['web_research']);
    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'disabled' });
    const b = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    expect((await resolveWorkerAllowlist(product, { ...b, workerId: 'research' })).status).toBe('ok');
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await db.selectFrom('company_worker_states').selectAll().execute()).toHaveLength(0);
    });
  });

  test('pausing an UNKNOWN worker is refused — a pause on a typo would look like protection and protect nothing', async () => {
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'ghost', state: 'paused' })).toEqual({ status: 'unknown_worker' });
    expect(await stateRows()).toHaveLength(0);
  });

  test('only an OWNER may pause — a viewer could otherwise stop the work without being able to start any', async () => {
    await register('research', 1, ['web_research']);
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect(await setCompanyWorkerState(product, { ...viewer, workerId: 'research', state: 'disabled' })).toEqual({ status: 'forbidden' });
    expect(await stateRows()).toHaveLength(0);
  });

  test('an invalid state or an over-long reason is refused before anything is written', async () => {
    await register('research', 1, ['web_research']);
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'off' })).toEqual({ status: 'invalid' });
    expect(await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused', reason: 'x'.repeat(501) })).toEqual({ status: 'invalid' });
    expect(await stateRows()).toHaveLength(0);
  });

  test('the change is AUDITED, and the owner\'s reason text stays out of the payload', async () => {
    await register('research', 1, ['web_research']);
    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused', reason: 'the summaries were wrong about pricing' });
    const events = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'worker.state_changed').execute();
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toMatchObject({ state: 'paused', has_reason: true });
    expect(JSON.stringify(events)).not.toContain('wrong about pricing');
  });

  // ── the definition feeds the chokepoint ───────────────────────────────────────────────────────────────────
  test('the resolved allowlist is what the DISPATCHER enforces — end to end', async () => {
    await register('research', 1, ['web_research']);
    const resolved = await resolveWorkerAllowlist(product, { ...base(), workerId: 'research' });
    const allowlist = (resolved as { allowlist: readonly string[] }).allowlist;

    const created = await createTask(product, { ...base(), title: 'Research', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    await planTask(product, { ...base(), taskId });
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const runId = ((await startRun(product, { ...base(), taskId, attempt: 1 })) as { status: 'ok'; run: { id: string } }).run.id;

    // The allowlisted tool proceeds...
    expect((await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist, context: [] })).status).toBe('authorized');
    // ...and one the definition does NOT list is refused, by the definition rather than by the caller.
    expect(await dispatchToolCall(product, { ...base(), runId, toolId: 'memory_read', args: {}, allowlist, context: [] })).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });
  });

  // ── the registry listing (WORK-001; review pass 2) ────────────────────────────────────────────────────────
  test('the registry LISTS each worker with its capabilities and allowlist — WORK-001\'s acceptance, literally', async () => {
    await register('research', 1, ['web_research']);
    await register('research', 2, ['web_research', 'memory_read']);
    await register('strategy', 1, ['memory_read']);
    await register('retired_one', 1, ['memory_read'], { status: 'retired' });

    const r = await listWorkers(product, base());
    expect(r.status).toBe('ok');
    const workers = (r as { workers: readonly { workerId: string; version: number; allowedTools: readonly string[]; state: string }[] }).workers;
    // One entry per worker — the version that would actually RUN, not every version ever registered.
    expect(workers.map((x) => x.workerId).sort()).toEqual(['research', 'strategy']);
    expect(workers.find((x) => x.workerId === 'research')?.version).toBe(2);
    expect(workers.find((x) => x.workerId === 'research')?.allowedTools).toEqual(['web_research', 'memory_read']);
  });

  test('the listing shows the PAUSE, and a VIEWER can see it — otherwise it is invisible to whoever is wondering why nothing ran', async () => {
    await register('research', 1, ['web_research']);
    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused', reason: 'checking output' });
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    const r = await listWorkers(product, viewer);
    expect(r.status).toBe('ok');
    const entry = (r as { workers: readonly { state: string; hasReason: boolean }[] }).workers[0];
    expect(entry?.state).toBe('paused');
    // The FACT that a reason exists is shown; the owner's text is not.
    expect(entry?.hasReason).toBe(true);
    expect(JSON.stringify(r)).not.toContain('checking output');
  });

  test('a worker the owner has never touched lists as enabled — the default and the column agree', async () => {
    await register('research', 1, ['web_research']);
    expect((await listWorkers(product, base()) as { workers: readonly { state: string }[] }).workers[0]?.state).toBe('enabled');
    expect(await stateRows()).toHaveLength(0);
  });

  // ── the MVP zero-external-actions boundary (review pass 1) ────────────────────────────────────────────────
  test('a definition whose allowlist reaches PAST internal_reversible can never be used', async () => {
    // CDR-056 §2-G4 claimed this boundary was structural while nothing enforced it — worse than not claiming it.
    // It cannot be a CHECK (the classes live in another table and CHECKs cannot subquery), so it is enforced at the
    // one point where a definition becomes a capability: a violating definition may EXIST and can never be USED.
    await register('overreaching', 1, ['web_research', 'send_email']);
    const r = await resolveWorkerAllowlist(product, { ...base(), workerId: 'overreaching' });
    expect(r).toMatchObject({ status: 'mvp_boundary_violation' });
    expect((r as { offendingTools: readonly string[] }).offendingTools).toEqual(['send_email']);
    // And it hands back NO allowlist — a refusal is never a narrower capability.
    expect(r).not.toHaveProperty('allowlist');
  });

  test('an allowlist naming an UNREGISTERED tool fails the boundary rather than slipping past it', async () => {
    // The tool has no class, `resolveRiskClass` maps that to the most restrictive one, and the boundary refuses.
    await register('typo', 1, ['web_research', 'web_reserch']);
    expect(await resolveWorkerAllowlist(product, { ...base(), workerId: 'typo' })).toMatchObject({
      status: 'mvp_boundary_violation',
      offendingTools: ['web_reserch'],
    });
  });

  test('a tool RE-CLASSIFIED down no longer offends — the check reads the ACTIVE version, not the history', async () => {
    // Without `distinct on (tool_id)`, both versions would return and the old external class would keep refusing.
    await sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('reformed', 1, 'external_reversible', 'v1'), ('reformed', 2, 'informational', 'v2')`.execute(owner.kysely);
    await register('reformer', 1, ['reformed']);
    expect((await resolveWorkerAllowlist(product, { ...base(), workerId: 'reformer' })).status).toBe('ok');
  });

  // ── the store's own guarantees ────────────────────────────────────────────────────────────────────────────
  test('the definition registry has NO runtime write path at all (CDR-056 §2-G1)', async () => {
    await register('research', 1, ['web_research']);
    for (const stmt of [
      `insert into worker_definitions (worker_id, version, capabilities, allowed_tools, input_schema_ref, output_schema_ref, max_spend_micros, max_duration_ms, retry_categories, model_task_class, logging_redaction_class) values ('x', 1, array['market_research']::text[], array['web_research']::text[], 'a', 'b', 1, 1, array[]::text[], 'generation', 'standard')`,
      `update worker_definitions set allowed_tools = array['send_email']::text[]`,
      `delete from worker_definitions`,
    ]) {
      await expect(
        asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql.raw(stmt).execute(db)),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    }
  });

  test('a pause cannot be re-pointed at another worker or another company after the fact', async () => {
    await register('research', 1, ['web_research']);
    await setCompanyWorkerState(product, { ...base(), workerId: 'research', state: 'paused' });
    const id = (await stateRows())[0]?.id ?? '';
    for (const stmt of ['worker_id = ' + `'other'`, 'company_id = ' + `'${w.companyB1}'::uuid`]) {
      await expect(
        asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update company_worker_states set ${sql.raw(stmt)} where id = ${id}::uuid`.execute(db)),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    }
  });

  test('the DATABASE refuses a definition with no tools, no capabilities, or an unknown capability', async () => {
    for (const bad of [`array[]::text[], array['web_research']::text[]`, `array['market_research']::text[], array[]::text[]`, `array['not_a_task_type']::text[], array['web_research']::text[]`]) {
      await expect(
        sql.raw(`insert into worker_definitions (worker_id, version, capabilities, allowed_tools, input_schema_ref, output_schema_ref, max_spend_micros, max_duration_ms, retry_categories, model_task_class, logging_redaction_class) values ('bad', 1, ${bad}, 'a', 'b', 1, 1, array[]::text[], 'generation', 'standard')`).execute(owner.kysely),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
    }
  });

  // ── contract ↔ database drift, in BOTH directions ─────────────────────────────────────────────────────────
  async function constraintDef(name: string): Promise<string> {
    const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`.execute(owner.kysely);
    const def = r.rows[0]?.def ?? '';
    expect(def).not.toBe('');
    return def;
  }
  const literalsIn = (def: string): readonly string[] => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();

  test('the capability, retry-category, risk-class and state CHECKs are SET-EQUAL to their contracts', async () => {
    // Applied here at writing time rather than after a review pass, because this is the third ticket in a row where
    // a one-directional guard was the finding.
    expect(literalsIn(await constraintDef('worker_definitions_capabilities_valid'))).toEqual([...TASK_TYPES].sort());
    expect(literalsIn(await constraintDef('worker_definitions_retry_categories_valid'))).toEqual([...RUN_FAILURE_CATEGORIES].sort());
    expect(literalsIn(await constraintDef('worker_definitions_approval_threshold_valid'))).toEqual([...RISK_CLASSES].sort());
    expect(literalsIn(await constraintDef('company_worker_states_state_valid'))).toEqual([...WORKER_STATES].sort());
  });

  test('the repository reads the tool classes the MVP-boundary check needs', async () => {
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, async (db) => {
      const classes = await new WorkerRepository(db).toolRiskClasses(['web_research', 'send_email']);
      expect(classes.map((c) => c.risk_class).sort()).toEqual(['external_reversible', 'informational']);
    });
  });
});
