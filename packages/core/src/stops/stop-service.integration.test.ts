// ACBP-P6-007 / CDR-072 — real-PostgreSQL proof of the emergency-stop CONTROLLER through the RESTRICTED role.
//
// THIS SUITE EXISTS BECAUSE IT DID NOT, and that absence was a Blocker. `activateStop`, `clearStop`,
// `reviewHeldWork` and `readStopState` shipped with ZERO tests and ZERO callers: the dispatcher suite defined its
// own local raw-insert helper rather than calling the service, and the schema suite used hand-written SQL. So every
// service-level guard — the authorization checks, every typed refusal, the held-work loop, all three audit events,
// the §1-G8 throw-on-failure rule — was unproven, and `StopRepository.insert`'s `ON CONFLICT` inference against a
// PARTIAL index had never executed at all. That last one is the `credit_transactions_reservation_key_uq` shape:
// a dead write path that typecheck, lint and unit tests all pass.
//
// Two documented claims are discharged here rather than asserted in prose: CDR-072 §1-G8's "force the failure,
// assert the call rejects AND that no partial stop state survives", and `audit-operations.ts`'s promise that the
// real scope/target/counts are "asserted against the stored payload".
//
// Setup/seed on the superuser (owner); every service call runs through the restricted `acbp_app` client.
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient, TaskRepository } from '@acbp/database';
import { STOP_SCOPES, NOT_YET_ENFORCEABLE_STOP_SCOPES } from '@acbp/contracts';
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
  asRestricted,
  type TwoTenantWorld,
} from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { activateStop, clearStop, reviewHeldWork, readStopState } from './index.js';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };
const WORKER_ID = 'research';

describe.skipIf(!hasTestDatabase)('emergency-stop controller (real PostgreSQL, restricted role) — ACBP-P6-007/CDR-072', () => {
  let owner: DatabaseClient;
  let product: DatabaseClient;
  let w: TwoTenantWorld;
  /** Task ids in flight in company A1, created fresh per test. */
  let taskOne = '';
  let taskTwo = '';
  /** A `running` task-run for `taskOne`, stamped with `WORKER_ID`. */
  let runOne = '';

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

  const asOwner = () => ({ userId: w.aOwner, accountId: w.accountA, companyId: w.companyA1 });
  const at = () => new Date('2026-08-01T12:00:00.000Z');

  const auditRows = async (name: string) =>
    owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', name).orderBy('event_id').execute();
  const stopRows = async () => owner.kysely.selectFrom('emergency_stops').selectAll().orderBy('activated_at').execute();
  // ORDERED BY `id`, NOT `held_at`. Every row an activation writes lands in ONE transaction, so `now()` — and
  // therefore `held_at` — is IDENTICAL across them; ordering by it leaves the row order up to the planner. The
  // first version of this helper did exactly that and CI caught it: a test asserting on `[0]` after a review read a
  // different row than the one it had reviewed. That is the same unordered-read vacuity the review pass flagged
  // elsewhere, reappearing in the suite written to close it — which is why assertions below resolve BY ID.
  const heldRows = async () => owner.kysely.selectFrom('held_work').selectAll().orderBy('id').execute();
  const heldById = async (id: string) => (await heldRows()).find((h) => h.id === id);

  /** Create a task and drive it to a genuinely in-flight state through the real use cases. */
  async function inFlightTask(): Promise<string> {
    const created = await createTask(product, { ...asOwner(), title: 'Research prospects', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...asOwner(), taskId })).status).toBe('ok');
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    return taskId;
  }

  beforeEach(async () => {
    await truncateFixtures(owner);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);

    // A registered worker, so a `worker`-scoped stop has a real target to name (the service resolves against the
    // REGISTRY, not a run — a worker with no run yet is still a legitimate pre-emptive target).
    await sql`insert into worker_definitions
                (worker_id, version, capabilities, allowed_tools, input_schema_ref, output_schema_ref,
                 max_spend_micros, max_duration_ms, retry_categories, model_task_class, logging_redaction_class)
              values (${WORKER_ID}, 1, array['market_research']::text[], array['web_research']::text[], 'in', 'out',
                      1000000, 600000, array[]::text[], 'generation', 'standard')`.execute(owner.kysely);

    taskOne = await inFlightTask();
    taskTwo = await inFlightTask();

    // Start a run for taskOne and stamp WORKER_ID onto it, so the `worker` scope has something to catch.
    const started = await startRun(product, { ...asOwner(), taskId: taskOne, attempt: 1 });
    expect(started.status).toBe('ok');
    runOne = (started as { status: 'ok'; run: { id: string } }).run.id;
    await sql`insert into worker_runs (account_id, company_id, task_run_id, worker_id, worker_version, max_spend_micros, max_duration_ms)
              values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runOne}::uuid, ${WORKER_ID}, 1, 1000000, 600000)`.execute(owner.kysely);
  });

  // ── AUTHORIZATION ────────────────────────────────────────────────────────────────────────────────────────

  test('a VIEWER may not activate, clear or review — and no row is written by the attempt', async () => {
    const viewer = { userId: w.aViewer, accountId: w.accountA, companyId: w.companyA1 };
    expect(await activateStop(product, { ...viewer, scope: 'account_wide' })).toEqual({ status: 'forbidden' });
    expect(await clearStop(product, { ...viewer, stopId: '00000000-0000-4000-8000-00000000000a', at: at() })).toEqual({ status: 'forbidden' });
    expect(await reviewHeldWork(product, { ...viewer, heldWorkId: '00000000-0000-4000-8000-00000000000a', decision: 'confirmed', at: at() })).toEqual({
      status: 'forbidden',
    });
    expect(await stopRows()).toHaveLength(0);
    expect(await heldRows()).toHaveLength(0);
  });

  // ── REFUSALS, EACH BEFORE THE FIRST WRITE (§1-G8) ────────────────────────────────────────────────────────

  test.each([
    ['not a scope at all', { scope: 'everything' }, 'not_a_scope'],
    ['a non-string scope', { scope: 42 }, 'not_a_scope'],
    // Storable but inert: refused BY NAME rather than accepted and silently useless (§1-G10).
    ['an inert capability scope', { scope: 'capability', targetId: 'web_research' }, 'scope_not_enforceable'],
    ['an inert integration scope', { scope: 'integration', targetId: 'slack' }, 'scope_not_enforceable'],
    ['a task scope with no target', { scope: 'task' }, 'target_required'],
    ['a task scope with a blank target', { scope: 'task', targetId: '   ' }, 'target_required'],
    ['an account_wide scope carrying a target', { scope: 'account_wide', targetId: 'something' }, 'target_not_allowed'],
    ['a task target that does not exist', { scope: 'task', targetId: '00000000-0000-4000-8000-0000000000ff' }, 'target_not_found'],
    // The malformed-uuid case: shape-checked in JS, because a failed ::uuid cast would ABORT the transaction.
    ['a task target that is not even a uuid', { scope: 'task', targetId: 'not-a-uuid' }, 'target_not_found'],
    ['a worker target that is not registered', { scope: 'worker', targetId: 'ghost_worker' }, 'target_not_found'],
  ])('refuses %s with reason %s, writing nothing', async (_label, over, reason) => {
    const r = await activateStop(product, { ...asOwner(), ...(over as { scope: unknown; targetId?: string }) });
    expect(r).toEqual({ status: 'refused', reason });
    // THE HALF THAT MATTERS: a refusal that had already written would be a partially-stopped platform reporting
    // that it did not stop (§1-G8). Every refusal above must leave the store untouched.
    expect(await stopRows()).toHaveLength(0);
    expect(await heldRows()).toHaveLength(0);
    expect(await auditRows('emergency_stop.activated')).toHaveLength(0);
  });

  test('a company stop naming a SIBLING company is refused — active, visible and covering nothing is the §0 failure', async () => {
    const r = await activateStop(product, { ...asOwner(), scope: 'company', targetId: w.companyA2 });
    expect(r).toEqual({ status: 'refused', reason: 'target_must_be_own_company' });
    expect(await stopRows()).toHaveLength(0);
  });

  test("a task in ANOTHER company reads as absent, not as forbidden — the refusal is no existence oracle", async () => {
    const foreign = await createTask(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1, title: 'theirs', description: null, milestoneId: null });
    const foreignId = (foreign as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect(await activateStop(product, { ...asOwner(), scope: 'task', targetId: foreignId })).toEqual({ status: 'refused', reason: 'target_not_found' });
  });

  // ── THE UPSERT ITSELF — the statement that had never run ─────────────────────────────────────────────────

  test('a SECOND identical stop is refused `already_active` — the ON CONFLICT inference against the PARTIAL index works', async () => {
    // This is the assertion the whole suite was missing. `StopRepository.insert` targets a partial unique index by
    // INFERENCE with a `WHERE status = 'active'` predicate against an index declared `NULLS NOT DISTINCT`. If that
    // inference does not resolve, PostgreSQL raises 42P10 and EVERY activation dies — a control that cannot be
    // switched on. Nothing but a real database can tell us; a typed `already_active` here proves it resolves.
    expect((await activateStop(product, { ...asOwner(), scope: 'account_wide' })).status).toBe('ok');
    expect(await activateStop(product, { ...asOwner(), scope: 'account_wide' })).toEqual({ status: 'refused', reason: 'already_active' });
    expect(await stopRows()).toHaveLength(1);
  });

  test('clearing frees the shape: the same stop can be raised again afterwards', async () => {
    const first = await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const stopId = (first as { status: 'ok'; stopId: string }).stopId;
    expect((await clearStop(product, { ...asOwner(), stopId, at: at() })).status).toBe('ok');
    expect((await activateStop(product, { ...asOwner(), scope: 'account_wide' })).status).toBe('ok');
  });

  // ── WHAT THE STOP ACTUALLY CAUGHT, PER SCOPE ─────────────────────────────────────────────────────────────

  test('account_wide holds EVERY in-flight task in the company', async () => {
    const r = await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    expect(r).toMatchObject({ status: 'ok', heldCount: 2 });
    expect((await heldRows()).map((h) => h.task_id).sort()).toEqual([taskOne, taskTwo].sort());
  });

  test('a TASK stop holds EXACTLY its task — not every task in the company', async () => {
    // The defect an independent review found: the hold query ignored scope entirely, so this reported 2 while the
    // dispatcher refused calls for exactly 1. A review queue padded with work that was never stopped is one nobody
    // can finish honestly, and §1-G2 names over-halting as a defect in its own right.
    const r = await activateStop(product, { ...asOwner(), scope: 'task', targetId: taskOne });
    expect(r).toMatchObject({ status: 'ok', heldCount: 1 });
    expect((await heldRows()).map((h) => h.task_id)).toEqual([taskOne]);
  });

  test('a WORKER stop holds the tasks that worker is executing, and no others', async () => {
    const r = await activateStop(product, { ...asOwner(), scope: 'worker', targetId: WORKER_ID });
    expect(r).toMatchObject({ status: 'ok', heldCount: 1 });
    // `taskTwo` has no worker run, so it is not this worker's work and must not appear.
    expect((await heldRows()).map((h) => h.task_id)).toEqual([taskOne]);
  });

  test('external_actions_only holds NOTHING — it halts calls, not tasks', async () => {
    // Deliberate and documented: it refuses the subset of a task's calls that reach outside, while internal work
    // continues. Which in-flight tasks will later attempt an external call is unknowable at activation time, so
    // holding them all would assert a halt that did not happen. An empty queue is the honest record.
    const r = await activateStop(product, { ...asOwner(), scope: 'external_actions_only' });
    expect(r).toMatchObject({ status: 'ok', heldCount: 0 });
    expect(await heldRows()).toHaveLength(0);
  });

  // ── EVIDENCE: the stored payloads, not merely that an event fired ─────────────────────────────────────────

  test('emergency_stop.activated records WHICH scope, WHICH target and HOW MUCH it caught', async () => {
    await activateStop(product, { ...asOwner(), scope: 'task', targetId: taskOne });
    const events = await auditRows('emergency_stop.activated');
    expect(events).toHaveLength(1);
    expect(events[0]?.outcome).toBe('success'); // an owner action that SUCCEEDED; what gets blocked is each later call
    expect(events[0]?.payload).toMatchObject({ scope: 'task', target: taskOne, held_count: 1 });
  });

  test('emergency_stop.cleared records the scope and how much still awaits review', async () => {
    const a = await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const stopId = (a as { status: 'ok'; stopId: string }).stopId;
    const c = await clearStop(product, { ...asOwner(), stopId, at: at() });
    expect(c).toMatchObject({ status: 'ok', pendingReviewCount: 2 });
    const events = await auditRows('emergency_stop.cleared');
    expect(events[0]?.payload).toMatchObject({ scope: 'account_wide', pending_review_count: 2 });
  });

  test('a DISCARD is recorded exactly as loudly as a confirm, and the row is never deleted', async () => {
    await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const held = await heldRows();
    const heldWorkId = held[0]!.id;
    expect(await reviewHeldWork(product, { ...asOwner(), heldWorkId, decision: 'discarded', at: at() })).toEqual({ status: 'ok', heldWorkId });
    const after = (await heldRows()).find((h) => h.id === heldWorkId);
    expect(after).toMatchObject({ status: 'discarded', reviewed_by_user_id: w.aOwner });
    expect(await auditRows('emergency_stop.work_reviewed')).toHaveLength(1);
    expect((await auditRows('emergency_stop.work_reviewed'))[0]?.payload).toMatchObject({ decision: 'discarded', held_work_id: heldWorkId });
  });

  test('reviewing the same item twice is refused — a decision is not replaceable', async () => {
    await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const heldWorkId = (await heldRows())[0]!.id;
    expect((await reviewHeldWork(product, { ...asOwner(), heldWorkId, decision: 'confirmed', at: at() })).status).toBe('ok');
    expect(await reviewHeldWork(product, { ...asOwner(), heldWorkId, decision: 'discarded', at: at() })).toEqual({
      status: 'refused',
      reason: 'already_reviewed',
    });
    // The FIRST decision stands: silently overwriting it would make ADMIN-002's review no decision at all.
    // Resolved BY ID — an `account_wide` stop holds several items and they share a `held_at`, so positional access
    // would assert against whichever row the planner returned first.
    expect(await heldById(heldWorkId)).toMatchObject({ status: 'confirmed' });
    // ...and the item NOT reviewed is untouched, so "already_reviewed" is about this item and not a global latch.
    const untouched = (await heldRows()).filter((h) => h.id !== heldWorkId);
    expect(untouched).toHaveLength(1);
    expect(untouched[0]).toMatchObject({ status: 'held', reviewed_at: null });
  });

  test('clearing an unknown or already-cleared stop is refused, not thrown', async () => {
    expect(await clearStop(product, { ...asOwner(), stopId: '00000000-0000-4000-8000-0000000000ff', at: at() })).toEqual({
      status: 'refused',
      reason: 'not_found',
    });
    const a = await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const stopId = (a as { status: 'ok'; stopId: string }).stopId;
    expect((await clearStop(product, { ...asOwner(), stopId, at: at() })).status).toBe('ok');
    expect(await clearStop(product, { ...asOwner(), stopId, at: at() })).toEqual({ status: 'refused', reason: 'not_active' });
  });

  // ── §1-G8: NO PARTIALLY-STOPPED PLATFORM ─────────────────────────────────────────────────────────────────

  test('a failure AFTER the first write rolls everything back — no partial stop survives', async () => {
    // CDR-072 §1-G8 promised this proof in the past tense and no such test existed. The audit writer is the
    // natural failure point: it runs LAST, after the stop row and every held-work row. If the transaction did not
    // roll back, the platform would be genuinely halted while the caller was told it was not — belief and state
    // disagreeing in the direction nobody checks.
    const boom = () => {
      throw new Error('audit sink unavailable');
    };
    await expect(activateStop(product, { ...asOwner(), scope: 'account_wide' }, { auditWriter: boom })).rejects.toThrow();
    expect(await stopRows()).toHaveLength(0);
    expect(await heldRows()).toHaveLength(0);
    expect(await auditRows('emergency_stop.activated')).toHaveLength(0);
  });

  // ── THE READ MODEL: seven named, five enforceable, and the split is visible ───────────────────────────────

  test('readStopState names all seven scopes and marks the two inert ones with a reason', async () => {
    const state = await readStopState(product, asOwner());
    expect(state.status).toBe('ok');
    const scopes = (state as { status: 'ok'; scopes: readonly { scope: string; enforceable: boolean; unavailableReason?: string }[] }).scopes;
    expect(scopes.map((s) => s.scope)).toEqual([...STOP_SCOPES]);
    const inert = scopes.filter((s) => !s.enforceable);
    expect(inert.map((s) => s.scope).sort()).toEqual([...NOT_YET_ENFORCEABLE_STOP_SCOPES].sort());
    // NOT decoration: an operator reading a scope list must be able to tell which entries do nothing, or the list
    // itself becomes the §0 failure — seven names implying seven working controls.
    for (const s of inert) expect(s.unavailableReason ?? '').not.toBe('');
  });

  test('the read model surfaces the ACTIVE stops, so an operator can see what is in force', async () => {
    await activateStop(product, { ...asOwner(), scope: 'task', targetId: taskOne });
    const state = await readStopState(product, asOwner());
    const active = (state as { status: 'ok'; activeStops: readonly { scope: string; targetId: string | null }[] }).activeStops;
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ scope: 'task', targetId: taskOne });
  });

  // ── LAUNCH GATE 8, MEASURED THROUGH THE PRODUCT PATH ─────────────────────────────────────────────────────

  test('LAUNCH GATE 8 — activateStop itself commits within the bound, MEASURED', async () => {
    // THE EARLIER MEASUREMENT TIMED THE WRONG THING and an independent review caught it: it wrapped a single raw
    // superuser INSERT, while `activateStop` does the stop insert, a scoped task scan, one insert per caught task
    // and an audit write — and the stop is invisible to every dispatcher until that whole transaction COMMITS,
    // which is precisely the property §1-G4 relies on. N+3 round trips, not one.
    //
    // This times the real call, with real in-flight work to hold, so the number covers the path an operator
    // actually takes. It is still a SINGLE-COMPANY, small-N measurement on one host — it does not bound a company
    // with thousands of in-flight tasks, and it is not a claim about a distributed fleet (P7 infrastructure's).
    const startedAt = performance.now();
    const r = await activateStop(product, { ...asOwner(), scope: 'account_wide' });
    const elapsedMs = performance.now() - startedAt;
    expect(r).toMatchObject({ status: 'ok', heldCount: 2 });
    console.info(`[ACBP-P6-007] gate 8 / activateStop (account_wide, ${2} tasks held): committed in ${elapsedMs.toFixed(1)}ms (bound 5000ms)`);
    expect(elapsedMs).toBeLessThan(5_000);
  });
});
