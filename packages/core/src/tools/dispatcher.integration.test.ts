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
import { TOOL_DENIAL_REASONS, TOOL_CALL_OUTCOMES, RISK_CLASSES, isToolDenialReason, MOST_RESTRICTIVE_RISK_CLASS, ENFORCEABLE_STOP_SCOPES, NOT_YET_ENFORCEABLE_STOP_SCOPES } from '@acbp/contracts';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { computePayloadBinding } from '../approvals/binding.js';
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

    // A WORKER STAMPED ONTO THAT RUN (ACBP-P6-007). Inserted directly as the OWNER rather than through
    // `startWorkerRun`, which would drag a registered worker definition and its allowlist into a suite about the
    // dispatcher. What matters here is only that `worker_runs` carries a real row for this task run, because
    // without one the `worker` stop scope has no identity to match and its case would prove nothing.
    // `UNIQUE(task_run_id)` (migration 0040) means this is the one and only worker run for the attempt.
    await sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runId}::uuid, 'research', 1, 1000000, 600000)`.execute(owner.kysely);

    await register('web_research', 'informational');
    await register('memory_write', 'internal_reversible');
    await register('send_email', 'external_reversible');
    await register('unclassified_tool', null);
    await register('retired_tool', 'informational', 'retired');

    // THE ENGINE NEEDS A POLICY NOW (ACBP-P6-002). The dispatcher consults it internally, so a suite that seeded
    // none would only ever be testing the no-policy refusal. The owner-ruled default (CDR-066 §3-G10) allows
    // informational + internal_reversible and requires approval above that — which is exactly the spread of
    // registered fixture tools below.
    expect((await initializeCompanyPolicy(product, base())).status).toBe('ok');
  });


  /**
   * Seed a REAL human decision for (run, tool) — the only way to satisfy the approval gate now that the caller-
   * injectable port is gone (CDR-068 §0.1). Inserted as the OWNER, because the product role has no business
   * writing approvals outside the service.
   */
  async function seedDecision(toolId: string, path: 'approve' | 'reject' = 'approve'): Promise<void> {
    const policy = await owner.kysely
      .selectFrom('policies')
      .select(['id', 'version'])
      .where('company_id', '=', w.companyA1)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    const request = (
      await sql<{ id: string }>`insert into approval_requests
             (account_id, company_id, run_id, tool_id, tool_version, action, reason, expected_result, data,
              estimated_cost_credits, risk_class, reversibility, preview, scope, policy_id, policy_version,
              payload_hash, binding_version, expires_at)
           values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runId}::uuid, ${toolId}, 1, 'fixture action',
                   'fixture reason', 'fixture result', '{}'::jsonb, 1, 'external_reversible', 'reversible',
                   'fixture preview', 'one_action', ${policy.id}::uuid, ${policy.version},
                   ${computePayloadBinding({ toolId, toolVersion: 1, payload: {}, costBoundCredits: 1 }).hash}, 1, now() + interval '30 days')
           returning id`.execute(owner.kysely)
    ).rows[0]!;
    await sql`insert into approval_decisions
            (account_id, company_id, request_id, path, decider_type, decided_by_user_id, decided_at, reason)
          values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${request.id}::uuid, ${path}, 'human', ${w.aOwner}::uuid, now(),
                  ${path === 'reject' ? 'not now' : null})`.execute(owner.kysely);
    await sql`update approval_requests set status = 'decided', decided_at = now() where id = ${request.id}::uuid`.execute(owner.kysely);
  }

  /** Remove the company's policy as the OWNER — there is no product DELETE grant, which is the point (P6-001b). */
  const removePolicy = () => sql`delete from policies where company_id = ${w.companyA1}::uuid`.execute(owner.kysely);

  /** Add a rule to the active policy as the OWNER. Editing rules is P6-010's product surface, not this ticket's. */
  const addRule = (rule: string) =>
    sql`update policies set rules = rules || ${rule}::jsonb where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);

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
      { toolId: 'memory_write' },             // authorized: internal_reversible, which the ruled default allows
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
  test('with NO POLICY CONFIGURED, EVERY class is refused — including the one the Phase 5 waiver spared', async () => {
    // THE BEHAVIOUR CHANGE ACBP-P6-002 LANDS. This used to assert that informational proceeded when no engine had
    // answered, which was the IMPLEMENTATION-ROADMAP §M5 envelope. The engine exists now, and a company with no
    // active policy has permitted nothing (CDR-066 §6-G15) — so the refusal reason is `policy_denied`, not
    // `policy_unavailable`: the engine ANSWERED, it did not fail to answer.
    await removePolicy();
    for (const toolId of ['web_research', 'memory_write', 'send_email', 'unclassified_tool']) {
      expect(await dispatch({ toolId })).toMatchObject({ status: 'denied', reason: 'policy_denied' });
    }
  });

  test('an explicit policy DENY refuses even the informational class, and beats an allowing approval', async () => {
    // A REAL rule now, not an injected answer: the deny has to travel from stored jsonb through the engine to the
    // gate. `risk_at_least informational` is the always-firing condition here; the stop ENGINE is P6-007's.
    await addRule('[{"id":"forbid","dimension":"risk_class","condition":"risk_at_least","operand":"informational","decision":"deny"}]');
    // A REAL human approval, seeded in the database — the port that used to fake one is gone. POL-005's "forbidden
    // beats approval" is now proven against an actual recorded decision rather than a lambda that said yes.
    await seedDecision('web_research');
    const r = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] });
    expect(r).toMatchObject({ status: 'denied', reason: 'policy_denied' });
  });

  // REWRITTEN BY ACBP-P6-007 (CDR-072 §1-G1). This used to inject `gates.stop`, which is exactly the bypass that
  // ticket deleted: a caller could hand the dispatcher any stop answer it liked. Both cases now go through a REAL
  // ROW in `emergency_stops`, so what is proven is the enforcement rather than the plumbing.
  test('a REAL account-wide stop refuses the call', async () => {
    await sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${w.accountA}::uuid, null, 'account_wide', null, ${w.aOwner}::uuid)`.execute(owner.kysely);
    const stopped = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] });
    expect(stopped).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
  });

  test('a stored stop this release CANNOT ENFORCE refuses distinctly — it never reads as clear', async () => {
    // The §0 failure as a live row: a `capability` stop is storable but inert (no registry identity exists), so it
    // must resolve to `stop_unavailable` rather than silently permitting the call. Inserted with the owner client
    // because the SERVICE refuses to create one — which is the point of having both defences.
    await sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'capability', 'web_research', ${w.aOwner}::uuid)`.execute(owner.kysely);
    const unreachable = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] });
    expect(unreachable).toMatchObject({ status: 'denied', reason: 'stop_unavailable' });
  });

  test('THE CONTROL: with no stop row at all the same call is NOT refused by the stop gate', async () => {
    // Without this, "always denies" would satisfy both cases above.
    const r = await dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [] });
    expect(r).not.toMatchObject({ reason: 'emergency_stopped' });
    expect(r).not.toMatchObject({ reason: 'stop_unavailable' });
  });

  // ── ACBP-P6-007: THE PER-SCOPE ENFORCEMENT MATRIX (CDR-072 §1-G2; launch gate 8) ───────────────────────────
  //
  // THE FAILURE THIS BLOCK EXISTS TO PREVENT (CDR-072 §0): a stop that silently fails to reach ONE scope is worse
  // than no stop at all, because the operator believes it worked and stops watching. The contract suite proves the
  // covering relation on paper; this proves it through a REAL ROW, the RLS predicates, and the live dispatcher —
  // which is where a scope actually goes missing, because a scope can be correct in `evaluateStops` and still never
  // fire if the dispatcher cannot populate the identity it matches on.
  //
  // Every enforceable scope is proven TWICE: it halts the call it claims, and it does NOT halt one it should not.
  // The misses are not padding. Without them a dispatcher that denied EVERYTHING would satisfy all five positives.
  //
  // The two INERT scopes are deliberately absent from this matrix — they cannot appear here as passing rows,
  // because they enforce nothing. Their behaviour (deny as `stop_unavailable`) is the test above.
  const activateStop = async (scope: string, targetId: string | null, companyId: string | null): Promise<void> => {
    await sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${w.accountA}::uuid, ${companyId}::uuid, ${scope}, ${targetId}, ${w.aOwner}::uuid)`.execute(owner.kysely);
  };

  /**
   * The identities the dispatcher resolves from the run — the exact values `task`/`worker` scopes match on, read
   * back from the database rather than assumed.
   *
   * THE THROW IS THE POINT, and it has already earned its place: the first version of this helper looked the run
   * up as `worker_runs.id = runId`, found nothing, and would have compared null against null — a `task` and a
   * `worker` case passing while proving that a stop targeting nothing fails to halt a call attached to nothing.
   * It threw instead, and hosted CI turned that into the discovery that the DISPATCHER had the same wrong lookup.
   */
  const runIdentities = async (): Promise<{ taskId: string; workerId: string }> => {
    const r = await sql<{ task_id: string; worker_id: string | null }>`
      select tr.task_id, (select wr.worker_id from worker_runs wr where wr.task_run_id = tr.id) as worker_id
      from task_runs tr where tr.id = ${runId}::uuid
    `.execute(owner.kysely);
    const row = r.rows[0];
    if (row === undefined) throw new Error('the fixture task run does not exist — the task/worker matrix would pass vacuously');
    if (row.worker_id === null) throw new Error('the fixture task run has no worker run — the worker scope case would compare null against null');
    return { taskId: row.task_id, workerId: row.worker_id };
  };

  /** The LATEST requested-event payload, ordered by the ULID primary key — which is monotonic by construction, so
   *  this is a real "most recent". An unordered read with `.at(-1)` would assert against whichever row the planner
   *  happened to return last, which is not the same thing and would pass or fail by luck. */
  const latestRequestedPayload = async (): Promise<Record<string, unknown>> => {
    const rows = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'tool.call_requested').orderBy('event_id').execute();
    const last = rows.at(-1);
    if (last === undefined) throw new Error('no tool.call_requested event was written — the assertion below would be vacuous');
    return last.payload;
  };

  /**
   * A COVERING stop for each enforceable scope: the row to write, and the call it must halt.
   *
   * Driven off `ENFORCEABLE_STOP_SCOPES` below rather than listed by hand, so a scope that becomes enforceable
   * without a covering case here fails on the missing key instead of quietly going unproven — which is the exact
   * way a scope goes silently missing.
   */
  type CoveringCase = { targetId: string | null; companyId: string | null; toolId: string };
  const COVERING_CASE: Record<string, () => CoveringCase | Promise<CoveringCase>> = {
    account_wide: () => ({ targetId: null, companyId: null, toolId: 'web_research' }),
    company: () => ({ targetId: w.companyA1, companyId: w.companyA1, toolId: 'web_research' }),
    // The TASK, not the task RUN. `held_work.task_id` references `tasks`, so a `task` stop names a task — the
    // distinction the dispatcher's first lookup got wrong.
    task: async () => ({ targetId: (await runIdentities()).taskId, companyId: w.companyA1, toolId: 'web_research' }),
    worker: async () => ({ targetId: (await runIdentities()).workerId, companyId: w.companyA1, toolId: 'web_research' }),
    // `send_email` is `external_reversible`, so the registry-derived external effect is true. The stop gate runs
    // BEFORE policy and approval, so the refusal below is the STOP's, not the approval requirement's — an emergency
    // stop must not be reachable only for calls that would have been allowed anyway.
    external_actions_only: () => ({ targetId: null, companyId: w.companyA1, toolId: 'send_email' }),
  };

  test('every enforceable scope has a covering case here — a scope added without one fails rather than goes unproven', () => {
    expect(Object.keys(COVERING_CASE).sort()).toEqual([...ENFORCEABLE_STOP_SCOPES].sort());
    // And the inert two are ABSENT on purpose: they cannot appear as passing rows in an enforcement matrix,
    // because they enforce nothing. Their behaviour is the `stop_unavailable` case above.
    for (const inert of NOT_YET_ENFORCEABLE_STOP_SCOPES) expect(Object.keys(COVERING_CASE)).not.toContain(inert);
  });

  // COVERS + LAUNCH GATE 8 IN ONE CASE PER SCOPE. Splitting them would let the enforcement pass while the timing
  // went unmeasured for four of the five — which is what the first draft of this file did, measuring only
  // `account_wide` while CDR-072 §G4 promises the bound "for every scope".
  //
  // WHAT THE NUMBER MEANS, stated so nobody reads more into it: propagation here is bounded by TRANSACTION
  // VISIBILITY, not by a cache refresh. The stop is read inside the same transaction as the call it authorizes, so
  // a stop committed before that read is visible to it — no interval to tune, no window for a stale answer. The
  // measurement confirms the mechanism has no hidden staleness. It is NOT a claim about a distributed fleet; that
  // is P7 infrastructure's to prove. And it cannot cover the two INERT scopes at all — they never produce
  // `emergency_stopped`, so there is no halt to time, which is the honest reason gate 8 is met for FIVE of seven.
  test.each(ENFORCEABLE_STOP_SCOPES)('COVERS + gate 8 — a %s stop halts its call, MEASURED under 5s', async (scope) => {
    const c = await COVERING_CASE[scope]!();
    // The control: this same call was NOT stop-refused a moment ago, so the refusal below is caused by the stop
    // rather than by anything already true of the fixture.
    expect(await dispatch({ toolId: c.toolId })).not.toMatchObject({ reason: 'emergency_stopped' });

    const startedAt = performance.now();
    await activateStop(scope, c.targetId, c.companyId);
    const stopped = await dispatch({ toolId: c.toolId });
    const elapsedMs = performance.now() - startedAt;

    expect(stopped).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    // Logged unconditionally so the measurement is in the CI record as evidence, not only when it fails.
    console.info(`[ACBP-P6-007] gate 8 / ${scope}: first refusal ${elapsedMs.toFixed(1)}ms after the stop committed (bound 5000ms)`);
    expect(elapsedMs).toBeLessThan(5_000);
  });

  test('MISSES — another ACCOUNT\'s account-wide stop does not halt this one', async () => {
    // The dual-scope RLS predicate is what makes this true, and it is the one that would silently over-halt the
    // whole platform if `company_id is null` had been written without the account check beside it.
    await sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${w.accountB}::uuid, null, 'account_wide', null, ${w.bOwner}::uuid)`.execute(owner.kysely);
    expect(await dispatch()).not.toMatchObject({ reason: 'emergency_stopped' });
  });

  test('MISSES — a SIBLING company\'s stop does not halt this company', async () => {
    // Same account, different company: the case where an over-broad predicate would turn one company's halt into
    // an outage for the whole account, and the operator would have no way to tell from the record.
    await activateStop('company', w.companyA2, w.companyA2);
    expect(await dispatch()).not.toMatchObject({ reason: 'emergency_stopped' });
  });

  test('MISSES — a stop on a DIFFERENT task does not halt this one', async () => {
    await activateStop('task', '00000000-0000-4000-8000-0000000000ff', w.companyA1);
    expect(await dispatch()).not.toMatchObject({ reason: 'emergency_stopped' });
  });

  test('MISSES — a stop on a DIFFERENT worker does not halt this one', async () => {
    await activateStop('worker', 'some-other-worker', w.companyA1);
    expect(await dispatch()).not.toMatchObject({ reason: 'emergency_stopped' });
  });

  test('MISSES — external_actions_only leaves an INTERNAL call running', async () => {
    // The whole purpose of this scope: stop what reaches the outside world, let internal work continue. If it
    // over-halted, an operator reaching for the narrow control would get a full outage instead.
    await activateStop('external_actions_only', null, w.companyA1);
    expect(await dispatch({ toolId: 'web_research' })).not.toMatchObject({ reason: 'emergency_stopped' });
  });

  // ── CDR-072 §1-G6, PM RULING (Option B): THE CHOKEPOINT HOLDS THE WORK IT REFUSES ────────────────────────
  //
  // The accepted cost of that ruling is a WRITE on the refusal path, so these cases exist to prove the write is
  // correct, idempotent, and does not fire when it should not. The objection recorded against the ruling — that the
  // chokepoint gains a task-lifecycle responsibility — is exactly why this block is adversarial rather than happy-path.

  const heldRows = async () => owner.kysely.selectFrom('held_work').selectAll().orderBy('id').execute();
  const taskStateOf = async (id: string) =>
    (await owner.kysely.selectFrom('tasks').select(['state']).where('id', '=', id).executeTakeFirst())?.state;

  test('a refused call HOLDS its task and PAUSES it — the sibling-company gap closed at the chokepoint', async () => {
    const { taskId } = await runIdentities();
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'queued', 'running'));
    expect(await taskStateOf(taskId)).toBe('running');

    await activateStop('account_wide', null, null);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });

    const held = await heldRows();
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ task_id: taskId, status: 'held' });
    expect(await taskStateOf(taskId)).toBe('paused');
  });

  test('IDEMPOTENT UNDER REPEATED REFUSALS — proven against the database, not argued', async () => {
    // LOAD-BEARING (PM ruling condition 3). A stopped task typically RETRIES, so this path is hit again and again;
    // without `held_work_stop_task_uq` + ON CONFLICT DO NOTHING the queue would gain a duplicate row per attempt and
    // ADMIN-002's review would become unfinishable by design — the operator asked to decide the same item N times.
    // Five refusals, because two would not distinguish "idempotent" from "the second one happened to fail".
    const { taskId } = await runIdentities();
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'queued', 'running'));
    await activateStop('account_wide', null, null);
    for (let i = 0; i < 5; i += 1) {
      expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    }
    expect(await heldRows()).toHaveLength(1);
  });

  test('a refusal for a DIFFERENT reason holds nothing — WITH a covering stop in force', async () => {
    // VACUOUS IN ITS FIRST VERSION, AND AN INDEPENDENT REVIEW CAUGHT IT — the same defect, in the same file, THIRTY
    // LINES ABOVE ITS OWN CORRECTED TWIN. It only deleted the registration; `beforeEach` truncates every fixture, so
    // no stop row existed, `stopEvaluation.kind` was `clear`, and BOTH conjuncts of the guard were false. Deleting
    // `finalReason === 'emergency_stopped'` — the mutation that would make any denial pollute the queue, which is
    // exactly what this test claims to prevent — left it green.
    //
    // The non-vacuous shape: a stop that DOES cover this call, AND an unregistered tool. `not_registered` is checked
    // first, so the refusal reason is not the stop's while the evaluation is genuinely `stopped` — the one cell that
    // distinguishes "holds on any denial" from "holds when a stop denies".
    await activateStop('account_wide', null, null);
    await sql`delete from tool_definitions where tool_id = 'web_research'`.execute(owner.kysely);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'not_registered' });
    expect(await heldRows()).toHaveLength(0);
    expect(await taskStateOf((await runIdentities()).taskId)).not.toBe('paused');
  });

  test('THE HELD ROW NAMES THE STOP THAT ACTUALLY COVERED IT — not merely one that shares a scope', async () => {
    // THE BLOCKER an independent review found. Attribution matched covering SCOPE NAMES back against `activeStops`,
    // which is ordered by `activated_at, id` — so with two `task` stops up, a call from the SECOND task was filed
    // under the FIRST task's stop. `listHeld` for the real stop then returned empty, so clearing it reported
    // nothing to review while the task sat paused, and the item could only be released by reviewing a row under a
    // stop that never covered it — which is refused while that stop is active. A permanently paused task, with the
    // evidence saying all was well.
    const { taskId } = await runIdentities();
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'queued', 'running'));

    // An EARLIER stop of the SAME scope naming a DIFFERENT task — the decoy the buggy lookup returned.
    await activateStop('task', '00000000-0000-4000-8000-0000000000ff', w.companyA1);
    const decoy = (await owner.kysely.selectFrom('emergency_stops').select(['id']).where('target_id', '=', '00000000-0000-4000-8000-0000000000ff').executeTakeFirstOrThrow()).id;
    // ...then the stop that genuinely covers this call.
    await activateStop('task', taskId, w.companyA1);
    const real = (await owner.kysely.selectFrom('emergency_stops').select(['id']).where('target_id', '=', taskId).executeTakeFirstOrThrow()).id;
    expect(decoy).not.toBe(real);

    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    const held = await heldRows();
    expect(held).toHaveLength(1);
    expect(held[0]?.stop_id, 'the held row must name the stop that covered the call, not an earlier same-scope one').toBe(real);
  });

  test('external_actions_only REFUSES the call but does NOT hold or pause the task', async () => {
    // It halts CALLS, not tasks — `activateStop` deliberately holds nothing for it because internal work continues
    // by design. An unfiltered dispatcher write silently converted the narrowest control into a whole-task halt:
    // one `send_email` and the task was paused into ADMIN-002's queue. §1-G2 names over-halting as a defect too.
    const { taskId } = await runIdentities();
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'queued', 'running'));
    await activateStop('external_actions_only', null, w.companyA1);
    expect(await dispatch({ toolId: 'send_email' })).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    expect(await heldRows()).toHaveLength(0);
    expect(await taskStateOf(taskId)).toBe('running');
  });

  test('THE HOLD AND THE PAUSE ARE AUDITED — a lifecycle mutation with no record is not evidence', async () => {
    // WORKFLOW §4's `running→paused` row carries "Audit: audited". The first version wrote the row and changed the
    // task's state with NO audit at all, so a reader could not tell the FIRST refusal — which created a queue item
    // and suspended a task — from the fifth, which did neither. `paused_task` is the CHECKED row count, not intent.
    const { taskId } = await runIdentities();
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'queued', 'running'));
    await activateStop('account_wide', null, null);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });

    const first = await latestRequestedPayload();
    expect(first['held_by_stop_id']).toEqual(expect.any(String));
    expect(first['paused_task']).toBe(true);

    // The SECOND refusal holds nothing new and pauses nothing — and says so, which is the whole point of recording
    // the checked count rather than the intent.
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });
    expect((await latestRequestedPayload())['paused_task']).toBe(false);
  });

  test('an UNREADABLE stop refuses without holding — `stop_unavailable` is not a halt that caught anything', async () => {
    // A `capability` stop is storable but inert, so the call is denied `stop_unavailable`. Nothing was interrupted
    // BY A COVERING STOP, so nothing may be attributed to one — a held row here would name a stop that covers
    // nothing, which is the §0 shape in the evidence rather than in the enforcement.
    await sql`insert into emergency_stops (account_id, company_id, scope, target_id, activated_by_user_id)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, 'capability', 'web_research', ${w.aOwner}::uuid)`.execute(owner.kysely);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'stop_unavailable' });
    expect(await heldRows()).toHaveLength(0);
  });

  test('THE EVIDENCE NAMES WHAT HALTED IT — not merely that something did (CDR-072 §1-G5)', async () => {
    // `denial_reason: emergency_stopped` alone cannot distinguish "the account is halted" from "one task is".
    // Both stops below cover this call, so the record must name BOTH — an evidence trail that reported only the
    // first would understate the halt while looking complete.
    const { taskId } = await runIdentities();
    await activateStop('account_wide', null, null);
    await activateStop('task', taskId, w.companyA1);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'emergency_stopped' });

    const metadata = await latestRequestedPayload();
    expect(metadata['denial_reason']).toBe('emergency_stopped');
    const scopes = metadata['stop_scopes'];
    // Narrowed rather than stringified: a non-string here (absent, or some object) would otherwise become the text
    // "undefined"/"[object Object]" and then fail on the comparison for a reason that names the wrong problem.
    if (typeof scopes !== 'string') throw new Error(`stop_scopes must be a comma-joined string; got ${typeof scopes}`);
    expect(scopes.split(',').sort()).toEqual(['account_wide', 'task']);
  });

  test('a NON-STOP refusal never claims a stop halted it — WITH a real stop in force', async () => {
    // THIS TEST WAS VACUOUS AND AN INDEPENDENT REVIEW CAUGHT IT. The first version only deleted the registration;
    // `beforeEach` truncates every fixture, so NO stop row existed, the evaluation was `clear`, `stopScopes` was ''
    // and the factory dropped the key for that reason alone. It would have passed with the
    // `denialReason === 'emergency_stopped'` guard deleted — i.e. it proved nothing about the property it names.
    //
    // The non-vacuous shape: activate a stop that DOES cover this call, and ALSO unregister the tool.
    // `decideDispatch` checks `not_registered` FIRST (an unregistered tool has no trustworthy risk class), so the
    // refusal reason is `not_registered` while `stopEvaluation.kind` is genuinely `stopped` and a non-empty scope
    // list is passed to the factory. Only the guard can drop it now.
    await activateStop('account_wide', null, null);
    await sql`delete from tool_definitions where tool_id = 'web_research'`.execute(owner.kysely);
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'not_registered' });
    expect(Object.keys(await latestRequestedPayload())).not.toContain('stop_scopes');
  });

  // UPDATED BY ACBP-P6-002 (CDR-067 §2-G7; PM ruling). This asserted that a gated class needed BOTH engines to allow
  // — i.e. that an absent approval refused whatever policy said. That was the stand-in for a `GateAnswer` which could
  // not express `require_approval`: with the middle output flattened onto `allow`, the only way to keep a demanded
  // approval enforceable was to demand one always. Policy is now the authority, so a policy that ALLOWS does not
  // conjure an approval requirement, and one that says `require_approval` still refuses without an approval — which
  // the contract suite pins for every risk class.
  test('policy decides whether an approval is needed: allow proceeds, require_approval waits', async () => {
    // ORDER MATTERS NOW, and it did not before. With the port closed there is no such thing as "the same call
    // without an approval offered" — an approval either exists in the store or it does not. So the ABSENCE is
    // asserted FIRST, against a genuinely empty `approval_decisions`, and only then is a real decision seeded.
    // My first rewrite seeded up front and then asserted the same call was refused for lack of an approval, which
    // could not hold: the sweep caught it.
    //
    // NO DECISION EXISTS: the ruled default requires approval for external_reversible, so this is refused — and the
    // reason names the missing approval rather than blaming policy, which said its piece perfectly clearly.
    const demanded = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] });
    expect(demanded).toMatchObject({ status: 'denied', reason: 'approval_required' });

    // A REAL HUMAN DECISION now exists for this run and tool: the same call is authorized.
    await seedDecision('send_email');
    const ok = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] });
    expect(ok.status).toBe('authorized');
    // …while an INFORMATIONAL call, which the same policy plainly allows, needs no approval at all. THIS is the
    // loosening, asserted end to end: policy decides, and it did not ask.
    expect((await dispatch({ toolId: 'web_research' })).status).toBe('authorized');
  });

  // ── ACCEPTANCE: unconfirmed is never success (TOOL-002) ───────────────────────────────────────────────────
  test('an EXTERNAL effect cannot be reported as succeeded without a receipt — and the DB refuses it too', async () => {
    // NO `policy` KEY: there is no policy port any more (CDR-067 §2-G1). Leaving a stale one here would still
    // typecheck — excess-property checking does not fire through a variable — and be SILENTLY IGNORED, which is the
    // exact shape the design warns about. Raised by the loosening's independent review (§2-G10).
    await seedDecision('send_email');
    await seedDecision('purge_everything');
    const call = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] });
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
    // A different tool, same key: a DIFFERENT CALL, which is this test's whole subject. It used to assert `denied`
    // here, but that was piggybacking on `memory_write` being refused for `policy_unavailable` — incidental to the
    // key scoping and no longer true, since the ruled default allows internal_reversible. What matters is that the
    // second call is not reported as a duplicate of the first.
    // EXACT, not `.not.toBe('duplicate')` — review pass 2 pointed out that a negative here also passes for
    // `forbidden`, `run_not_found` and `idempotency_conflict`, none of which would mean what the test claims.
    expect((await dispatch({ toolId: 'memory_write', idempotencyKey: 'shared' })).status).toBe('authorized');
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
    // NO `policy` KEY: there is no policy port any more (CDR-067 §2-G1). Leaving a stale one here would still
    // typecheck — excess-property checking does not fire through a variable — and be SILENTLY IGNORED, which is the
    // exact shape the design warns about. Raised by the loosening's independent review (§2-G10).
    await seedDecision('send_email');
    await seedDecision('purge_everything');
    const call = await dispatchToolCall(product, { ...base(), runId, toolId: 'send_email', args: {}, allowlist: allowAll, context: [] });
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

  test('migration 0039 carried the canon rename into EVERY class CHECK, data included', async () => {
    // The owner decision of 2026-07-28. The set-equality test below would catch a missed CHECK, but not a stranded
    // ROW — so this asserts the retired name is absent from both the constraint and the data.
    const defs = await sql<{ conname: string; def: string }>`
      select conname, pg_get_constraintdef(oid) as def from pg_constraint
      where conname in ('tool_definitions_risk_class_valid', 'tool_calls_risk_class_valid', 'worker_definitions_approval_threshold_valid')
    `.execute(owner.kysely);
    expect(defs.rows).toHaveLength(3);
    for (const row of defs.rows) {
      expect(row.def, row.conname).toContain('sensitive_irreversible');
      expect(row.def, row.conname).not.toContain('external_irreversible');
    }
    const stranded = await sql<{ n: number }>`
      select (select count(*) from tool_definitions where risk_class = 'external_irreversible')
           + (select count(*) from tool_calls where risk_class = 'external_irreversible')
           + (select count(*) from worker_definitions where approval_threshold_risk_class = 'external_irreversible') as n
    `.execute(owner.kysely);
    expect(Number(stranded.rows[0]?.n ?? 0)).toBe(0);
  });

  test('a SENSITIVE-IRREVERSIBLE tool still cannot claim success without a receipt', async () => {
    // The one place a pure rename could have changed behaviour unnoticed: `EXTERNAL_EFFECT_CLASSES` drives TOOL-002's
    // receipt rule, and dropping the renamed class from it would have quietly relaxed that rule on the most dangerous
    // class there is. Kept as an over-approximation on purpose — the safe direction.
    await sql`insert into tool_definitions (tool_id, version, risk_class, description) values ('purge_everything', 1, 'sensitive_irreversible', 'fixture')`.execute(owner.kysely);
    // NO `policy` KEY: there is no policy port any more (CDR-067 §2-G1). Leaving a stale one here would still
    // typecheck — excess-property checking does not fire through a variable — and be SILENTLY IGNORED, which is the
    // exact shape the design warns about. Raised by the loosening's independent review (§2-G10).
    await seedDecision('send_email');
    await seedDecision('purge_everything');
    const call = await dispatchToolCall(product, { ...base(), runId, toolId: 'purge_everything', args: {}, allowlist: [...allowAll, 'purge_everything'], context: [] });
    const callId = (call as { status: 'authorized'; call: { id: string; externalEffect: boolean } }).call.id;
    expect((call as { call: { externalEffect: boolean } }).call.externalEffect).toBe(true);
    expect(await reportToolCallOutcome(product, { ...base(), callId, outcome: 'succeeded' })).toEqual({ status: 'receipt_required' });
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
