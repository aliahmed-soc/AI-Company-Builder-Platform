// ACBP-P4-004 / CDR-042 — real-PostgreSQL proof of the task board through the RESTRICTED role. Proves: the board is
// RLS-confined (a foreign company's tasks and dependency EDGES are invisible, not filtered in application code);
// drafts stay off the board but are counted; held work is not counted as in progress; dependency edges are surfaced
// in both directions with the derived blocked flag; unavailable buckets are always present and labelled; truncation
// is reported honestly; owner+viewer may read and a non-member is forbidden. Skips when ACBP_TEST_DATABASE_URL is unset.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import type { DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask, addTaskDependency, getTaskBoard } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

describe.skipIf(!hasTestDatabase)('task board (real PostgreSQL, restricted role) — ACBP-P4-004/CDR-042', () => {
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

  /** A task in `draft` (created but not confirmed onto the board). */
  async function draft(title = 'Ship onboarding'): Promise<string> {
    const r = await createTask(product, { ...base(), title, description: null, milestoneId: null });
    expect(r.status).toBe('ok');
    return (r as { status: 'ok'; task: { taskId: string } }).task.taskId;
  }
  /** A task confirmed onto the board (`planned`). */
  async function planned(title = 'Planned work'): Promise<string> {
    const id = await draft(title);
    expect((await planTask(product, { ...base(), taskId: id })).status).toBe('ok');
    return id;
  }
  /** Force a state the app role cannot reach yet (execution transitions are Phase 5), via the fixture client. */
  const forceState = (id: string, state: string) => sql`update tasks set state = ${state} where id = ${id}::uuid`.execute(owner.kysely);
  const boardOk = async (params = base()) => {
    const r = await getTaskBoard(product, params);
    expect(r.status).toBe('ok');
    return (r as Extract<Awaited<ReturnType<typeof getTaskBoard>>, { status: 'ok' }>).board;
  };
  const bucket = (b: Awaited<ReturnType<typeof boardOk>>, name: string) => b.buckets.find((x) => x.bucket === name)!;

  test('the board always shows EVERY bucket, and the two that cannot fill say why', async () => {
    const board = await boardOk();
    expect(board.buckets.map((b) => b.bucket)).toEqual(['to_do', 'recurring', 'in_progress', 'completed', 'rejected', 'failed', 'cancelled', 'held']);
    // Empty by construction, not by chance: recurrence is Post-MVP and the reject control is P4-005.
    expect(bucket(board, 'recurring').availability).toBe('not_in_this_version');
    expect(bucket(board, 'rejected').availability).toBe('not_in_this_version');
    expect(bucket(board, 'to_do').availability).toBe('available');
  });

  test('drafts stay OFF the board but are counted — a generated plan is never silently invisible', async () => {
    await draft('unconfirmed one');
    await draft('unconfirmed two');
    const onBoard = await planned('confirmed');
    const board = await boardOk();
    expect(board.draftsOffBoard).toBe(2);
    expect(bucket(board, 'to_do').tasks.map((t) => t.task.taskId)).toEqual([onBoard]);
    expect(board.buckets.every((b) => b.tasks.every((t) => t.task.state !== 'draft'))).toBe(true);
    expect(board.unplaceable).toBe(0);
  });

  test('HELD work is its own bucket — a task waiting on the owner never reads as progressing', async () => {
    const running = await planned('running work');
    const waiting = await planned('waiting work');
    const blocked = await planned('policy-blocked work');
    await forceState(running, 'running');
    await forceState(waiting, 'waiting_for_approval');
    await forceState(blocked, 'blocked_by_policy');

    const board = await boardOk();
    expect(board.counts['in_progress']).toBe(1);
    expect(board.counts['held']).toBe(2);
    expect(bucket(board, 'in_progress').tasks.map((t) => t.task.taskId)).toEqual([running]);
    expect(bucket(board, 'held').tasks.map((t) => t.task.taskId).sort()).toEqual([blocked, waiting].sort());
  });

  test('cancelled and failed stay DISTINCT — the owner stopping work is not the platform falling over', async () => {
    const cancelled = await planned('cancelled work');
    const failed = await planned('failed work');
    await forceState(cancelled, 'cancelled');
    await forceState(failed, 'failed');
    const board = await boardOk();
    expect(bucket(board, 'cancelled').tasks.map((t) => t.task.taskId)).toEqual([cancelled]);
    expect(bucket(board, 'failed').tasks.map((t) => t.task.taskId)).toEqual([failed]);
  });

  test('dependencies surface in BOTH directions with the derived blocked flag', async () => {
    const prerequisite = await planned('do this first');
    const dependent = await planned('then this');
    expect((await addTaskDependency(product, { ...base(), taskId: dependent, dependsOnTaskId: prerequisite })).status).toBe('ok');

    let board = await boardOk();
    const find = (b: typeof board, id: string) => b.buckets.flatMap((x) => x.tasks).find((t) => t.task.taskId === id)!;
    expect(find(board, dependent).dependsOnTaskIds).toEqual([prerequisite]);
    expect(find(board, prerequisite).blocksTaskIds).toEqual([dependent]);
    // Blocked while the prerequisite is outstanding...
    expect(find(board, dependent).dependencyBlocked).toBe(true);

    // ...and only COMPLETED clears it.
    await forceState(prerequisite, 'failed');
    board = await boardOk();
    expect(find(board, dependent).dependencyBlocked).toBe(true);
    await forceState(prerequisite, 'completed');
    board = await boardOk();
    expect(find(board, dependent).dependencyBlocked).toBe(false);
  });

  test('RLS: company B sees NEITHER company A\'s tasks NOR its dependency edges', async () => {
    const prerequisite = await planned('A prerequisite');
    const dependent = await planned('A dependent');
    await addTaskDependency(product, { ...base(), taskId: dependent, dependsOnTaskId: prerequisite });

    // Company A2 belongs to the SAME account, so this also proves the board is company-scoped, not account-scoped.
    const a2 = await boardOk({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA2 });
    expect(a2.buckets.every((b) => b.tasks.length === 0)).toBe(true);
    expect(a2.draftsOffBoard).toBe(0);
    // A different tenant entirely.
    const b1 = await boardOk({ userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 });
    expect(b1.buckets.every((x) => x.tasks.length === 0)).toBe(true);
    // And company A still sees its own.
    expect((await boardOk()).counts['to_do']).toBe(2);
  });

  test('truncation is REPORTED — the board never implies it showed everything', async () => {
    for (let i = 0; i < 3; i += 1) await planned(`work ${i}`);
    const two = await getTaskBoard(product, { ...base(), limit: 2 });
    expect(two.status).toBe('ok');
    if (two.status !== 'ok') return;
    expect(two.board.truncated).toBe(true);
    expect(two.board.buckets.reduce((n, b) => n + b.tasks.length, 0)).toBe(2);

    // Exactly at the limit is NOT truncated — the +1 probe exists so a company holding exactly `limit` tasks is not
    // told its board was cut short.
    const three = await getTaskBoard(product, { ...base(), limit: 3 });
    expect(three.status === 'ok' && three.board.truncated).toBe(false);
  });

  test('DRAFTS DO NOT CONSUME THE PAGE — a planning run cannot push real board work out of view', async () => {
    // The bug this pins: `limit` applied to an unfiltered, newest-first query meant a batch of freshly-minted drafts
    // occupied the whole page, rendering every bucket empty while planned work existed. The limit must bound BOARD
    // rows to mean anything.
    const onBoard = await planned('real work');
    for (let i = 0; i < 5; i += 1) await draft(`preview ${i}`);

    const r = await getTaskBoard(product, { ...base(), limit: 2 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.board.draftsOffBoard).toBe(5);
    // The single board task is visible despite five NEWER drafts and a limit of 2.
    expect(bucket(r.board, 'to_do').tasks.map((t) => t.task.taskId)).toEqual([onBoard]);
    expect(r.board.truncated).toBe(false);
    expect(r.board.unplaceable).toBe(0);
  });

  test('an off-page prerequisite is RESOLVED, so a truncated board does not report everything as blocked', async () => {
    // Prerequisites are older than their dependents, so a newest-first page drops them FIRST. Failing closed on every
    // one would make a large board read as gridlocked.
    const prerequisite = await planned('older prerequisite');
    const dependent = await planned('newer dependent');
    await addTaskDependency(product, { ...base(), taskId: dependent, dependsOnTaskId: prerequisite });
    await forceState(prerequisite, 'completed');

    // limit 1 keeps only the NEWER dependent; the prerequisite falls off the page entirely.
    const r = await getTaskBoard(product, { ...base(), limit: 1 });
    expect(r.status).toBe('ok');
    if (r.status !== 'ok') return;
    expect(r.board.truncated).toBe(true);
    const shown = r.board.buckets.flatMap((b) => b.tasks);
    expect(shown.map((t) => t.task.taskId)).toEqual([dependent]);
    // Resolved from the database, not guessed: the completed prerequisite genuinely unblocks it.
    expect(shown[0]!.dependsOnTaskIds).toEqual([prerequisite]);
    expect(shown[0]!.dependencyBlocked).toBe(false);
  });

  test('a DRAFT endpoint never appears in either edge direction (CDR-042 §3-G1)', async () => {
    const onBoard = await planned('board task');
    const unconfirmed = await draft('still a preview');
    // A draft may legally be either end of an edge — the board must simply not surface it.
    expect((await addTaskDependency(product, { ...base(), taskId: unconfirmed, dependsOnTaskId: onBoard })).status).toBe('ok');

    const board = await boardOk();
    const shown = board.buckets.flatMap((b) => b.tasks);
    expect(shown.map((t) => t.task.taskId)).toEqual([onBoard]);
    expect(shown[0]!.blocksTaskIds).toEqual([]);
    expect(board.draftsOffBoard).toBe(1);
  });

  test('a non-integer limit falls back to the default instead of reaching SQL', async () => {
    await planned('work');
    for (const bad of [Number.NaN, 2.5, -1]) {
      const r = await getTaskBoard(product, { ...base(), limit: bad });
      expect(r.status).toBe('ok');
    }
  });

  test('authz: a viewer may read the board; a non-member is forbidden', async () => {
    await planned('visible work');
    expect((await getTaskBoard(product, { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('ok');
    expect((await getTaskBoard(product, { userId: w.bOwner, accountId: w.accountA, companyId: w.companyA1 })).status).toBe('forbidden');
  });

  test('the board writes NOTHING — it is a pure read (no audit, no state change)', async () => {
    const id = await planned('untouched');
    const before = (await sql<{ n: number }>`select count(*)::int as n from audit_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n;
    await boardOk();
    await boardOk();
    const after = (await sql<{ n: number }>`select count(*)::int as n from audit_events where company_id = ${w.companyA1}::uuid`.execute(owner.kysely)).rows[0]!.n;
    expect(after).toBe(before);
    expect((await sql<{ state: string }>`select state from tasks where id = ${id}::uuid`.execute(owner.kysely)).rows[0]?.state).toBe('planned');
  });
});
