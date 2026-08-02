# ACBP-P6-011 — independent review coverage

Ticket: **ACBP-P6-011** idempotency and replay hardening (TASK-009, NFR-006; ADR-008/ADR-013; launch gate 5;
trust-critical **#11 and #12**). Branch `p6-011-idempotency-replay`, PR **#69**, CDR-074, migration **0052**.

The review pass returned **FAIL** with one HIGH. It was found by reading the call graph, not by a failing test:
**CI was green, all 3447 tests passed, and the defect was live in the merge candidate.**

That is the P6-007/P6-009 lesson holding for a third ticket. The implementation was not the defect. The *test aim*
was.

---

## The HIGH — the only surface that suppresses anything in production could not report it

**`createIdentityWebhookService` never passed a logger to `processVerifiedIdentityEvent`, and
`IdentityEventProcessor` had no field that could carry one.** Every real webhook re-delivery therefore called
`recordSuppression(undefined, …)`, a no-op.

Why it mattered more than a missing log line:

| Surface | Production caller | Suppresses in production today? |
|---|---|---|
| `identity_event` | `createIdentityWebhookService` — **live** | **yes** — providers genuinely re-deliver |
| `usage_event` | `createModelGateway` — live | no: no caller supplies a key (CDR-074 §5.4, deliberate) |
| `job_enqueue` | **none** — P5-001a built the store ahead of its callers | no |

Identity is the **only** one of the three that fires. So the counter — the entire mechanism CDR-074 §0 argues for,
on the grounds that a suppression which writes nothing and says nothing is indistinguishable from a suppression
path that has stopped working — was structurally incapable of registering the one duplicate that actually occurs.

**Nothing was mis-billed or double-applied.** Suppression itself worked throughout; a re-delivered webhook was
correctly ignored. What was missing was the visibility, which is precisely the failure §0 is written about,
reproduced inside the fix for it.

### Why the tests did not catch it, which is the transferable part

The replay suite called **`processVerifiedIdentityEvent` directly** — an internal function, one layer below the
production entry point. So it proved *"the processor records when handed a logger"* and said **nothing at all**
about whether anything ever hands it one.

A test aimed below the entry point cannot see a gap that lives *at* the entry point, and it reads as thorough
while doing it. Same shape as ACBP-P6-009's HIGH 1, where a test re-implemented the SQL it was meant to check:
in both cases the assertion was real, the subject was wrong.

### The fix, and how it was verified

- Both identity replay cases now drive **`createIdentityWebhookService`**, faking only the signature verifier —
  it owns signature checking, which needs a real signing secret and is not what these assert.
- `webhook-service.test.ts` gains two cases: the logger reaches the processor **asserted by identity, not by
  presence** (a *different* logger would satisfy `toBeDefined`), and an absent logger adds no `logger` key at all,
  keeping the options object exact-shaped for the sibling assertion that depends on it.
- **Mutation-verified locally:** removing the pass-through fails with
  `expected undefined to be { debug: [Function debug], …(5) }`.

---

## The MEDIUM — CDR-074 §5.2 overclaimed reachability

The original wording: *"Is it reachable — does a key actually flow from a caller to the column? → the replay suite
calls the real use cases, not the repositories."*

True of the repositories and **false of the entry points**. One honest-sounding sentence covering three unequal
surfaces is how the HIGH survived being written down: the doc asserted a property the suite did not test, so the
doc could not be used to find the gap.

Corrected by **§5.2a**, which carries the per-surface table above — including the fact that `job_enqueue` has no
production caller at all, which the original section did not mention anywhere.

---

## Guards added this ticket, each mutation-tested

| Guard | Mutation applied | Result |
|---|---|---|
| `suppressionMetadata` allow-list (a caller-authored key must never reach a log) | replaced the named-field construction with `{ ...incident }` | 1 failed / 3 passed — caught |
| `check-migration-drain-loops.mjs` | restored the real 50-cap that broke CI | named the file, line, cap 50 and count 52 — caught |
| `webhook-service` logger pass-through | deleted the spread | `expected undefined to be {…}` — caught |

`recordSuppression`'s **info-not-warn** level is asserted but not mutation-tested: changing it to `warn` would
fail the assertion trivially, and the choice is a judgement recorded in the code, not a control.

---

## A second-occurrence defect the ticket surfaced

Migration 0052 broke `user-mapping.integration.test.ts` — a test about user mapping, failing on an idempotency PR.
Its migration-drain loop capped at 50; at 52 migrations it stopped with 0002 still applied.

**ACBP-P6-009's migration 0051 had already broken the identical pattern** in `database.integration.test.ts`, and
that fix did not sweep for other copies. Two occurrences, two tickets, both landing on unrelated work.

Closed on both axes: the loop now records **why** it ended (`tables_gone` / `stack_empty` / `iteration_cap`), and
`tools/check-migration-drain-loops.mjs` fails the build statically on any `migrateDown` loop whose cap does not
clear the migration count. A sweep confirmed exactly one remaining instance — every other bounded loop in the
repo is capped by a domain constant that does not scale with migration count.

---

## Deliberately not actioned, and why

- **The four other §1 suppression surfaces are not instrumented.** Naming a surface in
  `IDEMPOTENCY_SUPPRESSION_SURFACES` that nothing reports would claim coverage this ticket does not have.
- **No production caller supplies a usage idempotency key** (§5.4). A *wrong* key under-counts, and unlike an
  over-count nothing downstream ever contradicts it.
- **The `Idempotency-Key` HTTP surface is not wired.** No HTTP mutation surface exists for these paths; building
  one would invent a requirement.
- **A zero incident count remains ambiguous** (§5.2). Only a live canary fixes that, and it is **P7-006's** —
  owner-gated.

## Evidence

Exact-head CI `30727298208` on `723b19b`: **240 files / 3449 tests, zero skips.** The eleven real-PG replay cases
skip locally, so hosted CI on the exact SHA is their only evidence.
