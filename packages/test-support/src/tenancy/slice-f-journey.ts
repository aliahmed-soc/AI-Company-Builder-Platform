// ACBP-P6-012 / CDR-077 — the Slice F journey (M6 milestone exit), implemented ONCE and shared by the runnable demo
// (`pnpm demo:slice-f`) and the CI integration suite so the two can never drift. Test-support only; never a
// production dependency (boundary rule 9).
//
// The journey is the SAFETY AND RECOVERY vertical: a policy block → an approval that cannot buy past it → a modified
// payload refused → the exact payload authorized → a duplicate delivery suppressed → an emergency stop that outranks
// a live approval → review-to-resume → a lost worker reclaimed and retried → the account's usage totals reconciling
// after all of it.
//
// WHAT MAKES THIS DIFFERENT FROM THE FIVE SUITES IT SITS ON TOP OF (CDR-077 §0). Every mechanism here already has a
// dedicated real-PostgreSQL suite, and re-asserting them would add running time and no information. What no suite
// tests is that the controls hold TOGETHER, in one company's continuous lifetime, in the order an incident presents
// them: that a deny still refuses with a human approval standing against the same call; that a stop outranks that
// approval and leaves it UNSPENT; that a re-delivery of an approved action does not spend a second approval; that a
// halted company can actually be resumed from; and that the totals still reconcile afterwards. Those are the claims.
//
// Like every earlier journey, the use cases are INJECTED by the caller rather than imported: @acbp/core's own tests
// import @acbp/test-support, so test-support must not import @acbp/core (that would be a workspace-graph cycle).
//
// WHAT A GREEN RUN DOES NOT PROVE, stated here because eleven green steps invite over-reading (CDR-077 §4):
//   1. NO EXTERNAL ACTION HAS EVER EXECUTED. No tool implementation exists; `send_email` is a registry row with a
//      risk class, and "the approved action ran" means the chokepoint authorized it and spent the approval — the
//      only execution instant that exists today (CDR-069 §1-G7).
//   2. ONE STOP SCOPE IS EXERCISED (`company`). The per-scope enforcement matrix is the stop suite's job.
//   3. THE HELD-WORK QUEUE IS NOT A ROSTER of everything a stop covers — it records what the stop INTERRUPTED
//      (CDR-072 §1-G6).
import type { DatabaseClient } from '@acbp/database';
// Real contract types wherever one exists. Slice D was burned twice by hand-rolled structural subsets that
// type-checked perfectly while being wrong about a field NAME, and only failed minutes into a real-PostgreSQL CI run.
import { usagePeriodStart, type ModelGatewayRequest, type RollupFigures } from '@acbp/contracts';
import { sql } from 'kysely';
import type { JourneyStep } from './slice-a-journey.js';

export type { JourneyStep } from './slice-a-journey.js';

type Ids = { readonly userId: string; readonly accountId: string; readonly companyId: string };
type Status<T = object> = { readonly status: string } & Partial<T>;

/** The dispatcher's answer, narrowed to what this journey reads. `reason` is the CLOSED `ToolDenialReason`. */
export interface SliceFDispatchResult {
  readonly status: string;
  readonly reason?: string;
  readonly call?: { readonly id: string; readonly outcome: string; readonly denialReason: string | null };
}

/** A bound model gateway, already wired to a deterministic fake provider by the caller. */
export type SliceFGateway = (request: ModelGatewayRequest) => Promise<{ readonly outcome: string }>;

/** One captured log line. The journey reads `event` and `metadata.surface` and nothing else. */
export interface SliceFLogRecord {
  readonly event: string;
  readonly metadata?: unknown;
}

/**
 * A live log capture: `records` grows as the product logs.
 *
 * THE SUPPRESSION HALF OF SCENARIO 4 CANNOT BE ASSERTED WITHOUT THIS. "Nothing happened twice" is also what a
 * system with NO duplicate suppression looks like on a day nothing was re-delivered (CDR-074 §0), so the journey
 * asserts that the platform KNEW it was suppressing — which is only observable as an incident record.
 */
export interface SliceFLogCapture {
  readonly logger: unknown;
  readonly records: readonly SliceFLogRecord[];
}

/** The @acbp/core use cases the journey drives, injected by the caller (the caller passes the real functions). */
export interface SliceFOps {
  initializeCompanyPolicy(c: DatabaseClient, p: Ids): Promise<Status>;
  createTask(c: DatabaseClient, p: Ids & { title: string; description?: string | null; milestoneId?: string | null }): Promise<Status<{ task: { taskId: string } }>>;
  planTask(c: DatabaseClient, p: Ids & { taskId: string }): Promise<Status<{ task: { state: string } }>>;
  startRun(c: DatabaseClient, p: Ids & { taskId: string; attempt: number }): Promise<Status<{ run: { id: string; state: string; attempt: number }; taskState: string }>>;
  /** THE CHOKEPOINT. `context` is REQUIRED on the real params — an omitted context defaults to trusted. */
  dispatchToolCall(
    c: DatabaseClient,
    p: Ids & { runId: string; toolId: string; args: unknown; allowlist: readonly string[] | undefined; context: readonly unknown[]; idempotencyKey?: string },
    o?: { logger?: unknown },
  ): Promise<SliceFDispatchResult>;
  requestApproval(
    c: DatabaseClient,
    p: Ids & {
      runId: string;
      toolId: string;
      scope: 'one_action';
      action: string;
      reason: string;
      expectedResult: string;
      data: Readonly<Record<string, unknown>>;
      estimatedCostCredits: number;
      preview: string;
      expiresAt: Date;
    },
  ): Promise<Status<{ request: { id: string }; missing: readonly string[] }>>;
  decideApproval(c: DatabaseClient, p: Ids & { requestId: string; decision: { path: 'approve'; decidedAt: Date } }): Promise<Status<{ authorizes: boolean; reason: string }>>;
  activateStop(
    c: DatabaseClient,
    p: Ids & { scope: string; targetId?: string | null; reason?: string | null },
  ): Promise<Status<{ stopId: string; heldCount: number; pausedCount: number; stopRequestedCount: number; reason: string }>>;
  clearStop(c: DatabaseClient, p: Ids & { stopId: string; at: Date }): Promise<Status<{ pendingReviewCount: number; reason: string }>>;
  reviewHeldWork(c: DatabaseClient, p: Ids & { heldWorkId: string; decision: 'confirmed' | 'discarded'; at: Date }): Promise<Status<{ reason: string }>>;
  reclaimLostRuns(c: DatabaseClient, p: Ids & { limit?: number }, o?: { now?: Date; heartbeatGraceMs?: number }): Promise<Status<{ reclaimed: readonly string[] }>>;
  enqueueJob(c: DatabaseClient, p: Ids & { kind: string; idempotencyKey?: string }, o?: { logger?: unknown }): Promise<Status<{ deduplicated: boolean; job: { id: string } }>>;
  rebuildAccountUsageRollup(c: DatabaseClient, p: { userId: string; accountId: string; periodStart: unknown }): Promise<Status<{ figures: RollupFigures; companyCount: number }>>;
  reconcileAccountUsageRollup(
    c: DatabaseClient,
    p: { userId: string; accountId: string; periodStart: unknown; threshold: unknown },
  ): Promise<Status<{ computed: RollupFigures; stored: RollupFigures; drift: RollupFigures; lanesExceedingThreshold: readonly string[]; storedExisted: boolean }>>;
}

export interface SliceFJourneyDeps {
  /** Restricted `acbp_app` product connection — every use case runs through this. */
  readonly product: DatabaseClient;
  /** Owner/fixture connection — evidence inspection and the preconditions the product role has no path to. */
  readonly owner: DatabaseClient;
  readonly userId: string;
  readonly accountId: string;
  /** The company the incident happens in. */
  readonly companyId: string;
  /** A SIBLING company in the SAME account (CDR-077 §G9) — carries the tenancy half of the stop and the rollup. */
  readonly siblingCompanyId: string;
  readonly ops: SliceFOps;
  /** Build a gateway on the deterministic fake provider, metering through the restricted connection. */
  readonly makeGateway: (logger: unknown) => SliceFGateway;
  /** Build a fresh live log capture. */
  readonly makeLogger: () => SliceFLogCapture;
  /**
   * `SUPPRESSION_EVENT` from @acbp/observability, passed in rather than restated.
   *
   * test-support does not depend on @acbp/observability, and a hard-coded copy of the event name would keep this
   * journey green on the day the real constant changed — asserting an incident nothing emits any more.
   */
  readonly suppressionEvent: string;
}

// ── the scripted inputs ──────────────────────────────────────────────────────────────────────────────────
// Deterministic and inline: a milestone exit is a claim about the PLATFORM, so its inputs must be fixed. A randomised
// payload would make a failure unreproducible, which is the opposite of what a milestone exit is for.

const EXTERNAL_TOOL = 'send_email';
const INTERNAL_TOOL = 'web_research';
const ALLOWLIST: readonly string[] = [EXTERNAL_TOOL, INTERNAL_TOOL];

/** THE APPROVED PAYLOAD. Deliberately NON-EMPTY — an approval bound to `{}` cannot distinguish "refuses a modified
 *  payload" from "only ever authorizes the empty payload" (the gap P6-005's review pass 2 found). */
const APPROVED_PAYLOAD = { recipients: 3, template: 'supplier_intro' } as const;
/** Its neighbour: ONE field changed. This is the "material edit" of launch gate 4, at its smallest. */
const EDITED_PAYLOAD = { recipients: 4, template: 'supplier_intro' } as const;

/** A rule on the OBSERVED dimension — see CDR-077 §G5 for why not on `forbidden_action`. */
const FORBIDDEN_EXTERNAL_RULE = JSON.stringify([
  { id: 'slice-f-forbidden-external', dimension: 'risk_class', condition: 'risk_at_least', operand: 'external_reversible', decision: 'deny' },
]);

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
/** Every lane at zero: this asserts EXACTNESS, not the owner's alerting policy (CDR-077 §G8). */
const ZERO_DRIFT: RollupFigures = { eventCount: 0, inputTokens: 0, outputTokens: 0, estimatedCostMicros: 0 };

/**
 * Run the whole Slice F journey. Returns every step's verdict. NEVER throws for a failed step — the caller decides
 * how to report (the demo prints and exits non-zero; the suite asserts), so a failure is always visible with its
 * evidence rather than as an opaque stack.
 */
export async function runSliceFJourney(deps: SliceFJourneyDeps): Promise<{ readonly steps: readonly JourneyStep[] }> {
  const { product, owner, userId, accountId, companyId, siblingCompanyId, ops } = deps;
  const ids: Ids = { userId, accountId, companyId };
  const siblingIds: Ids = { userId, accountId, companyId: siblingCompanyId };
  const steps: JourneyStep[] = [];
  const record = (step: string, requirement: string, ok: boolean, detail: string): void => {
    steps.push({ step, requirement, ok, detail });
  };
  /** Stop the sequence honestly: later steps depend on earlier ones, so a cascade of failures hides the real cause. */
  const bail = (step: string, requirement: string, detail: string): { readonly steps: readonly JourneyStep[] } => {
    record(step, requirement, false, detail);
    return { steps };
  };

  // ── evidence reads, all on the OWNER connection ────────────────────────────────────────────────────────
  const approvalStatus = async (requestId: string): Promise<string> =>
    (await sql<{ status: string }>`select status from approval_requests where id = ${requestId}::uuid`.execute(owner.kysely)).rows[0]?.status ?? 'missing';
  const taskState = async (taskId: string): Promise<string> =>
    (await sql<{ state: string }>`select state from tasks where id = ${taskId}::uuid`.execute(owner.kysely)).rows[0]?.state ?? 'missing';
  const runState = async (runId: string): Promise<{ state: string; category: string | null }> => {
    const r = (await sql<{ state: string; failure_category: string | null }>`select state, failure_category from task_runs where id = ${runId}::uuid`.execute(owner.kysely)).rows[0];
    return { state: r?.state ?? 'missing', category: r?.failure_category ?? null };
  };
  const callCount = async (key: string): Promise<number> =>
    Number((await sql<{ n: string }>`select count(*)::text as n from tool_calls where idempotency_key = ${key}`.execute(owner.kysely)).rows[0]?.n ?? '-1');
  const usageRowCount = async (company: string): Promise<number> =>
    Number((await sql<{ n: string }>`select count(*)::text as n from usage_events where company_id = ${company}::uuid`.execute(owner.kysely)).rows[0]?.n ?? '-1');

  /** Rule editing has NO product surface (CDR-077 §G4) — the owner connection is the only path there is. */
  const setRules = (rules: string): Promise<unknown> =>
    sql`update policies set rules = ${rules}::jsonb where company_id = ${companyId}::uuid and status = 'active'`.execute(owner.kysely);

  const suppressions = (capture: SliceFLogCapture, surface: string): number =>
    capture.records.filter((r) => r.event === deps.suppressionEvent && (r.metadata as { surface?: string } | null | undefined)?.surface === surface).length;

  /**
   * A task taken all the way to a RUNNING run.
   *
   * `planned→queued` and `queued→running` on the TASK are performed on the owner connection because NO use case
   * implements either — `startRun` advances the RUN's state machine and never touches `tasks.state`. The same
   * documented gap Slice D and Slice E both work around (CDR-065 §3-G5c); named here rather than hidden in a helper.
   */
  const runningTask = async (scope: Ids, title: string): Promise<{ taskId: string; runId: string } | { failure: string }> => {
    const created = await ops.createTask(product, { ...scope, title, description: null, milestoneId: null });
    if (created.status !== 'ok' || created.task === undefined) return { failure: `createTask expected ok, got ${created.status}` };
    const taskId = created.task.taskId;
    const planned = await ops.planTask(product, { ...scope, taskId });
    if (planned.status !== 'ok') return { failure: `planTask expected ok, got ${planned.status}` };
    await sql`update tasks set state = 'queued' where id = ${taskId}::uuid`.execute(owner.kysely);
    const started = await ops.startRun(product, { ...scope, taskId, attempt: 1 });
    if (started.status !== 'ok' || started.run === undefined) return { failure: `startRun expected ok, got ${started.status}` };
    await sql`update tasks set state = 'running' where id = ${taskId}::uuid`.execute(owner.kysely);
    return { taskId, runId: started.run.id };
  };

  /** Raise and decide a REAL approval through the product services — never an owner-inserted row (CDR-077 §G7). */
  const approve = async (runId: string, data: Readonly<Record<string, unknown>>): Promise<{ requestId: string } | { failure: string }> => {
    const raised = await ops.requestApproval(product, {
      ...ids,
      runId,
      toolId: EXTERNAL_TOOL,
      scope: 'one_action',
      action: 'Send the introduction email to the three shortlisted suppliers',
      reason: 'The supplier shortlist was confirmed and outreach is the next planned step',
      expectedResult: 'Three emails delivered; replies tracked against the supplier task',
      data,
      estimatedCostCredits: 1,
      preview: 'To: 3 suppliers\nSubject: Introduction\n\nHello — we are evaluating suppliers for…',
      expiresAt: new Date(Date.now() + DAY_MS),
    });
    if (raised.status !== 'ok' || raised.request === undefined) {
      return { failure: `requestApproval expected ok, got ${raised.status}${raised.missing === undefined ? '' : ` (missing: ${raised.missing.join(', ')})`}` };
    }
    const decided = await ops.decideApproval(product, { ...ids, requestId: raised.request.id, decision: { path: 'approve', decidedAt: new Date() } });
    if (decided.status !== 'ok') return { failure: `decideApproval expected ok, got ${decided.status}${decided.reason === undefined ? '' : ` (${decided.reason})`}` };
    if (decided.authorizes !== true) return { failure: 'an `approve` decision reported that it does not authorize — the human said yes and the record disagrees' };
    return { requestId: raised.request.id };
  };

  const dispatch = (runId: string, over: { toolId?: string; args?: unknown; idempotencyKey?: string; scope?: Ids } = {}): Promise<SliceFDispatchResult> =>
    ops.dispatchToolCall(product, {
      ...(over.scope ?? ids),
      runId,
      toolId: over.toolId ?? EXTERNAL_TOOL,
      args: over.args ?? APPROVED_PAYLOAD,
      allowlist: ALLOWLIST,
      context: [],
      ...(over.idempotencyKey === undefined ? {} : { idempotencyKey: over.idempotencyKey }),
    });

  // ══ PRECONDITIONS ══════════════════════════════════════════════════════════════════════════════════════
  // The tool REGISTRY is platform data with no product write path, so it is seeded on the owner connection. The
  // risk classes are the load-bearing part: `send_email` is `external_reversible`, which is what makes the shipped
  // baseline policy demand an approval for it and what makes the deny rule below scoped rather than total.
  await sql`delete from tool_definitions`.execute(owner.kysely);
  await sql`insert into tool_definitions (tool_id, version, risk_class, description, status)
            values (${INTERNAL_TOOL}, 1, 'informational', 'read-only research', 'active'),
                   (${EXTERNAL_TOOL}, 1, 'external_reversible', 'sends an email', 'active')`.execute(owner.kysely);

  for (const scope of [ids, siblingIds]) {
    const initialized = await ops.initializeCompanyPolicy(product, scope);
    if (initialized.status !== 'ok') return bail('a policy is in force', 'POL-001', `initializeCompanyPolicy expected ok for ${scope.companyId}, got ${initialized.status}`);
  }

  const workA = await runningTask(ids, 'Contact the shortlisted suppliers');
  if ('failure' in workA) return bail('there is work in flight', 'TASK-001', workA.failure);
  const workB = await runningTask(ids, 'Draft the supplier comparison');
  if ('failure' in workB) return bail('there is work in flight', 'TASK-001', workB.failure);
  const workSibling = await runningTask(siblingIds, 'Sibling company work that must not be halted');
  if ('failure' in workSibling) return bail('there is work in flight', 'TASK-001', workSibling.failure);

  // ── 1. THE CONTROL, and the shipped default (CDR-077 §G6) ──────────────────────────────────────────────
  // Without this step every refusal below would be satisfied by a platform that simply refuses everything.
  const internalOk = await dispatch(workA.runId, { toolId: INTERNAL_TOOL, args: { q: 'suppliers' } });
  if (internalOk.status !== 'authorized') return bail('the platform runs work', 'TOOL-003', `an informational call under the baseline policy expected authorized, got ${internalOk.status}${internalOk.reason === undefined ? '' : `/${internalOk.reason}`}`);

  const unapproved = await dispatch(workA.runId);
  if (unapproved.status !== 'denied' || unapproved.reason !== 'approval_required') {
    return bail('an external action needs a human', 'APPR-001', `expected denied/approval_required from the SHIPPED baseline rule, got ${unapproved.status}/${String(unapproved.reason)}`);
  }
  record(
    'the platform runs internal work, and asks a human before an external action',
    'POL-001 / APPR-001',
    true,
    `${INTERNAL_TOOL} (informational) authorized; ${EXTERNAL_TOOL} (external_reversible) refused as approval_required — by the baseline policy \`initializeCompanyPolicy\` ships, not by a fixture rule`,
  );

  // ── 2. SCENARIO 1 — the disallowed action is BLOCKED, and the block is SCOPED (POL-005) ────────────────
  await setRules(FORBIDDEN_EXTERNAL_RULE);

  const blocked = await dispatch(workA.runId);
  if (blocked.status !== 'denied' || blocked.reason !== 'policy_denied') {
    return bail('policy blocks a disallowed action', 'POL-005', `expected denied/policy_denied, got ${blocked.status}/${String(blocked.reason)} — a refusal for some OTHER reason is not evidence that POLICY refused`);
  }
  // RECORDED. TOOL-002 wants 100% of attempts recorded, and a block nobody can audit is indistinguishable
  // afterwards from a call that was never attempted.
  if (blocked.call?.outcome !== 'denied' || blocked.call.denialReason !== 'policy_denied') {
    return bail('the block is recorded', 'TOOL-002', `the tool_calls row does not record the refusal: outcome=${String(blocked.call?.outcome)} reason=${String(blocked.call?.denialReason)}`);
  }
  // THE SCOPING HALF. A rule that took the tenant offline would satisfy the assertion above perfectly.
  const stillRuns = await dispatch(workA.runId, { toolId: INTERNAL_TOOL, args: { q: 'still working' } });
  if (stillRuns.status !== 'authorized') {
    return bail('the block is a BLOCK, not a blackout', 'POL-005', `the informational call was refused too (${stillRuns.status}/${String(stillRuns.reason)}) — a company whose every action stops is an outage, not a policy`);
  }
  record(
    'a disallowed action is blocked and recorded — and the company keeps working',
    'POL-005 / TOOL-002',
    true,
    `${EXTERNAL_TOOL} denied as policy_denied and written to tool_calls; ${INTERNAL_TOOL} still authorized under the same policy. The rule was installed on the OWNER connection: no product surface authors rules (CDR-077 §G4)`,
  );

  // ── 3. AN APPROVAL CANNOT BUY PAST A DENY, and is not consumed trying (POL-005) ────────────────────────
  const standing = await approve(workA.runId, APPROVED_PAYLOAD);
  if ('failure' in standing) return bail('a human approves the action', 'APPR-002', standing.failure);

  const deniedAnyway = await dispatch(workA.runId);
  if (deniedAnyway.status !== 'denied' || deniedAnyway.reason !== 'policy_denied') {
    return bail('an approval cannot override a deny', 'POL-005', `with a live human approval standing, expected denied/policy_denied, got ${deniedAnyway.status}/${String(deniedAnyway.reason)}`);
  }
  const afterDeny = await approvalStatus(standing.requestId);
  if (afterDeny !== 'decided') {
    return bail('the refused attempt does not burn the approval', 'APPR-009', `the approval is ${afterDeny} after a call policy refused — a human would have to approve again because a rule they never saw said no`);
  }
  record(
    'a human approval cannot buy past a policy DENY, and is not spent trying',
    'POL-005 / APPR-009',
    true,
    `approval ${standing.requestId} was raised and approved through the real services, the call was still denied as policy_denied, and the approval remains \`decided\` — most-restrictive-wins, at no cost to the human's decision`,
  );

  // ── 4. SCENARIO 2 — the MODIFIED payload requires reapproval (APPR-004; launch gate 4) ─────────────────
  // The deny is withdrawn: the baseline's `require_approval` is back in force, so the ONLY thing standing between
  // this call and execution is the binding. Without withdrawing it, the refusal below would prove nothing — policy
  // would have refused anyway.
  await setRules('[]');

  const edited = await dispatch(workA.runId, { args: EDITED_PAYLOAD });
  if (edited.status !== 'denied' || edited.reason !== 'approval_invalid') {
    return bail('a modified payload requires reapproval', 'APPR-004', `expected denied/approval_invalid for a payload the human never saw, got ${edited.status}/${String(edited.reason)}`);
  }
  const afterEdit = await approvalStatus(standing.requestId);
  if (afterEdit !== 'decided') {
    return bail('a tampered call does not burn the approval', 'APPR-004', `the approval is ${afterEdit} — a refusal that spent it would mean anyone able to submit a modified payload could force a human to approve again`);
  }
  record(
    'a payload the human never approved is refused, and their approval survives it',
    'APPR-004 / trust-critical #6',
    true,
    `one field changed (recipients ${String(APPROVED_PAYLOAD.recipients)} → ${String(EDITED_PAYLOAD.recipients)}) → approval_invalid; the approval is still \`decided\`, so the legitimate action below can still run`,
  );

  // ── 5. …and the action the human DID approve runs, exactly once (APPR-009) ─────────────────────────────
  const REPLAY_KEY = 'slice-f-approved-send';
  const authorized = await dispatch(workA.runId, { idempotencyKey: REPLAY_KEY });
  if (authorized.status !== 'authorized') {
    return bail('the approved action runs', 'APPR-003', `expected authorized for the exact approved payload, got ${authorized.status}/${String(authorized.reason)}`);
  }
  const spent = await approvalStatus(standing.requestId);
  if (spent !== 'consumed') return bail('the approval is spent', 'APPR-009', `expected consumed after authorizing, got ${spent} — an unspent approval is available for a second call the human never authorized`);
  record(
    'the payload the human approved is authorized, and the approval is spent',
    'APPR-003 / APPR-009',
    true,
    `authorized against the same bytes the human saw; approval ${standing.requestId} is now \`consumed\` — single-use, so the same decision cannot authorize a second action`,
  );

  // ── 6. SCENARIO 4 — DUPLICATE DELIVERY, on three surfaces, and against an approval (TASK-009) ──────────
  //
  // THE COMPOSITION CLAIM. A second approval is standing, decided and bound to the SAME payload, before the
  // re-delivery. If the replay re-ran the gates it would find that approval and spend it — one delivery, two human
  // decisions consumed, and the second one gone with nothing to show for it. Nothing in the repo has ever run the
  // two single-use guards against each other.
  const second = await approve(workA.runId, APPROVED_PAYLOAD);
  if ('failure' in second) return bail('duplicate delivery setup', 'TASK-009', second.failure);

  const capture = deps.makeLogger();
  const replay = await dispatch(workA.runId, { idempotencyKey: REPLAY_KEY });
  if (replay.status !== 'duplicate') {
    return bail('a re-delivered call does not run twice', 'TASK-009', `expected duplicate, got ${replay.status}/${String(replay.reason)}`);
  }
  const rows = await callCount(REPLAY_KEY);
  if (rows !== 1) return bail('a re-delivered call leaves one record', 'TASK-009', `expected exactly 1 tool_calls row for the key, found ${rows}`);
  const secondStatus = await approvalStatus(second.requestId);
  if (secondStatus !== 'decided') {
    return bail('a re-delivery does not spend a second approval', 'TASK-009 / APPR-009', `the standing approval is ${secondStatus} after a DUPLICATE — one delivery consumed two human decisions`);
  }

  // Jobs and metered model calls, the other two surfaces, each delivered twice for real.
  const jobFirst = await ops.enqueueJob(product, { ...ids, kind: 'understanding.generate', idempotencyKey: 'slice-f-job' }, { logger: capture.logger });
  const jobAgain = await ops.enqueueJob(product, { ...ids, kind: 'understanding.generate', idempotencyKey: 'slice-f-job' }, { logger: capture.logger });
  if (jobFirst.status !== 'ok' || jobAgain.status !== 'ok') return bail('a re-delivered job does not run twice', 'TASK-009', `enqueueJob returned ${jobFirst.status} then ${jobAgain.status}`);
  if (jobFirst.deduplicated !== false || jobAgain.deduplicated !== true || jobAgain.job?.id !== jobFirst.job?.id) {
    return bail('a re-delivered job does not run twice', 'TASK-009', `expected the second enqueue to return the FIRST job as deduplicated, got deduplicated=${String(jobAgain.deduplicated)} job=${String(jobAgain.job?.id)} vs ${String(jobFirst.job?.id)}`);
  }

  const gateway = deps.makeGateway(capture.logger);
  const meter = (company: string, idempotencyKey?: string): Promise<{ readonly outcome: string }> =>
    gateway({
      taskClass: 'extraction',
      templateRef: 'tmpl@1',
      contextParts: [{ role: 'user', content: 'go' }],
      timeoutClass: 'interactive',
      accountId,
      companyId: company,
      correlationId: 'slice-f',
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    });
  const metered = await meter(companyId, 'slice-f-usage-1');
  const meteredAgain = await meter(companyId, 'slice-f-usage-1');
  const meteredOther = await meter(companyId, 'slice-f-usage-2');
  const meteredSibling = await meter(siblingCompanyId, 'slice-f-usage-3');
  for (const [name, r] of [
    ['first', metered],
    ['re-delivered', meteredAgain],
    ['second', meteredOther],
    ['sibling', meteredSibling],
  ] as const) {
    // A SUPPRESSED DUPLICATE STILL RETURNS ITS OUTPUT (CDR-074 §2). Failing the re-delivery would withhold a
    // result the customer has already been charged for — the feature causing the harm it exists to prevent.
    if (r.outcome !== 'ok') return bail('a re-delivered metered call still answers', 'TASK-009', `the ${name} metered call reported ${r.outcome}`);
  }
  const meteredRows = await usageRowCount(companyId);
  if (meteredRows !== 2) return bail('a re-delivered metered call bills once', 'TASK-009 / trust-critical #12', `expected 2 usage rows in this company (two distinct calls, one of them delivered twice), found ${meteredRows}`);

  // THE HALF THAT CANNOT BE FAKED BY A SYSTEM THAT SIMPLY NEVER DUPLICATED ANYTHING (CDR-074 §0).
  const incidents = { job: suppressions(capture, 'job_enqueue'), usage: suppressions(capture, 'usage_event') };
  if (incidents.job !== 1 || incidents.usage !== 1) {
    return bail('the platform KNEW it was suppressing', 'TASK-009 / NFR-006', `expected exactly one incident per surface, got job_enqueue=${incidents.job} usage_event=${incidents.usage} — "nothing happened twice" is also what a system with no suppression looks like`);
  }
  record(
    'three surfaces are re-delivered for real, each takes effect once, and each incident is recorded',
    'TASK-009 / NFR-006 / trust-critical #11 and #12',
    true,
    `tool call → duplicate with 1 record and NO second approval spent (${second.requestId} still \`decided\`); job → the same job returned as deduplicated; metered call → 2 usage rows for 3 deliveries, output still returned. Suppression incidents: job_enqueue=1, usage_event=1`,
  );

  // ── 7. SCENARIO 3 — the EMERGENCY STOP outranks a live approval (ADMIN-001) ────────────────────────────
  //
  // `second` is still standing, decided, bound to this exact payload and unexpired: the call below would be
  // authorized a moment earlier. The stop is the only thing that changes.
  const stopped = await ops.activateStop(product, { ...ids, scope: 'company', targetId: companyId, reason: 'slice F drill' });
  if (stopped.status !== 'ok' || stopped.stopId === undefined) {
    return bail('the platform can be halted', 'ADMIN-001', `activateStop expected ok, got ${stopped.status}${stopped.reason === undefined ? '' : ` (${stopped.reason})`}`);
  }
  if ((stopped.heldCount ?? 0) < 2 || (stopped.pausedCount ?? 0) < 2) {
    return bail('the halt holds the work it interrupted', 'ADMIN-002', `expected both in-flight tasks held and paused, got heldCount=${String(stopped.heldCount)} pausedCount=${String(stopped.pausedCount)}`);
  }

  const halted = await dispatch(workA.runId);
  if (halted.status !== 'denied' || halted.reason !== 'emergency_stopped') {
    return bail('the stop blocks new work', 'ADMIN-001', `expected denied/emergency_stopped with a VALID approval standing, got ${halted.status}/${String(halted.reason)}`);
  }
  const survived = await approvalStatus(second.requestId);
  if (survived !== 'decided') {
    return bail('a halt costs nothing but time', 'ADMIN-001 / APPR-009', `the approval is ${survived} after a stopped call — the halt consumed a human decision that authorized nothing`);
  }
  // THE TENANCY HALF. A `company` stop that halted the account would be the over-halt direction of CDR-072 §1-G2.
  const sibling = await dispatch(workSibling.runId, { toolId: INTERNAL_TOOL, args: { q: 'unaffected' }, scope: siblingIds });
  if (sibling.status !== 'authorized') {
    return bail('the halt is scoped to its company', 'ADMIN-001', `the SIBLING company's call was refused too (${sibling.status}/${String(sibling.reason)}) — a company stop that halts the account is a different defect, not a safer one`);
  }
  record(
    'an emergency stop halts the company even with a valid approval standing — and halts nothing else',
    'ADMIN-001 / trust-critical #9',
    true,
    `stop ${stopped.stopId} (scope=company) held ${String(stopped.heldCount)} task(s), paused ${String(stopped.pausedCount)}, asked ${String(stopped.stopRequestedCount)} live run(s) to safe-stop; the very NEXT call was refused as emergency_stopped with approval ${second.requestId} still \`decided\`; the sibling company kept working`,
  );

  // ── 8. NOTHING AUTO-FIRES ON RESUME (ADMIN-002) ────────────────────────────────────────────────────────
  const cleared = await ops.clearStop(product, { ...ids, stopId: stopped.stopId, at: new Date() });
  if (cleared.status !== 'ok') return bail('the halt can be lifted', 'ADMIN-002', `clearStop expected ok, got ${cleared.status}${cleared.reason === undefined ? '' : ` (${cleared.reason})`}`);
  if ((cleared.pendingReviewCount ?? 0) < 2) {
    return bail('clearing opens a review, it does not resume', 'ADMIN-002', `expected the held items to await review, got pendingReviewCount=${String(cleared.pendingReviewCount)}`);
  }
  const stillPaused = await Promise.all([taskState(workA.taskId), taskState(workB.taskId)]);
  if (stillPaused.some((s) => s !== 'paused')) {
    return bail('clearing resumes nothing of its own accord', 'ADMIN-002', `expected both tasks to remain paused until reviewed, got ${stillPaused.join(', ')}`);
  }

  const held = await sql<{ id: string; task_id: string }>`select id, task_id from held_work where stop_id = ${stopped.stopId}::uuid`.execute(owner.kysely);
  const heldFor = (taskId: string): string | undefined => held.rows.find((h) => h.task_id === taskId)?.id;
  const confirmId = heldFor(workA.taskId);
  const discardId = heldFor(workB.taskId);
  if (confirmId === undefined || discardId === undefined) {
    return bail('the review queue names the work it holds', 'ADMIN-002', `held_work is missing an item: ${held.rows.length} row(s) for two paused tasks`);
  }

  const confirmed = await ops.reviewHeldWork(product, { ...ids, heldWorkId: confirmId, decision: 'confirmed', at: new Date() });
  const discarded = await ops.reviewHeldWork(product, { ...ids, heldWorkId: discardId, decision: 'discarded', at: new Date() });
  if (confirmed.status !== 'ok' || discarded.status !== 'ok') {
    return bail('held work can be decided', 'ADMIN-002', `confirm=${confirmed.status}${confirmed.reason === undefined ? '' : `(${confirmed.reason})`} discard=${discarded.status}${discarded.reason === undefined ? '' : `(${discarded.reason})`}`);
  }
  const [resumed, abandoned] = await Promise.all([taskState(workA.taskId), taskState(workB.taskId)]);
  if (resumed !== 'running') return bail('confirmed work resumes', 'ADMIN-002', `expected the confirmed task to be running again, got ${resumed}`);
  if (abandoned !== 'paused') {
    return bail('discarded work does NOT resume', 'ADMIN-002', `expected the discarded task to stay paused, got ${abandoned} — a discard that behaves like a confirm is not a decision`);
  }
  record(
    'the halt is recoverable, one decision at a time — and a discard is not a confirm',
    'ADMIN-002 / trust-critical #10',
    true,
    `clearing the stop opened a review of ${String(cleared.pendingReviewCount)} item(s) and resumed NOTHING; confirming one returned its task to running, discarding the other left it paused. The queue records what the stop INTERRUPTED, never everything it covered (CDR-072 §1-G6)`,
  );

  // ── 9. SCENARIO 5 — a lost worker is reclaimed, and the work is RECOVERABLE (TASK-006) ─────────────────
  //
  // No sleeping and no clock manipulation in the product: `now` is an INPUT to the sweep, so "the worker has been
  // silent past the grace" is expressed by judging the run against a later instant.
  const wellPastGrace = new Date(Date.now() + DAY_MS);
  const reclaimed = await ops.reclaimLostRuns(product, { ...ids }, { now: wellPastGrace });
  if (reclaimed.status !== 'ok' || reclaimed.reclaimed === undefined) return bail('a silent worker is noticed', 'TASK-006', `reclaimLostRuns expected ok, got ${reclaimed.status}`);
  if (!reclaimed.reclaimed.includes(workA.runId)) {
    return bail('a silent worker is noticed', 'TASK-006', `the run that stopped heartbeating was not reclaimed (reclaimed ${reclaimed.reclaimed.length} run(s)) — a dead worker's task would sit "running" for ever`);
  }
  const reaped = await runState(workA.runId);
  if (reaped.state !== 'failed' || reaped.category !== 'worker_lost') {
    return bail('the failure names its cause', 'TASK-006 / TASK-010', `expected failed/worker_lost, got ${reaped.state}/${String(reaped.category)} — "no blank failures" means a category`);
  }
  // NO HOLLOW SUCCESS. A reclaimed attempt must never leave the task looking finished.
  const afterReap = await taskState(workA.taskId);
  if (afterReap === 'completed') return bail('a lost worker never completes the task', 'invariant 20', 'the task reads as completed after its run was reclaimed — a completion with no successful run behind it');
  // AND IT IS NOT A DEAD END: recovery means another attempt can be claimed.
  const retry = await ops.startRun(product, { ...ids, taskId: workA.taskId, attempt: 2 });
  if (retry.status !== 'ok' || retry.run === undefined) return bail('the work is recoverable', 'TASK-006', `a second attempt expected ok, got ${retry.status}`);
  if (retry.run.attempt !== 2) return bail('the work is recoverable', 'TASK-006', `expected attempt 2, got ${String(retry.run.attempt)}`);
  record(
    'a worker that went silent is reclaimed with a named cause, and the work can be retried',
    'TASK-006 / TASK-010',
    true,
    `run ${workA.runId} failed as worker_lost by the sweep (liveness is a timestamp and lostness a comparison — no timer in the process most likely to have died); the task is not completed, and attempt 2 was claimed`,
  );

  // ── 10. M6's FIFTH CRITERION — the totals reconcile after ALL of that ──────────────────────────────────
  const periodStart = usagePeriodStart(new Date());
  // A MONTH BOUNDARY WOULD MAKE THE ASSERTION BELOW A LIE RATHER THAN A FAILURE, so it is checked instead of
  // assumed: if this run straddled midnight on the 1st, the ledger is right and the period is wrong.
  const straddle = await sql<{ n: string }>`
    select count(*)::text as n from usage_events
    where account_id = ${accountId}::uuid and date_trunc('month', created_at at time zone 'UTC') <> ${periodStart}::date
  `.execute(owner.kysely);
  if (Number(straddle.rows[0]?.n ?? '-1') !== 0) {
    return bail('usage totals reconcile', 'USAGE-001', `this run straddled a month boundary — some usage falls outside ${periodStart}, so a single-period total would be honestly wrong`);
  }

  const rebuilt = await ops.rebuildAccountUsageRollup(product, { userId, accountId, periodStart });
  if (rebuilt.status !== 'ok' || rebuilt.figures === undefined) return bail('usage totals reconcile', 'USAGE-001', `rebuildAccountUsageRollup expected ok, got ${rebuilt.status}`);
  if ((rebuilt.companyCount ?? 0) < 2) return bail('the account total spans its companies', 'USAGE-001', `expected the rollup to sum at least both companies, got companyCount=${String(rebuilt.companyCount)}`);

  // AN INDEPENDENT DERIVATION. Comparing the rollup against itself would reconcile perfectly and prove nothing;
  // this sums the ledger directly, the way an auditor would.
  const ledger = (
    await sql<{ n: string; input: string; output: string; cost: string }>`
      select count(*)::text as n,
             coalesce(sum(input_tokens), 0)::text as input,
             coalesce(sum(output_tokens), 0)::text as output,
             coalesce(sum(estimated_cost_micros), 0)::text as cost
      from usage_events
      where account_id = ${accountId}::uuid and date_trunc('month', created_at at time zone 'UTC') = ${periodStart}::date
    `.execute(owner.kysely)
  ).rows[0];
  const summed: RollupFigures = {
    eventCount: Number(ledger?.n ?? '-1'),
    inputTokens: Number(ledger?.input ?? '-1'),
    outputTokens: Number(ledger?.output ?? '-1'),
    estimatedCostMicros: Number(ledger?.cost ?? '-1'),
  };
  const lanes: readonly (keyof RollupFigures)[] = ['eventCount', 'inputTokens', 'outputTokens', 'estimatedCostMicros'];
  const disagreeing = lanes.filter((lane) => rebuilt.figures?.[lane] !== summed[lane]);
  if (disagreeing.length > 0) {
    return bail('usage totals reconcile', 'USAGE-001', `the account rollup disagrees with the ledger on ${disagreeing.join(', ')}: rollup=${JSON.stringify(rebuilt.figures)} ledger=${JSON.stringify(summed)}`);
  }
  // …and the SUPPRESSED DUPLICATE is counted once, not twice. Three deliveries in this company, two events.
  if (summed.eventCount !== 3) {
    return bail('the suppressed duplicate is counted once', 'trust-critical #12', `expected 3 events across the account (2 here + 1 in the sibling, from 4 deliveries), got ${summed.eventCount}`);
  }

  const reconciled = await ops.reconcileAccountUsageRollup(product, { userId, accountId, periodStart, threshold: ZERO_DRIFT });
  if (reconciled.status !== 'ok' || reconciled.drift === undefined) return bail('usage totals reconcile', 'USAGE-001', `reconcileAccountUsageRollup expected ok, got ${reconciled.status}`);
  const drifted = lanes.filter((lane) => reconciled.drift?.[lane] !== 0);
  if (drifted.length > 0 || (reconciled.lanesExceedingThreshold ?? []).length > 0) {
    return bail('usage totals reconcile', 'USAGE-001 / launch gate 7', `drift at a ZERO threshold on ${[...drifted, ...(reconciled.lanesExceedingThreshold ?? [])].join(', ')}: ${JSON.stringify(reconciled.drift)}`);
  }
  record(
    'the account and company usage totals reconcile after the refusals, the halt and the recovery',
    'USAGE-001 / launch gate 7',
    true,
    `${summed.eventCount} event(s) across ${String(rebuilt.companyCount)} companies; the rollup equals an independent ledger sum on all four lanes; zero drift at a ZERO threshold (the exactness claim, not the owner's alert policy — CDR-077 §G8). Four metered deliveries produced three billable events`,
  );

  return { steps };
}
