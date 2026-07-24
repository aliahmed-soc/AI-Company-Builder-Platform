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
| understanding.corrected | Understanding | memory (correction item), planning (staleness flags) | item_id, correction_ref, dependents_flagged | audited (DISC-008) | with company |
| memory.item_created | Memory (P2-006) | audit only — never activity | item_type, source_type (no content, no raw source_ref) | audited in-tx (MEM-003 "all changes audited"); CDR-024 §4; actor/account/company server-stamped | with company |
| memory.item_superseded | Memory browser (P2-010) | audit only — never activity | item_type, source_type of the NEW version (no content) | audited in-tx (a lifecycle transition, ADR-015); subject = the superseded (old) item; CDR-025 §4 | with company |
| memory.item_deleted | Memory browser (P2-010) | audit only — never activity | item_type, source_type, transition='active_to_deleted' (no content) | audited in-tx (a lifecycle transition, ADR-015); subject = the deleted item; owner-only soft delete; CDR-025 §0 | with company |
| understanding.confirmed | Understanding | Strategy (unlock), activity | understanding_version, confirmed_by | audited | permanent |
| strategy.generated | Strategy | activity | option_ids[], similarity_check_result | — | with company |
| strategy.selected | Strategy | Planning (unlock), decision | option_id, mode (select/edit/combine), phase_scope? | audited | permanent |
| decision.recorded | Strategy&Decision | activity, memory | decision_id, understanding_version, options_considered[] | **is audit-grade (immutable)** | permanent |
| roadmap.generated | Planning | Task module, activity | roadmap_version, milestone_count, task_ids[] | audited | with company |
| task.created / task.queued / task.started | Task / Coordinator | activity, Decision Room | task_id, (run_id, attempt on started) | audited | with company |
| task.waiting_for_input / task.waiting_for_approval | Coordinator | Decision Room, notification | task_id, blocking_ref (question/approval id) | audited | with company |
| task.completed | Coordinator | activity, usage, documents | task_id, run_id, artifact_refs[] (**required — no artifactless completion without explicit no-artifact rationale, TASK-005**) | audited | with company |
| task.failed | Coordinator | activity, Decision Room | task_id, run_id, failure_category, retry_state (TASK-006/010) | audited | with company |
| task.cancelled | Task | Coordinator, activity | task_id, cancelled_by, phase (queued/running-safe-stop) | audited | with company |
| worker.started / worker.completed / worker.failed | Worker runtime | Coordinator | worker_run_id, worker_id+version, (failure_category) | run trace | with company |
| policy.evaluated | Policy engine | (record) | evaluation_id, policy_version, decision, evaluation_point (propose/approval/pre_exec) | **is audit-grade** (POL-006) | ≥ audit |
| policy.blocked | Policy engine | Decision Room, activity | evaluation_id, blocked_action_ref, rule | audited | ≥ audit |
| approval.requested | Approval engine | Decision Room inbox, notification | approval_id, action_type, payload_hash, risk_class, expiry | audited | ≥ audit |
| approval.approved / approval.rejected | Approval engine | Coordinator (unblock), activity | approval_id, decider (human/delegated only), decision_notes? | **audit-grade, in-tx** | ≥ audit |
| approval.expired / approval.revoked | Approval engine | Coordinator (fail closed) | approval_id, (revoked_by) | audited | ≥ audit |
| tool.call_requested / tool.call_started | Dispatcher | (record) | tool_call_id, tool_id+version, risk_class, policy_eval_ref, approval_ref?, idempotency_key | TOOL-002 completeness | ≥ audit |
| tool.call_completed / tool.call_failed | Dispatcher | Coordinator, usage | tool_call_id, outcome, receipt_ref (external effects: **required for success claim**, invariant 20), error_category | audit-grade for external classes | ≥ audit |
| model.call_completed | Model gateway | Usage ledger | call_id, provider, model+version, token_usage, est_cost, fallback_used, latency_ms, outcome | usage source record | ≥ billing |
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
