# Workspace provisioning (ACBP-P1-012)

Status: implemented (internal-Postgres-only first cut; CDR-018). This is the "provisioning README" for the
checkpointed workspace bring-up that takes a newly created company from `draft` through `onboarding` to
`active`. Sources: COMP-002/003 (PRD); WORKFLOW-STATE-MACHINES §1; diagrams/03; ADR-008 *(semantics only — the
job-runner/worker machinery remains an M5 deliverable)*; ADR-015; CDR-015 (system-only `onboarding→active`; the
rejected 4th SECURITY DEFINER); CDR-018 (the 25 owner decisions).

## What provisioning is — and is not

Provisioning creates/verifies **internal PostgreSQL-backed workspace structures only**. No external provider,
credentials, webhook, object storage (P0-005 gates P5-011, not this), hosting, codebase, database service, or
sandbox is involved anywhere. The six canonical ordered steps:

| # | Step | Material effect | Success `result_code` |
|---|---|---|---|
| 1 | `profile` | **VERIFIES** the deterministic current `company_profiles` revision exists (created by the P1-010 bootstrap; no duplicate object) | `profile_verified` |
| 2 | `mission_draft` | INSERTs the minimal `company_workspace_areas` registry row (idempotent) | `mission_area_ready` |
| 3 | `research` | INSERTs the area registry row | `research_area_ready` |
| 4 | `roadmap` | INSERTs the area registry row | `roadmap_area_ready` |
| 5 | `documents` | INSERTs the area registry row | `document_area_ready` |
| 6 | `activity` | **VERIFIES** the `company.created` activity projection exists and matches its authoritative audit identity (no synthetic event) | `activity_stream_verified` |

A step is **never** `completed` unless its material effect/verification succeeded (invariant 20 — no fake
success). Verification failures use the closed codes `profile_missing` / `activity_projection_missing`;
`internal_error` is the bounded catch-all. Failure messages are never stored or exposed — only closed codes.

## Execution model — request-driven, sequential, checkpointed

Provisioning **starts automatically after the company-creation transaction commits**: the creation bootstrap
atomically seeds six PENDING checkpoints, performs the system `draft→onboarding` transition, and writes
`provisioning.started`; then the SAME REQUEST awaits the resume service inline. **There is no worker, queue,
detached task, polling loop, lease, checkpoint daemon, outbox, or owner-connected runtime path.** The only
drivers are the post-create inline run and the owner's explicit `POST …/provisioning/resume`.

Every entry — read, resume, each step, the completion transition — is a **fresh `runInCompanyScope`**: fresh
membership validation, fresh CompanyScope, its own transaction on the restricted `acbp_app` role. A step
transaction locks its checkpoint row `FOR UPDATE`, re-checks status/attempt under the lock (concurrent resumes
serialize; completed steps skip idempotently; no double attempt increment), writes `provisioning.step_started`,
performs the material effect, and commits the durable outcome + outcome audit **atomically**.

**Durable statuses are `pending | completed | failed` only — a `running` state is never committed** (the DB
CHECK makes it structurally impossible), so an interrupted step leaves NO committed trace and needs no lease:
kill-and-resume works by construction, resuming from the first incomplete checkpoint. Attempts are bounded to
**3 total per step**; a step failed at the cap is EXHAUSTED — resume performs no mutation and returns a safe
conflict (failed-and-acknowledged activation is deferred; no acknowledgement surface exists).

**Activation:** when all six steps are completed, a separate fresh transaction locks the checkpoints + the
company row, proves the gate (all completed AND status `onboarding`), transitions `onboarding→active`, and
writes `provisioning.completed` atomically — idempotent when already active; fail-closed on any other state.
No step failure can ever activate; pause/resume lifecycle semantics are untouched (a paused company fails
closed with no mutation). **Backfilled** pre-P1-012 draft companies (migration 0010 seeds their pending
checkpoints without executing or transitioning anything) are brought `draft→onboarding` on their first owner
resume, under a company-row lock, with `provisioning.started` emitted exactly once.

## Data model (migration 0010 — additive; 0001–0009 untouched)

`provisioning_steps` — one MUTABLE current-state row per (company, step): dual-keyed FORCE RLS; CHECK-pinned
closed step set + canonical order + statuses + attempt bounds + per-status shape + closed failure codes;
`acbp_app` gets SELECT + INSERT + **column-level UPDATE on exactly the seven outcome columns** (identity
columns are privilege-immutable); no DELETE/TRUNCATE. History is the in-transaction audit trail, not extra
rows. `company_workspace_areas` — append-only minimal registry (closed four-area set; SELECT+INSERT only).
**No fourth SECURITY DEFINER function** (the allowlist stays exactly three).

## Audit — six registered, audit-only events

`provisioning.started` `{step_count}` · `provisioning.step_started` `{step, attempt}` ·
`provisioning.step_completed` `{step, attempt, result_code}` · `provisioning.step_failed` (outcome `blocked`)
`{step, attempt, failure_code}` · `provisioning.retry_requested` `{step, next_attempt}` ·
`provisioning.completed` `{step_count}`. All company-scoped, durable, written in the same transaction as their
state change, with exactly these bounded metadata allowlists. Actor semantics: execution/transition events are
**system** actions (the scope-bound `actor_id` records whose request drove them — provenance, never
authority); only `retry_requested` is a **user** action, and a retry run's system events reference it via
`causation_id`. **None of these are ever projected into `activity_events`** — the P1-009 four-event activity
taxonomy is unchanged, and progress is served by the provisioning API, not the feed (SSE stays deferred).

## Authorization and API

`provisioning:read` → active company member (owner|viewer); `provisioning:resume` → company **owner** only.
companyId is a selector; every entry re-resolves a fresh CompanyScope; account ownership without an active
company membership is denied coarsely.

- **`GET /api/companies/{companyId}/provisioning`** — the ordered six-step status
  `{companyId, companyStatus, steps[], nextIncompleteStep, resumable, exhausted, completed}`; each step exposes
  ONLY `{step, order, status, attempt, requestedAt, startedAt, completedAt, failedAt, failureCode}`. NO query
  parameters (any present → 400). No accountId/actor/membership internals, no error text, ever.
- **`POST /api/companies/{companyId}/provisioning/resume`** — idempotent; no params, body never parsed;
  ok → 200 (status after processing), exhausted/paused/inconsistent → safe 409, denials → coarse opaque 403.
  **The only provisioning mutation surface** — no start/retry/acknowledge/cancel endpoint exists.

API-only: no rendered UI, no SSE (P6-008), no filters/pagination/step selection.

## Operational notes (review-recorded trade-offs)

- **Crashed attempts are audit-invisible by design:** an effect that THROWS (vs. returning a controlled
  failure) rolls back its whole step transaction including the `step_started` event — no committed trace, no
  attempt consumed. That is exactly the no-committed-`running` contract; every retry of such a step is a fresh
  authenticated owner request, and the loop cannot spin.
- **Deploy-order gap:** a company inserted by still-running pre-P1-012 code AFTER migration 0010 has already
  run would have no checkpoint rows (resume fails closed with `conflict`). The 0010 backfill INSERT is
  idempotent (`ON CONFLICT DO NOTHING`) and safe to re-run manually against such rows. No production
  deployment exists today, so this is a runbook note, not a live risk.
- **Pre-existing `active`/`paused` companies** are deliberately NOT backfilled: `GET …/provisioning` returns an
  empty step list with `completed:false` (fail-closed derivation) and resume returns `conflict` with no
  mutation — clients must not read `completed:false` on an `active` company as an error.
- A concurrent lifecycle change landing between resume phases (e.g. pause after activation) can surface a
  bounded 500 from the completion gate instead of a 409 — fail-closed, nothing mutated, vanishingly narrow.

## Deliberately NOT here (deferred)

External/provider provisioning (BUILD/DEPLOY/EMAIL, Post-MVP); the ADR-008 job-runner/worker/outbox (M5);
object storage (P0-005 → P5-011); SSE; UI; failed-step acknowledgement; interview start beyond the `active`
unlock (P2-001); deactivate/delete (COMP-007); P1-013+.
