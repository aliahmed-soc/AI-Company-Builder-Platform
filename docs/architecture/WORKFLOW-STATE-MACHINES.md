# Workflow State Machines

Status: Proposed. All transitions are **server-enforced** (TASK-001 acceptance); invalid transitions are rejected and audited. Diagrams: `diagrams/06`, `08`. Terminal states are marked ⏹.

Conventions per transition: **Actor** (who may trigger), **Pre** (preconditions), **Effects** (side effects), **Audit** (event), **Usage** (metering), **Retry** (behavior).

## 1. Company lifecycle

`draft → onboarding → active ⇄ paused → deactivating → deactivated ⏹` (+ `deleted ⏹` via COMP-007 only)

| Transition | Actor | Pre | Effects | Audit | Usage | Retry |
|---|---|---|---|---|---|---|
| draft→onboarding | user (create submit) | brief persisted | provisioning workflow enqueued | company.created | none (MVP) | provisioning steps resumable (NFR-005) |
| onboarding→active | system | all provisioning steps completed or explicitly failed-and-acknowledged | interview unlocked | provisioning completion | — | per-step retry, bounded |
| active→paused | owner | — | no new job pickup (invariant 16); in-flight safe-stop | company.paused | in-flight run metered to stop point | n/a |
| paused→active | owner | held-work review completed (ADMIN-002) | schedules restore; nothing auto-fires | company.resumed | — | n/a |
| active/paused→deactivating | owner | confirmation | public artifacts offline (future); autonomous work blocked | company.deactivated | — | n/a |
| deactivating→deactivated ⏹ | system | teardown checks done | data retained per retention | audited | — | teardown resumable |
| any→deleted ⏹ | owner | COMP-007: typed confirm + export offer | staged purge per retention | audited (redacted trace retained) | — | purge resumable |

**Implementation status of the Effects column (ACBP-P7-002, CDR-079).** This table describes intent; what is
actually enforced diverges, and the divergence is load-bearing.

- **`active→paused` — "no new job pickup (invariant 16)" is ENFORCED as of ACBP-P7-002, and was not before.**
  From ACBP-P1-010 until then, `pauseCompany` wrote the status and nothing read it: **pausing a company was a
  label, not a control.** Enforcement is `mayStartAutonomousWork`, called at four points — `startRun` (before
  the attempt is claimed), `dispatchToolCall` (so the refusal is still recorded), `enqueueJob` (after the
  idempotency read-back) and `runJobStep` (after the already-completed short-circuit). **It is a status READ,
  not an event subscription**; `EVENT-CATALOG.md` previously named a consumer that never existed.
- **"in-flight safe-stop" is NOT enforced by pausing.** Pause refuses *new* work; it does not terminate a run
  already executing. The durable-stop sweep that would is unbuilt (CDR-079 §9.5), and the three worker bodies
  are still reachable with a stale `runId` (§9.3). Both are open owner decisions.
- **`active/paused→deactivating` HAS NO IMPLEMENTATION.** The two states exist in the CHECK constraint
  (migration 0054) and the gate refuses them, but **no code performs this transition**, so in production they
  are reachable only by a direct database write and `company.deactivated` is never emitted. §9.5, OWNER.
- **`paused→active`'s "held-work review completed (ADMIN-002)" is not a precondition in code** — resume does not
  verify the review happened. See CDR-072 §1-G6 and CDR-079 §9.7 (reactivation semantics), both open.

## 2. Interview lifecycle

`not_started → in_progress ⇄ waiting_for_user → ready_for_review → confirmed ⏹(version) → superseded ⏹`

| Transition | Actor | Pre | Effects | Audit | Usage | Retry |
|---|---|---|---|---|---|---|
| not_started→in_progress | system (post-onboarding) | company active | first batch (≤3) generated | interview.started | model usage metered | gateway retry; static fallback flagged (DISC-001) |
| in_progress⇄waiting_for_user | system/user | — | resumable exactly (DISC-007) | — | — | n/a |
| in_progress→ready_for_review | system | required fields answered/assumed/deferred | understanding draft generated | understanding.generated | model usage | bounded |
| ready_for_review→confirmed ⏹ | **owner only** | UNDER-003 review done; Must-sections resolved | strategy generation unlocked | understanding.confirmed | — | n/a |
| confirmed→superseded ⏹ | system (on material correction) | DISC-008 revision | new session/version opens; dependents flagged | understanding.corrected | — | n/a |

## 3. Strategy lifecycle

`generating → ready_for_review → selected ⏹ | rejected ⏹ | superseded ⏹`

| Transition | Actor | Pre | Effects | Audit | Usage | Retry |
|---|---|---|---|---|---|---|
| generating→ready_for_review | system | ≥3 distinct options passing similarity check, or honest fewer-with-reasons (STRAT-001) | options rendered | strategy.generated | model usage | bounded; failure visible |
| ready_for_review→selected ⏹ | **owner only** | decision record write succeeds (STRAT-006 — record failure blocks transition) | planning unlocked; immutable decision | strategy.selected + decision.recorded | — | n/a |
| ready_for_review→rejected ⏹ | owner | reasons captured | routes to understanding review | audited | — | n/a |
| any→superseded ⏹ | system | understanding version superseded | options archived, never deleted | audited | — | n/a |

## 4. Task lifecycle (durable — ADR-008)

States: `draft → planned → queued → running → completed ⏹ | failed ⏹ | cancelled ⏹` with holds `waiting_for_input`, `waiting_for_approval`, `blocked_by_policy`, `paused`.

Legal transitions:

| From → To | Actor | Pre | Effects | Audit | Usage | Retry |
|---|---|---|---|---|---|---|
| draft→planned | system (planning) / user | traces to milestone or explicit ad-hoc | appears on board | task.created | — | — |
| planned→queued | owner/operator (run) or scheduler (post-MVP) | preflight shown + credit check (TASK-004); policy evaluate №1 pass | durable job row (tenant-stamped) in same tx as credit reservation | task.queued | credit reserved atomically | idempotency key required |
| queued→running | worker | policy evaluate №3 (pre-execution, mandatory); stop-state clear; company active | worker run opens | task.started | model/tool usage begins | job pickup retries safe |
| running→waiting_for_input | worker | question for user raised | Decision Room item | task.waiting_for_input | run paused metering | resumes on answer |
| running→waiting_for_approval | dispatcher | gated tool call proposed | approval.requested | task.waiting_for_approval | paused | resumes on decision |
| running→blocked_by_policy | policy engine | deny at any evaluation point | Decision Room blocked queue | policy.blocked | metered to block point | not retryable until policy/limits change |
| waiting_* → running | system | blocking ref resolved (answer given / approval approved) | resume from checkpoint | audited | resumes | — |
| waiting_for_approval→cancelled ⏹ | system | approval rejected/expired/revoked | reason recorded | approval.* + task event | reserved credit released per rule | n/a |
| running→completed ⏹ | worker | artifact persisted (TASK-005 — persistence failure ⇒ failed, never hollow success) | artifacts linked; usage finalized | task.completed | credit consumed final | n/a |
| running→failed ⏹ | worker/system | retries exhausted or non-retryable | TASK-006 failure detail mandatory | task.failed | per charging rules (ADR-013 §4) | auto-retry per TASK-010 config before terminal |
| queued→cancelled ⏹ | owner/operator | — | immediate removal | task.cancelled | reservation released | n/a |
| running→cancelled ⏹ | owner (stop request) | safe-stop: current tool call completes/aborts safely, then halt (TASK-007) | partial results retained + labeled | task.cancelled | metered to stop | n/a |
| running→paused / paused→running | system (company pause / emergency stop) | scope stop active | held visibly; resume requires review (ADMIN-002) | audited | metered to stop | resumes from checkpoint |

Timeout rule: heartbeat-lost runs transition `running→failed` with category `worker_lost` after bounded grace (FAILURE-AND-RECOVERY §4).

## 5. Approval lifecycle

`proposed → policy_checking → not_required ⏹ | blocked ⏹ | awaiting_approval → approved → consumed ⏹` with exits `rejected ⏹`, `expired ⏹`, `revoked ⏹`

| Transition | Actor | Pre | Effects | Audit | Notes |
|---|---|---|---|---|---|
| proposed→policy_checking | dispatcher | action normalized + hashed (APPR-004) | policy evaluate №2 | policy.evaluated | payload hash fixed here |
| policy_checking→not_required ⏹ | policy engine | risk class + autonomy level permit | execution proceeds (still passes evaluate №3) | recorded | e.g., informational class at L2 |
| policy_checking→blocked ⏹ | policy engine | forbidden/limit breach | Decision Room blocked | policy.blocked | approval cannot override forbidden (POL-005) |
| policy_checking→awaiting_approval | system | approval required | inbox item with full APPR-002 content + preview | approval.requested | expiry set per risk class (APPR-005) |
| awaiting_approval→approved | **human/delegated approver only (invariant 5)** | actor holds approval authority | bound to payload hash, scope, expiry | approval.approved (in-tx) | edit-then-approve rebinds hash (APPR-007) |
| awaiting_approval→rejected ⏹ | approver | — | task exits per §4 | approval.rejected | reason retained (J-15) |
| approved→consumed ⏹ | dispatcher | **at execution instant:** hash match + not expired + not revoked + stop-state clear | single-use consumption | approval.consumed-equivalent audit | invariant 6/7; race resolves to revoke (APPR-006) |
| approved→expired ⏹ / revoked ⏹ | clock / owner | — | execution attempts fail closed | approval.expired/revoked | clock ambiguity = expired (APPR-005) |

## 6. Tool-call lifecycle

`proposed → authorized → queued → executing → succeeded ⏹ | failed ⏹ | cancelled ⏹ | compensated ⏹`

| Transition | Actor | Pre | Effects | Audit | Usage | Retry |
|---|---|---|---|---|---|---|
| proposed→authorized | dispatcher | allowlist (invariant 4) + policy evaluate №3 + approval verify/consume where gated + stop-state + integration status (invariant 15) | idempotency key assigned (external classes: required) | tool.call_requested | — | authorization never cached across attempts |
| authorized→queued→executing | dispatcher | — | provider/tool invoked | tool.call_started | metered | bounded backoff (NFR-007), idempotent-safe only |
| executing→succeeded ⏹ | tool adapter | external classes: **receipt stored** (invariant 20; no receipt ⇒ `unconfirmed`, not success) | result recorded | tool.call_completed | finalized | n/a |
| executing→failed ⏹ | adapter | retries exhausted / non-retryable | normalized error category | tool.call_failed | per charging rules | duplicate detection on every retry |
| any→cancelled ⏹ | dispatcher | stop/cancel before execution | — | audited | released | n/a |
| succeeded→compensated ⏹ | system/operator (future external actions) | compensation defined for the tool | compensating action executed + linked | audit-grade pair | compensating usage entry | manual approval for sensitive classes |
