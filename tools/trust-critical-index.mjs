// ACBP — the trust-critical evidence index (ACBP-P7-007; CDR-080 §6).
//
// WHY THIS FILE EXISTS. `docs/implementation/TEST-AND-VERIFICATION-STRATEGY.md` lists twenty mandatory negative
// tests, each with a parenthesised ticket attribution. An eight-agent investigation for ACBP-P7-007 read the
// test BODIES behind all twenty and found: SEVEN attributions wrong or incomplete, TWO negatives with no test at
// all, FOUR resting on a returned value rather than on database state, and THREE whose claim as worded is never
// executed. Item 9 credited ACBP-P6-007 for a gate ACBP-P7-002 later proved P6-007 had never built.
//
// That is the ACBP-P7-002 failure mode — an artefact asserting a control nobody wrote — reproduced in the list
// this repository uses to decide whether it is safe to ship. A table of attributions is not evidence.
//
// So this index records, per negative, WHAT ACTUALLY PROVES IT, and `check-trust-critical-index.mjs` fails the
// build when a row drifts from the code. The load-bearing column is `mutationRunId`:
//
//   A NEGATIVE IS GREEN ONLY WHEN A RECORDED MUTATION MADE ITS NAMED TEST GO RED IN A HOSTED CI RUN.
//
// Not a probe SHA. ACBP-P6-006 recorded its probe commit `fe85082`; that commit is reachable from no ref today
// because the branch was squash-merged and deleted, and only the run id (`30646208952`, CDR-071:184) survived.
// `P7-002-REVIEW-COVERAGE.md` §2.1 told the next ticket to record the run id. This is that ticket.
//
// A row without a run id is NOT green. It is UNMEASURED, in that word, and `MAX_UNPROVEN` below is a ceiling on
// how many rows may be in that state.
//
// TWO LIMITS OF THIS FILE, STATED HERE BECAUSE A READER WILL OTHERWISE ASSUME OTHERWISE.
//
//   1. `mutationRunId` IS SELF-ASSERTED. The checker verifies its SHAPE, not its existence: it never contacts
//      GitHub, so it cannot confirm the run happened, that it failed, or that it failed the test named in the
//      same row. A six-digit number typed by hand passes. What the field buys is that the claim is DURABLE and
//      CHECKABLE BY A HUMAN — `gh run view <id>` resolves long after the probe branch is deleted, which is
//      exactly what a probe SHA does not do. It is an audit trail, not an oracle.
//   2. NOTHING MACHINE-CHECKS THE MUTATION AGAINST THE TEST TITLE. ACBP-P7-007 marked row 19 `measured` on run
//      31113087854, in which a DIFFERENT test in the same file went red; two independent reviews caught it and
//      this checker could not. Until that cross-check exists, a `measured` row means "the author says this run
//      reddened this test" — go read the run.
//
// Both are recorded as open items in CDR-080 §7 rather than papered over.

/** Closed vocabulary. Prose cannot round a weak anchor up to "green" if the column is a fixed set. */
export const ANCHOR_CLASSES = Object.freeze([
  'database_state', //   the test reads the row (or its absence) back from PostgreSQL
  'recorded_row', //     the test asserts a durable record was written (audit/tool_calls/usage)
  'return_value_only', // the test asserts only what the function returned
  'pure_helper_only', //  the test calls a pure predicate on a hand-made value; proves nothing about production
  'none', //              nothing asserts it
]);

export const STATUSES = Object.freeze([
  'measured', //    a mutation made the named test go red in a hosted CI run — the only GREEN state
  'unmeasured', //  a test exists and passes, but nothing has proved it can fail
  'not_covered', // no test asserts this claim
  'unprovable', //  cannot be tested in this repository; the reason is recorded
]);

/**
 * CEILING on the number of rows NOT in the `measured` state — unmeasured + not_covered + unprovable.
 *
 * IT COUNTS UNPROVEN, NOT UNMEASURED, and the difference is load-bearing. A first version counted `unmeasured`
 * alone; the first time a negative gained a test (#15, slice 3) that row moved `not_covered → unmeasured` and
 * the count ROSE, so it failed the build FOR ADDING COVERAGE. Counting everything not yet measured fixes it:
 * adding a test leaves the total unchanged, recording a red run lowers it, and losing a measurement raises it.
 *
 * IT IS CALLED A CEILING AND NOT A RATCHET, DELIBERATELY. An earlier version of this comment said "it may only
 * ever go DOWN", and NOTHING ENFORCED THAT — the number is an editable integer in a file any author can edit in
 * the same commit that breaks a measurement, and the checker only ever compares the live count against whatever
 * this line says. An independent review named it: per this repository's own rule, a comment claiming a guarantee
 * must be able to name its enforcer, and this one could not. `tools/check-trust-critical-index.mjs` now compares
 * this value against the merge-base of `origin/main` and FAILS when it rises, so the word is earned on any tree
 * with git history; where there is no baseline to read (a shallow or export-only checkout) it says so out loud
 * rather than passing quietly.
 */
export const MAX_UNPROVEN = 18;

/**
 * One row per canonical negative.
 *
 *  number        the canonical item number
 *  statement     MUST match the canon line verbatim (minus its attribution) — pinned by the checker
 *  attributedTo  what TEST-AND-VERIFICATION-STRATEGY.md currently credits
 *  builtBy       what actually built it, where those differ
 *  status        see STATUSES
 *  anchor        see ANCHOR_CLASSES
 *  file          repo-relative path to the proving suite ('' when none)
 *  testTitle     verbatim `test(...)` title — pinned by the checker, so renaming a test breaks the BUILD
 *  entryPoint    the production function the test drives ('' when it does not drive one)
 *  mutation      the exact edit that should make `testTitle` fail
 *  mutationRunId the hosted CI run in which that edit DID make it fail
 *  doesNotProve  the honest limit of this evidence — required, and never blank
 */
export const TRUST_CRITICAL_INDEX = Object.freeze([
  {
    number: 1,
    statement: "Tenant A cannot retrieve Tenant B's company.",
    attributedTo: 'P1-014',
    builtBy: 'ACBP-P1-014',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'apps/web/src/server/adversarial/http-routes.adversarial.integration.test.ts',
    testTitle:
      '[ORACLE-FOREIGN-ID][ORACLE-UNKNOWN-ID][ORACLE-MALFORMED-ID] foreign and unknown ids are byte-identical; malformed ids never succeed or leak',
    entryPoint: 'HTTP route handlers → core → PostgreSQL',
    mutation: 'Remove the application tenant predicate from the company read and rely on RLS alone.',
    mutationRunId: '',
    doesNotProve:
      'Byte-identity of the RESPONSE. Timing and error-shape side channels are out of scope, and no test measures response latency.',
  },
  {
    number: 2,
    statement: "Tenant A cannot guess/enumerate Tenant B's artifacts (IDs, storage paths, exports).",
    attributedTo: 'P1-014, P5-011, P7-001',
    builtBy: 'ACBP-P1-014 (ids), ACBP-P5-011 (storage keys), ACBP-P7-001 (exports)',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/database/src/integration/artifacts.integration.test.ts',
    testTitle: 'TRUST-CRITICAL #2: an object key carrying ANOTHER company prefix is refused by the row itself',
    entryPoint: 'direct INSERT under the restricted role (the constraint IS the control)',
    mutation: 'Drop the object_key prefix CHECK added by migration 0043.',
    mutationRunId: '',
    doesNotProve:
      'The READ side over HTTP: no route serves artifacts or exports yet, and the only storage adapter is in-memory. This is the WRITE-side proof only.',
  },
  {
    number: 3,
    statement: 'A worker cannot run without explicit tenant context.',
    attributedTo: 'P5-001/005',
    builtBy: 'ACBP-P5-001a — the `/005` half is UNEARNED (see doesNotProve)',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/jobs/enqueue-job.integration.test.ts',
    testTitle: 'LAYER 3 — a context-stripped enqueue is REFUSED with a typed reason and writes nothing',
    entryPoint: 'enqueueJob',
    mutation: 'Delete the tenancy refusal in enqueueJob so a context-stripped request reaches the insert.',
    mutationRunId: '',
    doesNotProve:
      'The WORKER RUNTIME. `runtime.ts:1` and `migrations/0040_worker_runs.ts:1` both DECLARE trust-critical #3, and no worker-runtime entry point is ever driven with absent context. The proof is about enqueue, not about running.',
  },
  {
    number: 4,
    statement: 'A tool not in the worker allowlist is denied.',
    attributedTo: 'P5-003',
    builtBy: 'ACBP-P5-003 (chokepoint) + ACBP-P5-004 (the registered allowlist itself)',
    status: 'unmeasured',
    anchor: 'recorded_row',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'every enforceable scope has a covering case here — a scope added without one fails rather than goes unproven',
    entryPoint: 'dispatchToolCall',
    mutation: 'Remove the allowlist conjunct from decideDispatch and dispatch an unregistered tool.',
    mutationRunId: '',
    doesNotProve:
      'That the chokepoint is UNAVOIDABLE. `dispatchToolCall` has no production caller — every call site is a test or the slice-F journey — and there is no static guard (cf. check-approval-port.mjs) preventing a step closure from calling a tool directly.',
  },
  {
    number: 5,
    statement: 'Model output cannot approve an action.',
    attributedTo: 'P6-003/004',
    builtBy: 'ACBP-P6-003/004',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/database/src/integration/approvals.integration.test.ts',
    testTitle: 'a WORKER cannot be recorded as having decided an approval — the database refuses it',
    entryPoint: 'direct INSERT under the restricted role (the CHECK constraint IS the control)',
    mutation: "Widen the decider_type CHECK to accept 'worker'.",
    mutationRunId: '',
    doesNotProve:
      'That no code PATH attempts it — this proves the database refuses the write, not that the application never tries.',
  },
  {
    number: 6,
    statement: 'Editing a material approved payload invalidates approval.',
    attributedTo: 'P6-005',
    builtBy: 'ACBP-P6-005',
    status: 'unmeasured',
    anchor: 'recorded_row',
    file: 'packages/core/src/tools/policy-enforcement.integration.test.ts',
    testTitle: 'the UNCHANGED action still runs — the suite is not simply refusing everything',
    entryPoint: 'dispatchToolCall',
    mutation: 'Stop including a bound element in the payload hash so an edit to it no longer invalidates.',
    mutationRunId: '',
    doesNotProve:
      'Nothing outstanding — this is the anti-vacuity CONTROL for the gate-4 set. The per-element cases are indexed in CDR-070 §2 and are the substantive proof.',
  },
  {
    number: 7,
    statement: 'Expired approval cannot execute.',
    attributedTo: 'P6-004',
    builtBy: 'ACBP-P6-004 (repository layer only)',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'an EXPIRED approval cannot execute — the call is denied and the denial is RECORDED',
    entryPoint: 'dispatchToolCall',
    mutation: 'Delete the `expires_at > now()` conjunct from verifyAndConsume\'s conditional UPDATE AND the approval-usability pre-check — both, because the UPDATE is the enforcement and the pre-check alone is an equivalent mutation (dispatcher.ts:388).',
    mutationRunId: '',
    doesNotProve:
      'The "task → cancelled/waiting" transition or an `approval.expired` audit event — only that the CALL is refused and the refusal recorded. A paired CONTROL seeds the identical approval unexpired and asserts it authorizes, so the refusal is about expiry and not about `send_email` being refused for some other reason. HISTORY, kept because it is the point: ACBP-P7-007 found this row citing `approvals.integration.test.ts`s decider_type case — BYTE-IDENTICAL to row 5\'s citation, about WHO may decide rather than WHEN an approval lapses — with a recorded mutation that could not have reddened it. It was demoted to `not_covered` with an empty citation rather than left borrowing. ACBP-P7-008 slice 4 built the real dispatcher case; the enforcement had existed the whole time, and nothing drove it from the chokepoint.',
  },
  {
    number: 8,
    statement: 'Revoked integration cannot execute.',
    attributedTo: 'rig in P6-002; full when integrations exist',
    builtBy: 'NOBODY — and the claimed rig does not exist',
    status: 'unprovable',
    anchor: 'none',
    file: '',
    testTitle: '',
    entryPoint: '',
    mutation: '',
    mutationRunId: '',
    doesNotProve:
      'There is no integrations entity anywhere in the repository: no table, no migration, no service, no contract, and no integration-related value in TOOL_DENIAL_REASONS. CDR-067 (P6-002s own decision record) never mentions integrations, so the canon phrase "rig in P6-002" asserts a control nobody built. REQUIREMENT-TRACEABILITY.csv compounds it: INTEG-003 reads "Covered (Post-MVP; rig in MVP)" verified by revoke-then-use tests that do not exist. Cannot go green until integrations exist — CDR-080 §7 item 1 is the owner decision on whether that blocks the ticket.',
  },
  {
    number: 9,
    statement: 'Paused company cannot start new autonomous work.',
    attributedTo: 'P6-007',
    builtBy: 'ACBP-P7-002 — the P6-007 attribution is FALSE',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/company/gate-14.integration.test.ts',
    testTitle: 'the refusal is `company_not_active`, NOT `task_not_startable` — the task is startable, the company is not',
    entryPoint: 'startRun',
    mutation: 'Add a fifth autonomous-work entry point that does not call readLifecycleDecision.',
    mutationRunId: '',
    doesNotProve:
      'That the four gated points are ALL of them. Approvals have check-approval-port.mjs and stops have check-stop-port.mjs; there is no check-lifecycle-gate.mjs, so a fifth ungated entry point would fail nothing. Also: only `paused` is reachable in production — the deactivate transitions are unbuilt (CDR-079 §10 slice 5).',
  },
  {
    number: 10,
    statement: 'Emergency stop blocks new external execution (all scopes, ≤5s).',
    attributedTo: 'P6-007',
    builtBy: 'ACBP-P6-007',
    status: 'unmeasured',
    anchor: 'return_value_only',
    file: 'packages/core/src/tools/dispatcher.integration.test.ts',
    testTitle: 'every enforceable scope has a covering case here — a scope added without one fails rather than goes unproven',
    entryPoint: 'dispatchToolCall',
    mutation: 'Remove one scope from the stop evaluation and dispatch a call it should have covered.',
    mutationRunId: '',
    doesNotProve:
      'THE ≤5s BOUND AS AN OPERATOR SEES IT. The timing helper NAMED `activateStop` is a raw owner-client INSERT into emergency_stops, not the production use case, so the measured interval EXCLUDES the activation path. "All scopes" is also five enforceable scopes, not seven.',
  },
  {
    number: 11,
    statement: 'Replayed jobs do not duplicate authoritative effects.',
    attributedTo: 'P6-011',
    builtBy: 'ACBP-P6-011, on foundations from ACBP-P5-001b (checkpoints) and ACBP-P5-003b (per-tool idempotency)',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/idempotency/replay.integration.test.ts',
    testTitle: 'a re-delivered enqueue creates no second job, and the suppression is recorded',
    entryPoint: 'enqueueJob',
    mutation: 'Remove the idempotency read-back so a re-delivered key inserts a second row.',
    mutationRunId: '',
    doesNotProve:
      'That producers SUPPLY a key. `idempotencyKey` is caller-supplied and optional at every call site, and no production producer derives one — two keyless enqueues are correctly two jobs.',
  },
  {
    number: 12,
    statement: 'Duplicate usage messages do not double count.',
    attributedTo: 'P6-009/011',
    builtBy: 'ACBP-P6-009/011',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/database/src/integration/usage-events.integration.test.ts',
    testTitle: 'A RE-DELIVERED USAGE ROW IS SUPPRESSED, not written and not thrown (trust-critical #12)',
    entryPoint: 'the usage-event insert path under the restricted role',
    mutation: 'Drop the usage-event uniqueness constraint so a re-delivery inserts twice.',
    mutationRunId: '',
    doesNotProve: 'Same producer-contract gap as #11: suppression depends on a key the caller chooses to supply.',
  },
  {
    number: 13,
    statement: 'Usage corrections create compensating records (never edits).',
    attributedTo: 'P6-009',
    builtBy: 'ACBP-P6-009',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/usage/usage-correction-service.integration.test.ts',
    testTitle: 'a correction is a NEW ROW referencing the original — and the WHOLE original row is UNCHANGED',
    entryPoint: 'recordUsageCorrection',
    mutation: 'Make recordUsageCorrection UPDATE the original row instead of inserting a compensating one.',
    mutationRunId: '',
    doesNotProve:
      'That no OTHER path can edit a usage row — the service suite states in its own text that "never edits" is not proven in that file; the privilege proof lives in usage-rollups.integration.test.ts.',
  },
  {
    number: 14,
    statement: 'Account usage equals the deterministic sum of eligible company usage.',
    attributedTo: 'P6-009',
    builtBy: 'ACBP-P6-009',
    status: 'unmeasured',
    anchor: 'return_value_only',
    file: 'packages/core/src/usage/usage-rollup-service.integration.test.ts',
    testTitle: "THE TOTAL DOES NOT DEPEND ON THE CALLER'S COMPANY MEMBERSHIPS (CDR-073 §1-G3)",
    entryPoint: 'rebuildAccountUsageRollup',
    mutation: 'Filter the rollup by the calling user\'s memberships so the total varies by caller.',
    mutationRunId: '',
    doesNotProve:
      'The PERSISTED row. This case compares returned figures; the persisted account_usage_rollups row is asserted in the reconciliation suite and the slice-F journey, not here.',
  },
  {
    number: 15,
    statement: 'Provider keys never appear in browser responses.',
    attributedTo: 'P0-019, P7-007',
    builtBy: 'ACBP-P7-007 slice 3 — P0-019 built a serialization test and a source scan, NOT a response test',
    status: 'measured',
    anchor: 'recorded_row',
    file: 'apps/web/src/server/adversarial/secret-egress.test.ts',
    testTitle: 'every exported HTTP method of every route module answers WITHOUT emitting a secret',
    entryPoint: 'every route.ts handler under apps/web/src/app',
    mutation:
      'Make a route emit a configured secret — e.g. add `debug: loadClerkConfig().secretKey.reveal()` to auth-check/route.ts\'s 401 body. Turns TWO tests red: the sweep and the `.reveal()` source guard.',
    mutationRunId: '31113087854',
    doesNotProve:
      'THE CANONICAL WORDING. "Provider keys" do not exist in the runtime yet (the Infisical adapter is `export {}`, the only model adapter is the fake, there is no credential_ref table), so what is proven is the narrower property that carries the claim once they do: no `Secret`-wrapped configuration value reaches a response body or header. Coverage is the DENIAL and THROW paths — an authenticated 200 body is not swept, because that needs a database. BEWARE TWO NEAR-MISSES that read as coverage to a grep: clerk-webhook-handler.test.ts and fail-closed-proxy.test.ts carry real whsec_/sk_test_ literals in real Response bodies; neither drives a route module.',
  },
  {
    number: 16,
    statement: 'Secret values never appear in logs or audit payloads.',
    attributedTo: 'P0-017, P7-007',
    builtBy: 'ACBP-P0-017 (logs half, and it had a hole ACBP-P7-007 closed); the AUDIT half is enforced by nobody',
    status: 'measured',
    anchor: 'recorded_row',
    file: 'packages/observability/src/logger.test.ts',
    testTitle: 'sentinel secret never appears in an emitted MESSAGE either (trust-critical #16)',
    entryPoint: 'logger',
    mutation: 'Revert logger.ts to emit `fields.message` verbatim instead of through redact().',
    mutationRunId: '31113087854',
    doesNotProve:
      'THE AUDIT HALF, which nothing ENFORCES. `boundedMetadata` rejects objects, arrays, Errors and null and then accepts ANY string up to 1024 units with no secret detection — safety rests on typed factories happening to carry scalars, a convention rather than a control, and `audit_events` is append-only so a secret written there is unrecoverable. ACBP-P7-007 slice 4 made that gap EXECUTABLE (`packages/contracts/src/audit/metadata-secrets.test.ts` asserts boundedMetadata accepts secret-shaped values, and is written to fail the day enforcement lands) and published a reusable real-PG detector (`assertNoSecretsInAuditPayloads` in @acbp/test-support) — but a detector run in tests is not a control in production. Whether `boundedMetadata` should REJECT is CDR-080 §7, an owner decision, because audit-or-nothing means a rejection fails the product operation and the high-entropy pattern matches a base64 SHA-256 that audit metadata legitimately carries. The prior evidence for the logs half was scoped "metadata + error" — honestly named, and `message` was in fact emitted unredacted until this slice. SECOND REVIEW PASS, and it narrows what run 31113087854 bought: that run proves `message` is PIPED THROUGH the redactor, not that the redactor recognises much. The case it reddened plants `password=…`, which the original P0-017 pattern set already handled, while a CONNECTION STRING, a JWT, an AWS key id, a Slack token and the `Basic` scheme were all still emitted verbatim — the connection string being the example the fix\'s own comment had offered. So the logs half was TWO holes, and only one was closed by the measured mutation. `redactString` now composes `redactSecrets` (the contracts SECRET_PATTERNS, a strict superset, and the same detector `containsSecret` uses so the sweep and the redactor finally agree), `event` is redacted too (it is `string`-typed and the dotted-name convention is not a control), and there is one case per shape plus two non-erasure controls — but NONE of those additions is mutation-measured. The run id below covers the piping, nothing more.',
  },
  {
    number: 17,
    statement: 'Raw untrusted content cannot directly trigger a tool call (injection corpus).',
    attributedTo: 'P5-003/006',
    builtBy: 'ACBP-P5-003c; the P5-006 credit is unearned. ACBP-P6-002/CDR-067 §2-G9 restored the boundary after it went DEAD and is uncredited.',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/tools/injection-corpus.integration.test.ts',
    testTitle: 'ZERO unauthorized executions — every corpus entry is refused, detectable or not',
    entryPoint: 'dispatchToolCall',
    mutation: 'Stop feeding untrusted provenance into approvalRequired so an injected instruction dispatches.',
    mutationRunId: '',
    doesNotProve:
      'Three real gaps, none of which more corpus strings would close (the refusal is provenance-based, so nine EMPTY strings produce the same nine denied rows): a payload in `params.args`, which injectionSignalsIn never inspects; anything past detectInjection\'s 64,000-character slice; and untrusted context PLUS a standing usable approval, which dispatch.ts:249 makes AUTHORIZED and no integration test exercises.',
  },
  {
    number: 18,
    statement: 'Failed model output cannot create a completed task.',
    attributedTo: 'P5-010/013',
    builtBy: 'ACBP-P5-011 (completeTask) and ACBP-P6-008 (evidence join) — P5-010 self-files as "groundwork"',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'packages/core/src/artifacts/complete.integration.test.ts',
    testTitle: 'a run that has NOT succeeded refuses — a running attempt cannot complete its task',
    entryPoint: 'completeTask',
    mutation: 'Weaken the run-state guard from `=== succeeded` so a non-succeeded run can complete its task.',
    mutationRunId: '',
    doesNotProve:
      'THE CLAIM AS WORDED. The seeded run state is `running`, not `failed` — searching this file for "failed" returns nothing. A `failed` run is covered by CONSTRUCTION (the guard is a single !== succeeded), never by execution. Nor does any test join model failure to a completion attempt.',
  },
  {
    number: 19,
    statement: 'Silent fallback does not occur for a material decision.',
    attributedTo: 'P5-009',
    builtBy: 'ACBP-P5-009 (suite); the mechanism is ACBP-P2-003',
    status: 'unmeasured',
    anchor: 'return_value_only',
    file: 'packages/core/src/model/silent-fallback-negative.test.ts',
    testTitle: 'a MATERIAL decision does NOT silently fall over — generation fails on the primary',
    entryPoint: 'the model gateway',
    mutation:
      "Two, and they fail DIFFERENT cases. (a) For the LEAK assertions: add a field carrying the provider's internal error text to the result object built at the END of callModel — NOT to `errorResult`, which serves only the policy-precheck and early-internal paths and is never reached by a provider failure. (b) For the FALLBACK claim itself — the one this row is about: re-label the `strategy.options` template family as `extraction` so the platform's most material decision becomes fallback-eligible. NEITHER IS RECORDED, AND THAT IS A CORRECTION. (a) was run in CI 31113087854 and this row was briefly marked `measured` on it, which was WRONG TWICE OVER: the run reddened `a material decision that fails, fails HONESTLY` — a DIFFERENT test in this file — and it reddened it through that test's LEAK assertion, so it is evidence about #16-style egress, not about silent fallback. The test named above asserts only outcome/fallbackUsed/callCount/validatedOutput and mutation (a) cannot touch any of them. Two independent reviews caught this; the checker could not, because it never cross-checks `mutation` against `testTitle`. (b) is the mutation that would actually prove this row, and it has never been run.",
    mutationRunId: '',
    doesNotProve:
      'WHICH decisions are material — mutation (b) above turns fallback on for strategy generation WITH THE WHOLE SUITE GREEN, because the task class is unpinned for several material template families. It is also a unit suite over an in-memory events array, so no PERSISTED usage row is checked (migration 0030 added usage_events.fallback_reason; a real-PG case would be stronger). FIXED BY ACBP-P7-007: this file carried two assertions that could not fail — not.toContain("SECRET") where the literal SECRET appears nowhere in the harness, the planted value being FAKE_INTERNAL_MARKER. Both now target that marker, with a CONTROL proving the fake still plants it, and mutation (a) confirms they detect a leak.',
  },
  {
    number: 20,
    statement:
      'A user cannot obtain elevated authority by altering a Clerk organization or role value in the client.',
    attributedTo: 'P1-007, P1-014',
    builtBy: 'ACBP-P1-007 (the control) + ACBP-P1-014 (the proof)',
    status: 'unmeasured',
    anchor: 'database_state',
    file: 'apps/web/src/server/adversarial/http-routes.adversarial.integration.test.ts',
    testTitle:
      '[AUTHZ-FORGED-CLERK-ROLE] a REAL member with a forged owner role cannot perform an owner-only mutation (the sharp #20 case)',
    entryPoint: 'HTTP route handlers → core → PostgreSQL',
    mutation: 'Read the role from the provider claim instead of from the internal membership row.',
    mutationRunId: '',
    doesNotProve:
      'Nothing outstanding for the forged-claim path. Note P1-014-REVIEW-COVERAGE.md:26 records that this negative once could NOT detect its own regression, because the forged claims named placeholder ids; the sharp case above is the fix.',
  },
]);
