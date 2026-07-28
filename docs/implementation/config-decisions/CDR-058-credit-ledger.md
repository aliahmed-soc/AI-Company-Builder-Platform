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

Canon does **not** fix: the SQL mechanism for atomicity, or how an account-scoped ledger interacts with the
company-scoped RLS every other tenant table uses. Both are decided below, because guessing them silently is how a
race gets shipped.

## 1. Guarantees

- **G1 — the ledger is APPEND-ONLY, structurally.** `credit_transactions` gets SELECT + INSERT and nothing else: no
  UPDATE grant on any column, no DELETE. Invariant 10 is then a property of the grants, not of anyone's restraint.
- **G2 — the balance is DERIVED, always.** `SUM(amount_micros)` over the account's rows. Signed amounts, so a grant is
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
- **G6 — the run and its ledger entry are ATOMIC** (`API-CONTRACTS` line 47: *"run + ledger atomic"*). One transaction.
  A run that exists without its reservation would be free work; a reservation without its run would be a charge for
  nothing.
- **G7 — metering failure FAILS CLOSED** (`COMPONENT-CATALOG`: *"Metering failure blocks metered work"*). If the
  balance cannot be determined, the answer is refusal, not "probably fine". This is the same direction as P5-005's
  unreadable-bound halt, for the same reason.
- **G8 — releases are bounded by what was reserved.** A release cannot exceed the reservation it references, and a
  reservation can be released once. Otherwise a release loop mints credits.

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

Grants (`credit:reserve` / `credit:consume`) are separate from the read and are **not** owner-only — the runtime
consumes on a run's behalf. Minting credits (`grant`) is neither: it is a platform/billing operation, and this ticket
does **not** give the product role a path to it (see §4).

## 3. Why `FOR UPDATE` on the account row, and not the alternatives

| Option | Why not |
| --- | --- |
| Serializable isolation | Correct, but it makes every caller retry on `40001` and pushes that burden into every use case. The repo has no retry-on-serialization-failure convention, and inventing one for a single race is a large blast radius. |
| A stored balance with a conditional `UPDATE ... WHERE balance >= n` | This is the classic atomic decrement and it *would* be race-proof — but it requires the stored balance G2 forbids, and canon is explicit that the balance is derived. Rejected on canon, not on mechanics. |
| Advisory lock (`pg_advisory_xact_lock`) | Works, and needs no existing row. But the lock key is a hash of an id, so it is invisible to anyone reading the schema, and two callers using different key derivations would silently not exclude each other. |
| **`SELECT ... FOR UPDATE` on `accounts`** | **Chosen.** The row exists, there is exactly one per account, the lock is released with the transaction, and the intent is legible at the call site. The cost is that concurrent reservations for one account serialize — which is precisely what the requirement asks for. |

The `accounts` row is read, not written, so this needs no new grant beyond the SELECT the app role already holds.

## 4. What this ticket does NOT do, said plainly

- **No grant path for the product role.** Minting credits is a platform operation, and there is no
  `grantCredits` use case here. Test fixtures grant as the OWNER role, the same way worker definitions are registered
  in P5-004. A product-role path to minting credits would be the largest possible foot-gun for the smallest reason.
- **No account usage rollups** (P6-009) and **no hard caps** (P6-010). This is the ledger and the reservation; the
  aggregation and the limits that read it are separate tickets, and pretending otherwise would leave two half-features.
- **No pricing.** `CREDITS_PER_MANUAL_RUN = 1` is the MVP rule as a named constant with D-02 cited at its definition.
  The schema stores an amount and knows nothing about how it was computed.
- **`usage_events.worker_run_id`** — the link `CDR-057 §4` deferred *to this ticket*. It is in scope and additive; see
  §5 slice 4. What stays out of scope is per-call cost attribution as a billing source, because that needs the
  reconciliation P6/Phase 7 owns.

## 5. Slice plan

1. CDR-058 + branch + draft PR.
2. Contracts: entry kinds, the signed-amount convention, `deriveBalance`, the charging-rule decision function
   (which outcome releases and which consumes) — TDD, pure, no clock, no database.
3. Migration 0041 `credit_transactions` + repository + the reset-list and grant-catalog sweep; real-PG proof of
   append-only (no UPDATE, no DELETE), the RLS predicate, and the idempotency index.
4. Core `preflightRun` / `reserveCredit` / `consumeCredit` / `releaseCredit`; the `usage_events.worker_run_id` link;
   real-PG proof of the **AT-025 race** — two concurrent reservations against one remaining credit, exactly one wins,
   and the balance still equals the ledger sum afterwards.
5. Docs + **TWO** independent review passes + finalization.
