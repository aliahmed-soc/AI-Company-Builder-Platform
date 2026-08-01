# CDR-073 — Account usage rollups and reconciliation (ACBP-P6-009)

Governing: **USAGE-001 (amended)**, ACT-004; ADR-013, ADR-003 §16; `USAGE-AND-BILLING-ARCHITECTURE.md` §2/§4;
`DATA-ARCHITECTURE.md` line 375 (`Account usage rollup | A | (account_id, period)`); `diagrams/10`;
**launch gate 7** (reconciliation drift alerts); **trust-critical #12, #13, #14**.

Canon's three trust-critical clauses, verbatim:

> **12. Duplicate usage messages do not double count.** *(P6-009/011)*
> **13. Usage corrections create compensating records (never edits).** *(P6-009)*
> **14. Account usage equals the deterministic sum of eligible company usage.** *(P6-009)*

And the architecture's defining sentence for this entity:

> *"per `(account_id, period)`: derived aggregation across the account's companies … Maintained incrementally,
> **rebuildable from the ledger** (it is a projection, **never a source of truth**)."* — `USAGE-AND-BILLING` §2

---

> ## ⚠️ READ THIS BEFORE ANYTHING ELSE: THIS TABLE IS NOT EVIDENCE OF ANYTHING
>
> Every figure in `account_usage_rollups` is a **cache of an arithmetic fact that lives in the ledger**. If the
> rollup and the ledger ever disagree, **the ledger is right and the rollup is a bug** — there is no case in which
> the stored number wins, and no code may treat it as authoritative for a billing, limit, or entitlement decision.
>
> The reason this warning is at the top rather than in a footnote: a stored total is the single most tempting
> thing in this schema to read directly, and the moment something enforces a limit against it, the projection has
> silently become a source of truth and canon's sentence above is false.
>
> **What P6-009 closes: #13 and #14 in full. What it does NOT close: #12 in full** — see §2.

## §0 The thing that makes this ticket different

The other trust-critical tickets fail *loudly*: a stop that does not fire, an approval that does not bind. **A
rollup fails silently and plausibly.** A number that is 4% low looks exactly like a number that is right. Nobody
files a bug against a total they cannot independently compute, and the first person who can compute it is the
customer disputing an invoice.

So the gates below are written against **"the number is wrong and nothing notices"**, not against "the query
errors". Concretely, that is why §1-G11 requires reconciliation to recompute from the ledger rather than
re-reading the projection, and why §1-G3 refuses a design that would have made the total depend on *who asked*.

## §1 Gates

### G1 — The rollup is a projection; the ledger is the truth

`account_usage_rollups` is **mutable** (`DATA-ARCHITECTURE` marks it `M (derived; rebuildable from ledger)`) —
deliberately unlike `usage_events` (invariant 9) and `credit_transactions` (invariant 10), which are append-only.
Mutability is safe *only* because the row carries no information of its own: it can be dropped and recomputed at
any time. Nothing in this ticket may add a column to it whose value cannot be re-derived from the ledger.

### G2 — Account-owned; RLS keys on `account_id` ALONE

Direct precedent, `credit_transactions` (migration 0041, P5-014), whose own comment states the rule:

> *"RLS therefore keys on `account_id` ALONE: putting `company_id` in the predicate would stop an owner ever
> seeing their own balance, because a balance spans companies and the GUC holds one at a time."*

A rollup spans companies for exactly the same reason, so it takes exactly the same policy shape. This is also
what lets the row be written from *either* scope: a CompanyScope sets **both** `app.current_account` and
`app.current_company`, so an account-keyed predicate is satisfied under a company transaction too.

### G3 — Cross-company aggregation uses `elevateToCompanyScope`, NOT `runInCompanyScope`

This is the load-bearing decision of the ticket, and the alternative is subtly wrong rather than obviously wrong.

`runInCompanyScope` validates the **actor's active company membership**. If the rollup used it, an account owner
who is not a member of every company in their account would get a **smaller total than another owner asking the
same question about the same account** — and both totals would look fine. That is a direct contradiction of
trust-critical #14's word *deterministic*: a membership-filtered total is a per-caller view, not an account fact.

`elevateToCompanyScope` (migration-free primitive in `transaction.ts`) instead verifies that **the company belongs
to the caller's current account**, via the account-scoped `companies` SELECT policy, and fails closed when it does
not. No membership is consulted. Authorization for the operation stays where canon puts it — at the account level
(`API-CONTRACTS`: *"account rollup = account owner"*) — and the aggregation beneath it is uniform.

### G4 — Enumeration is over the account's FULL company registry

`companies_select` is `using (account_id::text = current_account)` (migration 0008) — the account's whole
registry, **not** membership-filtered. Verified by reading the policy, and pinned by a test in which the actor is
deliberately given no membership in one of the account's companies and that company's usage still appears in the
total.

This is also what satisfies the backlog's *"deactivated-company history preserved"*: `paused` is a `companies`
status, not a deletion (BILL-006 — *"cancellation ⇒ company pause semantics, never deletion"*), so a paused
company is still in the registry and its history still counts. There is no status filter in the enumeration, and
adding one would silently rewrite history.

### G5 — Elevation is SEQUENTIAL, never parallel

`elevateToCompanyScope` issues `SET LOCAL app.current_company` on the **shared** transaction. Two concurrent
elevations would interleave that GUC and each read would attribute to whichever company won the race — producing
a wrong total with no error. The portfolio service documents the identical constraint for the identical reason
(*"SEQUENTIALLY (never in parallel — no mixing of transaction-local company context)"*).

Enumerate first, elevate one company at a time, then write. The account-keyed rollup write (G2) is unaffected by
whichever company the GUC happens to hold at the end.

### G6 — `usage_events` RLS is NOT widened (the rejected alternative, recorded)

The tempting shortcut was to add `or current_company is null` to the `usage_events` SELECT policy so one
account-scoped query could sum everything. **Rejected.** That predicate is fail-**open**: any code path that
intends company scope but fails to set the GUC would silently read the entire account instead of one company, on
a table canon marks trust-critical for tenant isolation. The dual-key exists to make a forgotten GUC deny rather
than over-serve, and no projection's convenience is worth inverting that.

**No existing policy, grant, or CHECK is modified by this ticket.** Everything it needs is additive.

### G7 — Which numbers exist here, and which deliberately do not

Only the two lanes that exist in the ledger today, from `USAGE-AND-BILLING` §1's five-number separation:

| Lane | Columns | Source |
|---|---|---|
| Technical usage | `event_count`, `input_tokens`, `output_tokens` | `usage_events` |
| Provider cost (estimate) | `estimated_cost_micros` | `usage_events.estimated_cost_micros` |

**Billable usage, included entitlement and user-visible credits are deliberately absent.** D-02 (the commercial
formula) is **open**, and canon requires this design to support flat, usage-based and hybrid pricing *"without
schema change"*. A `billable_*` column would bake a pricing model into the schema before the decision that
determines it. Credits already have their own append-only ledger (`credit_transactions`); duplicating a total
here would create the second source of truth G1 exists to prevent.

### G8 — Period is the UTC calendar month, derived identically everywhere

`period_start date`, computed as `date_trunc('month', created_at at time zone 'UTC')`. Determinism requires the
bucket be a **pure function of the event row**, computed the same way in the aggregate and in the rebuild — so the
derivation exists in exactly one place and both paths call it. A local-timezone bucket would move events between
periods depending on where the server runs, which is precisely the silent-wrongness failure of §0.

### G9 — Corrections are a SEPARATE append-only table, not a relaxed `usage_events`

Trust-critical #13 requires compensating records. `usage_events` cannot express one today: `input_tokens >= 0`,
`output_tokens >= 0`, `estimated_cost_micros >= 0`, and `kind in ('model_call')`.

Two ways to close it:

- **(a) Relax `usage_events`** — allow signed quantities and a `correction` kind. Rejected: it removes
  non-negativity CHECKs from a trust-critical append-only ledger for every writer, forever, so that one caller can
  write a negative. The constraint that stops a bug from writing `-2000000` tokens would be gone.
- **(b) A separate `usage_corrections` table** — append-only (SELECT+INSERT only), signed deltas, each row
  **required** to reference the original `usage_events` row it compensates, tenant-pinned by composite FK, no
  self-reference. **Chosen.**

(b) also makes the compensating shape structural rather than conventional, mirroring `credit_transactions`'s
`references_txn_id`. The rollup is then `sum(events) + sum(corrections)`, and "never edits" is a property of the
grants — there is no UPDATE path on either table to misuse.

### G10 — A correction cannot invent usage that never happened

Because a correction carries a signed delta and references an original, the obvious abuse is a correction that
subtracts far more than the original ever recorded (mirroring the release-exceeds-reservation hole review pass 1
found in `credit_transactions`). The same answer applies: a CHECK cannot see another row, so the bound is enforced
by a trigger that reads the referenced event and refuses a correction whose magnitude exceeds it, per lane.

### G10-order — The trigger fires BEFORE the foreign key, and that hid a hole in the first test

Found by running the suite against real PostgreSQL rather than by reading the migration.

A `BEFORE INSERT` trigger runs ahead of constraint checking. So when the app role, scoped into company A1, tries
to correct an event belonging to A2, the trigger's **visibility** branch refuses first (`23514`) — the composite
FK's `23503` never gets a chance. The refusal is correct and fail-closed: a bound that cannot be evaluated
because RLS hides the row must refuse rather than skip.

The problem was in the **test**, and it is the kind this ticket is most prone to: asserting "the cross-company
correction is rejected" would have passed **even if the composite FK did not exist at all**, because the trigger
alone rejects it. One guard was silently shadowing another, and the evidence looked complete.

The fix is to prove the FK on a path where the trigger cannot mask it — as a superuser, where the row IS visible
and the same-account check passes, so the FK is the only thing left to reject. Both assertions now stand, and
each names which mechanism it is exercising.

### G10a — A correction may only ever REDUCE recorded usage

Every delta is `<= 0`, enforced by CHECK, with at least one lane non-zero.

The asymmetry is deliberate. Under-recording cannot be fixed here anyway: metering is fail-closed (CDR-026 §5),
so a model call that failed to write its usage event withheld its output — there is no silently unmetered usage
to add back. What a positive delta *would* create is a path to **inflate a customer's recorded usage without
writing a real metered event**, which is the one direction that must stay structurally impossible. Adding usage
requires a genuine `usage_events` row; only subtraction is expressible as a correction.

### G10b — AT MOST ONE correction per usage event

A unique index on `corrects_usage_event_id`. Without it, G10's per-row bound is not a bound at all: three
corrections each individually within the referenced event's magnitude still sum past it, and the rollup goes
negative — a negative token count reaching a billing surface.

The tradeoff, stated plainly: **a wrong correction cannot be quietly fixed by a second one.** That is the
intended behaviour. A correction already adjusts a billing-relevant figure and is owner-only and audited;
discovering one was wrong is an operational escalation, not something to settle with another silent adjustment.
This is what makes the non-negative CHECK on the rollup sound rather than aspirational.

### G10c — A correction belongs to the CORRECTED EVENT'S period, not its own

The subtle one, and the one most likely to be got wrong by a later reader.

If a July event is corrected in August, the correction must land in **July's** rollup. Bucketing it by the
correction's own `created_at` would leave July's total permanently wrong while August silently absorbed an
adjustment that has nothing to do with it — §0's failure exactly, and unfixable by rebuilding, because a rebuild
would faithfully reproduce the same misattribution.

So the rebuild joins `usage_corrections` → `usage_events` and buckets by the **event's** `created_at`. The period
is deliberately NOT denormalised onto the correction row: it is derivable, and a stored copy is one more thing
that can disagree with the ledger (G1).

### G11 — Reconciliation recomputes; it never re-reads the projection

`reconcileAccountUsageRollup` recomputes the figures **from the ledger** by the same path as a rebuild and
compares them against the stored row. Comparing the stored row against itself — or against another cached value —
would report "no drift" in exactly the case the check exists to catch. Drift is reported per lane, not as one
boolean, because a token drift and a cost drift have different causes.

### G12 — Rebuild is idempotent, and that is what #12 buys here

Rebuilding twice must produce the same row, so the write is an upsert keyed on `(account_id, period_start)` that
**replaces** the figures rather than adding to them. An additive incremental write is what would make a replayed
maintenance message double the total — the rollup half of trust-critical #12.

### G13 — The accumulator must be WIDER than the thing it accumulates

`usage_events.estimated_cost_micros`, `input_tokens` and `output_tokens` are `integer` (int4, max ≈ 2.147e9).
That is the right width for **one event** and the wrong width for **a period's worth**:

- `estimated_cost_micros` is micro-units, so int4 tops out at ≈ **2,147 cost units per account-period**. An account
  spending more than that in a month would overflow — not an exotic scenario, a successful customer.
- `input_tokens` overflows at ≈ 2.1e9 tokens, roughly 210k events at 10k tokens each.

Overflow here is `22003 numeric_value_out_of_range` at best and a wrong total at worst. **The rollup columns are
therefore `bigint`**, which also matches what PostgreSQL already does: `sum(integer)` returns `bigint`.

### G14 — `bigint` crosses the driver as a STRING, and that must be handled explicitly

This repo has **no `int8` type-parser override** (verified: no `setTypeParser` anywhere in `@acbp/database`), and
this ticket introduces the **first** `bigint` columns in the schema. node-postgres therefore returns them as
**strings**, so a `sum()` result arrives as `"4200"`, not `4200`.

Left alone this is a §0-class silent failure: `"100" + "200"` is `"100200"` in JavaScript, so a drift comparison
would "pass" and a total would be nonsense that still looks like a number in JSON.

The decision is to convert at the repository seam via one shared helper rather than to install a global type
parser. A global parser would silently change the meaning of every future `bigint` column across the whole
codebase — a large, invisible blast radius for a local problem. The helper:

- accepts `string | number | bigint | null` (a `sum()` over zero rows is `NULL`, which means **0** here);
- **throws** above `Number.MAX_SAFE_INTEGER` rather than returning a silently rounded number;
- is the only path by which a rollup figure becomes a JS number.

Its rejection branch is mutation-tested — a guard nobody has watched fail is not a guard.

### G15 — Two audit events, registered WITH their producers and not before

Canon's requirement is narrow (backlog: *"Audit behavior: Reconciliation audited"*), so this ticket adds exactly two:

- **`usage.corrected`** — subject is the CORRECTION row, not the event it compensates. A reader tracing "who
  adjusted this account's usage and why" follows corrections; the original event is immutable and already has its
  own durable record. This is the audit half of trust-critical #13.
- **`usage.rollup_reconciled`** — subject is the ACCOUNT, because reconciliation is a statement about an
  `(account, period)` pair rather than about any row. The payload carries the **per-lane drift** and whether a
  rebuild was applied. An event recording only "reconciliation ran" cannot answer whether the number moved, which
  is §0's silent-wrongness failure written into the audit trail — the same nominal-vs-substantive defect already
  called out for `policy.changed` and `emergency_stop.activated`.

There is deliberately **no `usage.rollup_rebuilt`**: a bare rebuild recomputes a projection and changes no fact
(§1-G1), and the only production path that triggers one is reconciliation, which records it above.

**Registration timing, learned the hard way.** These were first registered in `AUDIT_EVENTS` a slice ahead of the
use cases that emit them, and `audit-operations.test.ts` failed: *"every REGISTERED audit event is produced by
exactly one approved operation (no orphan events)"*. The guard is right. `DEFERRED_REGISTERED_EVENTS` exists as an
escape hatch for reserving a name ahead of its producer, and using it here would have been the wrong call — it
would leave a registered-but-unproduced event to be cleaned up later, which is precisely the kind of loose end
that survives to merge. The registration was backed out and lands in the slice that builds the producers, so the
event, its builder, its operation, its factory case and its real caller all arrive together.

## §2 Honest scope — what this ticket does NOT close

**Trust-critical #12 is shared with P6-011 and this ticket closes only its rollup half.** A `SUM` over ledger rows
cannot double count unless *the ledger itself holds duplicate rows*; suppressing duplicate delivery into the
ledger is P6-011's *"replay/duplicate-delivery suite across jobs/events/usage"*, and the backlog attributes #12 to
**"P6-009/011"** jointly. What P6-009 proves is that the rollup does not double count a single ledger row —
across a repeated rebuild (G12), across periods, or across companies. It does **not** prove that two identical
model-call deliveries produce one ledger row; nothing in this ticket touches the gateway's write path.

Stating this here because the alternative is a PROJECT-STATE line reading "#12 done" that nobody re-checks.

## §3 Owner gates raised by this ticket

1. **The drift threshold value** (launch gate 7: *"drift beyond threshold alerts"*). The mechanism is built and
   takes the threshold as a parameter; the **value** is a commercial/operational decision, not an engineering one,
   and is left to the owner exactly as AOQ-14's limit values are. No default is silently invented — a caller must
   pass one.
2. **Who may trigger a rebuild.** The read is account-owner-only per `API-CONTRACTS`. A rebuild is a maintenance
   operation; whether an account owner may trigger one on demand, or whether it is platform-only, is an
   authorization decision with support-cost implications. Until ruled, the rebuild is **not exposed on any API
   surface** — it exists as a core use case invoked by tests and (later) a scheduled maintenance job.

## §4 Requirements this ticket does not touch

No UI, no API route, no scheduled-job wiring. The Decision Room surfacing of usage alerts is P6-010's
(`usage.limit_reached`), and the reconciliation *job* schedule belongs with the job runner. This ticket delivers
the schema, the deterministic aggregation, the correction mechanism and the reconciliation computation.
