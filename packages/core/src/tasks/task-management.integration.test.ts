// ACBP-P4-002 / CDR-033 §2–4 — real-PostgreSQL proof of the task use cases through the RESTRICTED role. Proves:
// createTask mints a draft (no audit yet); planTask performs the SERVER-ENFORCED draft→planned and writes a bounded
// task.created (subject = task id, metadata {has_milestone} only — never title/description); the state machine rejects
// every illegal transition (planned→planned, terminal→planned) with no audit; addTaskDependency creates an immutable
// same-company edge and refuses self / duplicate / unknown edges; audit-or-nothing rollback; owner+viewer may
// create/plan/read, a non-member is forbidden; cross-company isolation. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient, AuditScope } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { TASK_DESCRIPTION_MAX, TASK_TITLE_MAX } from '@acbp/contracts';
import { createTask, planTask, addTaskDependency, getTask, listTasks } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('task use cases (real PostgreSQL, restricted role) — ACBP-P4-002/CDR-033', () => {
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

  const base = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const auditFor = async (name: string) => owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).execute();
  const stateOf = async (id: string) => (await sql<{ state: string }>`select state from tasks where id = ${id}::uuid`.execute(owner.kysely)).rows[0]?.state;
  async function newDraft(over: { title?: string; milestoneId?: string | null } = {}): Promise<string> {
    const r = await createTask(product, { ...base(), title: over.title ?? 'Ship onboarding', description: null, milestoneId: over.milestoneId ?? null });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
  }

  test('createTask mints a company-scoped task in draft — no audit is written yet (planTask owns task.created)', async () => {
    const r = await createTask(product, { ...base(), title: 'Ship onboarding', description: 'the first flow', milestoneId: null });
    expect(r.status).toBe('ok');
    const task = (r as { status: 'ok'; task: { taskId: string; state: string; phase: string; title: string } }).task;
    expect(task.state).toBe('draft');
    expect(task.phase).toBe('draft');
    expect(task.title).toBe('Ship onboarding');
    expect(await stateOf(task.taskId)).toBe('draft');
    expect(await auditFor('task.created')).toHaveLength(0);
  });

  test('createTask validation: empty/blank title, over-long title, and over-long description are rejected', async () => {
    expect((await createTask(product, { ...base(), title: '   ', description: null, milestoneId: null })).status).toBe('invalid');
    expect((await createTask(product, { ...base(), title: 'x'.repeat(TASK_TITLE_MAX + 1), description: null, milestoneId: null })).status).toBe('invalid');
    expect((await createTask(product, { ...base(), title: 'ok', description: 'y'.repeat(TASK_DESCRIPTION_MAX + 1), milestoneId: null })).status).toBe('invalid');
    expect((await sql<{ n: number }>`select count(*)::int as n from tasks`.execute(owner.kysely)).rows[0]!.n).toBe(0);
  });

  test('planTask: server-enforced draft→planned appears on the board + writes a bounded task.created (no content)', async () => {
    const id = await newDraft({ title: 'Secret internal codename' });
    const r = await planTask(product, { ...base(), taskId: id });
    expect(r.status).toBe('ok');
    expect((r as { status: 'ok'; task: { state: string; phase: string } }).task.state).toBe('planned');
    expect(await stateOf(id)).toBe('planned');
    const audits = await auditFor('task.created');
    expect(audits).toHaveLength(1);
    expect(audits[0]!.subject_id).toBe(id);
    expect(audits[0]!.payload).toEqual({ has_milestone: false });
    // Never leak the title/description into audit metadata.
    expect(JSON.stringify(audits[0]!.payload)).not.toContain('codename');
  });

  test('planTask metadata: has_milestone reflects whether the task was created against a milestone', async () => {
    const milestone = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    const id = await newDraft({ milestoneId: milestone });
    await planTask(product, { ...base(), taskId: id });
    const audits = await auditFor('task.created');
    expect(audits[0]!.payload).toEqual({ has_milestone: true });
  });

  test('planTask rejects illegal transitions with no audit: replanning a planned task and planning a terminal task', async () => {
    const id = await newDraft();
    expect((await planTask(product, { ...base(), taskId: id })).status).toBe('ok');
    // planned→planned is not legal — rejected (no second task.created).
    const again = await planTask(product, { ...base(), taskId: id });
    expect(again.status).toBe('illegal_transition');
    // A task the owner (superuser) forced into a terminal state cannot be planned (terminal→planned illegal).
    const term = await newDraft();
    await sql`update tasks set state = 'completed' where id = ${term}::uuid`.execute(owner.kysely);
    const t = await planTask(product, { ...base(), taskId: term });
    expect(t.status).toBe('illegal_transition');
    expect(await auditFor('task.created')).toHaveLength(1); // only the one legal plan above
  });

  test('planTask not_found: a task id that is absent / invisible to the caller', async () => {
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await planTask(product, { ...base(), taskId: foreign })).status).toBe('not_found');
  });

  test('audit-or-nothing: an in-tx audit failure on planTask rolls back — the task stays draft', async () => {
    const id = await newDraft();
    await expect(planTask(product, { ...base(), taskId: id }, { auditWriter: (_s: AuditScope) => Promise.reject(new Error('audit down')) })).rejects.toThrow();
    expect(await stateOf(id)).toBe('draft');
    expect(await auditFor('task.created')).toHaveLength(0);
  });

  test('addTaskDependency: an immutable same-company edge; self / duplicate / unknown dependency are refused', async () => {
    const a = await newDraft({ title: 'A' });
    const b = await newDraft({ title: 'B' });
    const ok = await addTaskDependency(product, { ...base(), taskId: a, dependsOnTaskId: b });
    expect(ok.status).toBe('ok');
    expect((await sql<{ n: number }>`select count(*)::int as n from task_dependencies where task_id = ${a}::uuid and depends_on_task_id = ${b}::uuid`.execute(owner.kysely)).rows[0]!.n).toBe(1);
    // Self-dependency refused.
    expect((await addTaskDependency(product, { ...base(), taskId: a, dependsOnTaskId: a })).status).toBe('invalid');
    // Duplicate edge refused.
    expect((await addTaskDependency(product, { ...base(), taskId: a, dependsOnTaskId: b })).status).toBe('duplicate');
    // Unknown dependency target refused.
    const foreign = (await sql<{ id: string }>`select gen_random_uuid() as id`.execute(owner.kysely)).rows[0]!.id;
    expect((await addTaskDependency(product, { ...base(), taskId: a, dependsOnTaskId: foreign })).status).toBe('not_found');
  });

  test('authz: a viewer MAY create/plan/read a task; a non-member is forbidden from every task action', async () => {
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    const nonMember = { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 };
    const vc = await createTask(product, { ...viewer, title: 'viewer task', description: null, milestoneId: null });
    expect(vc.status).toBe('ok');
    const vid = (vc as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...viewer, taskId: vid })).status).toBe('ok');
    expect((await getTask(product, { ...viewer, taskId: vid })).status).toBe('ok');
    // Non-member: every action forbidden.
    expect((await createTask(product, { ...nonMember, title: 'x', description: null, milestoneId: null })).status).toBe('forbidden');
    expect((await planTask(product, { ...nonMember, taskId: vid })).status).toBe('forbidden');
    expect((await getTask(product, { ...nonMember, taskId: vid })).status).toBe('forbidden');
    expect((await listTasks(product, nonMember)).status).toBe('forbidden');
  });

  test('cross-company isolation: a company A1 task is invisible + un-plannable under company A2 scope', async () => {
    const id = await newDraft();
    const a2 = { userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 };
    expect((await getTask(product, { ...a2, taskId: id })).status).toBe('not_found');
    expect((await planTask(product, { ...a2, taskId: id })).status).toBe('not_found');
    // A2 owner cannot make an A1 task depend on their own task (the A1 task is invisible → not_found).
    const a2Task = (await createTask(product, { ...a2, title: 'a2 task', description: null, milestoneId: null }) as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await addTaskDependency(product, { ...a2, taskId: a2Task, dependsOnTaskId: id })).status).toBe('not_found');
    // A1 listing shows exactly its own one task.
    const listed = await listTasks(product, base());
    expect(listed.status).toBe('ok');
    expect((listed as { status: 'ok'; tasks: unknown[] }).tasks).toHaveLength(1);
  });
});
