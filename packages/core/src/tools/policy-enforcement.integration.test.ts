// ACBP-P6-002 / CDR-067 — real-PostgreSQL proof that the POLICY ENGINE gates tool calls, through the restricted role.
//
// `dispatcher.integration.test.ts` proves the chokepoint's Phase 5 acceptance (allowlist, recording, fail-closed).
// THIS suite proves the Phase 6 clause: that the engine's own answer decides, that the decision is recorded against
// the policy VERSION that produced it, and that the two can never disagree — including across a supersession that
// commits while a dispatch is in flight.
//
// Skips when ACBP_TEST_DATABASE_URL is unset — a skipped run is never green; hosted CI on the exact SHA is evidence.
import { describe, test, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { sql } from 'kysely';
import { type DatabaseClient } from '@acbp/database';
import { hasTestDatabase, createOwnerFixtureClient, createRestrictedProductClient, enableAppLogin, resetSchema, truncateFixtures, seedTwoTenantWorld, teardown, assertRestrictedRole, asRestricted, type TwoTenantWorld } from '@acbp/test-support';
import { provisionPersonalAccount } from '../accounts/provisioning.js';
import { createCompany } from '../company/company-service.js';
import { pauseCompany } from '../company/company-lifecycle.js';
import { createTask, planTask } from '../tasks/index.js';
import { startRun } from '../runs/index.js';
import { initializeCompanyPolicy } from '../policy/index.js';
import { computePayloadBinding } from '../approvals/binding.js';
import { dispatchToolCall } from './index.js';
import { TaskRepository } from '@acbp/database';

const SEED_OPS = { provisionPersonalAccount, createCompany, pauseCompany };

/** A rule that fires on EVERY call, whatever the class — `informational` is the floor of the ordered set. */
const alwaysRule = (id: string, decision: 'deny' | 'require_approval') =>
  JSON.stringify([{ id, dimension: 'risk_class', condition: 'risk_at_least', operand: 'informational', decision }]);

describe.skipIf(!hasTestDatabase)('policy enforcement at the dispatcher (real PostgreSQL) — ACBP-P6-002/CDR-067', () => {
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
  const allowAll = ['web_research', 'memory_write', 'send_email'];

  /**
   * PARAMS AND OPTIONS ARE DIFFERENT ARGUMENTS, and keeping them separate here is not cosmetic: `gates` and
   * `auditWriter` are OPTIONS, and folding them into params silently dropped them — three tests failed with the
   * dispatcher's default behaviour and looked like product defects until the argument split was fixed.
   */
  const dispatch = (params: Record<string, unknown> = {}, options: Parameters<typeof dispatchToolCall>[2] = {}) =>
    dispatchToolCall(product, { ...base(), runId, toolId: 'web_research', args: {}, allowlist: allowAll, context: [], ...params }, options);

  /**
   * The row at `index`, or a LOUD failure. The `rows[0]?.field` idiom used elsewhere in this package is fine when the
   * expected value is a literal, but this suite compares two ids to each other — and `undefined === undefined` would
   * pass while proving nothing. Two rows that are both missing must not read as two rows that match.
   */
  function row<T>(rows: readonly T[], index = 0): T {
    const found = rows[index];
    if (found === undefined) throw new Error(`expected a row at index ${index}, got ${rows.length} row(s)`);
    return found;
  }

  /** SQLSTATE by walking the cause chain — the driver nests the real code, so a shallow `.code` matches nothing. */
  const sqlStateOf = (p: Promise<unknown>): Promise<string> =>
    p.then(() => 'no-error').catch((e: unknown) => {
      for (let cur: unknown = e, hops = 0; cur !== null && cur !== undefined && hops < 5; hops += 1) {
        const node = cur as { code?: unknown; cause?: unknown };
        if (typeof node.code === 'string' && /^[0-9A-Z]{5}$/.test(node.code)) return node.code;
        cur = node.cause;
      }
      return /sqlstate=([0-9A-Z]{5})/.exec(String(e))?.[1] ?? 'unknown';
    });

  const evaluations = async () => owner.kysely.selectFrom('policy_evaluations').selectAll().orderBy('created_at').execute();
  const callRows = async () => owner.kysely.selectFrom('tool_calls').selectAll().orderBy('created_at').execute();


  /**
   * Seed a REAL human decision for (run, tool) — the only way to satisfy the approval gate now that the caller-
   * injectable port is gone (CDR-068 §0.1). Inserted as the OWNER, because the product role has no business
   * writing approvals outside the service.
   */
  /**
   * A PENDING request with a real binding and no decision — the state a human has not answered yet.
   *
   * Split out of `seedDecision` for review pass 2's F5: `findConsumableForCall` is narrowed to `status='decided'`,
   * and the other side of that filter needs its own test. A question nobody has answered must not read as an answer.
   */
  async function seedRequestOnly(toolId: string): Promise<string> {
    const policy = await owner.kysely
      .selectFrom('policies')
      .select(['id', 'version'])
      .where('company_id', '=', w.companyA1)
      .where('status', '=', 'active')
      .executeTakeFirstOrThrow();
    return (
      await sql<{ id: string }>`insert into approval_requests
             (account_id, company_id, run_id, tool_id, tool_version, action, reason, expected_result, data,
              estimated_cost_credits, risk_class, reversibility, preview, scope, policy_id, policy_version,
              payload_hash, binding_version, expires_at)
           values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runId}::uuid, ${toolId}, 1, 'fixture action',
                   'fixture reason', 'fixture result', '{}'::jsonb, 1, 'external_reversible', 'reversible',
                   'fixture preview', 'one_action', ${policy.id}::uuid, ${policy.version},
                   ${computePayloadBinding({ toolId, toolVersion: 1, payload: {}, costBoundCredits: 1 }).hash}, 1, now() + interval '30 days')
           returning id`.execute(owner.kysely)
    ).rows[0]!.id;
  }

  /**
   * `bind` OVERRIDES WHAT THE APPROVAL IS BOUND TO, and the stored `data` follows it (review pass 2, F1/F4).
   *
   * Two things needed this. (a) Every dispatcher-level approval in the repo bound `payload: {}`, so no test could
   * tell "refuses a modified payload" from "only ever authorizes the empty payload". (b) Proving the TOOL is a
   * bound element needs an approval that the tool-scoping FINDS but the hash REJECTS — which is only expressible
   * by binding one tool's hash onto another tool's request.
   */
  async function seedDecision(
    toolId: string,
    path: 'approve' | 'reject' | 'schedule' | 'edit_then_approve' = 'approve',
    effectiveFrom?: Date,
    bind?: { toolId: string; toolVersion: number; payload: unknown; costBoundCredits: number },
  ): Promise<void> {
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
                   'fixture reason', 'fixture result', ${JSON.stringify(bind?.payload ?? {})}::jsonb, 1, 'external_reversible', 'reversible',
                   'fixture preview', 'one_action', ${policy.id}::uuid, ${policy.version},
                   ${computePayloadBinding(bind ?? { toolId, toolVersion: 1, payload: {}, costBoundCredits: 1 }).hash}, 1, now() + interval '30 days')
           returning id`.execute(owner.kysely)
    ).rows[0]!;
    await sql`insert into approval_decisions
            (account_id, company_id, request_id, path, decider_type, decided_by_user_id, decided_at, reason, effective_from,
             edited_data)
          values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${request.id}::uuid, ${path}, 'human', ${w.aOwner}::uuid, now(),
                  ${path === 'reject' ? 'not now' : null}, ${effectiveFrom ?? null},
                  ${path === 'edit_then_approve' ? '{"recipients":1}' : null}::jsonb)`.execute(owner.kysely);
    await sql`update approval_requests set status = 'decided', decided_at = now() where id = ${request.id}::uuid`.execute(owner.kysely);
  }

  /** Add a rule to the active policy AS THE OWNER — rule editing is P6-010's product surface, not this ticket's. */
  const addRule = (rule: string) =>
    sql`update policies set rules = rules || ${rule}::jsonb where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(owner.kysely);

  beforeEach(async () => {
    await truncateFixtures(owner);
    await sql`delete from tool_definitions`.execute(owner.kysely);
    w = await seedTwoTenantWorld(owner, product, SEED_OPS);

    const created = await createTask(product, { ...base(), title: 'Research five prospects', description: null, milestoneId: null });
    const taskId = (created as { status: 'ok'; task: { taskId: string } }).task.taskId;
    expect((await planTask(product, { ...base(), taskId })).status).toBe('ok');
    await asRestricted(product, { account: w.accountA, company: w.companyA1 }, (db) => new TaskRepository(db).updateState(taskId, 'planned', 'queued'));
    const started = await startRun(product, { ...base(), taskId, attempt: 1 });
    expect(started.status).toBe('ok');
    runId = (started as { status: 'ok'; run: { id: string } }).run.id;

    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('web_research', 1, 'informational', 'fixture tool', 'active'),
                     ('memory_write', 1, 'internal_reversible', 'fixture tool', 'active'),
                     ('send_email', 1, 'external_reversible', 'fixture tool', 'active')`.execute(owner.kysely);

    expect((await initializeCompanyPolicy(product, base())).status).toBe('ok');
  });

  // ───────────────────────────── THE DECISION IS RECORDED AGAINST ITS OWN VERSION ─────────────────────────────

  test('an authorized call cites the evaluation that authorized it, pinned to the policy version in force', async () => {
    const r = await dispatch();
    expect(r.status).toBe('authorized');

    // No `expect(evaluation).toBeDefined()` — `row()` has already thrown if it is not, so the assertion could not
    // fail and review pass 2 was right to call it noise.
    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('allow');
    expect(Number(evaluation.policy_version)).toBe(1);
    expect(evaluation.evaluation_point).toBe('pre_execution');

    // THE LINK, in the direction CDR-067 §2-G3 chose: the call names its evaluation. A call whose evaluation cannot
    // be found is a call whose authorization cannot be explained.
    const call = row(await callRows());
    expect(call.policy_eval_id).toBe(evaluation.id);
  });

  test('the evaluation happens even when the call is refused on some OTHER ground (G4)', async () => {
    // Not allowlisted: the allowlist refuses before policy is consulted in the ORDER of the decision, but the
    // evaluation is still performed and recorded, because "all checks audited" means the policy consultation is
    // evidence in its own right.
    const r = await dispatch({ allowlist: ['memory_write'] });
    expect(r).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });
    expect(await evaluations()).toHaveLength(1);
    const call = row(await callRows());
    expect(call.outcome).toBe('denied');
    expect(call.policy_eval_id).not.toBeNull();
  });

  // ─────────────────────────────────── POLICY DECIDES WHETHER APPROVAL IS NEEDED ───────────────────────────────

  test('a real REQUIRE_APPROVAL rule refuses a call with no approval, and the recorded decision says so', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));

    const refused = await dispatch();
    expect(refused).toMatchObject({ status: 'denied', reason: 'approval_required' });

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('require_approval');
    // THE DECISION IS RECORDED, NOT THE OUTCOME. The engine required an approval; whether one turned up is the
    // dispatcher's business, and conflating the two would destroy the ability to ask "what did policy say?".
    expect(evaluation.fired_rule_ids).toContain('needs-approval');
  });

  test('the SAME rule authorizes once an approval answers — policy demanded it, the approval satisfied it', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));

    await seedDecision('web_research');
    const ok = await dispatch();
    expect(ok.status).toBe('authorized');

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('require_approval');
  });

  test('a REJECTING approval refuses even when policy only required one — and it is not the policy that refused', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research', 'reject');
    const r = await dispatch();
    expect(r).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
  });

  /**
   * MUTATION-DRIVEN (P6-003c). Mutating `approvalAnswer` to treat `schedule` as instantly authorizing SURVIVED the
   * whole suite: three of the four branches were pinned, the clock was not. A scheduled approval says "do this LATER",
   * and acting on it now is exactly the "already done while I deferred it" failure the deferral exists to prevent —
   * the one direction Phase 6's highest bar says to get wrong safely. So the clock gets its own test, both sides.
   */
  test('a SCHEDULED approval does not authorize before its instant — and does at it', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    const effectiveFrom = new Date('2026-08-01T09:00:00.000Z');
    await seedDecision('web_research', 'schedule', effectiveFrom);

    // BEFORE. Refused as `approval_invalid`, and this expectation was DELIBERATELY REVERSED after review pass 2.
    // It read `approval_required` on the reasoning that "not yet due" is not "malformed" — good prose, wrong gate
    // answer: `approval_required` comes from the `unavailable` branch, which refuses only when policy demanded an
    // approval, so an informational call riding the no-gate waiver executed the deferred action immediately.
    // A present-but-non-authorizing decision now always denies, and the reason granularity is the price.
    const early = await dispatch({}, { now: new Date(effectiveFrom.getTime() - 1000) });
    expect(early).toMatchObject({ status: 'denied', reason: 'approval_invalid' });

    // AT the instant — the boundary itself, not a second past it, because `>=` and `>` differ exactly here.
    expect((await dispatch({}, { now: effectiveFrom })).status).toBe('authorized');
  });

  /**
   * REVIEW PASS 2, H1 — the finding that a DEFERRAL was only honoured when policy happened to demand an approval.
   *
   * There is deliberately NO `require_approval` rule here. `web_research` is informational, so it rides the
   * no-gate waiver, and the baseline policy allows it. A human nonetheless said "not yet". Mapping that deferral to
   * `unavailable` made it indistinguishable from "nobody has answered", and an answer nobody was REQUIRED to give
   * was waived straight through — the deferred action executed immediately.
   *
   * The rule this pins: a decision that EXISTS and does not authorize must never read as a decision that is ABSENT.
   */
  test('a DEFERRED decision refuses even when policy never demanded an approval', async () => {
    const effectiveFrom = new Date('2026-08-01T09:00:00.000Z');
    await seedDecision('web_research', 'schedule', effectiveFrom);

    const early = await dispatch({}, { now: new Date(effectiveFrom.getTime() - 1000) });
    expect(early.status).toBe('denied');

    // …and the same call still proceeds once the instant arrives, so this is a deferral and not a block.
    expect((await dispatch({}, { now: effectiveFrom })).status).toBe('authorized');
  });

  /**
   * REVIEW PASS 2, H2 — `edit_then_approve` authorized the ORIGINAL payload. The human refused what was proposed and
   * offered a substitute; nothing reads `edited_data`, so the gate saw "an approval exists" and ran the payload that
   * was edited away. Until P6-004 carries the edited payload through, an edit authorizes NOTHING on the old request —
   * the superseding request has to be approved on its own merits.
   */
  test('an EDIT_THEN_APPROVE never authorizes the payload it edited away', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research', 'edit_then_approve');
    expect((await dispatch()).status).toBe('denied');
  });

  // ══════════ ACBP-P6-004 / CDR-069 — BINDING AND SINGLE-USE, AT THE DISPATCHER ══════════
  //
  // Review pass 2 measured five surviving mutations here and named the gap exactly: the primitives are well tested
  // in isolation, but APPR-004 ("bound to these bytes") and APPR-009 ("single-use") are claimed *enforced at the
  // tool dispatcher* and nothing at the dispatcher proved either. `spend = false`, hashing a constant instead of
  // the real arguments, dropping the usability half of the gate, deleting the `approval.consumed` audit, and
  // deleting the lost-race correction ALL left the suite green.

  const requestRows = async () => owner.kysely.selectFrom('approval_requests').selectAll().orderBy('created_at').execute();

  test('an authorized call SPENDS its approval — and the next identical call is refused (APPR-009)', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research');

    const first = await dispatch();
    expect(first.status).toBe('authorized');

    const spent = row(await requestRows());
    expect(spent.status).toBe('consumed');
    // The approval names the call that spent it — "what did this authorize?" answered by the row, not by a join.
    expect(spent.consumed_by_call_id).toBe((first as { call: { id: string } }).call.id);
    const consumedEvents = await owner.kysely.selectFrom('audit_events').selectAll().where('name', '=', 'approval.consumed').execute();
    expect(consumedEvents).toHaveLength(1);

    // SINGLE-USE. The approval is gone, policy still demands one, so the second call is refused for the honest
    // reason: none stands against it. Not `approval_invalid` — a spent approval is absent, not a refusal.
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'approval_required' });
  });

  test('a MISMATCHED PAYLOAD is refused, and does NOT burn the approval (APPR-004)', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research');

    // The approval was bound to `{}`. These are different bytes, so it authorizes nothing.
    expect(await dispatch({ args: { to: 'attacker@example.test' } })).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
    expect(row(await requestRows()).status).toBe('decided');

    // …and the human's actual approval still works, which is what makes the refusal a mismatch rather than a loss.
    expect((await dispatch()).status).toBe('authorized');
  });

  /**
   * REVIEW PASS 1, #2 — the binding element that did nothing.
   *
   * The expected hash was recomputed with `standing.tool_version`, read from the very row it is compared against,
   * so the tool VERSION could never mismatch. A human approves `web_research` while v1 is active, an active v2
   * lands, and v2 runs under v1's approval — while `APPROVAL-AND-POLICY §2` and CDR-069 §1-G1 both name tool
   * version as bound. The version now comes from the registry, which is the version the call will actually execute.
   */
  test('a NEW ACTIVE TOOL VERSION invalidates an approval bound to the old one', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research');
    // The approval is live and would authorize — proven by the sibling tests — until the registry moves.
    await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
              values ('web_research', 2, 'informational', 'fixture tool v2', 'active')`.execute(owner.kysely);

    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
    // The approval is NOT burned: a human can still be asked about v2, and the v1 record stands unspent.
    expect(row(await requestRows()).status).toBe('decided');
  });

  test('a REVOKED approval refuses a call that policy demanded one for', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedDecision('web_research');
    await sql`update approval_requests set status='revoked', revoked_at=now(), revoked_by_user_id=${w.aOwner}::uuid`.execute(owner.kysely);

    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'approval_required' });
  });

  /**
   * REVIEW PASS 2, F2 — the permanent denial of service I introduced, and the reason the read is narrow.
   *
   * `findConsumableForCall` once matched `decided | consumed | revoked`, so a spent approval stood against its
   * `(run, tool)` FOREVER: the gate read it as an explicit refusal and denied every later call — including calls
   * the company's own policy allows outright and which never needed an approval at all. A terminal approval is
   * ABSENT, not refusing.
   */
  test('a SPENT approval does not poison the tool: a call policy allows outright still proceeds', async () => {
    // No `require_approval` rule. `web_research` is informational and the baseline policy allows it, so this call
    // needs no approval — but one exists, is spent by the first dispatch, and must not block anything afterwards.
    await seedDecision('web_research');
    expect((await dispatch()).status).toBe('authorized');
    expect(row(await requestRows()).status).toBe('consumed');

    expect((await dispatch()).status).toBe('authorized');
    expect((await dispatch()).status).toBe('authorized');
  });

  test('a REVOKED approval does not poison the tool either — revocation withdraws an approval, it does not ban the action', async () => {
    await seedDecision('web_research');
    await sql`update approval_requests set status='revoked', revoked_at=now(), revoked_by_user_id=${w.aOwner}::uuid`.execute(owner.kysely);
    // Policy allows this call outright, so the withdrawn approval is simply not needed.
    expect((await dispatch()).status).toBe('authorized');
  });

  /**
   * REVIEW PASS 2, F5 — `findConsumableForCall`'s status filter, from the other side. A merely PENDING request must
   * not stand against a call: it is a question nobody has answered, not an answer.
   */
  test('a PENDING request is not a refusal — the reason is `approval_required`, not `approval_invalid`', async () => {
    await addRule(alwaysRule('needs-approval', 'require_approval'));
    await seedRequestOnly('web_research');
    expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'approval_required' });
  });

  // ══════════ ACBP-P6-005 / CDR-070 — LAUNCH GATE 4, trust-critical #6 ══════════
  //
  // `TEST-AND-VERIFICATION-STRATEGY.md` §Trust-critical, item 6, verbatim: *"Editing a material approved payload
  // invalidates approval."* M6's user-visible criterion is *"modified approved payload requires reapproval"*.
  //
  // ONE CASE PER BOUND ELEMENT, not one case for "a change". `APPROVAL-AND-POLICY-ARCHITECTURE §2`'s
  // material-change rule names payload, tool, destination and cost bound; P6-004 binds three of those plus the
  // tool VERSION, and destination has no representation yet so it travels inside the payload. A single
  // changed-payload test would pass while three of the four did nothing — which is not hypothetical: P6-004's
  // review found the tool-version component inert precisely because no test varied it.
  //
  // EVERY CASE ENDS AT THE DISPATCHER. `bindingMatches` returning false is a unit fact; gate 4's claim is that the
  // modified action DOES NOT RUN.
  //
  // ── HONEST NOTE ON WHAT THIS BLOCK CAN AND CANNOT MEASURE (review pass 2, F2) ───────────────────────────────
  //
  // The dispatcher enforces the binding TWICE: the usability pre-check, and the atomic conditional UPDATE in
  // `verifyAndConsume`. Measured, EITHER can be neutralised alone with every case here still green — they mutually
  // mask, and only mutating BOTH turns this block red. That is defence in depth working, not a hole, but it means
  // these cases cannot tell you WHICH layer refused.
  //
  // So the layers are pinned where they can be pinned individually, and this block does not pretend otherwise:
  //   - the UPDATE's predicates (`payload_hash`, `binding_version`, status, revocation, expiry) — pinned in
  //     `packages/database/src/integration/approvals.integration.test.ts`, one mutation each;
  //   - `bindingMatches` / `approvalUsability` — pinned in `packages/contracts/src/approvals/binding.test.ts`;
  //   - `bindingMaterial`'s four components — pinned there too, AND here, at the dispatcher, because a component
  //     that is inert end-to-end is the defect this whole ticket exists to catch.
  //
  // The first version of this block killed NOTHING its siblings had not already killed, and one case passed for a
  // reason unrelated to its name. Both are fixed below; this note exists so the next person does not have to
  // re-measure to find out.
  describe('gate 4 — a material edit invalidates the approval', () => {
    beforeEach(async () => {
      await addRule(alwaysRule('needs-approval', 'require_approval'));
      await seedDecision('web_research');
    });

    /** THE CONTROL. Without it, a suite that refused everything would pass every negative below. */
    test('the UNCHANGED action still runs — the suite is not simply refusing everything', async () => {
      expect((await dispatch()).status).toBe('authorized');
    });

    /**
     * THE STRONGER CONTROL, and M6's other half (review pass 2, F4).
     *
     * Every dispatcher-level approval in this repo bound `payload: {}`, so nothing distinguished "refuses a
     * modified payload" from "only ever authorizes the EMPTY payload" — a suite that authorized `{}` and refused
     * everything else would have passed the whole block.
     *
     * M6's user-visible criterion is *"modified approved payload requires REAPPROVAL"*, which is two claims. The
     * negatives below prove the refusal. This proves the other one: an approval bound to a NON-EMPTY payload
     * authorizes exactly that payload, and refuses its neighbour.
     */
    test('an approval bound to a NON-EMPTY payload authorizes that payload — and only that one', async () => {
      await seedDecision('memory_write', 'approve', undefined, { toolId: 'memory_write', toolVersion: 1, payload: { q: 'alpha' }, costBoundCredits: 1 });

      // The neighbour differs by one character and is refused BY THE BINDING.
      expect(await dispatch({ toolId: 'memory_write', args: { q: 'beta' } })).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
      // …and the approved payload runs, so the refusal above is about the bytes, not about the tool.
      expect((await dispatch({ toolId: 'memory_write', args: { q: 'alpha' } })).status).toBe('authorized');
    });

    // THE REASON IS PINNED PER CASE (review pass 2, F1). Without it, "denied" hides WHICH mechanism refused —
    // and one case in this block was passing for a completely different reason than its name claimed.
    test.each([
      ['the PAYLOAD gains a field', { args: { to: 'someone@example.test' } }],
      ['the PAYLOAD changes a value', { args: { q: 'different' } }],
    ])('%s → refused as approval_invalid, and the approval is NOT burned', async (_what, over) => {
      expect(await dispatch(over)).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
      // NOT CONSUMED. A refusal that burned the approval would deny the modified call and the legitimate one
      // alike — the human would have to re-approve because someone else tampered, which is a denial of service
      // wearing a security control's clothes.
      expect(row(await requestRows()).status).toBe('decided');
      // …proven by the legitimate call still working afterwards.
      expect((await dispatch()).status).toBe('authorized');
    });

    /**
     * THE TOOL, PROVEN AT THE BINDING (review pass 2, F1 — this case was rewritten).
     *
     * It used to dispatch a DIFFERENT tool against an approval seeded for `web_research`, and it passed —
     * with `approval_required`, because `findConsumableForCall` scopes by tool, found nothing, and never computed
     * a hash at all. Measured consequence: deleting the `tool=` component from `bindingMaterial` left the entire
     * policy-enforcement file green. The case proved SCOPING and was labelled as proving the binding.
     *
     * So this seeds a DECIDED approval for `send_email` whose stored hash was computed for `web_research`. The
     * scoping now finds it, the binding is the only thing left to refuse it, and the refusal is `approval_invalid`.
     */
    test('the TOOL is a bound element — an approval hashed for another tool is refused BY THE BINDING', async () => {
      await seedDecision('send_email', 'approve', undefined, { toolId: 'web_research', toolVersion: 1, payload: {}, costBoundCredits: 1 });
      expect(await dispatch({ toolId: 'send_email' })).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
    });

    test('the TOOL VERSION moves → refused (the element P6-004 shipped inert)', async () => {
      await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
                values ('web_research', 2, 'informational', 'fixture tool v2', 'active')`.execute(owner.kysely);
      expect(await dispatch()).toMatchObject({ status: 'denied', reason: 'approval_invalid' });
      expect(row(await requestRows()).status).toBe('decided');
    });

    // THE COST BOUND IS NOT ASSERTED HERE, and that is deliberate (review pass 2, F8).
    //
    // It was — as a pure, database-free hash comparison sitting inside this `describe.skipIf(!hasTestDatabase)`
    // block, paying for a full two-tenant seed to compare two strings, and silently not running at all on a machine
    // without PostgreSQL. By this repo's own "skipped ≠ green" rule that is the wrong home for it, and an identical
    // assertion already lives in `packages/contracts/src/approvals/binding.test.ts`.
    //
    // The limit itself is real and recorded in CDR-069 §3: `dispatchToolCall` has NO cost input, so it recomputes
    // the hash with the request's own stored bound and cannot detect cost drift. Canon's "execution exceeding bound
    // limit fails closed" is the worker runtime's check at execution (P5-005). The binding covers cost, so the hash
    // is ready for that check the day a preflight cost exists — but no case in this block can prove it, and one
    // pretending to would be exactly the overclaim this ticket was written to find.
  });

  test('an approval CANNOT override a policy DENY (POL-005), and the reason names policy', async () => {
    await addRule(alwaysRule('forbidden', 'deny'));
    await seedDecision('web_research');
    const r = await dispatch();
    expect(r).toMatchObject({ status: 'denied', reason: 'policy_denied' });

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('deny');
  });

  // ──────────────────────────────────────── THE SUPERSESSION RACE ─────────────────────────────────────────────

  test('a supersession that commits WHILE a dispatch is in flight cannot make the record disagree with the decision', async () => {
    // THE WINDOW THIS CLOSES. The dispatcher reads the active policy, decides, and records — three steps with a
    // policy edit possible between any two of them. The dangerous outcome is not "the call used the old version";
    // that is unavoidable and correct under snapshot semantics. The dangerous outcome is a call AUTHORIZED under one
    // version while the record cites another, because then no reader can ever establish what actually permitted it.
    //
    // The interleaving is made deterministic with a held-open owner transaction rather than timing: the supersession
    // is issued and left UNCOMMITTED, the dispatch runs to completion against the snapshot it can see, and only then
    // does the supersession commit.
    let release!: () => void;
    let ready!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const isReady = new Promise<void>((resolve) => {
      ready = resolve;
    });

    const superseding = owner.kysely.transaction().execute(async (tx) => {
      await sql`update policies set status = 'superseded', superseded_at = now()
                where company_id = ${w.companyA1}::uuid and status = 'active'`.execute(tx);
      // `autonomy_level` carried forward from the row being superseded (ACBP-P6-006): a supersession changes the
      // RULES, not the company's autonomy, and re-deriving it here would make this fixture disagree with the level
      // the company actually has.
      await sql`insert into policies (account_id, company_id, version, baseline, rules, autonomy_level, status, created_by_user_id)
                select account_id, company_id, version + 1, 'allow', ${alwaysRule('forbidden-v2', 'deny')}::jsonb, autonomy_level, 'active', created_by_user_id
                from policies where company_id = ${w.companyA1}::uuid and status = 'superseded'`.execute(tx);
      ready();
      await released;
    });
    await isReady;

    // IN FLIGHT: the supersession exists but has not committed, so this dispatch sees version 1 and is authorized.
    //
    // `finally`, so a THROWN dispatch cannot leak the open transaction. Without it a failure here would leave the
    // owner transaction holding a row lock on `policies` for the rest of the file, and the next test's
    // `truncateFixtures` would block rather than fail — a hung CI run instead of a red one.
    let during;
    try {
      during = await dispatch();
    } finally {
      release();
      await superseding;
    }
    expect(during.status).toBe('authorized');

    // The authorized call's evaluation pins the version that authorized it — 1, not the 2 that is now in force.
    const afterFirst = await evaluations();
    expect(afterFirst).toHaveLength(1);
    expect(Number(row(afterFirst).policy_version)).toBe(1);
    expect(row(afterFirst).decision).toBe('allow');
    const firstCall = row(await callRows());
    expect(firstCall.policy_eval_id).toBe(row(afterFirst).id);

    // AND THE WINDOW IS SHUT: the very next call sees version 2 and is refused by it.
    const after = await dispatch();
    expect(after).toMatchObject({ status: 'denied', reason: 'policy_denied' });

    const both = await evaluations();
    expect(both).toHaveLength(2);
    expect(Number(row(both, 1).policy_version)).toBe(2);
    expect(row(both, 1).decision).toBe('deny');
    // NO CROSS-WIRING: each call cites its own evaluation, and the versions differ. This is the assertion that would
    // fail if the dispatcher ever re-read the policy after deciding, or cached an evaluation across calls.
    const calls = await callRows();
    expect(row(calls, 1).policy_eval_id).toBe(row(both, 1).id);
    expect(row(calls).policy_eval_id).not.toBe(row(calls, 1).policy_eval_id);
  });

  test('a rule on a dimension the dispatcher does NOT observe refuses the call — it does not silently pass', async () => {
    // RAISED BY REVIEW PASS 2, and it corrected a claim in CDR-067 §1. The dispatcher supplies exactly ONE
    // observation, `risk_class`. A rule on any other dimension has nothing to read, is UNEVALUABLE, and by
    // CDR-066 §3-G9 contributes `deny` — so a company that configured a spend cap would have every tool call
    // REFUSED rather than approval-gated. That is the fail-closed direction and therefore not a hole, but §1 had
    // described it as "limit … wired here", which claimed a capability that does not exist. This test is what makes
    // the real behaviour a fact rather than a paragraph, and it will fail the day an observation for this dimension
    // is supplied — which is the correct moment to revisit §1.
    await addRule(JSON.stringify([{ id: 'spend-cap', dimension: 'spending_limit', condition: 'at_or_over_limit', operand: 100, decision: 'require_approval' }]));

    const r = await dispatch();
    expect(r).toMatchObject({ status: 'denied', reason: 'policy_denied' });

    const evaluation = row(await evaluations());
    expect(evaluation.decision).toBe('deny');
    // The rule is named as UNEVALUABLE, not as fired — the distinction a reader needs to tell "policy refused you"
    // from "policy could not be applied to you".
    expect(evaluation.unevaluable_rule_ids).toContain('spend-cap');
    expect(evaluation.fired_rule_ids).not.toContain('spend-cap');
  });

  // ──────────────── THE IDEMPOTENCY SHORT CIRCUIT IS NOT A WAY PAST THE GATE (CDR-067 §2-G10) ─────────────────
  //
  // Raised by the loosening's independent review, which called this "the one place the chokepoint is genuinely not a
  // chokepoint": the duplicate check returns BEFORE the policy evaluation. Short-circuiting is right for a call that
  // actually ran — re-gating it could produce a second, contradictory record of one event. It is wrong for a call
  // that never ran, and wrong for a key attached to different arguments.

  test('replaying a DENIED call returns the DENIAL, never `duplicate` — a refused call never ran', async () => {
    // `duplicate` means "already ran in this company". A denied call did not run, and a caller written as
    // `if (denied) abort else proceed` would read a laundered refusal as permission.
    const first = await dispatch({ allowlist: ['memory_write'], idempotencyKey: 'k-denied' });
    expect(first).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });

    const replay = await dispatch({ idempotencyKey: 'k-denied' });
    expect(replay).toMatchObject({ status: 'denied', reason: 'not_allowlisted' });

    // AND NO SECOND ROW: the refusal is reported from the existing record, so one attempt stays one record.
    expect(await callRows()).toHaveLength(1);
  });

  test('a key attached to DIFFERENT arguments is a conflict, not a duplicate', async () => {
    // Otherwise the caller receives someone else's authorization: the prior call's record, carrying the prior call's
    // digest, in answer to a request whose arguments were never gated or recorded.
    expect((await dispatch({ args: { q: 'first' }, idempotencyKey: 'k-args' })).status).toBe('authorized');

    const conflict = await dispatch({ args: { q: 'second' }, idempotencyKey: 'k-args' });
    expect(conflict.status).toBe('idempotency_conflict');
    expect(await callRows()).toHaveLength(1);
  });

  test('the SAME arguments under the same key are still a plain duplicate', async () => {
    // The hardening must not break what idempotency is for. Identical retry → the original record, no second call.
    expect((await dispatch({ args: { q: 'same' }, idempotencyKey: 'k-same' })).status).toBe('authorized');
    const again = await dispatch({ args: { q: 'same' }, idempotencyKey: 'k-same' });
    expect(again.status).toBe('duplicate');
    expect(await callRows()).toHaveLength(1);
  });

  // ─────────────────────────────────────── ATOMICITY AND ISOLATION ────────────────────────────────────────────

  test('a failed audit write leaves NO evaluation and NO call row — the whole dispatch rolls back together', async () => {
    // The comment at the call site claims the evaluation, the call record and the audit events commit or roll back
    // as one. That claim is worth exactly as much as this test: a call recorded as authorized whose evaluation was
    // rolled back would assert an authorization that never happened.
    const exploding = () => {
      throw new Error('audit sink unavailable');
    };
    await expect(dispatch({}, { auditWriter: exploding })).rejects.toThrow();

    expect(await evaluations()).toHaveLength(0);
    expect(await callRows()).toHaveLength(0);
  });

  test('a company with an authorized tool call can still be DELETED — the FK cycle does not wedge the cascade', async () => {
    // RAISED BY REVIEW PASS 2 AS A SUSPICION, tested here rather than reasoned about. Migration 0045 gives
    // `policy_evaluations.tool_call_id -> tool_calls` and 0046 gives `tool_calls.policy_eval_id ->
    // policy_evaluations`: a CYCLE. Both cascade from `companies`, both FKs are NO ACTION and NOT DEFERRABLE, and
    // sibling RI trigger order is not ours to choose — so if the wrong side cascades first, deleting a company with
    // an authorized call raises 23503 and the company becomes undeletable. That is exactly the kind of thing that is
    // cheap to assert and expensive to discover from a support ticket.
    expect((await dispatch()).status).toBe('authorized');
    expect(await evaluations()).toHaveLength(1);
    expect(await callRows()).toHaveLength(1);

    await expect(sql`delete from companies where id = ${w.companyA1}::uuid`.execute(owner.kysely)).resolves.toBeDefined();
    expect(await callRows()).toHaveLength(0);
    expect(await evaluations()).toHaveLength(0);
  });

  test("a tool call cannot cite ANOTHER company's policy evaluation (migration 0046, tenant-pinned FK)", async () => {
    // RAISED BY REVIEW PASS 2. Migration 0046's whole justification is that `tool_calls.policy_eval_id` is pinned to
    // `(id, company_id)` rather than to `id` alone, because RI checks ALWAYS bypass RLS — so without the company
    // column in the key, company A's call could name company B's evaluation and the database would agree. The claim
    // lived in the migration's comment and in no test.
    //
    // It lives HERE rather than in the policies suite because `tool_calls.run_id` is NOT NULL: the first attempt
    // died 23502 before the FK was ever consulted, which would have been a green test proving nothing about 0046.
    // This suite already has a real running run and a seeded company B.
    const policyB = (
      await sql<{ id: string }>`insert into policies (account_id, company_id, version, baseline, rules, autonomy_level, status, created_by_user_id)
           values (${w.accountB}::uuid, ${w.companyB1}::uuid, 1, 'allow', '[]'::jsonb, 2, 'active', ${w.bOwner}::uuid) returning id`.execute(owner.kysely)
    ).rows[0]!;
    const evaluationB = (
      await sql<{ id: string }>`insert into policy_evaluations
             (account_id, company_id, policy_id, policy_version, evaluation_point, decision, escalate, fired_rule_ids, unevaluable_rule_ids, untrusted_rule_ids, evaluated_at)
           values (${w.accountB}::uuid, ${w.companyB1}::uuid, ${policyB.id}::uuid, 1, 'pre_execution', 'allow', false, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, now()) returning id`.execute(
        owner.kysely,
      )
    ).rows[0]!;

    const insertCall = (policyEvalId: string) =>
      sql`insert into tool_calls (account_id, company_id, run_id, tool_id, risk_class, external_effect, outcome, arguments_digest, policy_eval_id)
          values (${w.accountA}::uuid, ${w.companyA1}::uuid, ${runId}::uuid, 'web_research', 'informational', false, 'requested', repeat('a', 64), ${policyEvalId}::uuid)`.execute(
        owner.kysely,
      );

    // Cross-company: refused by the FK, not by RLS — which is the point, because RI bypasses RLS.
    expect(await sqlStateOf(insertCall(evaluationB.id))).toBe('23503');
    // A NON-EXISTENT id is refused identically, so the constraint is not an existence oracle either.
    expect(await sqlStateOf(insertCall('00000000-0000-4000-8000-000000000000'))).toBe('23503');
    // …and the SAME-company evaluation is accepted, so the test above is about tenancy and not about the FK simply
    // rejecting everything.
    expect((await dispatch()).status).toBe('authorized');
  });

  test("company B's policy has no say over company A's call, and vice versa", async () => {
    // A deny rule on the OTHER company must not refuse this one. Tenant isolation of the evaluation itself, not
    // merely of the rows it writes.
    expect((await initializeCompanyPolicy(product, { userId: w.bOwner, accountId: w.accountB, companyId: w.companyB1 })).status).toBe('ok');
    await sql`update policies set rules = rules || ${alwaysRule('forbidden-b', 'deny')}::jsonb
              where company_id = ${w.companyB1}::uuid and status = 'active'`.execute(owner.kysely);

    expect((await dispatch()).status).toBe('authorized');

    const rows = await evaluations();
    expect(rows).toHaveLength(1);
    expect(row(rows).company_id).toBe(w.companyA1);
  });
});
