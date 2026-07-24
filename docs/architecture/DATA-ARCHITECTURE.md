# Data Architecture

Status: Proposed. **Logical model — not final migrations.** Vendor-neutral; ADR-007 governs isolation. Mutability: A = append-only, I = immutable after creation, V = versioned (new version per change), M = mutable with audit. Tenant: C = company-owned (`company_id` immutable), A = account-owned, G = global/platform.

## 1. Logical objects

| Object | Tenant | Key identifiers | Relationships | Lifecycle | Mut. | Sensitive fields | Retention | Audit | MVP |
|---|---|---|---|---|---|---|---|---|---|
| Account | A (root) | account_id | has Users via Membership; owns Companies | active→suspended→closed | M | billing refs | Life + legal hold post-deletion | All lifecycle changes | MVP |
| User | G (identity) | user_id, email | Memberships | active→deactivated→deleted | M | email, name, credentials hash | Until deletion (ACC-005) | auth events | MVP |
| Membership | A | (user_id, account_id, company scope) | User↔Account/Company + role | invited→active→revoked | M | — | Life of account | role changes audited | MVP |
| Company | C (root) | company_id, account_id | owns everything below | draft→onboarding→active→paused→deactivating→deactivated (→deleted) | M | — | Until deletion + retention | company.* events | MVP |
| Company profile | C | profile_id | 1:1 Company | with company | V | founder-provided business data | With company | version history | MVP |
| Provisioning checkpoint | C | (company_id, step) | 6 canonical steps per Company (ACBP-P1-012; CDR-018) | pending→completed / pending→failed (retry ≤3; no durable running) | M (current state; history = audit) | — | With company | provisioning.* audit-only events | MVP |
| Workspace area | C | (company_id, area) | closed set: mission_draft, research, roadmap, documents (ACBP-P1-012) | registered | A (append-only) | — | With company | via provisioning step audits | MVP |
| Platform admin | G (operator allowlist) | user_id (PK, FK users.id) | marks a User as platform operator (ACBP-P1-013; CDR-019) | active→revoked (shape CHECKs; owner-connection ops only — no runtime write path) | M (owner connection only; acbp_app = self-check SELECT only under FORCE RLS) | — | Permanent (revoked rows retained) | admin.tenant_read audit-only events record every use | MVP |
| Interview session | C | session_id | has Questions/Answers; feeds Understanding | not_started→in_progress→waiting_for_user→ready_for_review→confirmed→superseded | M (state) | founder answers | With company | interview.* | MVP |
| Question | C | question_id, session_id | belongs to session; may depend on prior Answer | asked→answered/skipped | I | — | With session | — | MVP |
| Answer | C | answer_id, question_id | 1:1 Question; source for memory items | given→revised(new row) | A (revisions append) | founder content | With session | corrections audited | MVP |
| Fact / Preference / Constraint / Assumption / Research finding | C | memory_item_id (typed) | realized as **Memory item** rows (MEM-001); linked to sources and dependents | proposed→accepted/confirmed→superseded/invalidated/deleted | V | business content | User-deletable (MEM-002) | all changes audited (MEM-003) | MVP |
| Strategy option | C | option_id | derives from Understanding version; feeds Decision | generating→ready_for_review→selected/rejected→superseded | I (content) | — | With company | strategy.* | MVP |
<!-- IMPLEMENTED (ACBP-P2-008; CDR-029): the Understanding artifact is realized as `understanding_documents`
     (versioned header — `version` unique per company, `status` complete|partial, `overall_confidence` = weakest
     section, UNDER-005) + `understanding_items` (classified into the closed 6-set fact/preference/constraint/
     assumption/research_finding/open_question, each with `confidence` + a `source_ref` provenance link to memory).
     Both company-owned, dual-keyed FORCE RLS, VERSIONED + APPEND-ONLY (SELECT+INSERT only — a re-generation is a
     new version; review/correct is P2-009). Generated via the gateway from confirmed memory; `understanding.generated`
     audited in-tx; usage metered. -->

| Decision | C | decision_id | links understanding version + options considered + selection | recorded (terminal) | **I** | — | Permanent (with company) | decision.recorded | MVP |
| Goal | C | goal_id | belongs to Roadmap | active→achieved/dropped | V | — | With company | roadmap versions | MVP |
| Roadmap | C | roadmap_id, version | has Goals/Milestones; from Decision | versioned | V | — | With company | ROAD-002 versions | MVP |
| Milestone | C | milestone_id | belongs to Roadmap; Tasks trace to it | planned→reached/dropped | V | — | With company | — | MVP |
| Task | C | task_id | traces to Milestone; has Runs, Dependencies | see WORKFLOW-STATE-MACHINES §4 | M (state) | — | With company | task.* | MVP |
| Task dependency | C | (task_id, depends_on_task_id) | Task↔Task | with tasks | I | — | With tasks | — | MVP |
| Task run | C | run_id, task_id, attempt | has Worker run, Tool calls, Usage events | queued→running→succeeded/failed/cancelled | A | — | With company | run trace | MVP |
| Worker definition | G | worker_id, version | allowlists Tools; referenced by runs | draft→active→retired | V | — | Permanent | version changes | MVP |
| Worker run | C | worker_run_id | 1:1 task run execution segment | started→completed/failed | A | — | With company | worker.* | MVP |
| Tool definition | G | tool_id, version | risk class; referenced by allowlists | active→retired | V | — | Permanent | class changes audited | MVP |
| Tool call | C | tool_call_id, idempotency_key | belongs to run; links policy eval + approval | see state machine §6 | A | args digest (not raw sensitive args) | With company | 100% recorded (TOOL-002) | MVP |
| Policy | C (+G defaults) | policy_id, version | evaluated per action | active→superseded | V | limits config | Permanent versions | policy changes audited | MVP |
| Policy evaluation | C | evaluation_id | links tool call/approval; policy version | recorded (terminal) | **A/I** | — | ≥ audit retention | POL-006 | MVP |
| Approval request | C | approval_id, payload_hash | links action, policy eval; consumed by Tool call | see state machine §5 | M (state only) | normalized payload | ≥ audit retention | approval.* | MVP |
| Approval decision | C | decision on approval_id | actor, timestamp, choice | recorded | **I** | — | ≥ audit retention | approval.approved/rejected | MVP |
| Integration | C | integration_id | has Credential reference | connected→degraded→revoked | M | scopes, account identity | Revocation record permanent | integration.* | Post-MVP |
| Credential reference | C/G | credential_ref_id (opaque) | points into secret manager — **value never in DB** | active→rotated→revoked | M | none in DB (by design) | Reference history permanent | access audited | MVP (platform keys) |
| Memory item | C | memory_item_id, type | source link (provenance §3); dependents | see Fact row | V | business content | User-deletable | MEM-003 | MVP |
| Generated document | C | document_id, version | produced by Task run; content in object storage | draft→final→superseded | V | business content | With company; exportable | provenance (TASK-005) | MVP |
| Generated artifact | C | artifact_id | non-document outputs (future: code bundles) | created→exported/deleted | I | — | With company | export audits | Post-MVP |
| Deployment | C | deployment_id, version | future: generated-app deploys | future | I | — | Future | full audit | Future |
| Activity event | C | event_id | projection feeding the feed | recorded | **A** | redacted content | With company | is activity | MVP |
| Audit event | C/A/G | audit_id, correlation_id | references any object | recorded | **A** (immutable, invariant 11) | actor, context (redacted) | AOQ retention (≥ product data) | is the audit | MVP |
| Usage event | C | usage_event_id | links run/tool call/model call | recorded | **A** (invariant 9) | — | ≥ billing retention | reconciliation | MVP |
<!-- IMPLEMENTED for MODEL CALLS (ACBP-P2-003; CDR-026 §6): table `usage_events` (migration 0017) — company-owned,
     dual-keyed FORCE RLS, APPEND-ONLY (SELECT+INSERT grants only; NO update/delete grant, NO update policy —
     invariant 9). v1 `kind = 'model_call'`; `estimated_cost_micros` is integer micro-units (never a float);
     `error_category` present iff `outcome='error'` (the seven-value taxonomy). Tool/worker usage kinds + the account
     usage rollup arrive with their tickets (P5-004/P5-014/P6-009). -->

| Account usage rollup | A | (account_id, period) | aggregates usage events across companies | maintained | M (derived; rebuildable from ledger) | — | ≥ billing retention | reconciliation | MVP (ADR-003) |
| Credit transaction | A/C | credit_txn_id | grants/spends/refunds/expiry; corrections reference originals | recorded | **A** (invariant 10) | — | ≥ billing retention | BILL-002 | MVP |
| Notification | C/A | notification_id | references source event | queued→delivered/failed | M (state) | — | Short (config) | delivery log | Post-MVP |
| Emergency-stop state | C/A/G | (scope, scope_id) | checked by dispatcher | active→cleared | M | — | History permanent | emergency_stop.* | MVP |

## 2. Tenant isolation (ADR-007)

1. **Immutable ownership:** every C-row carries `company_id` (and `account_id` where relevant) set at insert, with no update path (invariant 1).
2. **Authorization queries always tenant-scoped:** repository layer requires tenant context as a construction parameter — queries without it do not compile/execute (invariant 2: context derives from session membership, never client input).
3. **Second layer:** database row-level security policies keyed to a per-connection tenant setting — an app-layer bug alone cannot cross tenants. Row-level enforcement is **recommended where practical**; the *requirement* is two independent layers, vendor choice is separate (AOQ-02).
4. **Cross-company access tests:** adversarial suite (ID substitution, forged membership, IDOR probes) runs in CI; 100% pass is launch gate 1.
5. **Administrative access:** separate authz surface; reason capture; audited; no RLS bypass except break-glass role with alarmed usage (§SECURITY).
6. **Background workers:** jobs carry explicit tenant context (invariant 3); worker DB sessions set the tenant before any query.
7. **Tool calls:** dispatcher stamps tenant onto every call record; tools receive scoped context only.
8. **Storage paths:** object keys prefixed `company/{company_id}/…`; signed URLs scoped to prefix.
9. **Cache keys:** mandatory tenant prefix in the cache-key builder (single utility, lint-enforced).
10. **Log redaction:** tenant identifiers appear in logs only as opaque IDs; cross-tenant log access is role-controlled (ADR-017).
11. **Export ownership:** export jobs verify requester's membership of the exact company; archives contain only that company's prefix.

## 3. Facts vs assumptions — provenance model

Memory items are **typed** (MEM-001): `user_fact` · `user_preference` · `constraint` · `ai_assumption` · `research_finding` · `approved_decision` · `measured_outcome` · `correction`. A generated claim can never be stored as `user_fact` (type is set by source path, not by content).

Provenance fields on every memory item and generated-claim reference:

| Field | Meaning |
|---|---|
| source_type | interview_answer · user_edit · task_result · model_generation · imported_document · system_measurement |
| source_ref | ID of the originating answer/run/document (resolvable link — MEM-003) |
| confidence | numeric + class per PRD §7 bands |
| created_by | actor (user id / worker id + version) |
| confirmed_by | user actor when confirmation state advances |
| confirmation_state | proposed → accepted → validated / invalidated (UNDER-004) |
| superseded_by | forward pointer on correction/replacement (never destructive overwrite) |

Instruction precedence (MEM-004): explicit user instructions are stored as `user_fact`/`constraint` with `confirmed_by` set; the context assembler ranks confirmed user items above AI assumptions and, on conflict, emits a question event instead of silently preferring memory (invariant-adjacent runtime check, tested via seeded conflicts).
