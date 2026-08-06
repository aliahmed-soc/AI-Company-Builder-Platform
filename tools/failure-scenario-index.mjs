// ACBP — the failure-scenario evidence index (ACBP-P7-008; CDR-084 §3).
//
// `docs/architecture/FAILURE-AND-RECOVERY.md` is a sixteen-row table and CDR-059:14 calls it "the
// specification". ACBP-P7-008's acceptance criterion is "16-scenario matrix green". This file records, per row,
// WHAT ACTUALLY PROVES IT — and `check-failure-scenario-index.mjs` fails the build when a row drifts from the
// code.
//
// THE RULE, inherited from CDR-080 §2 and sharpened for this matrix:
//
//   A ROW IS GREEN ONLY WHEN A TEST *INJECTS* THE FAILURE AT A PRODUCTION ENTRY POINT, ASSERTS THE ROW'S OWN
//   DOCUMENTED CONSEQUENCE, AND A RECORDED MUTATION MADE THAT TEST GO RED IN A HOSTED CI RUN.
//
// "Injects" is the word that does the work. CDR-059:113 levelled exactly this complaint at its own tests:
// *"Nothing here injects anything: the contract tests construct input objects and the integration tests write
// already-failed rows."* Constructing a failed input, or INSERTing an already-failed row to exercise a CHECK
// constraint, is not injection. The fault must enter a dependency the production path calls, and the production
// path must be the thing that reacts.
//
// WHY THE `consequence` COLUMN EXISTS. Every matrix row specifies a state transition, a user-facing status, an
// audit event and a usage behaviour. A test asserting only "it failed" proves the least interesting cell of the
// row it claims. `consequence` names which cell is actually asserted, so a row cannot borrow credit for the
// other three.
//
// SLICE 1 BUILT THIS TABLE BY READING TEST BODIES, AND CORRECTED THE CDR TWICE WHILE DOING IT: rows 6 and 14
// were provisionally recorded as having no coverage and both were wrong — row 14 is one of the best-covered
// rows in the repository. The corrections are in each row's `notes`, because a disposition table that quietly
// improves is the artefact class this repository has learned not to trust.

/** Closed vocabulary. Prose cannot round a weak anchor up to "green" if the column is a fixed set. */
export const ANCHOR_CLASSES = Object.freeze([
  'database_state', //     the test reads the row (or its absence) back from PostgreSQL
  'recorded_row', //       the test asserts a durable record was written (audit/usage/tool_calls)
  'return_value_only', //  the test asserts only what the function returned
  'pure_helper_only', //   the test calls a pure predicate on a hand-made value
  'none', //               nothing asserts it
]);

export const STATUSES = Object.freeze([
  'measured', //    a mutation made the named test go red in a hosted CI run — the only GREEN state
  'unmeasured', //  a test exists and passes, but nothing has proved it can fail
  'absent', //      no test injects this failure
  'unbuildable', // the failure has no subject in this system; the reason is recorded
]);

/**
 * CEILING on rows not in the `measured` state. Compared against `origin/main` by the checker, so it cannot RISE
 * — the property CDR-080 §6.1 records as having claimed an enforcer it did not have until someone built one.
 *
 * It starts at 16 because NOTHING is measured yet: slice 6 runs the mutation probe. Fourteen rows have tests,
 * one is absent and one is unbuildable, and none of that is evidence until a red run says so.
 */
export const MAX_UNPROVEN = 16;

/**
 * One row per matrix row.
 *
 *  number        the matrix row number (1–16)
 *  failure       MUST match the matrix's `Failure` cell verbatim — pinned by the checker
 *  consequence   WHICH cell of the row the cited test asserts
 *  status        see STATUSES
 *  anchor        see ANCHOR_CLASSES
 *  injection     HOW the fault enters: which dependency is made to fail, at which seam ('' when none)
 *  file          repo-relative path of the proving suite ('' when none)
 *  testTitle     verbatim title, and the checker requires it be attached to a LIVE test(/it( call
 *  entryPoint    the production function the test drives ('' when it does not drive one)
 *  mutation      the exact edit that should make `testTitle` fail
 *  mutationRunId the hosted CI run in which it did ('' until slice 6)
 *  doesNotProve  the limit of this row's evidence — never blank
 *  notes         slice-1 verification record, including corrections to CDR-084's provisional table
 */
export const FAILURE_SCENARIO_INDEX = Object.freeze([
  {
    number: 1,
    failure: 'Model timeout',
    consequence: 'call → `timeout`; the deadline is enforced by the gateway, not the provider',
    status: 'unmeasured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider `{ kind: "hang", ms }` — a real deadline, not a thrown error',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'gateway enforces the per-class timeout when the provider hangs',
    entryPoint: 'callModel',
    mutation: 'Remove the per-class deadline from callModel so a hanging provider hangs the caller.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "Taking longer than expected" USER-FACING STATUS, its `model.call_completed(timeout)` audit, or the billable-once rule. This is a unit suite over an in-memory events array: no persisted usage row is read back.',
    notes: 'Verified slice 1. A sibling case pins that the deadline follows the TASK class rather than the request field.',
  },
  {
    number: 2,
    failure: 'Provider outage',
    consequence: 'fallback fires for an eligible class, and NEVER for a quality-bearing one',
    status: 'unmeasured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider `{ kind: "fail", error: "provider_unavailable" }` on the primary',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'fallback fires for an ELIGIBLE task class on a retryable exhaustion',
    entryPoint: 'callModel',
    mutation: 'Make every task class fallback-eligible so the ineligible sibling case also falls over.',
    mutationRunId: '',
    doesNotProve:
      'THE OTHER HALF OF THE ROW, which does not exist. The matrix requires "tasks queue", an "Honest banner: provider degraded", and "Operator: drain queue on recovery". There is no queue-on-outage, no provider-health banner and no drain path in the repository. CDR-059:98 already records this and assigns it to P6/observability. NFR-019 is nonetheless marked `Covered` in BOTH traceability matrices — CDR-084 §7 item 4 asks whether that stands.',
    notes: 'Verified slice 1: fallback genuinely injected; the queue/banner/drain half genuinely absent.',
  },
  {
    number: 3,
    failure: 'Invalid structured output',
    consequence: '`invalid_output` after bounded re-asks — the cap is enforced, not advisory',
    status: 'unmeasured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider scripted to return unparseable output on every call',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 're-ask is bounded: still-invalid after the cap → invalid_output',
    entryPoint: 'callModel',
    mutation: 'Remove the re-ask cap so the gateway re-asks forever instead of failing.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "plain-language reason (TASK-006)" reaching a user, or "credit released". A sibling case proves the bounded re-ask SUCCEEDS when the second attempt is valid, which is the control that stops this passing on a gateway that never re-asks at all.',
    notes: 'Verified slice 1.',
  },
  {
    number: 4,
    failure: 'Worker crash',
    consequence: 'run `running→failed(worker_lost)` after the heartbeat grace, read back from the database',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'a worker that stops heartbeating past the grace window, then the real reaper sweep',
    file: 'packages/core/src/runs/coordinator.integration.test.ts',
    testTitle: 'TIMEOUT WORKS — a run whose worker went silent past the grace is failed as worker_lost',
    entryPoint: 'the run coordinator sweep',
    mutation: 'Widen the heartbeat grace to infinity so a silent worker is never reclaimed.',
    mutationRunId: '',
    doesNotProve:
      'The resume-from-checkpoint alternative in the same row — that is proven separately by the kill-and-resume case in `checkpoint.integration.test.ts` — nor the "Dead-letter → Decision Room blocked queue" recovery. Siblings pin that a LIVE run is never reclaimed and that a heartbeat cannot revive an already-reclaimed one.',
    notes: 'Verified slice 1. The NFR-005 anchor. Real PostgreSQL; skipped locally without ACBP_TEST_DATABASE_URL.',
  },
  {
    number: 5,
    failure: 'Queue/job-store outage',
    consequence: '',
    status: 'absent',
    anchor: 'none',
    injection: '',
    file: '',
    testTitle: '',
    entryPoint: '',
    mutation: 'Make the job store reject writes, then attempt to start a run; expect a fail-closed refusal.',
    mutationRunId: '',
    doesNotProve:
      'ANYTHING — this is the matrix\'s one genuine absence, and it is absent twice over. All 27 tests in `enqueue-job.integration.test.ts` were read in slice 1: tenancy stamping, three redundant refusal layers, authz, immutability, state vocabulary and idempotency. None simulates store UNAVAILABILITY. Worse, the row\'s detection is "Enqueue/pickup errors" and THERE IS NO PICKUP IMPLEMENTATION — `dequeue|claimJob|pickup|pollJobs|nextJob|reserveJob` match nothing; the only hit is an index comment in `migrations/0031_jobs.ts` describing a runner that does not exist. Injecting this needs a job-store seam that does not exist, which CDR-084 §7 item 2 raises as an owner decision: a fault hook reachable in production is a liability.',
    notes: 'Verified slice 1 — CONFIRMED absent, and the missing pickup path is a finding the CDR did not have.',
  },
  {
    number: 6,
    failure: 'Database outage',
    consequence: 'no partial writes — a transaction that fails midway leaves nothing behind',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'a throw inside `withTransaction` after a real statement has already executed',
    file: 'packages/database/src/integration/database.integration.test.ts',
    testTitle: 'transaction rolls back on failure and releases the connection',
    entryPoint: 'withTransaction',
    mutation: 'Swallow the error inside withTransaction so it COMMITs instead of rolling back.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "Platform read-only/unavailable" TRANSITION or its "Honest maintenance status". Nothing asserts a user-facing surface degrades when the database is down. `client.test.ts`\'s `checkDatabaseHealth` case does inject a real ECONNREFUSED, but asserts a returned health object — not that any product path refuses work.',
    notes:
      'CORRECTED IN SLICE 1: CDR-084 provisionally called this row ABSENT. Wrong. The no-partial-writes half is genuinely injected, here and in at least five other places (a rejected migration mid-sequence, a stop service that throws after its first write, a policy supersession that conflicts, a checkpoint step that writes then throws, a webhook user-mutation failure). Only the outage TRANSITION is uncovered.',
  },
  {
    number: 7,
    failure: 'Object-storage failure',
    consequence: 'artifact persist fails ⇒ task fails, and NO artifact row exists afterwards',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'InMemoryObjectStorage `dropNextPut()` — the dependency LIES, reporting success while storing nothing',
    file: 'packages/core/src/artifacts/persist.integration.test.ts',
    testTitle: 'a storage write that REPORTS SUCCESS while storing nothing refuses, and writes no row',
    entryPoint: 'persistArtifact',
    mutation: 'Trust the storage adapter\'s reported metadata instead of verifying the object landed.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "Credit released" or its `task.failed` audit. Sibling cases cover a THROWING write and a TRUNCATED one, and that a retry after refusal ends with exactly one artifact.',
    notes:
      'Verified slice 1 — the strongest real injection in the repository, and the only place that distinguishes a dependency that FAILS from one that LIES. The row count is read through the OWNER client, so RLS cannot fool it.',
  },
  {
    number: 8,
    failure: 'Tool/API failure (future external)',
    consequence: 'a throwing step is recorded as a failure with a category — but NOT a distinguishable one',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'a worker step that throws, driven through the real runtime',
    file: 'packages/core/src/workers/runtime.integration.test.ts',
    testTitle: 'a THROWING step is recorded as a provider_error, not rolled back into nothing',
    entryPoint: 'the worker runtime step executor',
    mutation: 'Roll the whole run back on a throwing step so no failed row survives.',
    mutationRunId: '',
    doesNotProve:
      'THE ROW\'S ACTUAL CLAIM. The row wants a tool call `failed` with a NORMALIZED CATEGORY distinguishing a tool fault from a provider fault, and requires idempotency keys for external classes. `runtime.ts` has a bare `catch {}` that finishes with `failureCategory: "provider_error"` unconditionally, so the two are indistinguishable. Fixing it needs a MIGRATION, not just code: `RUN_FAILURE_CATEGORIES` is a closed five-value set with no `tool_error`, mirrored by CHECK constraints on `task_runs` and `worker_runs` and pinned by a test asserting the constant and the CHECK are the same set. CDR-084 §7 item 5.',
    notes: 'Verified slice 1. CDR-059:103 named this row unserved for the same reason; the migration requirement is new.',
  },
  {
    number: 9,
    failure: 'Expired authorization (approval)',
    consequence: 'the database refuses an approval decided by a worker',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'an INSERT that violates the decider_type CHECK',
    file: 'packages/database/src/integration/approvals.integration.test.ts',
    testTitle: 'a WORKER cannot be recorded as having decided an approval — the database refuses it',
    entryPoint: '',
    mutation: "Widen the decider_type CHECK to accept 'worker'.",
    mutationRunId: '',
    doesNotProve:
      'EXPIRY, which is what the row is about. This is the nearest real evidence and it is about WHO may decide, not WHEN an approval lapses. "Cannot execute" is never asserted at `dispatchToolCall`: searching both dispatcher suites for "expired" returns ZERO cases while every sibling approval state has one. Identical to trust-critical #7, which ACBP-P7-007 recorded as `not_covered`. The cited test also does not INJECT into a production path — it exercises a constraint directly.',
    notes: 'Verified slice 1. The weakest citation in this index, and it says so.',
  },
  {
    number: 10,
    failure: 'Revoked integration',
    consequence: '',
    status: 'unbuildable',
    anchor: 'none',
    injection: '',
    file: '',
    testTitle: '',
    entryPoint: '',
    mutation: '',
    mutationRunId: '',
    doesNotProve:
      'There is no integrations entity anywhere in this repository: no table, no migration, no service, no contract. `TOOL_DENIAL_REASONS` has eleven values and none is integration-related. The matrix itself labels the sibling row 8 "(future external)", and `REQUIREMENTS.csv` marks NFR-020 Post-MVP with the ticket traceability recording "Deferred by approved scope". This is the identical absence ACBP-P7-007 recorded as trust-critical #8 `unprovable`. **A literal "16/16 green" is unreachable while this row exists.**',
    notes: 'Verified slice 1 — CONFIRMED. CDR-084 §5 removed NFR-020 from the ticket on the owner\'s ruling.',
  },
  {
    number: 11,
    failure: 'Duplicate delivery (job/event)',
    consequence: 'the duplicate is suppressed AND the suppression is recorded',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'the production enqueue path is called TWICE with the same idempotency key',
    file: 'packages/core/src/idempotency/replay.integration.test.ts',
    testTitle: 'a re-delivered enqueue creates no second job, and the suppression is recorded',
    entryPoint: 'enqueueJob',
    mutation: 'Drop the idempotency-key lookup so the second delivery inserts a second job.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "duplicate-suppression incident counter" as an operational metric. Two anchors per case — real row counts read through the OWNER client plus a suppression log incident — because CDR-074 §0 requires that a suite checking only "one row exists" would pass against a build with every guard removed. Negative controls pin that two KEYLESS deliveries are two jobs, so the mechanism never suppresses by accident.',
    notes:
      'Verified slice 1 — joint-strongest. All nine cases call the production path twice rather than testing a dedupe helper in isolation. The file records a PAST version of this defect: a test that called the inner function directly was green while the only surface that suppresses anything in production recorded nothing.',
  },
  {
    number: 12,
    failure: 'Partial completion (multi-step run)',
    consequence: 'resume from checkpoint — a killed run continues rather than restarting',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'a run killed mid-sequence, then resumed against the real checkpoint rows',
    file: 'packages/core/src/jobs/checkpoint.integration.test.ts',
    testTitle: 'KILL AND RESUME — a crashed plan resumes without re-running the step that already completed',
    entryPoint: 'the job step executor',
    mutation: 'Ignore existing checkpoints on resume so completed steps re-run.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "fail with partials LABELED partial" branch, or the "Discard-partials option" compensation. No user-facing partial-labelling surface was found. The checkpoint/transaction case (a step that writes then throws leaving nothing) is row 6\'s evidence, not this row\'s.',
    notes: 'Verified slice 1.',
  },
  {
    number: 13,
    failure: 'Usage-recording failure',
    consequence: 'metered work BLOCKS — the call aborts and the output is withheld',
    status: 'unmeasured',
    anchor: 'return_value_only',
    injection: 'a `recordUsage` dependency that rejects',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'a usage-write failure aborts the call and withholds the output',
    entryPoint: 'callModel',
    mutation: 'Swallow the usage-write rejection and return the output anyway.',
    mutationRunId: '',
    doesNotProve:
      'That the ledger is reconcilable afterwards, or the row\'s "Compensating entries". Withholding is asserted on the returned result, not on a persisted row — the fail-closed decision is in-process, so there is no durable artefact to read back.',
    notes: 'Verified slice 1 — genuine injection, and the USAGE-001 fail-closed anchor.',
  },
  {
    number: 14,
    failure: 'Audit-event failure',
    consequence: 'the action is BLOCKED and rolled back — no job row survives an audit-write failure',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'the documented `auditWriter` test seam, substituted with one that rejects',
    file: 'packages/core/src/jobs/enqueue-job.integration.test.ts',
    testTitle: 'audit-or-nothing: when the audit write fails, NO job row survives (ADR-015)',
    entryPoint: 'enqueueJob',
    mutation: 'Catch the audit-write rejection inside the transaction so the job row commits without its audit.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "low-risk queued with alert" branch — every test asserts a hard rollback and nothing exercises a degraded queue-and-alert path — nor its "Audit writes idempotent" note. The high-risk fail-closed clause is covered at roughly 25 entry points across seventeen subsystems.',
    notes:
      'CORRECTED IN SLICE 1, AND THIS WAS THE EXPENSIVE ERROR: CDR-084 provisionally called this row ABSENT. It is one of the best-covered rows in the repository. The cited test lives in the SAME FILE the CDR cited as evidence for row 5. Building "audit failure blocks the operation" would have rebuilt mature, deliberately designed work.',
  },
  {
    number: 15,
    failure: 'Emergency stop during execution',
    consequence: 'the next tool call is blocked at the dispatcher and the refusal is RECORDED',
    status: 'unmeasured',
    anchor: 'recorded_row',
    injection: 'a live stop activated between calls, then a real dispatch attempt',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'a REAL account-wide stop refuses the call',
    entryPoint: 'the worker runtime step boundary',
    mutation: 'Skip the stop check at the step boundary so a stopped run continues.',
    mutationRunId: '',
    doesNotProve:
      'Two things the row asserts. Only FIVE of the seven stop scopes are enforceable — `capability` and `integration` are inert (CDR-072) — and the ≤5s activation window measured for launch gate 8 uses a raw INSERT helper, so it EXCLUDES the production activation path entirely (`TEST-AND-VERIFICATION-STRATEGY.md:42`). The "in-flight call finishes/aborts safely" clause shares row 16\'s problem below.',
    notes: 'Verified slice 1.',
  },
  {
    number: 16,
    failure: 'Company pause during execution',
    consequence: 'a paused company cannot START new autonomous work — refused before the claim',
    status: 'unmeasured',
    anchor: 'database_state',
    injection: 'a company moved to `paused`, then a real attempt to start a run',
    file: 'packages/core/src/company/gate-14.integration.test.ts',
    testTitle: 'a paused company CANNOT enqueue a job, and NO jobs row is created',
    entryPoint: 'startRun',
    mutation: 'Remove readLifecycleDecision from startRun so a paused company still starts runs.',
    mutationRunId: '',
    doesNotProve:
      'THE ROW AS WRITTEN, AND THE CANON CONTRADICTS ITSELF HERE. The matrix says "Safe-stop: current tool call completes, then halt". `WORKFLOW-STATE-MACHINES.md:35` says the opposite of today\'s system: *"\'in-flight safe-stop\' is NOT enforced by pausing. Pause refuses new work; it does not terminate a run already executing. The durable-stop sweep that would is unbuilt."* What is proven is the refusal of NEW work. **One of the two canon documents is wrong**, and CDR-084 §7 item 3 makes it an owner decision rather than a test decision.',
    notes: 'Verified slice 1. ACBP-P7-002 built the gate; the in-flight half was never built.',
  },
]);
