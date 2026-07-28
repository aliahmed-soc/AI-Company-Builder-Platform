# CDR-054 — The tool dispatcher: a single enforcement chokepoint (ACBP-P5-003b)

**Status:** proposed · **Ticket:** ACBP-P5-003b · **Requirements:** TOOL-002, TOOL-003, WORK-005, NFR-006 · **ADR:** 012 · **Trust-critical:** #4, #11 · **Depends on:** ACBP-P5-003a (tool registry + risk classes), ACBP-P5-002 (task runs)

| | |
| --- | --- |
| In scope | The `tool_calls` record; the dispatch chokepoint; allowlist deny-by-default; the fail-closed policy / approval / emergency-stop seams; per-company idempotency; the honest outcome vocabulary |
| Out of scope | The policy engine and the approval engine themselves (Phase 6); the injection boundary and its corpus (P5-003c); the worker registry that will SUPPLY allowlists (P5-004); real external-effect tools — MVP is structurally zero-external-action |

## 0. What canon settles, so this record does not re-decide it

Diagram `07-worker-execution` fixes the order of operations inside the dispatcher, and it is unusually specific:

1. `allowlist check (invariant 4, deny-by-default)`
2. `policy evaluate №3 + stop-state + approval verify/consume`
3. `denied / stopped / approval invalid` → `fail closed + audited`
4. authorized → execute → `usage event (company + account)`

`COMPONENT-CATALOG` names this component *"Trusted — **the** enforcement chokepoint"*, with the failure mode *"Fail closed on any gate outage"*. `IMPLEMENTATION-ROADMAP-v1 §M5` records the deviation this ticket rests on: the dispatcher **core** lands in Phase 5 because *"execution is impossible without the allowlist chokepoint"*, and *"Phase 6 adds the policy/approval enforcement integration into that dispatcher."*

That section also states the Phase 5 operating envelope outright:

> **"P5 execution is gated by user-initiated runs on informational-class tools only."**

This is the answer to the question the ticket would otherwise have to guess at — what a dispatcher does when the policy engine it must consult does not exist yet. It neither invents a permissive default nor blocks everything: **`informational` may execute; every other class is refused, because the gate that would authorize it is absent, and an absent gate is a closed gate.** Nothing here is my choice; all four of the risk classes are named verbatim by APPR-001, and the Phase 5 envelope is named verbatim by the roadmap.

## 1. Guarantees

- **G1 — one chokepoint, and it is the only path.** Exactly one exported `dispatchToolCall`. No other module executes a tool. A tool with no dispatcher path does not execute at all, which is what makes TOOL-001's *"unregistered execution paths do not exist"* a structural claim rather than a convention.
- **G2 — deny-by-default against the registry.** A tool id absent from `tool_definitions` is refused before anything else. A tool present but **unclassified** resolves to `sensitive_irreversible` (P5-003a's `resolveRiskClass`), so it is refused for exactly the reason any sensitive tool is — the unclassified case needs no separate rule.
- **G3 — the allowlist is checked, and an ABSENT allowlist denies.** WORK-005 requires server-enforced least privilege; trust-critical #4 says allowlists are *"versioned in worker definitions"*, and those arrive in P5-004, which depends on this ticket. So the allowlist is a **port** here whose Phase 5 behaviour is: no allowlist supplied → deny. Deferring the SOURCE is honest sequencing; deferring the CHECK would leave the invariant unenforced on the surface that exists to enforce it.
- **G4 — every gate seam fails closed, and an outage is indistinguishable in effect from a denial.** `PolicyGate`, `ApprovalGate` and `EmergencyStop` are ports whose Phase 5 implementations answer *"no decision available"*. The dispatcher treats no-decision as **deny** for every class above `informational`. There is no configuration in Phase 5 that makes a missing gate permissive.
- **G5 — 100% call records, written BEFORE execution.** TOOL-002 requires a record for every call. A record written after the fact cannot exist for a call that died mid-flight — which is precisely the call worth having a record of. The row is inserted `requested`, then updated with the outcome, so a crash leaves a visibly unfinished call rather than no call at all.
- **G6 — arguments are a DIGEST, never the arguments.** TOOL-002 says *"arguments digest"*. sha256 over a canonical encoding. This is also the charter's standing rule, and it keeps the 100%-coverage surface from becoming the place where secrets accumulate.
- **G7 — an unconfirmed external effect is NEVER reported as success.** TOOL-002's failure clause is explicit: *"Missing receipt marks the call outcome 'unconfirmed', never 'succeeded'."* So `unconfirmed` is a first-class outcome, and `succeeded` is structurally unreachable for an external-effect class without a stored receipt reference.
- **G8 — idempotency is per COMPANY.** Same key + same tool → the first call's record, never a second execution (NFR-006; FAILURE-AND-RECOVERY row 11, *"duplicate suppressed"*). A PARTIAL unique index on `(company_id, tool_id, idempotency_key)`, on CDR-049 §4's reasoning: a global unique would let one tenant's key collide with — and so reveal the existence of — another's.
- **G9 — a refusal fails the STEP, not the task.** WORK-005's failure clause: *"Rejection does not crash the task; it fails that step with reason."* The dispatcher returns a typed refusal. It does not throw, and it does not transition the task.
- **G10 — a call belongs to a run.** `run_id` is NOT NULL with a tenant-pinned composite FK to `task_runs`. This is why P5-002 came first: a nullable, FK-less `run_id` would have made *"a tool call belonging to nothing"* a legal state on the 100%-call-record surface of the enforcement chokepoint (CDR-052 §1).

## 2. Shape

| Element | Shape |
| --- | --- |
| `tool_calls` | Company-owned, dual-keyed FORCE RLS. `run_id` NOT NULL, tenant-pinned composite FK to `task_runs`. |
| outcome | CLOSED: `requested · denied · succeeded · failed · unconfirmed`. Declared in full up front (the CDR-049 §4-G6 precedent). |
| `denial_reason` | Nullable, CLOSED, one-directionally CHECKed against `denied` — the P5-009/P5-001c lesson. |
| `arguments_digest` | sha256 hex, NOT NULL. Never the arguments. |
| `idempotency_key` | Nullable; PARTIAL unique on `(company_id, tool_id, idempotency_key)` where the key is not null. |
| `receipt_ref` | Nullable reference. Required for `succeeded` on an external class — CHECKed, so TOOL-002's clause is enforced by the database and not only by the use case. |
| grants | SELECT + INSERT + a column-scoped UPDATE of exactly the outcome columns. **No DELETE** — a call record is the evidence the call happened. |

## 3. Slice plan

1. CDR-054 + branch + draft PR.
2. Contracts: outcome + denial vocabularies, the gate-port types, the fail-closed decision function — TDD, pure, no I/O.
3. Migration 0036 `tool_calls` + repository + the reset-list sweep (the guard enforces it now); real-PG.
4. Core `dispatchToolCall` + real-PG proof of deny-by-default, fail-closed gating, 100% records, idempotency and the unconfirmed outcome.
5. Docs + **TWO** independent review passes + finalization.
