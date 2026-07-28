# Event Catalog

Status: Proposed. **These are proposed contracts for this product — not observed Polsia internals** (no event system was ever visible in the reference product; PRD §10).

**Implementation status (ACBP-P1-008/010/012; CDR-014/015/018):** the durable append-only audit store exists.
Persisted in-transaction today: `membership.invited`, `membership.revoked` (P1-008); `company.created`,
`company.updated`, `company.paused`, `company.resumed` (P1-010; the four are also activity-projected — P1-009);
and the six AUDIT-ONLY workspace-provisioning events (P1-012; CDR-018 §8) — `provisioning.started`,
`provisioning.step_started`, `provisioning.step_completed`, `provisioning.step_failed`,
`provisioning.retry_requested`, `provisioning.completed` — which are NEVER activity-projected (the P1-009
four-event feed taxonomy is closed); and the AUDIT-ONLY platform-admin event `admin.tenant_read` (P1-013;
CDR-019) — written into the TARGET tenant's trail with `actor_type='admin'` and metadata exactly
`{reason (verbatim), scope='company_overview'}`, never activity-projected. All other events in this catalog
remain **proposed / interim structured logs only** and are NOT durable yet (see `docs/architecture/AUDIT.md`).

## Common envelope (all events)

| Field | Rule |
|---|---|
| event_id | ULID, unique |
| name | dot-namespaced, past tense, from this catalog |
| occurred_at | UTC timestamp |
| company_id / account_id | Tenant identifiers — **required** on all tenant events (invariant 1/3); account-only events carry account_id |
| actor | `{type: user|worker|system|admin, id, version?}` — worker actors can never appear on approval decisions (invariant 5) |
| correlation_id | Propagated from originating request/job (ADR-017) |
| causation_id | event_id of the direct cause, when applicable |
| idempotency_key | Present on events emitted by idempotent operations; consumers dedupe on it |
| schema_version | Integer per event name |
| payload | Per-event fields below; **sensitive-field restriction:** no secret values, no raw prompts, no full personal data — references/digests only (NFR-018, ADR-017) |

Retention default: activity-projected events with company data; audit-relevant events ≥ audit retention (AOQ-13). Delivery: transactional outbox from the owning module (ADR-008/015); consumers are idempotent.

## Events

| Event | Producer | Consumers | Required payload fields | Audit relationship | Retention |
|---|---|---|---|---|---|
| account.created | Identity | Usage ledger, notification | account_id, plan_state | audited | permanent |
| company.created | Account&Company | Workflow coord. (provisioning), activity | company_id, creation_mode | audited | with company |
| company.updated | Account&Company | activity | changed_fields (names only) | audited | with company |
| company.paused / company.resumed | Account&Company | Workflow coord. (halt/resume pickup, invariant 16), activity | reason?, held_work_count (resume) | audited | with company |
| company.deactivated | Account&Company | Workflow coord., export | — | audited | permanent record |
| provisioning.started | Account&Company (P1-012) | audit only — never activity | step_count | audited (company-scoped) | with company |
| provisioning.step_started / step_completed / step_failed | Account&Company (P1-012) | audit only — never activity | step, attempt (+ result_code / failure_code — closed sets) | audited; step_failed outcome=blocked; system actor | with company |
| provisioning.retry_requested | Account&Company (P1-012) | audit only — never activity | step, next_attempt | audited; USER actor; causation for the retry run | with company |
| provisioning.completed | Account&Company (P1-012) | audit only — never activity | step_count | audited atomically with onboarding→active | with company |
| admin.tenant_read | Admin surface (P1-013) | audit only — never activity | reason (verbatim), scope='company_overview' | THE admin-action record (CDR-019); target-tenant-scoped; actor_type=admin (real admin id); written before response delivery | with company |
| interview.started | Discovery | activity (deferred — see note) | session_id | audited | with session |
| interview.question_answered | Discovery | Understanding (incremental), memory (deferred — see note) | question_id, answer_ref (no full text), revision_of? | — | with session |
| understanding.generated | Understanding | activity, strategy | understanding_version, section_confidences | audited | with company |
<!-- IMPLEMENTED (ACBP-P2-008; CDR-029): realized as a durable `audit_events` row written in the SAME transaction
     as the versioned document + items insert (audit-or-nothing). Bounded metadata = {version, status, item_count}
     — NO generated content, NO section text. Activity fan-out is DEFERRED (P1-009's closed activity taxonomy is
     not expanded here, exactly as `interview.started`'s activity projection is deferred); the strategy consumer
     is P3-001. `understanding.confirmed`/`understanding.corrected` are IMPLEMENTED by P2-009 (below). -->

<!-- IMPLEMENTED (ACBP-P2-009; CDR-030): `understanding.item_reviewed` (subject = the reviewed item; bounded metadata
     {decision, version} — NO item content / edited text / reject reason), `understanding.confirmed` (subject = the
     document; {version} — the confirming actor is the server-stamped audit actor), and `understanding.corrected`
     (subject = the document; {version, correction_ref, dependents_flagged}) are durable `audit_events` rows written
     in the SAME transaction as their review/confirmation-event insert (audit-or-nothing). Activity fan-out + the
     strategy consumer of the unlock remain P3-001. `dependents_flagged` in the MVP schema = the count of downstream
     strategy stages re-blocked by the supersession (1 = strategy; becomes invalidated-option count when P3-001 lands). -->

| understanding.item_reviewed | Understanding (P2-009) | audit only — never activity | decision, version (no content/edited text) | audited in-tx (UNDER-003 "item decisions audited"); subject = the reviewed item; owner-only; CDR-030 §6 | with company |
| understanding.corrected | Understanding | memory (correction item), planning (staleness flags) | version, correction_ref, dependents_flagged | audited in-tx (DISC-008); subject = the document; supersedes the confirmation; owner-only; CDR-030 §4 | with company |
| context.conflict_flagged | Context assembly (P2-007) | audit only — never activity | confirmed_count, assumption_count (no content, no source_ref) | audited in-tx (MEM-004; BACKLOG "Conflict events audited"); subject = the confirmed item; both items WITHHELD from context + surfaced as an open question (never rank-resolved); outcome `blocked`; CDR-032 §3 | with company |
| memory.item_created | Memory (P2-006) | audit only — never activity | item_type, source_type (no content, no raw source_ref) | audited in-tx (MEM-003 "all changes audited"); CDR-024 §4; actor/account/company server-stamped | with company |
| memory.item_superseded | Memory browser (P2-010) | audit only — never activity | item_type, source_type of the NEW version (no content) | audited in-tx (a lifecycle transition, ADR-015); subject = the superseded (old) item; CDR-025 §4 | with company |
| memory.item_deleted | Memory browser (P2-010) | audit only — never activity | item_type, source_type, transition='active_to_deleted' (no content) | audited in-tx (a lifecycle transition, ADR-015); subject = the deleted item; owner-only soft delete; CDR-025 §0 | with company |
| understanding.confirmed | Understanding | Strategy (unlock), activity | version (confirming actor = server-stamped audit actor, not in metadata) | audited in-tx (P2-009; CDR-030 §3); subject = the document; owner-only | permanent |
<!-- IMPLEMENTED (ACBP-P3-001; CDR-034 §4): `strategy.generated` is a durable `audit_events` row written in the SAME
     transaction as the immutable strategy generation (audit-or-nothing — an in-tx audit failure rolls the generation +
     options back). Subject = the generation id; bounded metadata = {understanding_version, option_count,
     similarity_check_result} ONLY — NEVER option content/fields or the fewer-than-three reason. `similarity_check_result`
     is the STRAT-001 distinctness verdict (`distinct`/`insufficient_distinct`, set by the P3-002 similarity check — a
     deterministic, model-free check on the customer/offer/business_model axes; `pending` is no longer written).
     ACBP-P3-003 (the OPTIONAL ADVISORY recommendation, CDR-036) registers NO new event — it changes no state (backlog
     Audit=—); its only durable trace is the automatic gateway usage event (`model.call_completed`). A future
     `strategy.recommended` event would be a new decision (owner gate) — not added. Activity fan-out is DEFERRED. -->
<!-- IMPLEMENTED (ACBP-P3-005; CDR-038 §4; STRAT-006): `decision.recorded` is a durable `audit_events` row written in the
     SAME transaction as the immutable decision record. That audit-or-nothing pair IS the STRAT-006 failure mode —
     "failed record writes block the transition (decision is not silently unrecorded)": if either write fails, no
     decision exists and the downstream P4-001 planning gate cannot pass. Subject = the DECISION id; bounded metadata =
     {understanding_version, options_considered_count, mode} ONLY — NEVER option content, chosen fields, reject reasons,
     or the rationale text. `options_considered_count` is a SCALAR (audit metadata forbids arrays — the shorthand
     `options_considered[]` in the row below is the conceptual link, recoverable from the decision's immutable
     `generation_id`). Owner-only (`decision:record`). A `reject` selection also gets a record; recording unlocks NO
     planning. Activity/memory fan-out is DEFERRED. -->
<!-- IMPLEMENTED (ACBP-P3-004; CDR-037 §4): `strategy.selected` is a durable `audit_events` row written in the SAME
     transaction as the immutable owner selection (audit-or-nothing — an in-tx audit failure rolls the selection back).
     Subject = the SELECTION id; bounded metadata = {mode} (+ `phase_scope` when set) ONLY — NEVER the chosen fields, the
     option content, or the reject reasons. It records a SELECTION, so it does NOT unlock planning (that is the P4
     boundary — CDR-037 §5) and it is NOT the immutable Decision record (decision.recorded is P3-005). `phase_scope` is
     FLAGGING only (STRAT-005). Owner-only (`strategy:select`). -->
| strategy.generated | Strategy | activity | generation_id, understanding_version, option_count, similarity_check_result (P3-001; no content) | audited in-tx | with company |
| strategy.selected | Strategy | decision (P3-005) | selection_id (subject); mode (select/edit/combine/reject), phase_scope? — no content | audited in-tx (P3-004; owner-only) | permanent |
| decision.recorded | Strategy&Decision | activity, memory | decision_id (subject); understanding_version, options_considered_count, mode (P3-005; scalar — no content/rationale) | **is audit-grade (immutable)**; audited in-tx (owner-only) | permanent |
<!-- IMPLEMENTED (ACBP-P4-001; CDR-039 §5; ROAD-001/002): `roadmap.generated` is a durable `audit_events` row written in
     the SAME transaction as the roadmap version + its goals + its milestones (audit-or-nothing, ADR-015). Subject =
     the roadmap VERSION id; bounded metadata = {roadmap_version, goal_count, milestone_count, status,
     model_flagged_partial} ONLY — NEVER goal/milestone titles or descriptions. The `task_ids[]` shorthand below cannot
     be metadata (audit metadata forbids arrays — the `strategy.generated` / `decision.recorded` precedent) and P4-001
     plans no tasks anyway (task generation is P4-003), so it is carried as a COUNT.
     `roadmap.edited` (CDR-039 §7-G2) is a SEPARATE event for a ROAD-002 owner edit — reusing `roadmap.generated` would
     misreport hand-authored content as a model generation. Subject = the NEW version id; bounded metadata
     {roadmap_version, supersedes_version, affected_task_count, has_reason} — NEVER the reason text. It is written in
     the same transaction as the new version and its affected-task flags, which is what makes ROAD-002's "version write
     failure blocks the edit rather than losing history" true end to end. Activity fan-out is DEFERRED. -->
| roadmap.generated | Planning | Task module (P4-003), activity | roadmap_version, goal_count, milestone_count, status, model_flagged_partial (P4-001; scalar — no plan content) | audited in-tx | with company |
| roadmap.edited | Planning | Task module (review flags), activity | roadmap_version, supersedes_version, affected_task_count, has_reason (P4-001; owner-only; no reason text) | audited in-tx | with company |
<!-- IMPLEMENTED (ACBP-P4-002; CDR-033 §4): `task.created` is a durable `audit_events` row written in the SAME
     transaction as the server-enforced `draft → planned` "appears on the board" transition (audit-or-nothing —
     an in-tx audit failure rolls back the transition). Subject = the task id; bounded metadata = {has_milestone}
     ONLY — NEVER the title/description or any content. `task.created` is emitted exactly once per task (a
     re-plan of a non-draft task is an illegal transition, rejected with no audit — TASK-001). The other task.*
     events (queued/started/completed/failed/cancelled/waiting_*) are registered by the P5/P6 tickets that
     implement their transitions; no generic transition audit exists yet. Activity fan-out is DEFERRED. -->
<!-- ACBP-P4-003 (CDR-040 §7/§8-G5) registers NO NEW EVENT. Planning and chat steering mint tasks in `draft`, which is
     the PREVIEW state — not on the board and deliberately unaudited (CDR-033 §4) — so the durable trace is
     `task.created` firing per CONFIRMED task via the existing `draft→planned` transition, plus the automatic gateway
     usage event for the metered model call. A planning-run event would need an AUDITED_OPERATIONS entry with no canon
     behind it; EVENT-CATALOG registers none, and P4-006 owns the run/snapshot linkage (PLAN-004). The P4-003 backlog
     row's Audit = "roadmap.generated audited" is inherited boilerplate: that event is P4-001's, is subject-typed
     `roadmap`, and its metadata is already fixed. -->
<!-- ACBP-P4-006 (CDR-041 §3-G6; PLAN-004) registers ONE new event, `planning.run_recorded`, subject type
     `planning_run` — the run/snapshot linkage EVENT-CATALOG deferred to this ticket in the P4-003 note above.
     AUDITED in-tx with the run row, its input links and the task drafts (ADR-015 audit-or-nothing). Bounded metadata
     is scalars ONLY — {mode, outcome, task_count, tasks_missing_rationale, memory_items_considered,
     milestones_in_scope} — never rationale text, task titles, or memory content; the exact input set is recoverable
     from the immutable `planning_run_inputs` rows (audit metadata forbids arrays).
     Its audit OUTCOME is `success` even for a run whose generation failed: the audited operation is RECORDING THE
     RUN, which succeeded, and the run's own result is the `outcome` metadata scalar. This follows `strategy.selected`
     recording a `reject` mode as metadata rather than as a non-success outcome, and keeps `denied`/`blocked`
     meaningful for authorization and policy.
     This does NOT contradict the P4-003 note: that rule holds because a DRAFT TASK is not on the board, and drafts
     remain unaudited here. A planning RUN is a platform action taken on the owner's behalf — what ADR-015 audits.
     Activity fan-out remains DEFERRED. -->
<!-- ACBP-P4-004 (CDR-042; TASK-001 views) registers NO NEW EVENT. The board is a pure READ projection over the
     eleven-state machine P4-002 built: it adds no state, no transition, no storage and no migration, so there is
     nothing to audit. TASK-001's acceptance ("all state transitions are server-enforced, audited, and visible") is
     satisfied by P4-002's transition enforcement plus `task.created`; this ticket delivers the VISIBLE half.
     Note for future work: the six PRD buckets are TABS observed in the reference product, not persisted states —
     `raw-audit/evidence/task-states.csv` records four of them as empty tabs. `recurring` and `rejected` are declared
     but unreachable in this version (PLAN-003/TASK-003 are Post-MVP), and HELD is a bucket this platform adds so a
     stalled task cannot read as progressing.
     CORRECTED by ACBP-P4-005 (CDR-043 §2): this note previously said the `rejected` bucket was pending "the reject
     control is P4-005". It is not pending — NO REQUIREMENT DEFINES TASK REJECTION AT ALL. The backlog Objective's
     "reject" is shorthand contradicted by its own Acceptance criteria; the `reject` verb belongs to UNDER-003,
     STRAT-003 and APPR-007, all different objects; and the audit lists task rejection under "Controls not exercised".
     The bucket is therefore declared-but-unreachable indefinitely, not merely awaiting a ticket. -->
<!-- IMPLEMENTED (ACBP-P4-005; CDR-043 §4-G10; TASK-008 "delete ... is audited"): two events, both durable
     `audit_events` rows written in the SAME transaction as their effect (ADR-015 audit-or-nothing), SCALARS ONLY.
     `task.repeated` takes the NEW task as its subject with `{source_task_id, source_state}` in metadata, so lineage
     reads forward from either end. `task.deleted` records `{state_at_delete, has_reason}` — WHAT was lost, since once
     reads exclude the task that is the only surviving signal, and `has_reason` as a BOOLEAN so the owner's free-text
     reason stays out of the audit payload entirely. No titles, no descriptions, no reason text in either. -->
<!-- IMPLEMENTED (ACBP-P5-001a; CDR-049 §4; ADR-008 "Run trail audited"): `job.enqueued`, written in the SAME
     transaction as the `jobs` row (ADR-015), so a job cannot exist without the record of who scheduled it. Metadata is
     EXACTLY `{kind, deduplicated}`: never the payload, which carries caller-chosen references and is not a reviewed
     surface, and never the tenant ids, since the audit row is already account-scoped and copying tenancy into a
     payload is how the two come to disagree. `deduplicated` records the one enqueue outcome that creates no row — an
     idempotency key matching an existing job — which is reported to the caller as success and would otherwise leave
     no trace at all. -->
<!-- IMPLEMENTED (ACBP-P5-002; CDR-053): the coordinator registers exactly THREE of the rows below — `task.started`
     {run_id, attempt}, `task.failed` {run_id, attempt, failure_category}, `task.cancelled` {run_id, phase}. The
     catalog's `phase (queued/running-safe-stop)` matches `classifyCancellation` exactly, which is a strong independent
     confirmation that the two-operation split is canon's own reading and not an invention.
     `task.completed` is DELIBERATELY NOT registered: this row requires `artifact_refs[]` ("no artifactless
     completion", TASK-005), and a RUN succeeding is not the same fact as a TASK completing — the task completes when
     its artifact is persisted, which belongs to the ticket that owns artifacts.
     `retry_state` on `task.failed` is TASK-010 retry visibility, owned by P5-013; it will arrive as schema version 2
     rather than being guessed at now. `cancelled_by` is likewise deferred: the actor already reaches the audit row
     through `AuditWriteContext`, and duplicating an identity into the payload would put it in two places that can
     disagree. -->
| job.enqueued | Durable job | run trail | job_id (subject), {kind, deduplicated} — never the payload | audited | with company |
| task.repeated | Task | activity | new task_id (subject), {source_task_id, source_state} | audited | with company |
| task.deleted | Task | activity | task_id, {state_at_delete, has_reason} — never the reason text | audited | with company |
| task.created / task.queued / task.started | Task / Coordinator | activity, Decision Room | task_id (created: {has_milestone} only, P4-002), (run_id, attempt on started) | audited | with company |
| task.waiting_for_input / task.waiting_for_approval | Coordinator | Decision Room, notification | task_id, blocking_ref (question/approval id) | audited | with company |
| task.completed | Coordinator | activity, usage, documents | task_id, run_id, artifact_refs[] (**required — no artifactless completion without explicit no-artifact rationale, TASK-005**) | audited | with company |
| task.failed | Coordinator | activity, Decision Room | task_id, run_id, failure_category, retry_state (TASK-006/010) | audited | with company |
| task.cancelled | Task | Coordinator, activity | task_id, cancelled_by, phase (queued/running-safe-stop) | audited | with company |
| worker.started / worker.completed / worker.failed | Worker runtime | Coordinator | worker_run_id, worker_id+version, (failure_category) | run trace | with company |
<!-- IMPLEMENTED (ACBP-P5-005; CDR-057): all three registered, with canon's names and canon's payload. The subject is
     the WORKER RUN, not the worker — a reader tracing "what did this attempt do" wants one thread per run — and the
     version travels with the id because once a worker is re-registered, "which worker ran this" has no answer without it.
     A SAFE-STOP files under `worker.completed` carrying `run_outcome: 'stopped'`. It is not `worker.failed` (CDR-057
     §1-G7: the run did what the owner asked, and filing it as a failure would make every deliberate intervention look
     like a malfunction), and it is not mistakable for finished work either, because the payload says which it was.
     The audit OUTCOME stays `success` even on a failed run, following `planningRunRecorded`: the audited operation is
     RECORDING the run, and reserving `denied`/`blocked` for authorization and policy keeps those outcomes meaningful.
     Optional keys are OMITTED, never null — `AuditMetadata` is scalars only and a null throws at write time. -->
| policy.evaluated | Policy engine | (record) | evaluation_id, policy_version, decision, evaluation_point (propose/approval/pre_exec) | **is audit-grade** (POL-006) | ≥ audit |
| policy.blocked | Policy engine | Decision Room, activity | evaluation_id, blocked_action_ref, rule | audited | ≥ audit |
| approval.requested | Approval engine | Decision Room inbox, notification | approval_id, action_type, payload_hash, risk_class, expiry | audited | ≥ audit |
| approval.approved / approval.rejected | Approval engine | Coordinator (unblock), activity | approval_id, decider (human/delegated only), decision_notes? | **audit-grade, in-tx** | ≥ audit |
| approval.expired / approval.revoked | Approval engine | Coordinator (fail closed) | approval_id, (revoked_by) | audited | ≥ audit |
<!-- IMPLEMENTED (ACBP-P5-003b; CDR-054): the dispatcher registers THREE of the rows below — `tool.call_requested`
     {tool_id, tool_version, risk_class, external_effect, (denial_reason)}, `tool.call_completed` and
     `tool.call_failed` {tool_id, tool_version, risk_class, call_outcome, has_receipt}.
     `tool.call_requested` IS EMITTED FOR REFUSALS TOO, carrying outcome `denied` — TOOL-001 requires the attempt to be
     audited, and a reader counting denials should not have to parse metadata to find them.
     `tool.call_started` is STILL NOT registered after P5-005. The worker runtime exists, but it deliberately never
     executes a tool itself — every call goes through `dispatchToolCall`, which already emits `tool.call_requested`.
     Registering a start event no code can emit would declare a record that does not exist.
     `policy_eval_ref` and `approval_ref` are absent because the engines that produce them are Phase 6's. `has_receipt`
     is a BOOLEAN rather than the receipt: whether an external effect could be evidenced is the auditable fact, and the
     reference itself lives on the `tool_calls` row. `unconfirmed` never carries the success outcome — canon says a
     missing receipt marks the call unconfirmed, "never 'succeeded'". -->
| tool.call_requested / tool.call_started | Dispatcher | (record) | tool_call_id, tool_id+version, risk_class, policy_eval_ref, approval_ref?, idempotency_key | TOOL-002 completeness | ≥ audit |
| tool.call_completed / tool.call_failed | Dispatcher | Coordinator, usage | tool_call_id, outcome, receipt_ref (external effects: **required for success claim**, invariant 20), error_category | audit-grade for external classes | ≥ audit |
| model.call_completed | Model gateway | Usage ledger | call_id, provider, model+version, token_usage, est_cost, fallback_used, latency_ms, outcome | usage source record | ≥ billing |
<!-- IMPLEMENTED (ACBP-P2-003; CDR-026 §5): `model.call_completed` is realized as the APPEND-ONLY `usage_events`
     row (migration 0017) — the durable, immutable usage source record for every model call, written FAIL-CLOSED in
     the gateway. It carries bounded metadata only (provider, model@version, token_usage, estimated_cost_micros
     [integer micro-units], fallback_used, latency_ms, outcome, task_class, correlation_id) — NO prompt/response
     content. Because that append-only row IS the durable record, it is not ALSO written to `audit_events` (avoids
     double-recording; mirrors the CDR-023/CDR-024 audit-mechanism decisions). `usage.recorded`/rollups stay
     deferred (P5-014/P6-009). -->

| usage.recorded | Usage ledger | Rollup maintainer, UI | usage_event_id, kind, quantities, company_id, account_id | append-only ledger | ≥ billing |
| usage.limit_reached | Usage ledger | Policy engine, notification, Decision Room | limit_type, scope, threshold (hard/soft) | audited | ≥ billing |
| document.generated | Document module | activity, Decision Room results | document_id, version, provenance_ref (worker, run, model_version) | audited | with company |
| artifact.exported | Export module | audit | export_job_id, scope, manifest_digest | **audit-grade** (ownership check logged) | permanent record |
| integration.connected / integration.revoked | Integration module | Dispatcher (fail closed on revoked, invariant 15), activity | integration_id, provider, scopes (connected), revoked_by | audit-grade | permanent record |
| emergency_stop.activated / emergency_stop.cleared | Emergency-stop controller | Dispatcher (immediate check), Coordinator, notification | scope, scope_id, activated_by / cleared_by, held_work_count (clear) | **audit-grade, in-tx** | permanent record |

## Notes

- **`interview.started` activity fan-out is DEFERRED (ACBP-P2-001 / CDR-022 §4).** As implemented in P2-001 the
  event is **audit-only**: it is registered in `AUDIT_EVENTS` and emitted in the session-start transaction, but
  it is NOT projected into the `activity_events` feed. Projecting it would extend P1-009's deliberately closed
  activity taxonomy (pinned by the P1-014 adversarial suite), which belongs in an isolated, reviewed change made
  when the discovery activity/memory surface (M3) actually consumes it. Audit-only-now → project-later is
  additive and reversible. The "activity" column above records the eventual design intent, not the current
  shipped behavior.
- **`interview.question_answered` is NOT emitted yet (ACBP-P2-002 / CDR-023 §4).** P2-002 persists questions and
  answers (append-only revisions) but emits **no** event: its Audit-relationship is already "—", and its
  consumers (Understanding-incremental, memory) do not exist until M3/P2-006, nor does the transactional outbox
  — so emitting it now would have no consumer. Accountability for a revision lives in the append-only, authored
  (`created_by_user_id NOT NULL`), immutable answer rows; the audit-grade *correction* record is
  `understanding.corrected` (M3, DISC-008). The "Consumers" column records the eventual design intent, not the
  current shipped behavior. Deferral is additive and reversible.
