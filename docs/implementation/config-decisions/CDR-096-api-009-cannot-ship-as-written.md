# CDR-096 — ACBP-API-009 cannot ship as written, and shipping it would stop all generation

**Ticket:** ACBP-API-009 — "Wire credit reservation and settlement to the generate path"
**Date:** 2026-08-20
**Status:** **BLOCKED — decision required.** No production code was written. No row is set to `Done`.

---

## 0. The finding, in one paragraph

ACBP-API-009 is specified as *wiring*: call three existing primitives from the four
generate paths. The primitives do exist. But **two of the three cannot be called from
a generate path at all**, and there is a second, larger problem the ticket does not
mention: **no production path grants credits, by design and by row-level security, so
every real account's balance is zero.** An enforcing credit gate on the four generate
routes would therefore return `402` to every generate call in production, on the day
it shipped. The ticket is not wiring; it is at least three tickets, and the first one
is a decision rather than code.

## 1. What is actually there

All three primitives exist under exactly the names the ticket uses, in
`packages/core/src/billing/credit-service.ts`, all exported through the barrel:

| Function | Line | Callable from a generate path? |
|---|---|---|
| `preflightRun` | `:69` | **Yes** — `PreflightParams = ScopeParams` (`:44`), no run id |
| `reserveCredit` | `:118` | **No** — requires a `task_runs` row |
| `settleRun` | `:207` | **No** — requires a `task_runs` row |

All three authorize on `run:execute`, which is owner-only
(`packages/contracts/src/authz/authz.ts:370`).

## 2. Why two of them cannot be called

`reserveCredit` refuses immediately without a run:

```ts
// credit-service.ts:130-131
const taskRun = await new TaskRunRepository(scope.db).findById(params.taskRunId);
if (taskRun === undefined) return { status: 'run_not_found' };
```

`settleRun` does the same, and takes **no outcome parameter** — it reads
`task_runs.state` and returns `not_settleable` for any non-terminal state. Accepting a
caller-supplied outcome was a shipped defect (unlimited free execution), recorded at
`credit-service.ts:193-198`. That is not a limitation to work around; it is a control.

The database agrees. `credit_transactions_run_fk` is a **composite** foreign key
`(run_id, company_id) → task_runs (id, company_id)`
(`packages/database/migrations/0041_credit_transactions.ts:51`).

And a `task_runs` row cannot be conjured: `task_id` is `NOT NULL` and foreign-keyed to
`tasks` (`packages/database/src/schema.ts:858`). Its only production insert path is
`TaskRunRepository.claimAttempt`, driven solely by `packages/core/src/runs/coordinator.ts:161`.

**This was already known and written down.** CDR-091 §3.5 says it plainly:

> *"A strategy generation is not a task run. Even fully wired, today's ledger has no
> row shape for 'a founder generated a strategy.'"*

So the acceptance criterion — *"preflightRun/reserveCredit/settleRun called on all four
generate use cases"* — cannot be met without either fabricating domain data or changing
the ledger's shape. Both are architecture decisions.

## 3. ⚠️ The blocker nobody had stated: there is no way to grant credits

This is the finding that stops the ticket rather than merely re-scoping it.

Every `grant` in the repository is raw SQL on the **owner** connection inside a test or
a journey fixture. There is no production grant, no signup grant, no admin top-up. This
is **structural, not an omission** — the RLS insert policy forbids it through the app
role, and migration 0041 says why in its own words:

```
-- MINTING IS NOT A PRODUCT OPERATION. The policy admits only the three run-lifecycle
-- kinds, so the app role cannot write a `grant` (which creates credits outright) or a
-- `correction` (which may be positive, and so can also create them). Both are
-- platform/billing operations performed out of band. A table-level INSERT grant cannot
-- express this — an RLS WITH CHECK can, which is what makes "no minting path"
-- structural rather than conventional.
```

The balance is derived, not stored: `coalesce(sum(credits),0)::int` per **account**
(`packages/database/src/credit-repository.ts:53-60`). With no grants, that sum is `0`
for every real account.

**Therefore: enforcing a credit gate on the four generate routes turns off generation
for every user, immediately.** Not degrades — stops. The 402 the ticket exists to make
reachable would be the *only* outcome any founder ever saw.

## 4. A second unanswered question: where does the idempotency key come from

`reserveCredit` requires a caller-supplied `idempotencyKey`, and the uniqueness index is
**account-scoped**:

```sql
create unique index credit_transactions_reservation_key_uq
  on public.credit_transactions (account_id, idempotency_key)
  where kind = 'reservation' and idempotency_key is not null;   -- 0041:93
```

There is no obvious key for a generate call, and the wrong choice is a silent defect in
either direction:

- Derive it from call attributes (`{companyId, action}`) → **two legitimate sequential
  generates collapse into one charge.** The sibling ledger already records this exact
  rule: two identical calls in the same instant are legitimate, and collapsing them
  would under-count (`packages/database/src/usage-event-repository.ts:46-50`).
- Take it from the client → **no `Idempotency-Key` header exists on any of the four
  routes**, and adding one is a public API change.

## 5. What the ticket's own security note demands, and why it raises the bar further

> **MONEY PATH - FULL BAR.** Defect D9 shipped a DOUBLE CHARGE on this exact
> preflight/reserve/settle sequence; the credit system idempotency exists because of it.

`reserveCredit` returns **three** distinct non-refusal outcomes a retry can produce, and
they are not interchangeable:

- `already_reserved` — the same key, possibly a **different** run
- `run_already_reserved` — the same run, a **different** key
- `insufficient_credits` — the only one that is a 402

Collapsing the first two into an error turns a safe retry into a failure; collapsing
them into a 402 reports a successful reservation as out-of-money. Any wiring must map
all three deliberately.

## 6. The decision this record asks for

**Q1 — What is the ledger row shape for "a founder generated a strategy"?**

| Option | Cost |
|---|---|
| (i) Add a `generation_id` column and relax the composite run FK | A migration on the money table |
| (ii) A new non-run-scoped `reserveGeneration` primitive | New code on the path D9 burned |
| (iii) Mint a `tasks` + `task_runs` pair per generation | **Recommend rejecting** — fabricated domain data on the money path |

**Q2 — Where does a caller-stable idempotency key come from?** See §4. Both available
answers have a named failure mode.

**Q3 — What is the out-of-band grant path?** RLS makes this deliberately not a product
operation, so the question is what "out of band" means operationally here. Until this is
answered, **no enforcing gate may ship.**

## 7. The proposed split

| Slice | Contents | Blocks |
|---|---|---|
| **API-009a** | This decision record; Q1–Q3 answered; backlog rows written. **Zero production code.** | everything |
| **API-009b** | The grant path. Without it, every balance is 0. | any enforcing gate |
| **API-009c** | The reservation primitive and the wiring, with the real-PG race test and a recorded mutation on the double-charge guard. | — |

### If exactly one thing ships first

Call `preflightRun` in `resolveMeteredContext` after the company ceiling and return
`budget_exhausted` when `affordable === false`. It needs no run row, no idempotency key
and no settlement, and can strand no hold.

**It still must not ship before API-009b**, for the reason in §3. And it must be
documented in `preflightRun`'s own terms — *"deliberately NOT authoritative … it takes
no lock, so the balance it reports can be stale"* (`credit-service.ts:65-68`). Replacing
the honest `⚠️ UNREACHABLE TODAY` comment at `companies-http.ts:331-333` with a claim
that the budget control works would be exactly the failure that comment exists to prevent.

## 8. What was NOT done, and why

No production code was written. No migration, no new primitive, no route change, no
backlog row set to `Done`. On a money path with a recorded double-charge defect, the
options in §6 are architecture decisions with an owner gate on them, and the §3 blocker
means the most "complete-looking" version of this ticket is also the one that breaks the
product hardest.

The ticket stays `Planned`. It is not stalled for want of effort; it is waiting on three
answers that only the owner can give.
