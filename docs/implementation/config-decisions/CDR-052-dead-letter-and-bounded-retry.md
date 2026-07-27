# CDR-052 — Dead-letter and bounded retry (ACBP-P5-001c, NFR-007)

Status: proposed by the implementing session. Governs **ACBP-P5-001c**, the last of the three sub-scopes the owner
ratified on 2026-07-27. Governing ADR: **ADR-008**. Completes **CDR-049**, which owns the `jobs` table, and
**CDR-050**, which owns checkpoints.

## 1. Sequencing note — why this comes before P5-003b

The owner asked for P5-003b (the dispatcher chokepoint) next, and for the open question — how a tool call links to
the run it belongs to — to be resolved from canon. **Canon answers it, and the answer is a sequencing answer:**

> "Tool call | C | tool_call_id, idempotency_key | **belongs to run**" — `DATA-ARCHITECTURE.md`
> "ACBP-P5-002, Workflow coordinator … Data: **task runs**" — `BACKLOG.csv`

So tool calls belong to task runs, and **P5-002 owns the task-run entity**. P5-002 is `Ready`; its dependencies are
`ACBP-P4-002` (Done) and `ACBP-P5-001` (a and b merged; **this sub-scope is the remainder**).

Building P5-003b first would mean a nullable, FK-less `run_id` on `tool_calls` — a legal "tool call belonging to
nothing" state. That is exactly the defaulting hole CDR-049 §3-G4 refused for `jobs.company_id`, and it would be worse
here: `tool_calls` is the 100%-call-record surface of the enforcement chokepoint (invariant 4), so a call that
references nothing is a call whose provenance cannot be reconstructed.

**Order therefore: P5-001c → P5-002 (task runs) → P5-003b (dispatcher, with a real tenant-pinned FK).** Every step is
unblocked Phase 5 work. Nothing is deferred and no requirement is weakened; only the build order changes.

## 2. What this sub-scope owns

| Acceptance clause | *"cap = dead-letter"* (NFR-007) |
|---|---|
| In scope | The retry cap; bounded backoff; exhausted jobs reaching a VISIBLE `dead_letter` state, never silently retried |
| Out of scope | The polling loop and the runner library; the workflow coordinator (**P5-002**); Decision Room UI |

## 3. What canon actually requires

> "**no unlimited retries** — every retry policy is bounded with backoff (NFR-007); **non-idempotent actions are never
> retried without a safe idempotency mechanism** (invariant 8)" — FAILURE-AND-RECOVERY, global rules
> "attempt cap … **Dead-letter → Decision Room blocked queue**" — row 4
> "Bounded backoff; **config caps**" — NFR-007

- **G1 — the cap is enforced where the DECISION is made, not where the retry happens.** A runner that asks "should I
  retry?" and gets a boolean cannot silently retry; a runner that increments a counter and decides for itself can. So
  the transition is a single use case returning a closed outcome — `retry_scheduled` or `dead_lettered` — and there is
  no third answer that means "try again anyway".
- **G2 — "never silently retried" is the real requirement, and it is about VISIBILITY.** A job that exhausts its cap
  must land in a state a human can find. `dead_letter` was declared in the closed state set up front (CDR-049 §4-G6)
  precisely so this sub-scope sets it rather than adding it, and the blocked-queue read is what makes it visible.
- **G3 — the failure reason is recorded, bounded and non-sensitive.** Row 4 pairs the dead-letter with a Decision Room
  entry, which is useless without saying why. The reason is a CLOSED category, never provider exception text — the
  same rule the model gateway follows for `usage_events.error_category`.
- **G4 — backoff is computed, not stored.** The next-attempt delay is a pure function of the attempt number and the
  policy. Storing a `next_attempt_at` would create a second source of truth that can disagree with `attempts`, and the
  runner already has both.

## 4. Shape

| Element | Shape |
| --- | --- |
| `RetryPolicy` | `{ maxAttempts, baseDelayMs, maxDelayMs }`. A VALUE the caller passes, with a platform default — this is NFR-007's "config caps" hook without inventing a config surface no requirement asks for yet. |
| backoff | Exponential from `baseDelayMs`, **clamped** to `maxDelayMs`. Deterministic: jitter is a runner concern (it must not make the contract untestable), and is named as such rather than silently omitted. |
| `jobs.attempts` | Already exists and is already in the column-scoped UPDATE grant (CDR-049 §4). **No migration is needed** — a and b declared everything c requires. |
| `failure_reason` | ALTER-only addition: nullable, bounded, CLOSED category set. One-directional CHECK (`reason is null or state = 'dead_letter'`) so history without it stays legal — the P5-009 lesson. |

- **G5 — no new migration for the retry mechanics themselves.** That the state and counter were declared up front is
  the payoff of §4-G6, and it is worth noting: this sub-scope adds one nullable column and changes no grant.

## 5. Slice plan

1. CDR-052 + branch + draft PR.
2. Contracts: `RetryPolicy`, `nextBackoffMs`, `classifyRetryOutcome` — TDD, pure, exhaustive.
3. Migration 0034 (`jobs.failure_reason`, ALTER-only) + core `recordJobFailure` + the blocked-queue read; real-PG
   proof that the cap lands in `dead_letter` and that nothing retries past it.
4. Docs + **TWO** independent review passes + finalization.
