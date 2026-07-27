# CDR-046 — Structured-output validation hardening (ACBP-P5-010, NFR-007)

Status: proposed by the implementing session. Governs **ACBP-P5-010**. Depends on ACBP-P2-003 (merged). Governing
ADR: **ADR-011**. Security note: "Trust-critical **#18** groundwork".

## 1. What canon asks for

Backlog row `ACBP-P5-010`:

- **Objective:** "Schema-first validation + bounded re-ask + `invalid_output` category"
- **Usage behavior:** "Re-asks metered"
- **Failure behavior:** "**Invalid after re-asks = failed never partial-accepted**"
- **Acceptance criteria:** "**Invalid output cannot complete a task**"
- **Required tests:** "Invalid-output tests" · **Verification:** "Validation suite"

## 2. Load-bearing finding — the MECHANISM already exists; this ticket is the PROOF, not the build

Read before writing anything, per the standing rule that a ticket's summary is checked against the code and canon
before it is built. **Every mechanical clause of the Objective is already implemented by ACBP-P2-003 (CDR-026).**
Verified in `packages/core/src/model/model-gateway.ts` and `packages/contracts/src/model/gateway.ts`:

| Clause | Status | Where |
| --- | --- | --- |
| Schema-first validation | **exists** | `singleCall` runs `deps.validateOutput(request.outputSchemaRef, resp.output)` whenever a schema ref is present; a failure becomes `{kind:'error', category:'invalid_output'}` |
| `invalid_output` category | **exists** | in `MODEL_ERROR_CATEGORIES`, and TERMINAL — `isRetryableModelError` excludes it, so it is never retried as though it were infrastructure |
| Bounded re-ask | **exists** | `reasksLeft = cfg.maxReask`, clamped to `[0, max]` so a misconfigured `GatewayConfig` cannot unbound it; an invalid output is **re-asked, not retried** |
| Re-asks metered | **exists** | `runProvider` ACCUMULATES `providerUsage` across every attempt, so the single usage event reflects total consumption, not just the last try (CDR-026 §5) |
| Invalid after re-asks = failed, never partial-accepted | **exists** | once `reasksLeft` is exhausted, `runProvider` returns the `error` attempt; there is no code path that returns a partially-validated value |

**So this ticket does not re-implement any of it.** Writing a second validation path would be worse than useless: it
would create two behaviours that can disagree, and the disagreement would surface as a model output being accepted by
one caller and rejected by another.

- **G1 — P5-010 delivers the CONFORMANCE SUITE the backlog actually asks for**, and nothing else. The row's Required
  tests ("Invalid-output tests") and Verification procedure ("Validation suite") are the deliverable; the Objective
  describes the property the suite must pin. A ticket whose mechanism already exists is finished by *proving* the
  mechanism, not by rebuilding it.
- **G2 — the suite pins the properties as BEHAVIOUR, not as implementation.** It drives the real gateway and asserts
  outcomes, so a future refactor that preserves the guarantees passes and one that quietly drops a bound fails.

## 3. What the suite must pin

Each of these is a property that would silently regress and that nothing currently asserts end-to-end:

1. **A structurally-invalid output is re-asked, not retried** — `invalid_output` must not consume the retry budget,
   because retry is for infrastructure and re-ask is for the model. Conflating them either wastes a retry on a
   deterministic failure or re-asks a timeout.
2. **The re-ask bound is honoured exactly** — with `maxReask = N`, a persistently-invalid model is called exactly
   `N + 1` times. Not `N`, not unbounded.
3. **`maxReask` cannot be unbounded by configuration** — a caller passing a huge or negative value is clamped. The
   bound is a platform guarantee, not a caller's choice (NFR-007: *no unlimited retries*).
4. **Invalid after the last re-ask is a FAILED result** — the caller receives an error carrying `invalid_output`, and
   **never** a partially-validated or raw-string value. This is the "never partial-accepted" clause, and the one that
   makes the acceptance criterion true.
5. **Every attempt is metered** — the accumulated usage of a call that re-asked twice exceeds that of one that
   succeeded first time. A re-asked bad output really cost tokens, and an unmetered re-ask is a free retry the ledger
   cannot see.
6. **Metering stays fail-closed on the invalid path** — a metering-write failure must abort rather than yield
   un-metered usage, exactly as on the success path. Otherwise the cheapest way to hide usage would be to make the
   call fail.
7. **Validation is OPT-IN** — a call with no `outputSchemaRef` returns the raw output and is never failed as
   `invalid_output`. *Added during the first review pass:* the suite pinned this and §3 did not list it, so the CDR
   under-described its own deliverable. It guards the other direction, and without it a change that made validation
   unconditional would pass every one of the six above while breaking every free-text caller.

## 4. "Invalid output cannot complete a task" is GROUNDWORK, and this CDR says so plainly

The acceptance criterion names *task completion*. Task completion is driven by execution — runs, workers, the
coordinator — which is **ACBP-P5-002/P5-005 and not yet built**. There is today no code path by which a model output
completes a task, so the criterion cannot be exercised end-to-end.

- **G3 — the ticket delivers the half that exists and states the half that does not.** The suite proves the gateway
  never hands a caller an unvalidated value, which is the *necessary* condition; the *sufficient* condition — that a
  task cannot reach `completed` on one — belongs to the coordinator ticket, where the backlog itself files it as
  "trust-critical #18 **groundwork**".
- Claiming the criterion fully satisfied here would be the hollow-success failure invariant 20 exists to prevent,
  applied to our own backlog. The traceability note must read *groundwork*, not *covered*.

## 5. Out of scope

The fallback provider (**ACBP-P5-009**, NFR-019) — a different requirement with its own silent-fallback negatives.
Execution, runs and task completion (**P5-002/P5-005**). Live-model behaviour (**P2-011**, owner gate). No migration,
no new authz action, no new audit event, no HTTP route, no UI, and **no change to the gateway's behaviour**: if the
suite finds a gap, that is a bug fix with its own test, not a redesign.

## 6. Slice plan

1. CDR-046 + branch + draft PR.
2. The conformance suite (§3.1–§3.6) against the real gateway with the deterministic fake provider.
3. Traceability + docs: record NFR-007's validation half as covered and the task-completion half as groundwork
   (§4-G3), + TWO independent review passes + finalization.
