# CDR-058 — Run preflight and the credit ledger: append-only, derived balance, atomic reservation (ACBP-P5-014)

| | |
| --- | --- |
| Ticket | ACBP-P5-014 — Run preflight and credit ledger core |
| Requirements | TASK-004, BILL-002, ACT-004, USAGE-001/002, NFR-015 |
| Decisions | ADR-013, ADR-003 (per-account rollup), invariants 9 and 10 |
| Diagram | `diagrams/10-usage-and-cost-flow.mmd` |
| Trust-critical | The **AT-025 race**: two concurrent runs against one remaining credit — exactly one may win |
| Out of scope | Subscription entitlements and the billing module (Phase 7, D-02 open); account usage ROLLUPS (P6-009); hard caps and rate limits (P6-010); the run API surface |

## 0. What canon fixes, and where it deliberately does not

Canon is unusually complete here, and three of its statements are load-bearing enough to quote:

1. *"Balance is always derived"* (`USAGE-AND-BILLING §2`). There is no balance column anywhere. A stored balance is a
   second source of truth that can disagree with the ledger, and the moment it does, no one can say which is right.
2. *"Corrections use compensating entries"* (invariant 10, `TECHNICAL-ARCHITECTURE-v1` row 10). A correction is a NEW
   row referencing the original. Nothing in this table is ever updated or deleted — not by the app role, not at all.
3. *"the ledger design supports all three without schema change (that neutrality is the architecture requirement)"*
   (`USAGE-AND-BILLING §1`). **D-02 is open**: whether pricing stays task-credits, becomes usage-billing, or
   hybridizes is undecided. So *"one manual task run = one credit"* is the MVP **rule**, and it lives in code as a
   named constant — never as a schema assumption, a default, or a CHECK that would have to be migrated away.

   **The neutrality holds for the RULE, not for the UNIT** — worth stating precisely, because the unqualified claim
   would be false. `credits` is a whole-number `integer`, so a D-02 outcome that priced *fractions* of a credit would
   need a unit migration to micro-credits (the convention used everywhere else here: `estimated_cost_micros`,
   `spend_micros`). That is accepted rather than pre-empted: the table is empty, the migration is mechanical, and
   choosing a sub-credit unit now would be designing for a decision nobody has made. Flagged so the D-02 decider sees
   the cost rather than discovering it.

Canon does **not** fix: the SQL mechanism for atomicity, or how an account-scoped ledger interacts with the
company-scoped RLS every other tenant table uses. Both are decided below, because guessing them silently is how a
race gets shipped.

## 1. Guarantees

- **G1 — the ledger is APPEND-ONLY, structurally.** `credit_transactions` gets SELECT + INSERT and nothing else: no
  UPDATE grant on any column, no DELETE. Invariant 10 is then a property of the grants, not of anyone's restraint.
- **G2 — the balance is DERIVED, always.** `SUM(credits)` over the account's rows. Signed amounts, so a grant is
  positive and a reservation negative, and the sum is the balance by construction rather than by a rule someone has to
  remember to apply. No cached total, no counter column, nothing to reconcile against itself.
- **G3 — reservation is ATOMIC, and the race resolves in the DATABASE.** Two runs against one remaining credit: exactly
  one wins. The serialization point is a `SELECT ... FOR UPDATE` on the **account row**, taken before the balance is
  derived. A derived balance cannot itself be locked — there is no row to lock — so the lock has to be on something
  that exists and is exactly one per account. `accounts.id` is that thing. (The alternatives were considered and
  rejected in §3.)
- **G4 — a reservation is not a consumption.** Preflight reserves; completion consumes; cancellation and provider-fault
  failure release. Each is its own row, and the sequence is legible afterwards: a reader can see that a credit was
  held, and what became of it.
- **G5 — one credit spend per idempotency key** (`API-CONTRACTS` line 47, BILL-002 race rule). A partial unique index on
  the reservation's key, so a retried request cannot reserve twice. The uniqueness is scoped to reservations, because
  the consumption and release that follow legitimately share the run.
- **G6 — a reservation and its audit event are atomic with each other.** *Corrected after review: the original text
  claimed the RUN and its ledger entry were atomic, and that is NOT delivered.* `startRun` never touches the ledger,
  and `reserveCredit` is a separate use case in a separate transaction that requires the run to already exist. Canon
  is more specific than the original wording admitted — `WORKFLOW-STATE-MACHINES` line 53 puts the reservation in the
  **`planned→queued`** transition, *"in same tx as credit reservation"*, one transition earlier than where this
  ticket's reservation attaches. **Nothing in the product is credit-gated today**; see §4.
- **G7 — metering failure FAILS CLOSED** (`COMPONENT-CATALOG`: *"Metering failure blocks metered work"*). If the
  balance cannot be determined, the answer is refusal, not "probably fine". This is the same direction as P5-005's
  unreadable-bound halt, for the same reason.
- **G8 — releases are bounded by what was reserved, IN THE DATABASE.** A release cannot exceed the reservation it
  references, a settlement must reference a reservation in the same account, and a reservation can be settled once.
  *The first two were app-code only until review pass 1 showed the hole:* reserve 1 credit, then release 2,147,483,647
  against it — every CHECK passes, because a CHECK cannot see another row. A `BEFORE INSERT` trigger closes it. It is
  **not** SECURITY DEFINER, so the referenced row is still subject to the caller's own RLS policy and the closed
  definer allowlist stays at three.

## 2. The A/C question — account-owned, company-attributed

`DATA-ARCHITECTURE` line 354 scopes the credit transaction **`A/C`**, and that is not the shape of any tenant table
built so far. Every one of those is company-owned and dual-keyed. This one is different, and the difference is real:

- **The BALANCE is per ACCOUNT.** ADR-003's binding refinement puts the rollup at the account, and a founder with three
  companies has one pool of credits, not three. A company-keyed balance would be a different product.
- **Each TRANSACTION attributes to a COMPANY** — `company_id` is NOT NULL on spends, so "which company burned the
  credits" is answerable, which is the whole point of the per-account rollup being a rollup *of* something.

**RLS therefore keys on `account_id` alone.** `company_id` is attribution, not the isolation predicate — if it were in
the predicate, an owner could never see their own account's balance, since the balance spans companies and the GUC
holds one company at a time.

**That makes the AUTHORIZATION action the real control**, and it is the part to get right: reading the ledger is
`billing:read`, and it is **account-owner only**. A company-scoped operator must not read the account ledger, because
it discloses what the account's *other* companies have been spending. This is a genuine widening of what a row can
show compared with every company-owned table, so it is stated here rather than inherited by resemblance.

**And "account-owner" has to mean the ACCOUNT role.** Review pass 1's HIGH finding: the first implementation ran the
read in a *company* scope, so it checked the caller's company-membership role. A user who was a company owner but only
an account viewer would have been handed the whole account's ledger. `readCreditLedger` now runs in an **account**
scope and resolves the role with `resolveOwnMembershipBootstrap` — the same primitive `portfolio:read` uses, for the
same reason. It takes no `companyId` at all, so the wrong role cannot be reached. Note the fixtures could not have
caught this: every seeded user's company role equals their account role.

Reservation and settlement reuse **`run:execute`** rather than dedicated `credit:reserve`/`credit:consume` actions —
those names appeared in an earlier draft of this record and were never registered. `run:execute` is owner-only, which
is stricter than a worker identity will eventually need; when P5-006/007/008 give workers an identity, that is the
point to split the actions. Minting (`grant`) and correcting are neither: both are platform/billing operations, and
this ticket gives the product role no path to either (§4).

## 3. Why `FOR UPDATE` on the account row, and not the alternatives

| Option | Why not |
| --- | --- |
| Serializable isolation | Correct, but it makes every caller retry on `40001` and pushes that burden into every use case. The repo has no retry-on-serialization-failure convention, and inventing one for a single race is a large blast radius. |
| A stored balance with a conditional `UPDATE ... WHERE balance >= n` | This is the classic atomic decrement and it *would* be race-proof — but it requires the stored balance G2 forbids, and canon is explicit that the balance is derived. Rejected on canon, not on mechanics. |
| Advisory lock (`pg_advisory_xact_lock`) | Works, and needs no existing row. But the lock key is a hash of an id, so it is invisible to anyone reading the schema, and two callers using different key derivations would silently not exclude each other. |
| **`SELECT ... FOR UPDATE` on `accounts`** | **Chosen.** The row exists, there is exactly one per account, the lock is released with the transaction, and the intent is legible at the call site. The cost is that concurrent reservations for one account serialize — which is precisely what the requirement asks for. |

**It does need more than SELECT, and the original wording here was wrong.** PostgreSQL requires the **UPDATE**
privilege (or DELETE, or an explicit `SELECT FOR UPDATE` grant) in addition to SELECT before it will take a row lock.
This works because migration `0005` already grants `select, update on accounts` to the app role and defines a matching
`accounts_update` policy. It fails closed if either is ever removed — but the earlier text would have justified exactly
that removal, which is why it is corrected rather than quietly left.

## 4. What this ticket does NOT do, said plainly

- **No grant path for the product role.** Minting credits is a platform operation, and there is no
  `grantCredits` use case here. Test fixtures grant as the OWNER role, the same way worker definitions are registered
  in P5-004. A product-role path to minting credits would be the largest possible foot-gun for the smallest reason.
- **NOTHING IS CREDIT-GATED.** This is the largest honest gap and it deserves to be first. All four use cases —
  `preflightRun`, `reserveCredit`, `settleRun`, `readCreditLedger` — have **no production caller**. A run starts,
  executes and finishes today without consulting the ledger, so every run is currently free work. Canon puts the
  reservation inside the `planned→queued` transition (`WORKFLOW-STATE-MACHINES` line 53, *"in same tx as credit
  reservation"*); composing it there is **ACBP-P5-015**'s, and it needs a scope-taking variant so the coordinator can
  do it in one transaction. Until then this ticket ships the ledger, not the gate.
- **No correction path.** The schema makes a compensating entry *representable* — the `correction` kind, the
  reference-shape CHECK, the non-zero CHECK — and the product role is deliberately excluded from writing one. But
  nothing creates a correction, so invariant 10's *"correction flow tests"* are not satisfied here. That flow is
  **ACBP-P6-009**. Until then, repairing a bad ledger entry is an owner-role operation, not a product one. (§0.2 says
  invariant 10 is "a property of the grants" — that is true of *cannot edit*, and says nothing about corrections
  existing.)
- **No account usage rollups** (P6-009), **no per-company aggregation** (P6-009), and **no hard caps** (P6-010). This
  is the ledger and the reservation; the aggregation and the limits that read it are separate tickets, and pretending
  otherwise would leave two half-features.
- **The refusal is numbers, not a path.** The backlog asks for *"insufficient credits block with a path"*.
  `insufficient_credits` reports the balance and the cost, which is honest but is not a remediation: there is no
  top-up route, no plan-reset date, and by design no grant path. The affordance belongs to the Phase 7 billing module.
- **`sideEffectClass` is a CONSTANT.** Preflight returns `informational` because a run's tools are not bound until
  P5-006/007/008; it is not yet derived from the worker's allowlist. It is a `RiskClass` from canon's closed set — an
  earlier version invented `'internal_only'`, a fifth name, which is the drift this repo already shipped one
  correction for.
- **No pricing.** `CREDITS_PER_MANUAL_RUN = 1` is the MVP rule as a named constant with D-02 cited at its definition.
  The schema stores an amount and knows nothing about how it was computed.
- **`usage_events.worker_run_id`** — the link `CDR-057 §4` deferred *to this ticket*. It is in scope and additive; see
  §5 slice 4. Nothing populates it yet (the gateway's callers are planning and strategy use cases, none of which run
  inside a worker run), so the column and the repository field exist to make the link *writable* the moment a worker
  calls a model; that wiring is P5-006/007/008's. **The owner ruled on 2026-07-28 that the column stays** rather than
  waiting for its first writer. What is out of scope regardless is per-call cost attribution as a billing source,
  because that needs the reconciliation Phase 7 owns.
- **Retry dedupe.** `USAGE-AND-BILLING §4` says a retry is *"billable at most once per logical task"*. This ledger
  dedupes per **run**, so two successful attempts of one task consume twice. Canon assigns that dedupe to the charging
  **views**, which are P6-009's — recorded here so that owner sees it rather than rediscovering it.

## 4.1 Post-implementation corrections (2026-07-29) — found only when a real database first ran these suites

Recorded because each was a guard that existed and did not work, and the reasoning is not re-derivable from the
diff alone.

### D1 — `ON CONFLICT` must target the reservation index by INFERENCE, never by name

`credit_transactions_reservation_key_uq` is a **partial** unique index (`WHERE kind = 'reservation' AND
idempotency_key IS NOT NULL`). `CreditRepository.insert` targeted it with `ON CONFLICT ON CONSTRAINT <name>`, which
PostgreSQL accepts only for a real table CONSTRAINT — so **every reservation raised `42704`**, on the money path, on
every call.

**Rejected: convert it to a named unique constraint.** PostgreSQL unique *constraints* cannot be partial — there is
no `WHERE` on `ALTER TABLE ... ADD CONSTRAINT ... UNIQUE`. The predicate is load-bearing: BILL-002 scopes "one spend
per key" to **reservations**, because the consumption and release that follow legitimately share a run (§G5). Dropping
the `WHERE` to satisfy `ON CONFLICT` would not fix the bug — it would silently change the rule to "one entry per key
across all kinds". The trade-off is therefore not a preference between two valid options; only inference preserves
the semantics.

**Chosen: inference by column list plus predicate**, spelled out at the call site rather than hidden behind a name.
The predicate must match the index's own `WHERE` for PostgreSQL to infer it, so if the migration's predicate ever
changes and the call site does not, inference fails **loudly** at the next insert instead of quietly widening what
gets deduplicated.

Why no test caught it: every idempotency test short-circuits at `findReservationForRun`, which returns
`run_already_reserved` before the INSERT is attempted. The partial index — the actual BILL-002 guard — was unreachable.
Two *different* runs sharing one key is the only shape that reaches `ON CONFLICT`, and that is now the test.
`tools/check-conflict-targets.mjs` makes the class statically impossible to reintroduce.

### D9 — a consumption moves NO credits, and `credits <= 0` rather than `= 0`

`isCreditGrantKind` covers only `grant` and `release`, so `consumption` carried a spend's negative sign and settling a
succeeded run debited the reservation's amount a second time: `grant +3, reservation -1, consumption -1` → balance 1.
**Every successful run cost two credits** against canon's *"one manual task run = one credit"*, while a failed run
correctly cost none — succeeding was the expensive outcome. One passing test (`a SUCCEEDED run consumes`) asserted the
double charge as expected; the *failing* one (`SETTLING TWICE`) was right.

The reservation is the debit — that is what reserving *is* — so settlement only records that the hold became a real
spend. `settlementMagnitude` returns 0 for a consumption and the full reserved magnitude for a release.

**Rejected: reservation 0, consumption −1.** That reopens AT-025: if reservations do not decrement, the derived
balance no longer reflects open holds and two concurrent runs can both see the same last credit. The whole ticket
exists to close that.

**Rejected: constrain `consumption` to exactly `= 0`.** It is the tighter guard and was considered on that basis, but
**D-02 is open** and canon requires this ledger to support flat, usage and hybrid pricing *"without schema change"*. A
metered consumption debiting a real overage must stay expressible, and `= 0` would force a migration to allow it. The
constraint is therefore `<= 0`; the MVP's exact zero is pinned in `settlementMagnitude` and its tests, which is where
a pricing rule belongs, rather than in the schema. **Owner-accepted 2026-07-29** — do not reopen without D-02 moving.

### D3 — the trigger function's default PUBLIC EXECUTE

`CREATE FUNCTION` grants EXECUTE to PUBLIC implicitly. `acbp_check_credit_settlement` is deliberately **not**
SECURITY DEFINER, so this escalates nothing, but it was still callable cluster-wide and the three bootstrap functions
are explicitly revoked for the same reason. Now revoked, and asserted **per function** in the catalog suites so the
next missing revoke fails by name.

### D2 — the closed allowlist is about SECURITY DEFINER, not about the `acbp_` prefix

Both catalog suites compared *every* `public.acbp_%` function against the three bootstraps, so a plain trigger
function read as "the SECURITY DEFINER allowlist was breached" when nothing had been escalated — a false alarm on a
real security assertion, which is the kind that gets suppressed rather than investigated. Split: the DEFINER set stays
exactly three; the non-definer set is named explicitly so a new one must still be admitted on purpose; ownership is
asserted across all of them.

## 5. Slice plan

1. CDR-058 + branch + draft PR.
2. Contracts: entry kinds, the signed-amount convention, `deriveBalance`, the charging-rule decision function
   (which outcome releases and which consumes) — TDD, pure, no clock, no database.
3. Migration 0041 `credit_transactions` + repository + the reset-list and grant-catalog sweep; real-PG proof of
   append-only (no UPDATE, no DELETE), the RLS predicate, and the idempotency index.
4. Core `preflightRun` / `reserveCredit` / `settleRun` (one function, not the separate `consumeCredit` /
   `releaseCredit` this plan first named — the consume-or-release decision belongs in ONE place, reading canon's
   charging rules, rather than in two call sites that could diverge); the `usage_events.worker_run_id` link;
   real-PG proof of the **AT-025 race** — two concurrent reservations against one remaining credit, exactly one wins,
   and the balance still equals the ledger sum afterwards.
5. Docs + **TWO** independent review passes + finalization.
