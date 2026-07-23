# CDR-018 — Workspace provisioning (ACBP-P1-012)

Status: **Accepted** (owner decision 2026-07-23). Governs ACBP-P1-012.
Sources: backlog ACBP-P1-012 (COMP-002/003; ADR-008 *(semantics)*; ADR-015; dep ACBP-P1-010; "Provision workspace
(profile/docs areas/activity) with visible checkpointed progress"; "Failed step visible + retry; no orphans";
"All steps visible ordered; interrupt + resume proven"; "Kill-and-resume test"); REQUIREMENTS.csv COMP-002
("profile, mission draft, research area, roadmap area, document store, and activity stream… Code/hosting
provisioning is Post-MVP") + COMP-003 ("ordered, timestamped… ending in an explicit completed or failed state…
Interrupted provisioning resumes from the last checkpoint"); WORKFLOW-STATE-MACHINES §1 (draft→onboarding on
create submit; onboarding→active system-driven; per-step retry, bounded); diagrams/03 ("MVP provisioning =
workspace/profile/docs only (no code/hosting)"; steps "profile, mission draft, research area, roadmap area,
docs, activity"); ADR-008 (durable/idempotent/checkpointed/kill-and-resume SEMANTICS — the pg-boss-class runner
itself is an M5 deliverable); CDR-015 (§103: a 4th `acbp_provision_company` SECURITY DEFINER REJECTED; pause/
resume can never force onboarding→active); CDR-016 (closed 4-event activity taxonomy); P0-005 (object storage
BLOCKED — canonically gates P5-011 only, NOT P1-012).

## Owner decisions (2026-07-23)

1. **Internal-only boundary.** Provisioning creates/verifies internal PostgreSQL-backed workspace structures
   ONLY. No external provider, credentials, webhook, object-storage integration, hosting, codebase, database
   service, or sandbox is involved anywhere in P1-012.
2. **Six canonical ordered steps:** 1 `profile` · 2 `mission_draft` · 3 `research` · 4 `roadmap` ·
   5 `documents` · 6 `activity`. A closed set; order is fixed.
3. **Automatic post-create start; request-driven sequential execution.** Provisioning starts automatically
   after the company-creation transaction COMMITS. Execution is request-driven and sequential — every step runs
   in a FRESH validated CompanyScope transaction. **No worker, queue, detached task/promise, polling loop,
   lease, checkpoint daemon, outbox, or owner-connected runtime path.**
4. **Durable checkpoint/resume.** One MUTABLE current-state row per (company, step) (`provisioning_steps`);
   durable statuses are **pending | completed | failed** — a `running` state is NEVER committed (a request-local
   in-flight notion must not survive commit; no lease machinery is therefore needed). Append-only history lives
   in the durable audit events, not in extra tables.
5. **Bounded attempts.** Maximum **3 total attempts per step** (including the first). A step failed at attempt 3
   is EXHAUSTED: resume returns a safe conflict and performs no mutation.
6. **Material effects (no fake success — invariant 20).** `profile` VERIFIES the existing deterministic current
   `company_profiles` revision (no duplicate profile object); `mission_draft`/`research`/`roadmap`/`documents`
   each INSERT a minimal `company_workspace_areas` registry row (closed area set, idempotent); `activity`
   VERIFIES the existing `company.created` activity projection against its authoritative audit identity (no
   synthetic activity event). A step is never `completed` unless its material effect/verification succeeded.
7. **Activation gate.** `onboarding→active` requires **all six steps completed** (fresh transaction; locks;
   idempotent; `provisioning.completed` audited atomically with the transition). **Failed-and-acknowledged
   activation is DEFERRED** — no acknowledgement surface exists in P1-012, and no step failure may activate.
8. **Audit-only events; activity taxonomy unchanged.** Exactly six new REGISTERED durable audit events —
   `provisioning.started`, `provisioning.step_started`, `provisioning.step_completed`,
   `provisioning.step_failed`, `provisioning.retry_requested`, `provisioning.completed` — company-scoped,
   redacted (bounded metadata allowlists; closed failure/result codes; never raw exceptions/SQL/free text), and
   **excluded from `activity_events`** (the P1-009 four-event taxonomy stays closed). Automatic execution =
   `system` actor; an explicit resume request's `retry_requested` = the authenticated `user` actor.
9. **Migration 0010 (additive).** `provisioning_steps` (dual-keyed, FORCE RLS, SELECT+INSERT+column-limited
   UPDATE for `acbp_app`, no DELETE/TRUNCATE) + `company_workspace_areas` (dual-keyed, FORCE RLS,
   SELECT+INSERT only). Backfill seeds six PENDING checkpoint rows for every existing draft/onboarding company —
   deterministic/idempotent, runs NO provisioning, performs NO lifecycle transition. Migrations 0001–0009
   unchanged. **No fourth SECURITY DEFINER function.**
10. **Creation-transaction integration.** The existing atomic company-creation bootstrap additionally inserts
    the six pending checkpoints, transitions `draft→onboarding`, and writes `provisioning.started` — ALL in the
    same single `acbp_app` transaction (any of these failing rolls the whole creation back; no partial rows; no
    external work before commit). After commit, the request invokes the resume service inline; a later step
    failure never rolls back the created company — it stays `onboarding` with truthful checkpoints.
11. **Authorization.** New company-level actions `provisioning:read` (owner|viewer) and `provisioning:resume`
    (owner only). companyId stays a selector; every API/executor entry resolves a fresh CompanyScope; account
    ownership without active company membership is denied.
12. **API-only.** `GET /api/companies/[companyId]/provisioning` (ordered six-step status; no query params) and
    `POST /api/companies/[companyId]/provisioning/resume` (idempotent; no body/params; owner-only). **No
    start/retry/acknowledge/cancel endpoint beyond the single resume route. No UI. No SSE.**

## Explicitly rejected

Detached in-process background work (unawaited promises/timers); process-global provisioning state; owner
database connections or BYPASSRLS in any runtime path; a committed `running` state (would require leases);
fake completed steps with no durable result; duplicate profile/activity representations; provisioning events in
the activity feed; failed-step acknowledgement; automatic activation with failed steps; UI/SSE; provider
simulation presented as production provisioning; a 4th SECURITY DEFINER function (CDR-015 reaffirmed).

## Out of scope (deferred)

External/provider provisioning (BUILD/DEPLOY/EMAIL, Post-MVP); the ADR-008 job-runner/worker/outbox machinery
(M5); object storage (P0-005 → P5-011); SSE (P6-008); rendered UI; failed-step acknowledgement flow; interview
start beyond the `active` unlock (P2-001); deactivate/delete (COMP-007); P1-013+.
