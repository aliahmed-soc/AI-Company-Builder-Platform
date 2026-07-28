// ACBP-P5-003b / CDR-054 — real-PostgreSQL proof of the enforcement chokepoint, through the RESTRICTED role.
//
// Acceptance, from the backlog: **"Non-allowlisted denied; every call recorded"** — plus the two clauses the design
// record adds because canon states them outright: fail-closed on a missing gate, and `unconfirmed` never reported as
// success. (The injection corpus is P5-003c's half of the acceptance row.)
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import { TOOL_DENIAL_REASONS, TOOL_CALL_OUTCOMES, RISK_CLASSES, isToolDenialReason, MOST_RESTRICTIVE_RISK_CLASS } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { dispatchToolCall, reportToolCallOutcome, digestToolArguments } from './index.js';
import { TaskRepository } from '@acbp/database';

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

describe.skipIf(!hasTestDatabase)('tool dispatcher (real PostgreSQL, restricted role) — ACBP-P5-003b/CDR-054', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  let runId: string;

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
  const callRows = async () => owner.kysely.selectFrom('tool_calls').selectAll().orderBy('created_at').execute();
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();

  /** Register a tool as the OWNER role — there is no runtime write grant on the registry (CDR-051). */
  async function register(toolId: string, riskClass: string | null, status = 'active'): Promise<void> {
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values (${toolId}, 1, ${riskClass}, 'fixture tool', ${status})`.execute(owner.kysely);
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);

    // A RUNNING run for the calls to belong to: create → plan → queue → start.
    const created = await createTask(product, { ...base(), title: 'Research five prospects', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    runId = (started as { status: 'ok'; run: { id: string } }).run.id;

    await register('web_research', 'informational');
    await register('memory_write', 'internal_reversible');
    await register('send_email', 'external_reversible');
    await register('unclassified_tool', null);
    await register('retired_tool', 'informational', 'retired');
  });

  const allowAll = ['web_research', 'memory_write', 'send_email', 'unclassified_tool', 'retired_tool', 'ghost_tool'];
  const dispatch = (over: Partial<Parameters<typeof dispatchToolCall>[1]> = {}) =>
    dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: { q: 'prospects' }, allowlist: allowAll, context: [], ...over });

  // ── ACCEPTANCE: non-allowlisted denied ────────────────────────────────────────────────────────────────────
  test('a tool NOT on the worker allowlist is denied — and the refusal is recorded', async () => {
    const r = await dispatch({ allowlist: ['memory_write'] });
    expect(r).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });
    const rows = await callRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.outcome).toBe('denied');
    expect(rows[0]?.denial_reason).toBe('not_allowlisted');
  });

  test('NO allowlist at all is denied distinctly from an empty one — different faults, different fixes', async () => {
    expect(await dispatch({ allowlist: undefined })).toMatchObject({ status: 'denied', reason: 'no_allowlist' });
    expect(await dispatch({ allowlist: [] })).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });
    expect(await callRows()).toHaveLength(2);
  });

  test('an UNREGISTERED tool is denied and recorded at the MOST RESTRICTIVE class', async () => {
    // The record must be writable for a tool the registry does not have — which is why `tool_id` carries no FK.
    const r = await dispatch({ toolId: 'ghost_tool' });
    expect(r).toMatchObject({ status: 'denied', reason: 'not_registered' });
    const rows = await callRows();
    expect(rows[0]?.tool_id).toBe('ghost_tool');
    expect(rows[0]?.risk_class).toBe(MOST_RESTRICTIVE_RISK_CLASS);
  });

  test('a RETIRED registration is not an active one — the tool reads as unregistered', async () => {
    expect(await dispatch({ toolId: 'retired_tool' })).toMatchObject({ status: 'denied', reason: 'not_registered' });
  });

  // ── ACCEPTANCE: every call recorded (TOOL-002) ────────────────────────────────────────────────────────────
  test('EVERY outcome writes exactly one row — authorized and refused alike', async () => {
    const attempts: Array<Partial<Parameters<typeof dispatchToolCall>[1]>> = [
      {},                                     // authorized (informational)
      { toolId: 'memory_write' },             // denied: no policy engine
      { toolId: 'unclassified_tool' },        // denied: unclassified → most restrictive
      { toolId: 'ghost_tool' },               // denied: not registered
      { allowlist: [] },                      // denied: not allowlisted
    ];
    for (const over of attempts) await dispatch(over);
    const rows = await callRows();
    expect(rows).toHaveLength(attempts.length);
    // 100% coverage means no row is missing AND none is a placeholder: every one carries a real digest and class.
    for (const row of rows) {
      expect(row.arguments_digest).toMatch(/^[0-9a-f]{64}$/);
      expect(row.risk_class).not.toBe('');
      if (row.outcome === 'denied') expect(isToolDenialReason(row.denial_reason)).toBe(true);
    }
    // And each one is audited, refusals included (TOOL-001 "attempts are audited").
    expect(await auditFor('tool.call_requested')).toHaveLength(attempts.length);
  });

  test('the ARGUMENTS never reach the database — only their digest does', async () => {
    await dispatch({ args: { secret_looking: 'super-secret-value', q: 'x' } });
    const rows = await callRows();
    expect(JSON.stringify(rows)).not.toContain('super-secret-value');
    expect(rows[0]?.arguments_digest).toBe(digestToolArguments({ secret_looking: 'super-secret-value', q: 'x' }));
  });

  // ── ACCEPTANCE: fail closed with no engine (IMPLEMENTATION-ROADMAP §M5) ───────────────────────────────────
  test('with NO policy engine, informational proceeds and everything above it is refused', async () => {
    expect((await dispatch({ toolId: 'web_research' })).status).toBe('authorized');
    for (const toolId of ['memory_write', 'send_email', 'unclassified_tool']) {
      expect(await dispatch({ toolId })).toMatchObject({ status: 'denied', reason: 'policy_unavailable' });
    }
  });

  test('an explicit policy DENY refuses even the informational class, and beats an allowing approval', async () => {
    const r = await dispatchToolCall(
      product,
      { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] },
      { gates: { policy: () => ({ kind: 'deny' }), approval: () => ({ kind: 'allow' }) } },
    );
    expect(r).toMatchObject({ status: 'denied', reason: 'policy_denied' });
  });

  test('an emergency stop refuses, and an UNREACHABLE stop state refuses distinctly', async () => {
    const stopped = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] }, { gates: { stop: () => ({ kind: 'stopped' }) } });
    expect(stopped).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    const unreachable = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] }, { gates: { stop: () => ({ kind: 'unavailable' }) } });
    expect(unreachable).toMatchObject({ status: 'denied', reason: 'stop_unavailable' });
  });

  test('a gated class proceeds only when BOTH engines answer allow', async () => {
    const gates = { policy: () => ({ kind: 'allow' }) as const, approval: () => ({ kind: 'allow' }) as const };
    const ok = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] }, { gates });
    expect(ok.status).toBe('authorized');
    const noApproval = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] }, { gates: { policy: gates.policy } });
    expect(noApproval).toMatchObject({ status: 'denied', reason: 'approval_required' });
  });

  // ── ACCEPTANCE: unconfirmed is never success (TOOL-002) ───────────────────────────────────────────────────
  test('an EXTERNAL effect cannot be reported as succeeded without a receipt — and the DB refuses it too', async () => {
    const gates = { policy: () => ({ kind: 'allow' }) as const, approval: () => ({ kind: 'allow' }) as const };
    const call = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] }, { gates });
    const callId = (call as { status: 'authorized'; call: { id: string } }).call.id;

    expect(await reportToolCallOutcome(product, { ...base(), callId, outcome: 'succeeded' })).toEqual({ status: 'receipt_required' });
    // The honest outcome is available, and it is NOT a success.
    const honest = await reportToolCallOutcome(product, { ...base(), callId, outcome: 'unconfirmed' });
    expect(honest).toMatchObject({ status: 'ok' });
    expect((await callRows())[0]?.outcome).toBe('unconfirmed');

    // Layer two: even bypassing the use case, the constraint refuses a receiptless external success.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update tool_calls set outcome = 'succeeded' where id = ${callId}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('a closed call cannot be RE-reported — an unconfirmed effect is never upgraded after the fact', async () => {
    const r = await dispatch();
    const callId = (r as { status: 'authorized'; call: { id: string } }).call.id;
    expect((await reportToolCallOutcome(product, { ...base(), callId, outcome: 'failed' })).status).toBe('ok');
    expect(await reportToolCallOutcome(product, { ...base(), callId, outcome: 'succeeded' })).toEqual({ status: 'not_requested', outcome: 'failed' });
    expect((await callRows())[0]?.outcome).toBe('failed');
  });

  test('a caller cannot report `requested` or `denied` — those are the dispatcher\'s own writes', async () => {
    const r = await dispatch();
    const callId = (r as { status: 'authorized'; call: { id: string } }).call.id;
    for (const outcome of ['requested', 'denied', 'nonsense']) {
      expect(await reportToolCallOutcome(product, { ...base(), callId, outcome })).toEqual({ status: 'invalid' });
    }
  });

  // ── idempotency (NFR-006) ─────────────────────────────────────────────────────────────────────────────────
  test('the same idempotency key runs ONCE — the second attempt returns the first call, not a new one', async () => {
    const first = await dispatch({ idempotencyKey: 'k1' });
    expect(first.status).toBe('authorized');
    const second = await dispatch({ idempotencyKey: 'k1' });
    expect(second.status).toBe('duplicate');
    expect((second as { call: { id: string } }).call.id).toBe((first as { call: { id: string } }).call.id);
    expect(await callRows()).toHaveLength(1);
  });

  test('the key is scoped PER COMPANY and per tool — one tenant\'s key never collides with another\'s', async () => {
    await dispatch({ idempotencyKey: 'shared' });
    // A different tool, same key: a different call.
    expect((await dispatch({ toolId: 'memory_write', idempotencyKey: 'shared' })).status).toBe('denied');
    expect(await callRows()).toHaveLength(2);
  });

  test('a BLANK idempotency key is NO key — two unrelated calls never suppress each other (review pass 1)', async () => {
    // Treating '' as a real key would make the second call a "duplicate" of something it has nothing to do with.
    for (const key of ['', '   ']) {
      await dispatch({ idempotencyKey: key });
      await dispatch({ idempotencyKey: key });
    }
    const rows = await callRows();
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.idempotency_key).toBeNull();
  });

  test('a BLANK receipt is not evidence — it is refused and never stored (review pass 1)', async () => {
    const gates = { policy: () => ({ kind: 'allow' }) as const, approval: () => ({ kind: 'allow' }) as const };
    const call = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] }, { gates });
    const callId = (call as { status: 'authorized'; call: { id: string } }).call.id;
    expect(await reportToolCallOutcome(product, { ...base(), callId, outcome: 'succeeded', receiptRef: '   ' })).toEqual({ status: 'receipt_required' });

    // And the CONSTRAINT holds the same line, for anything that skips the use case.
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update tool_calls set outcome = 'succeeded', receipt_ref = '   ' where id = ${callId}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);

    // A blank receipt on a legitimate non-success outcome is stored as NULL rather than as fake evidence.
    expect((await reportToolCallOutcome(product, { ...base(), callId, outcome: 'failed', receiptRef: '  ' })).status).toBe('ok');
    expect((await callRows())[0]?.receipt_ref).toBeNull();
  });

  // ── the run linkage ───────────────────────────────────────────────────────────────────────────────────────
  test('a call must belong to a RUNNING run of THIS company', async () => {
    expect(await dispatch({ runId: '00000000-0000-4000-8000-000000000000' })).toEqual({ status: 'run_not_found' });
    // Company B cannot attach a call to company A's run, and learns nothing about whether it exists.
    const foreign = await dispatchToolCall(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] });
    expect(foreign).toEqual({ status: 'run_not_found' });

    await sql`update task_runs set state = 'succeeded', ended_at = now() where id = ${runId}::uuid`.execute(owner.kysely);
    expect(await dispatch()).toEqual({ status: 'run_not_running', runState: 'succeeded' });
    expect(await callRows()).toHaveLength(0);
  });

  // ── the store's own guarantees ────────────────────────────────────────────────────────────────────────────
  test('there is NO DELETE, and the immutable columns are immutable', async () => {
    await dispatch();
    const id = (await callRows())[0]?.id ?? '';
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`delete from tool_calls`.execute(db)),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    for (const stmt of ['risk_class = ' + `'informational'`, 'arguments_digest = ' + `'${'0'.repeat(64)}'`, 'external_effect = false', 'run_id = ' + `'${runId}'::uuid`]) {
      await expect(
        asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => sql`update tool_calls set ${sql.raw(stmt)} where id = ${id}::uuid`.execute(db)),
      ).rejects.toSatisfy((e: unknown) => sqlState(e) === INSUFFICIENT_PRIVILEGE);
    }
    expect(await callRows()).toHaveLength(1);
  });

  async function constraintDef(name: string): Promise<string> {
    const r = await sql<{ def: string }>`select pg_get_constraintdef(oid) as def from pg_constraint where conname = ${name}`.execute(owner.kysely);
    const def = r.rows[0]?.def ?? '';
    // A renamed or dropped constraint must FAIL here rather than silently compare an empty set.
    expect(def).not.toBe('');
    return def;
  }
  const literalsIn = (def: string): readonly string[] => [...def.matchAll(/'([a-z_]+)'::text/g)].map((m) => m[1] ?? '').sort();

  test('the denial-reason CHECK and the contract vocabulary are the SAME set, in both directions', async () => {
    const inCheck = literalsIn(await constraintDef('tool_calls_denial_reason_valid')).filter((v) => v !== 'denied');
    expect(inCheck).toEqual([...TOOL_DENIAL_REASONS].sort());
  });

  test('the OUTCOME and RISK-CLASS CHECKs are set-equal to their contracts too (review pass 2)', async () => {
    // Pass 1 shipped this guard for denial reasons only. One-directional drift on the other two is the same defect:
    // a value the database permits and no contract code can reason about — and on `risk_class` that means a class
    // that dispatches without a rank, which is precisely the P5-003a finding in a new place.
    expect(literalsIn(await constraintDef('tool_calls_outcome_valid'))).toEqual([...TOOL_CALL_OUTCOMES].sort());
    expect(literalsIn(await constraintDef('tool_calls_risk_class_valid'))).toEqual([...RISK_CLASSES].sort());
  });

  test('the call records WHICH REGISTERED VERSION was in force (review pass 2)', async () => {
    // EVENT-CATALOG pairs `tool_id+version`. Without the version, a re-registration makes every earlier record
    // ambiguous about which definition — and so which risk class — actually applied.
    await sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('web_research', 2, 'informational', 'v2')`.execute(owner.kysely);
    await dispatch();
    expect((await callRows())[0]?.tool_version).toBe(2); // the ACTIVE, highest version
    expect((await auditFor('tool.call_requested'))[0]?.payload).toMatchObject({ tool_version: 2 });

    // An unregistered tool has no version to record, and null says exactly that.
    await dispatch({ toolId: 'ghost_tool' });
    expect((await callRows())[1]?.tool_version).toBeNull();
  });

  test('a denial reason cannot be attached to a non-denied call', async () => {
    await dispatch();
    const id = (await callRows())[0]?.id ?? '';
    await expect(
      asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) =>
        sql`update tool_calls set denial_reason = 'policy_denied' where id = ${id}::uuid`.execute(db),
      ),
    ).rejects.toSatisfy((e: unknown) => sqlState(e) === CHECK_VIOLATION);
  });

  test('another company can neither read nor report on this company\'s call', async () => {
    const r = await dispatch();
    const callId = (r as { status: 'authorized'; call: { id: string } }).call.id;
    const foreign = { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 };
    expect(await reportToolCallOutcome(product, { ...foreign, callId, outcome: 'failed' })).toEqual({ status: 'not_found' });
    await asRestricted(product, { account: w.accountB, company: w.companyB1 }, async (db) => {
      expect(await db.selectFrom('tool_calls').selectAll().execute()).toHaveLength(0);
    });
  });
});
