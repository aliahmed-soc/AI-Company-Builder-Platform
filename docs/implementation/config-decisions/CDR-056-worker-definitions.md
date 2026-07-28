# CDR-056 — Worker definitions: versioned configuration, and the allowlist's home (ACBP-P5-004)

**Status:** proposed · **Ticket:** ACBP-P5-004 · **Requirements:** WORK-001, WORK-006 · **ADR:** 012 · **Trust-critical:** #4 · **Open question:** IOQ-12 · **Depends on:** ACBP-P5-003 (complete)

| | |
| --- | --- |
| In scope | The versioned `worker_definitions` registry with canon's eleven fields; the per-company pause/disable state (WORK-006); the resolver that turns a worker id into the allowlist the dispatcher enforces |
| Out of scope | The worker RUNTIME that executes definitions (P5-005); the three MVP workers' prompts and logic (P5-006/007/008); the policy and approval engines the `approval_profile` will feed (Phase 6) |

## 0. Why this ticket matters more than its size suggests

`CDR-054 §1-G3` and `CDR-055 §5` both deferred the same thing: **where the tool allowlist comes from.** The dispatcher enforces it unconditionally — no allowlist supplied ⇒ deny — but until now the list was a caller-supplied parameter, which makes WORK-005's *"server-enforced"* true mechanically and not yet authoritatively.

This ticket closes that. Trust-critical #4 says allowlists are *"versioned in worker definitions"*; after this, they are.

## 1. What canon fixes

`AI-AND-WORKER-ARCHITECTURE §2` gives the field list outright, and this record does not improvise on it:

| Field | Canon's words |
| --- | --- |
| Worker ID / version | e.g. `research@1` |
| Capability | declared task types it may accept |
| Allowed tools | explicit allowlist (WORK-005; deny-by-default, invariant 4) |
| Required input schema | task-type input contract |
| Output schema | artifact contract (validated) |
| Max execution budget | model-spend cap per run (NFR-015) |
| Max duration | wall-clock bound; overrun → safe-stop → failed(`timeout`) |
| Retry eligibility | which failure categories auto-retry (TASK-010) |
| Approval profile | which of its tool calls are approval-gated **by risk class** |
| Model profile | which gateway task-class config it uses |
| Logging policy | redaction class for its prompts/outputs |

It also fixes the same section's closing constraint: *"All three run **informational / internal-reversible risk classes only** — no MVP worker has any external-effect tool in its allowlist (the MVP's zero-external-actions boundary is thus **structural, not procedural**)."*

## 2. Guarantees

- **G1 — a worker definition is GLOBAL platform configuration, like the tool registry.** Canon: workers are *"versioned configuration + prompts over one shared execution runtime — not independent agent services"*. So `worker_definitions` carries no tenancy and no RLS, and the app role gets **SELECT only** — the P5-003a shape, for the same reason: a definition the product could rewrite at runtime is not a control.
- **G2 — the PAUSE state is tenant data, because WORK-006 is per company.** *"Individual workers can be paused or disabled **per company** by the owner."* `company_worker_states` is company-owned, dual-keyed FORCE RLS. Two tables, because they answer to two different owners: the platform sets what a worker IS, the company owner sets whether it may run here.
- **G3 — the approval profile is a THRESHOLD, not a list.** *"which of its tool calls are approval-gated by risk class"* — and P5-003a already exports an ordering with `isAtLeastAsRestrictiveAs`. A threshold reuses that ordering; a hand-listed set would drift from it the moment the class set is re-shaped (which `CDR-051 §0.1` says it should be).
- **G4 — the MVP's zero-external-actions boundary is enforced STRUCTURALLY.** A CHECK rejects any definition whose allowlist contains an external-effect tool. Canon calls the boundary structural; a comment saying "we won't do that" is procedural. This is the one guarantee here that is a real gate rather than configuration.
- **G5 — an unregistered worker gets nothing.** WORK-001's failure clause. Resolution returns a typed refusal, never an empty allowlist, because an empty allowlist and an unknown worker mean different things and the dispatcher already distinguishes them (`not_allowlisted` vs `no_allowlist`).
- **G6 — a paused or disabled worker resolves to a REFUSAL, not to a narrower allowlist.** WORK-006: *"Disabled workers receive no new tasks; their queued tasks are held visibly."* Held, not cancelled — so the state belongs on the read path, and nothing here deletes or transitions a task.
- **G7 — definition changes are audited.** The backlog's own audit column. `worker.definition_changed`, subject = the definition, metadata = the bounded ids and versions, never prompts.

## 3. IOQ-12 — the budgets, proposed and flagged

IOQ-12 (*"Initial worker execution budgets: per-run model spend + duration"*) lists its decider as **"Eng + owner"** and its input as **"P2–P4 usage telemetry"**. That telemetry does not exist: no live provider has ever been called (P2-011 remains owner-gated). So there is nothing to derive from, and the honest move is the one CDR-008 already established for the same class of question — **interim technical values, explicitly revisit-bound, no pricing implied.**

| Field | Proposed interim default | Reasoning |
| --- | --- | --- |
| `max_spend_micros` | **500 000** (0.50 USD-equivalent per run) | CDR-008 set an interim ceiling of 2M tokens/day per company. A single run costing more than half a dollar, against that daily ceiling, is far more likely to be a runaway loop than legitimate work — and the cost of being wrong is a refused run, which is visible and retryable. |
| `max_duration_ms` | **600 000** (10 minutes) | `DEFAULT_HEARTBEAT_GRACE_MS` is 90s (CDR-053), so 10 minutes is ~6 heartbeat windows: long enough that a slow-but-live run is never killed by this bound, short enough that a wedged one surfaces the same hour. |

**These are NOT owner-ratified.** They are stored as per-definition columns rather than constants precisely so changing one is a data change, not a deploy — and they are flagged in `AUTONOMOUS-RUN-LOG.md` alongside the risk-class question. Nothing in the MVP exercises them yet: no worker runtime exists to spend or to time out.

## 4. Shape

| Element | Shape |
| --- | --- |
| `worker_definitions` | GLOBAL, versioned `(worker_id, version)`. SELECT-only for the app role. No tenancy, no RLS — the `tool_definitions` precedent. |
| `allowed_tools` | `text[]`, NOT NULL. CHECKed non-empty and against the external-effect boundary (G4). |
| `capabilities` | `text[]` of task types, NOT NULL, CHECKed against P4-003's closed `TASK_TYPES`. |
| `approval_threshold_risk_class` | Nullable. NULL = nothing this worker does is approval-gated. Otherwise the least class that requires approval. |
| `company_worker_states` | Company-owned, dual-keyed FORCE RLS. `(company_id, worker_id)` unique. `state`: `enabled · paused · disabled`. |
| resolution | `resolveWorkerAllowlist(workerId)` → `{ ok, allowlist, definition }` | `unknown_worker` | `paused` | `disabled`. |

## 5. Slice plan

1. CDR-056 + branch + draft PR.
2. Contracts: worker states, the approval threshold, the external-effect boundary predicate, budget bounds — TDD, pure.
3. Migration 0038 (both tables) + repositories + the reset-list sweep; real-PG.
4. Core `resolveWorkerAllowlist` + `setCompanyWorkerState` + the dispatcher wiring; real-PG proof of G4/G5/G6.
5. Docs + **TWO** independent review passes + finalization.

## 6. Review outcomes (both passes FAILED; see `docs/implementation/P5-004-REVIEW.md`)

- **G8 — the MVP boundary is enforced at RESOLUTION, and that is what makes it structural.** §2-G4 said a CHECK would
  reject an over-reaching allowlist. It cannot: `allowed_tools` is a `text[]` and the risk classes live in another
  table, and PostgreSQL CHECKs cannot subquery. Pass 1 found that I had documented the guarantee and implemented
  nothing. It is now enforced at the one point where a definition becomes a **capability** — a violating definition may
  exist in the registry and can never be used, which is the property canon's *"structural, not procedural"* needs. An
  allowlist naming an **unregistered** tool fails it too, because an unknown tool resolves to the most restrictive
  class.
- **G9 — the boundary check reads the ACTIVE version, not the history.** `toolRiskClasses` returned every version, and
  since the check refuses if *any* row is external-effect, a tool re-classified **down** would have been refused
  forever by its own past. `distinct on (tool_id) … order by tool_id, version desc`.
- **G10 — the registry LISTS (WORK-001), readable by any active member.** One entry per worker at the version that
  would actually run. A **viewer** can see the pause: hiding it would make the control invisible to exactly the people
  wondering why nothing ran. `has_reason` is a boolean — the owner's text stays theirs.

### WORK-006's failure clause is NOT met yet, and that is sequencing

> *"Disable during execution triggers safe-stop per TASK-007."*

Disabling stops **future** resolution; it does not currently safe-stop a run already executing. It cannot yet: nothing
links a run to a worker. `task_runs` has no `worker_id`, because the component that knows which worker is executing is
the **worker runtime (P5-005)**, and adding a nullable, unpopulated `worker_id` now would be precisely the FK-less hole
`CDR-049` and `CDR-052 §1` both refused.

So the sequencing is: **P5-005 stamps the worker onto the run, and the disable path then calls P5-002's `cancelRun`**,
which already implements exactly the bounded safe-stop TASK-007 describes. Recorded here rather than left silent,
because an unmet failure clause that nobody wrote down is indistinguishable from one nobody noticed.
