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
 * It STARTED at 16, because nothing was measured until slice 6 ran the probe. Each row the probe proves lowers
 * it by one — that is the only direction it may move, and lowering it is the work. Fourteen rows have tests, one
 * is absent and one is unbuildable, and a test that nobody has tried to break is not evidence.
 */
export const MAX_UNPROVEN = 6;

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
    // MEASURED in slice 6 wave 2, run 31215176255. TWO tests red, both about the deadline: this row's own, and
    // the sibling pinning that the deadline follows the TASK class rather than the request field. The edit
    // multiplied the per-class deadline so the 500ms hang finishes inside it; nothing else in the suite noticed.
    status: 'measured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider `{ kind: "hang", ms }` — a real deadline, not a thrown error',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'gateway enforces the per-class timeout when the provider hangs',
    entryPoint: 'callModel',
    mutation: 'Remove the per-class deadline from callModel so a hanging provider hangs the caller.',
    mutationRunId: '31215176255',
    doesNotProve:
      'The row\'s "Taking longer than expected" USER-FACING STATUS, its `model.call_completed(timeout)` audit, or the billable-once rule. This is a unit suite over an in-memory events array: no persisted usage row is read back.',
    notes: 'Verified slice 1. A sibling case pins that the deadline follows the TASK class rather than the request field.',
  },
  {
    number: 2,
    failure: 'Provider outage',
    consequence: 'fallback fires for an eligible class, and NEVER for a quality-bearing one',
    // MEASURED in slice 6 wave 2, run 31215094462. THREE red, all about fallback eligibility. The edit flipped ONE
    // class - `extraction`, the class this test drives - rather than the whole policy map, so the
    // ineligible-generation sibling stayed untouched and a red here is about eligibility, not about fallback
    // existing at all. A first attempt (`return false && ...`) was REJECTED BY LINT and never ran.
    status: 'measured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider `{ kind: "fail", error: "provider_unavailable" }` on the primary',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'fallback fires for an ELIGIBLE task class on a retryable exhaustion',
    entryPoint: 'callModel',
    // CORRECTED in slice 6: the previous text ("make every task class fallback-eligible") would have reddened the
    // INELIGIBLE sibling case, not this row's test, which stays green when MORE classes are eligible. A mutation
    // aimed at a neighbouring test is the ACBP-P7-007 row-19 defect exactly.
    mutation: 'Make `isFallbackEligible` return false for every task class, so an eligible class exhausting a retryable error returns the primary error instead of the fallback output.',
    mutationRunId: '31215094462',
    doesNotProve:
      'THE OTHER HALF OF THE ROW, which does not exist. The matrix requires "tasks queue", an "Honest banner: provider degraded", and "Operator: drain queue on recovery". There is no queue-on-outage, no provider-health banner and no drain path in the repository. CDR-059:98 already records this and assigns it to P6/observability. NFR-019 is nonetheless marked `Covered` in BOTH traceability matrices — CDR-084 §7 item 4 asks whether that stands.',
    notes: 'Verified slice 1: fallback genuinely injected; the queue/banner/drain half genuinely absent.',
  },
  {
    number: 3,
    failure: 'Invalid structured output',
    consequence: '`invalid_output` after bounded re-asks — the cap is enforced, not advisory',
    // MEASURED in slice 6 wave 1, run 31211276891. THREE red: this row's test and the conformance case asserting
    // `bounded retries <= 2, bounded re-ask <= 1` - honest collateral, since both read the same constant.
    status: 'measured',
    anchor: 'return_value_only',
    injection: 'FakeModelProvider scripted to return unparseable output on every call',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 're-ask is bounded: still-invalid after the cap → invalid_output',
    entryPoint: 'callModel',
    // Raising the cap rather than removing it: removing it makes the fixture loop forever and the only signal is a
    // suite timeout, which is a red that says nothing about the bound. +1 reddens the callCount and the accumulated
    // token assertions directly.
    mutation: 'Raise `MAX_REASK_ATTEMPTS` in @acbp/contracts from 1 to 2, so `runProvider` re-asks twice and the bound is no longer where canon puts it.',
    mutationRunId: '31211276891',
    doesNotProve:
      'The row\'s "plain-language reason (TASK-006)" reaching a user, or "credit released". A sibling case proves the bounded re-ask SUCCEEDS when the second attempt is valid, which is the control that stops this passing on a gateway that never re-asks at all.',
    notes: 'Verified slice 1.',
  },
  {
    number: 4,
    failure: 'Worker crash',
    consequence: 'run `running→failed(worker_lost)` after the heartbeat grace, read back from the database',
    // MEASURED in slice 6 wave 2, run 31215216065. SEVEN red, every one about heartbeat liveness or the reclaim
    // sweep, plus the Slice F journey which drives a real run. Wider collateral than rows 1 or 13, and recorded
    // as such: `isRunLost` is consulted by the sweep, the revive guard and the zombie check, so an edit to the
    // grace is felt by all of them. Confined to the mutated control's own behaviour is what surgical means here.
    status: 'measured',
    anchor: 'database_state',
    injection: 'a worker that stops heartbeating past the grace window, then the real reaper sweep',
    file: 'packages/core/src/runs/coordinator.integration.test.ts',
    testTitle: 'TIMEOUT WORKS — a run whose worker went silent past the grace is failed as worker_lost',
    entryPoint: 'reclaimLostRuns',
    mutation: 'Make `isRunLost` always return false (equivalently, set `DEFAULT_HEARTBEAT_GRACE_MS` to a value no test can outlive), so `reclaimLostRuns` never reclaims a silent worker.',
    mutationRunId: '31215216065',
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
    mutation: 'Delete the `verifyPersistedObject` call in `persistArtifact` and trust `storage.head`, so a write that reports success while storing nothing is accepted.',
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
    entryPoint: 'runWorkerStep',
    mutation: 'Wrap the body of `runWorkerStep` so a throwing step rolls its own transaction back instead of reaching `finishAs` with `provider_error`, leaving no failed row.',
    mutationRunId: '',
    doesNotProve:
      'THE ROW\'S ACTUAL CLAIM. The row wants a tool call `failed` with a NORMALIZED CATEGORY distinguishing a tool fault from a provider fault, and requires idempotency keys for external classes. `runtime.ts` has a bare `catch {}` that finishes with `failureCategory: "provider_error"` unconditionally, so the two are indistinguishable. Fixing it needs a MIGRATION, not just code: `RUN_FAILURE_CATEGORIES` is a closed five-value set with no `tool_error`, mirrored by CHECK constraints on `task_runs` and `worker_runs` and pinned by a test asserting the constant and the CHECK are the same set. CDR-084 §7 item 5.',
    notes: 'Verified slice 1. CDR-059:103 named this row unserved for the same reason; the migration requirement is new.',
  },
  {
    number: 9,
    failure: 'Expired authorization (approval)',
    consequence: 'the call is DENIED with `approval_invalid`, and the denial is recorded in `tool_calls`',
    // MEASURED in slice 6, run 31129056434: 2 of 3874 tests failed and they were the right two — this row's test
    // and the repository-layer sibling — while the CONTROL (`the SAME approval, unexpired, authorizes`) stayed
    // GREEN. The control holding is what makes the run evidence about EXPIRY rather than about a build that
    // refuses everything.
    status: 'measured',
    anchor: 'database_state',
    injection: 'a real human `approve` seeded with `expires_at` already in the past, then a real dispatch',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'an EXPIRED approval cannot execute — the call is denied and the denial is RECORDED',
    entryPoint: 'dispatchToolCall',
    mutation: 'Drop the `expires_at` conjunct from approvalUsability AND from verifyAndConsume\'s conditional UPDATE — both, because the UPDATE is the real enforcement and the pre-check is an equivalent mutation on its own (dispatcher.ts:388).',
    mutationRunId: '31129056434',
    doesNotProve:
      'The row\'s "task → cancelled/waiting" transition, its `approval.expired` audit event, or "Reservation released". A paired CONTROL seeds the identical approval unexpired and asserts it AUTHORIZES, so the refusal is about expiry rather than about anything else refusing `send_email`.',
    notes:
      'BUILT IN SLICE 4, and it closes trust-critical #7 at the same time. Until now BOTH were proven at the repository layer only — a `decider_type` CHECK test about WHO may decide, not WHEN an approval lapses — and searching either dispatcher suite for "expired" returned ZERO cases while every sibling approval state had one. The enforcement existed the whole time; nothing drove it from the chokepoint.',
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
    // MEASURED in slice 6 wave 2, run 31215134001. SIX red, all idempotency behaviour plus the Slice F journey.
    // THE MUTATION HAD TO BE CORRECTED FIRST: the previous text said to skip the `findByIdempotencyKey`
    // read-back, which CANNOT create a second job - dedupe is the partial unique index plus ON CONFLICT DO
    // NOTHING, and the read-back only resolves what already exists. The slice-6 rule passed that text because
    // its symbols are real; it cannot tell whether an edit achieves the effect the row claims.
    status: 'measured',
    anchor: 'database_state',
    injection: 'the production enqueue path is called TWICE with the same idempotency key',
    file: 'packages/core/src/idempotency/replay.integration.test.ts',
    testTitle: 'a re-delivered enqueue creates no second job, and the suppression is recorded',
    entryPoint: 'enqueueJob',
    // CORRECTED in slice 6 wave 2, after the probe proved the old text inert: skipping the read-back cannot
    // create a second job, because the partial unique index plus ON CONFLICT DO NOTHING is what dedupes.
    mutation: 'Store `idempotencyKey: null` on the insert inside `enqueueJob`, so the partial unique index cannot match a re-delivery and a second job row is created.',
    mutationRunId: '31215134001',
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
    entryPoint: 'runJobStep',
    mutation: 'Make `runJobStep` ignore its `listCheckpoints` read, so a step that already completed runs a second time on resume.',
    mutationRunId: '',
    doesNotProve:
      'The row\'s "fail with partials LABELED partial" branch, or the "Discard-partials option" compensation. No user-facing partial-labelling surface was found. The checkpoint/transaction case (a step that writes then throws leaving nothing) is row 6\'s evidence, not this row\'s.',
    notes: 'Verified slice 1.',
  },
  {
    number: 13,
    failure: 'Usage-recording failure',
    consequence: 'metered work BLOCKS — the call aborts and the output is withheld',
    // MEASURED in slice 6 wave 1, run 31212321748. THREE red, all fail-closed metering: this row's test and the
    // two siblings asserting the same rule on the persisted and invalid-output paths.
    status: 'measured',
    anchor: 'return_value_only',
    injection: 'a `recordUsage` dependency that rejects',
    file: 'packages/core/src/model/model-gateway.test.ts',
    testTitle: 'a usage-write failure aborts the call and withholds the output',
    entryPoint: 'callModel',
    mutation: 'Catch the `recordUsage` rejection inside `callModel` and return the output anyway, so the call is answered un-metered.',
    mutationRunId: '31212321748',
    doesNotProve:
      'That the ledger is reconcilable afterwards, or the row\'s "Compensating entries". Withholding is asserted on the returned result, not on a persisted row — the fail-closed decision is in-process, so there is no durable artefact to read back.',
    notes: 'Verified slice 1 — genuine injection, and the USAGE-001 fail-closed anchor.',
  },
  {
    number: 14,
    failure: 'Audit-event failure',
    consequence: 'the action is BLOCKED and rolled back — no job row survives an audit-write failure',
    // MEASURED in slice 6, run 31140772210: EXACTLY ONE test failed of 3874, this row's own. The swallow was a
    // try/catch around the audit call inside the transaction, so the job row committed without its audit event —
    // which is the state ADR-015 exists to make impossible, produced deliberately and observed at the database.
    // The fault enters through `auditWriter`, the seam the TEST supplies, which is why this row counts as
    // genuinely INJECTED under CDR-084 §1 rather than as an already-failed row written by hand.
    status: 'measured',
    anchor: 'database_state',
    injection: 'the documented `auditWriter` test seam, substituted with one that rejects',
    file: 'packages/core/src/jobs/enqueue-job.integration.test.ts',
    testTitle: 'audit-or-nothing: when the audit write fails, NO job row survives (ADR-015)',
    entryPoint: 'enqueueJob',
    mutation: 'Catch the `writeAuditEvent` rejection inside the transaction in `enqueueJob`, so the job row commits without its audit event.',
    mutationRunId: '31140772210',
    doesNotProve:
      'The row\'s "low-risk queued with alert" branch — every test asserts a hard rollback and nothing exercises a degraded queue-and-alert path — nor its "Audit writes idempotent" note. The high-risk fail-closed clause is covered at roughly 25 entry points across seventeen subsystems.',
    notes:
      'CORRECTED IN SLICE 1, AND THIS WAS THE EXPENSIVE ERROR: CDR-084 provisionally called this row ABSENT. It is one of the best-covered rows in the repository. The cited test lives in the SAME FILE the CDR cited as evidence for row 5. Building "audit failure blocks the operation" would have rebuilt mature, deliberately designed work.',
  },
  {
    number: 15,
    failure: 'Emergency stop during execution',
    consequence: 'the next tool call is blocked at the dispatcher and the refusal is RECORDED',
    // MEASURED in slice 6, run 31129196873. NINE tests went red and EVERY ONE of them depends on `account_wide`:
    // this row's test, the matrix's own account_wide case, the hold/pause/audit/evidence group that seeds an
    // account-wide stop as its fixture, and three contract units. The FOUR sibling scopes — task, worker,
    // company, external_actions_only — all stayed GREEN, as did `MISSES — another ACCOUNT's account-wide stop
    // does not halt this one`. That pattern is what makes the run evidence about THIS scope rather than about
    // stops in general; a mutation that reddened every scope would prove only that stops exist.
    status: 'measured',
    anchor: 'recorded_row',
    injection: 'a live stop activated between calls, then a real dispatch attempt',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'a REAL account-wide stop refuses the call',
    entryPoint: 'dispatchToolCall',
    mutation: 'Drop the `account_wide` case from `evaluateStops`, so an active account-wide stop no longer covers the dispatched call.',
    mutationRunId: '31129196873',
    doesNotProve:
      'Only FIVE of the seven stop scopes are enforceable — `capability` and `integration` are inert (CDR-072) — so "execution halts" is proven for five of seven, not seven. The "in-flight call finishes/aborts safely" clause shares row 16\'s problem below. The launch-gate-8 ≤5s window now IS measured across the production `activateStop` use case (slice 5), but for the `company` scope only; the per-scope matrix beside it still times a raw INSERT and therefore still measures transaction visibility rather than activation.',
    notes:
      'Verified slice 1. Slice 5 closed the half this field previously recorded as excluded — the ≤5s measurement no longer skips the production activation path.',
  },
  {
    number: 16,
    failure: 'Company pause during execution',
    consequence: 'a paused company cannot START new autonomous work — refused before the claim',
    // MEASURED in slice 6, run 31140011057, and it is the CLEANEST result in the probe: EXACTLY ONE test failed
    // of 3874, this row's own, with no collateral at all. The sibling case `but a REPLAY of a job enqueued
    // BEFORE the pause is still answered — not refused` stayed GREEN, because the replay branch returns before
    // the removed refusal; so the run also demonstrates the gate is scoped to NEW work rather than to replays.
    // It confirms the entryPoint correction above independently: mutating `enqueueJob` reddens this test, and
    // `startRun` — which the row named until slice 6 — is a different function this test never calls.
    status: 'measured',
    anchor: 'database_state',
    injection: 'a company moved to `paused`, then a real attempt to start a run',
    file: 'packages/core/src/company/gate-14.integration.test.ts',
    testTitle: 'a paused company CANNOT enqueue a job, and NO jobs row is created',
    // CORRECTED in slice 6: this row said `startRun` while its cited test drives `enqueueJob`. Both are real
    // functions used in the SAME file, so the mutation-names-real-code rule passes it — that is the limit the
    // rule states about itself, found by the same audit that built it. A human read the test body; no tool did.
    entryPoint: 'enqueueJob',
    mutation: 'Delete the `readLifecycleDecision` gate from `enqueueJob` (enqueue-job.ts), so a paused company enqueues the job and a row is created.',
    mutationRunId: '31140011057',
    doesNotProve:
      'THE ROW AS WRITTEN, AND THE CANON CONTRADICTS ITSELF HERE. The matrix says "Safe-stop: current tool call completes, then halt". `WORKFLOW-STATE-MACHINES.md:35` says the opposite of today\'s system: *"\'in-flight safe-stop\' is NOT enforced by pausing. Pause refuses new work; it does not terminate a run already executing. The durable-stop sweep that would is unbuilt."* What is proven is the refusal of NEW work. **One of the two canon documents is wrong**, and CDR-084 §7 item 3 makes it an owner decision rather than a test decision.',
    notes: 'Verified slice 1. ACBP-P7-002 built the gate; the in-flight half was never built.',
  },
]);
