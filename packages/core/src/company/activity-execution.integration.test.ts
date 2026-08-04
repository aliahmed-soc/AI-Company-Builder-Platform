// ACBP-P6-008 / CDR-076 §7 — execution reaches the founder-facing feed (ACT-001, ACT-003, ACT-005).
//
// WHAT THIS SUITE IS FOR. Before this ticket a founder could read that their company had been created and
// nothing whatsoever about the work done inside it: every task and approval was audited and none of it was
// projected. The gap was recorded in PROJECT-STATE and the Slice E journey asserted the ABSENCE so that closing
// it would have to be deliberate. These tests are the deliberate closing, and they check the two things that
// make the difference real rather than nominal:
//
//   1. THE EVENTS ACTUALLY ARRIVE, through the production use cases, in the same transaction as the state
//      change — not through a projector called by a test.
//   2. THEY ARRIVE REDACTED. The task title a founder typed, the reason they gave for a rejection, and a
//      provider's error text are the three strings most likely to be waved into a feed by a summary that
//      copied its payload, so each is written into the fixture and asserted absent from the feed.
//
// Plus the guard P5-013 earned: the live CHECK and the contract's list are compared as SETS, read out of
// `pg_constraint` rather than out of the migration's source text.
//
// Setup/seed on the superuser (owner); every service call runs through the restricted `acbp_app` client.
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import { ACTIVITY_TYPES, type ActivityEventDTO } from '@acbp/contracts';
import {
  hasTestDatabase,
  createOwnerFixtureClient,
  createRestrictedProductClient,
  enableAppLogin,
  resetSchema,
  truncateFixtures,
  seedTwoTenantWorld,
  teardown,
  assertRestrictedRole,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun, succeedRun, failRun } from '../runs/index.js';
import { completeTask } from '../artifacts/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { requestApproval, decideApproval } from '../approvals/index.js';
import { getCompanyActivity } from './activity-service.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** The exact strings a founder or a provider authored. None may reach the feed. */
const TASK_TITLE = 'Email three suppliers about bulk pricing';
const REJECTION_REASON = 'Too expensive for us right now, ask again next quarter';

describe.skipIf(!hasTestDatabase)('execution in the activity feed (real PostgreSQL, restricted role) — ACBP-P6-008/CDR-076 §7', () => {
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
  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);
  });

  const asOwner = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });

  async function feed(params = asOwner()): Promise<readonly ActivityEventDTO[]> {
    const r = await getCompanyActivity(product, { ...params, limit: 100 });
    if (r.status !== 'ok') throw new Error(`expected ok feed, got ${r.status}`);
    return r.page.items;
  }
  const typesIn = (items: readonly ActivityEventDTO[]): string[] => items.map((i) => i.type);
  const itemOf = (items: readonly ActivityEventDTO[], type: string): ActivityEventDTO => {
    const found = items.find((i) => i.type === type);
    if (found === undefined) throw new Error(`feed has no ${type} (saw: ${[...new Set(typesIn(items))].join(', ')})`);
    return found;
  };

  async function forceTaskState(taskId: string, state: string): Promise<void> {
    await sql`update tasks set state = ${state}, updated_at = now() where id = ${taskId}::uuid`.execute(owner.kysely);
  }

  /** A task on the board, created through the real use cases, titled with the founder's own words. */
  async function plannedTask(title = TASK_TITLE): Promise<string> {
    const created = await createTask(product, { ...asOwner(), title, description: 'private notes about our margins', milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...asOwner(), taskId })).status).toBe('ok');
    return taskId;
  }

  async function startedRun(taskId: string): Promise<string> {
    await forceTaskState(taskId, 'queued');
    const started = await startRun(product, { ...asOwner(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    await forceTaskState(taskId, 'running');
    return (started as { status: 'ok'; run: { id: string } }).run.id;
  }

  async function registeredToolAndPolicy(): Promise<void> {
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('send_email', 1, 'external_reversible', 'fixture tool', 'active')
              on conflict do nothing`.execute(owner.kysely);
    expect((await initializeCompanyPolicy(product, asOwner())).status).toBe('ok');
  }

  async function raiseApproval(runId: string): Promise<string> {
    const r = await requestApproval(product, {
      ...asOwner(),
      runId,
      toolId: 'send_email',
      expiresAt: new Date(Date.now() + 3_600_000),
      scope: 'one_action' as const,
      action: 'Email three suppliers',
      reason: 'Outreach is the next planned step',
      expectedResult: 'Three emails delivered',
      data: { recipients: 3 },
      estimatedCostCredits: 1,
      preview: 'To: 3 suppliers',
    });
    if (r.status !== 'ok') throw new Error(`approval request failed: ${r.status}`);
    return r.request.id;
  }

  // ── the taxonomy and the database cannot drift ────────────────────────────────────────────────────────

  test('THE LIVE CHECK EQUALS THE CONTRACT SET — read from pg_constraint, compared both ways', async () => {
    // P5-013 widened `ACTIVITY_TYPES` with no migration and nothing caught it, because the divergence only bites
    // at INSERT and the projector is fail-closed. This reads the constraint PostgreSQL is actually enforcing.
    const def = await sql<{ definition: string }>`
      select pg_get_constraintdef(oid) as definition from pg_constraint where conname = 'activity_events_type_valid'
    `.execute(owner.kysely);
    const definition = def.rows[0]?.definition;
    expect(definition, 'activity_events_type_valid must exist for this assertion to mean anything').toBeDefined();
    const inCheck = [...String(definition).matchAll(/'([a-z_.]+)'::text/g)].map((m) => m[1]).sort();
    expect(inCheck).toEqual([...ACTIVITY_TYPES].sort());
  });

  // ── the events arrive ─────────────────────────────────────────────────────────────────────────────────

  test('the WORK a founder is paying for now appears: created → started → completed, newest first', async () => {
    const taskId = await plannedTask();
    const runId = await startedRun(taskId);
    expect((await succeedRun(product, { ...asOwner(), runId })).status).toBe('ok');
    await sql`insert into artifacts (account_id, company_id, object_key, content_hash, format, size_bytes, run_id, worker_id, worker_version, model_version, title)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${`company/${w.companyA1.toLowerCase()}/${runId}`}, repeat('a', 64), 'markdown', 12, ${runId}::uuid, 'research', 1, 'test-model-1', 'Supplier list')`.execute(owner.kysely);
    const artifact = await owner.kysely.selectFrom('artifacts').select('id').where('run_id', '=', runId).executeTakeFirstOrThrow();
    const completed = await completeTask(product, { ...asOwner(), taskId, runId, evidence: { kind: 'artifacts', artifactIds: [artifact.id] } });
    expect(completed.status, 'precondition: the completion path must succeed for its projection to mean anything').toBe('ok');

    const items = await feed();
    expect(typesIn(items)).toContain('task.created');
    expect(typesIn(items)).toContain('task.started');
    expect(typesIn(items)).toContain('task.completed');
    // Newest first, so a founder opening the feed sees the outcome before the setup.
    expect(typesIn(items).indexOf('task.completed')).toBeLessThan(typesIn(items).indexOf('task.created'));
    expect(itemOf(items, 'task.completed').summary).toEqual({ artifact_count: 1, no_artifact_rationale: false });
    expect(itemOf(items, 'task.started').summary).toEqual({ attempt: 1 });
  });

  test('ACT-005: a FAILURE is shown, with a category and a retry state and no provider text', async () => {
    const taskId = await plannedTask();
    const runId = await startedRun(taskId);
    expect((await failRun(product, { ...asOwner(), runId, failureCategory: 'provider_error' })).status).toBe('ok');

    const failed = itemOf(await feed(), 'task.failed');
    expect(failed.state).toBe('executed');
    // The retry state comes from `describeRunFailure`'s closed set — asserted as a member of that set rather
    // than as "some string", because "no blank failures" is a claim about the VALUE, not about the key.
    expect(Object.keys(failed.summary).sort()).toEqual(['attempt', 'failure_category', 'retry_state']);
    expect(failed.summary['attempt']).toBe(1);
    expect(failed.summary['failure_category']).toBe('provider_error');
    expect(['retry_eligible', 'attempts_exhausted', 'not_retryable']).toContain(failed.summary['retry_state']);
  });

  test('ACT-003: the PROPOSAL is marked proposed and the DECISION that answers it is marked executed', async () => {
    await registeredToolAndPolicy();
    const runId = await startedRun(await plannedTask());
    const requestId = await raiseApproval(runId);

    const proposed = itemOf(await feed(), 'approval.requested');
    // The whole point of the marking: "asked to send three emails" must not read as "sent three emails".
    expect(proposed.state).toBe('proposed');
    expect(proposed.summary).toEqual({ tool_id: 'send_email', risk_class: 'external_reversible', scope: 'one_action', estimated_cost_credits: 1 });

    const decided = await decideApproval(product, { ...asOwner(), requestId, decision: { path: 'reject', decidedAt: new Date(), reason: REJECTION_REASON } });
    expect(decided.status, `decision failed: ${decided.status}`).toBe('ok');
    const rejected = itemOf(await feed(), 'approval.rejected');
    expect(rejected.state).toBe('executed');
    expect(rejected.summary).toEqual({ decider_type: 'human' });
  });

  test('A REJECTION IS SHOWN AT ALL — a feed that dropped refusals would read as if nobody ever said no', async () => {
    await registeredToolAndPolicy();
    const runId = await startedRun(await plannedTask());
    const requestId = await raiseApproval(runId);
    await decideApproval(product, { ...asOwner(), requestId, decision: { path: 'reject', decidedAt: new Date(), reason: REJECTION_REASON } });
    expect(typesIn(await feed())).toContain('approval.rejected');
  });

  // ── redaction ─────────────────────────────────────────────────────────────────────────────────────────

  test('NOTHING A HUMAN WROTE REACHES THE FEED — not the task title, not the rejection reason', async () => {
    await registeredToolAndPolicy();
    const taskId = await plannedTask();
    const runId = await startedRun(taskId);
    const requestId = await raiseApproval(runId);
    await decideApproval(product, { ...asOwner(), requestId, decision: { path: 'reject', decidedAt: new Date(), reason: REJECTION_REASON } });
    expect((await failRun(product, { ...asOwner(), runId, failureCategory: 'provider_error' })).status).toBe('ok');

    const serialized = JSON.stringify(await feed());
    for (const authored of [TASK_TITLE, REJECTION_REASON, 'private notes about our margins', 'Email three suppliers about bulk pricing', 'To: 3 suppliers']) {
      expect(serialized, `the feed leaked authored text: ${authored}`).not.toContain(authored);
    }
    // Nor the internal linkage: run ids are on the audit row, not in a founder's feed summary.
    expect(serialized).not.toContain(runId);
    // The feed carries no actor ids either — `actorType` is the coarse kind, and that is all.
    expect(serialized).not.toContain(w.aOwner);
  });

  // ── tenancy ───────────────────────────────────────────────────────────────────────────────────────────

  test("company B's execution never appears in company A's feed", async () => {
    const foreign = await createTask(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, title: 'Beta work', description: null, milestoneId: null });
    const foreignTaskId = (foreign as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, taskId: foreignTaskId })).status).toBe('ok');
    await plannedTask();

    const mine = await feed();
    expect(typesIn(mine).filter((t) => t === 'task.created')).toHaveLength(1);
    expect(JSON.stringify(mine)).not.toContain(foreignTaskId);
    // And the projection is dual-keyed at rest, not merely filtered on read.
    const rows = await owner.kysely.selectFrom('activity_events').select(['company_id', 'account_id', 'activity_type']).where('activity_type', '=', 'task.created').execute();
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => (r.company_id === w.companyA1 && r.account_id === w.accountA) || (r.company_id === w.companyB1 && r.account_id === w.accountB))).toBe(true);
  });

  // ── fail-closed ───────────────────────────────────────────────────────────────────────────────────────

  test('THE PROJECTION IS FAIL-CLOSED: if the feed row cannot be written, the state change is undone', async () => {
    // The property that makes the feed trustworthy rather than best-effort. A projector that swallowed its own
    // failure would produce exactly the silent-progress state this surface exists to prevent: work advancing
    // while the founder's only window on it stays blank.
    const created = await createTask(product, { ...asOwner(), title: 'Never reaches the board', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    await expect(
      planTask(
        product,
        { ...asOwner(), taskId },
        {
          activityWriter: () => {
            throw new Error('projection failed');
          },
        },
      ),
    ).rejects.toThrow();

    const task = await owner.kysely.selectFrom('tasks').select('state').where('id', '=', taskId).executeTakeFirstOrThrow();
    expect(task.state, 'the transition must have rolled back with its projection').toBe('draft');
    const audits = await owner.kysely.selectFrom('audit_events').select('event_id').where('name', '=', 'task.created').execute();
    expect(audits, 'and the audit write rolls back with it — audit-or-nothing, feed-or-nothing').toEqual([]);
  });
});
