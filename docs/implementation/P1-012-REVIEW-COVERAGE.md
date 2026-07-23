# P1-012 — Independent review coverage and findings register

Three independent reviews ran on the committed `p1-012-workspace-provisioning` diff (base `main` @ `e7f9a53`,
all five implementation slices in): **R1** security / tenant-isolation / audit-redaction; **R2** correctness /
concurrency / state-machine; **R3** scope / migration / taxonomy. Verdicts: **no Critical or High findings**;
R2 reported 2 Medium (one shared root cause) + 4 Low; R1 3 Low; R3 3 Low (two overlapping R1's). Every Medium
and reasonable in-scope Low was FIXED in the Slice 6 commit; the rest are accepted with rationale below.

## Review lens coverage

| Lens (owner §17) | Review | Verdict |
|---|---|---|
| 1 creation/bootstrap atomicity | R1 §7, R2 §6 + tests | sound (selective-writer full-rollback proven) |
| 2 step checkpoint & kill/resume | R2 §1 (traced) + per-checkpoint test | sound — `running` uncommittable 3 ways; zero-trace interruption |
| 3 duplicate/concurrent resume | R2 §3 + deadlock analysis | 2 Medium found → FIXED (retry authorization; see F-1/F-2) |
| 4 transition/attempt-state invariants | R2 §2/§4/§5/§7 | sound — cap airtight; activation gate closed; loop bound exact |
| 5 RLS/grants/tenant isolation | R1 §1/§2 + catalog tests | sound — column-limited UPDATE; dual-key; no 4th SECURITY DEFINER |
| 6 audit taxonomy & redaction | R1 §4, R3 §4 | sound — exact allowlists, closed codes, system/user actors (F-3 fixed) |
| 7 activity-taxonomy non-expansion | R1 §4, R3 §3 | sound — `ACTIVITY_TYPES` untouched; feed carries only company.created |
| 8 API authorization/privacy | R1 §5/§6, R3 §6 | sound — param-free routes; enumerated DTO; coarse denials (F-4 fixed) |
| 9 migration backfill/lifecycle | R3 §1 + down/up suite | sound — additive; idempotent; BYPASSRLS-guarded; types match DDL |
| 10 no worker/provider/later-scope leakage | R1 §3, R3 §3 | sound — full-diff greps clean; awaited inline post-create run |

## Findings register

| ID | Src | Sev | Finding | Disposition |
|---|---|---|---|---|
| F-1 | R2 | **Medium** | Concurrent duplicate resumes could retry a just-failed step with NO `retry_requested` audit (the second run's Phase B fell through the failed-row guards) — violating CDR-018 §8's retry-is-a-user-action invariant and allowing one salvo to burn multiple attempts unaudited | **FIXED.** A failed row now executes ONLY under a matching Phase-A `RetryAuthorization {step, fromAttempt}`; any mismatch (failed after the gate, or authorization already consumed) HALTS with no mutation. New concurrent-retry-race test proves: fresh race → 1 attempt, 0 retry events; retry race → 1 executed retry, 1 event. |
| F-2 | R2 | **Medium** | `retry_requested` could double-write with stale `next_attempt`/mis-chained causation under concurrent retries (Phase A serialized but did not deduplicate) | **FIXED structurally.** `retry_requested` moved INTO the executing step transaction — written exactly once per EXECUTED retry, `next_attempt` computed at execution time, its event id the causation of that attempt's system events. Unexecuted authorizations write nothing. |
| F-3 | R1 | Low | `provisioning.started` actor inconsistent (user at creation vs system at backfilled bring-up) | **FIXED** — the creation-path event now stamps `actorType:'system'` (automatic provisioning is a system action; scope-bound actor_id keeps provenance). |
| F-4 | R1+R3 | Low | Unexpected mid-step throw surfaced as a framework 500 instead of the bounded envelope on the two provisioning routes | **FIXED** — both routes catch and return `genericErrorBody(500)` (no framework/internal detail; checkpoints are untouched by construction). |
| F-5 | R2 | Low | `createCompany` inferred the returned `active` from the steps-only `completed` flag (could momentarily lead a concurrent activation's commit) | **FIXED** — now derived from the DTO's transactionally-read `companyStatus`. |
| F-6 | R3 | Low | `ProvisioningStatusDTO.companyStatus` doc omitted the defensive `'unknown'` | **FIXED** (doc line). |
| F-7 | R3 | Low | Pause-from-draft rejection lost its direct integration coverage (fresh companies are now onboarding) | **FIXED** — explicit draft→pause `invalid_transition` case restored. |
| F-8 | R2 | Low | Test gaps: concurrent-resume-on-failed-step; crash-between-sixth-step-and-activation recovery | **FIXED** — both tests added (the first is the F-1/F-2 proof; the second proves the all-completed+onboarding recovery activates exactly once with zero step re-execution). |
| F-9 | R2 | Low | Completion gate 500 when a concurrent pause lands between resume phases (all-completed + paused) | **Accepted** — fail-closed, zero mutation, vanishingly narrow; recorded in PROVISIONING.md operational notes. |
| F-10 | R2 | Low | Deploy-order gap: pre-P1-012 code creating companies after 0010 runs leaves them checkpoint-less (resume → conflict) | **Accepted + documented** — the backfill INSERT is idempotent and manually re-runnable; no production deployment exists (PROVISIONING.md runbook note). |
| F-11 | R2 | Low (observation) | Pre-existing active/paused companies read `completed:false, steps:[]` | **Accepted design** (CDR-018 §9 backfill scope) — documented for clients in PROVISIONING.md. |
| F-12 | R1 | Low (observation) | Crashed attempts are audit-invisible and don't consume the cap | **Accepted by design** (CDR-018 §4 mandates no committed trace; every retry is an authenticated owner request) — documented in PROVISIONING.md. |
| F-13 | R3 | Observation | `started_at` set at outcome-commit time (≈ completed_at); true chronology lives in the audit events | **Accepted** — consistent with decision 15 ("history = audit"). |
