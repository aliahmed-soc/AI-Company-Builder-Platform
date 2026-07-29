# ACBP-P5-014 — review ledger

Two independent passes, both FAILED. Pass 1 adversarial security/correctness; pass 2 canon fidelity and scope.

This is money code, and the passes found **two paths that create credits out of nothing** and **one that gives away
unlimited free execution**. None was reachable through the shipped use cases; all three were reachable by the app role
directly, which is the standard the rest of this table is held to.

Hosted CI also found something both passes and the local gate missed — see "What CI caught" below.

## Pass 1 — adversarial

| # | Sev | Finding | Fix |
| --- | --- | --- | --- |
| 1 | HIGH | **`billing:read` checked the COMPANY role, not the ACCOUNT role.** `readCreditLedger` ran in a company scope, so a user who was a company owner but only an account *viewer* would have been handed the whole account's ledger — every company's spending. That is exactly the disclosure the action exists to prevent, and the CDR asserts the opposite four times. **The fixtures could not catch it: every seeded user's company role equals their account role.** | Runs in an **account** scope, resolving the role with `resolveOwnMembershipBootstrap` — the `portfolio:read` precedent. It no longer takes a `companyId`, so the wrong role is unreachable. |
| 2 | MED | CDR G6 claimed the run and its ledger entry are atomic. Nothing does this; `startRun` never touches the ledger. | G6 rewritten to claim only what holds; §4 now leads with **nothing is credit-gated**, and names P5-015. |
| 3 | MED | **`settleRun` trusted a caller-supplied `outcome` and never read the run.** Settle a succeeded run as `cancelled` → release → the work was free. Repeatable for every run: unlimited free execution, with a perfectly legible reserve/release pair in the ledger. Fixtures agreed with the bug — every settlement test's run was still `running`, and the assertion only exercised the string passed in. | The outcome is read from `task_runs`. The parameter is gone. |
| 4 | MED | **A release could exceed its reservation.** Reserve 1, release 2,147,483,647 against it — every CHECK passes, because a CHECK cannot see another row. **~2.1 billion credits, once per reservation.** | A `BEFORE INSERT` trigger: a settlement must reference a **reservation**, in the **same account**, for **no more than** was held. Not SECURITY DEFINER. |
| 5 | MED | The `already_reserved` branch was unreachable and the code path that replaced it **threw**: the conflict recovery re-queried by *run*, which under the lock is guaranteed to be the `undefined` already seen. Reusing one idempotency key across two runs — an ordinary client mistake — became a 500. Also a **blanket `onConflict doNothing`**, which `CLAUDE.md` forbids by name. | `findReservationByKey`; the conflict is targeted at `credit_transactions_reservation_key_uq`. |
| 6 | MED | **Two `deriveBalance` implementations with incompatible conventions.** The repository sums the signed stored value; the contract expected unsigned magnitudes and applied the sign itself. They disagree on *every* spend row, and the contract's fixtures used rows the sign CHECK makes impossible to insert — a unit suite validating a ledger that cannot exist. No production caller. | Deleted from contracts. The SQL sum is the only balance, as the repository already said. |
| 7 | LOW | `preflightRun` accepted `taskRunId` and never read it — the defect its own sibling docstring calls out. | Removed. |
| 8 | LOW | CDR named `credit:reserve`/`credit:consume`; neither exists. The code uses `run:execute`, which is owner-only — the opposite of what the CDR said. | CDR reconciled; the split is named as P5-006/007/008's. |
| 9 | LOW | CDR §3 claimed `FOR UPDATE` needs no grant beyond SELECT. False — PostgreSQL requires UPDATE. It works only because migration 0005 grants it. | Corrected; the earlier text would have justified removing the very grant it depends on. |
| 10 | LOW | The `company_id` FK was single-column while the run FK three lines later was composite *for the stated reason that RI bypasses RLS*. The app role could pair its own `account_id` with a foreign `company_id`. | Composite `(company_id, account_id)`, with the additive `companies (id, account_id)` unique it needs. |
| 11 | LOW | "One reservation per run" rested entirely on the account lock. | A partial unique index. |
| 12 | LOW | `readCreditLedger` clamped a bad limit where the CDR-017 §8 convention is reject-never-clamp. | Rejects with `invalid_limit`. |

## Pass 2 — canon fidelity

| # | Finding | Fix |
| --- | --- | --- |
| 1 | **The entire ledger suite never ran.** `seedTwoTenantWorld(owner, product, {} as never)` — the typechecker accepted it, the suite is `skipIf`-gated so it was silently green locally, and hosted CI on `821fdb9` failed **14/14** with `ops.provisionPersonalAccount is not a function`. Every structural claim in that file was unproven. | Real `SEED_OPS`. |
| 2 | No hosted-CI evidence at HEAD — the AT-025 race has executed in zero environments. | Environment, not code; see below. |
| 3 | G6 (same as pass-1 #2), plus: canon puts the reservation in `planned→queued`, one transition earlier than where this ticket attaches it. | Recorded in §4 with the canon citation. |
| 4 | **Compensating entries are representable but nothing creates one**, and §4 didn't say so while §0.2 read as though invariant 10 were delivered whole. | §4 bullet; the flow is P6-009. |
| 5 | `sideEffectClass: 'internal_only'` invented a fifth name outside canon's closed `RISK_CLASSES` — the drift this repo already shipped a correction for. The test asserted the literal, so it could not fail. | Returns a `RiskClass`; constant `informational` until tools are bound, recorded in §4. |
| 7 | Pricing neutrality: the *rule* is neutral, the *unit* is not — whole-integer credits would need a migration for sub-credit pricing under D-02. The CDR claimed neutrality unqualified. | §0.3 states the limit and why pre-empting it was declined. |
| 8 | "Insufficient credits block with a **path**" — the block ships, the path does not. | Recorded in §4. |
| 9 | Four use cases, `CreditRepository.findById`, and contracts `deriveBalance` all have no production caller. | Dead ones deleted; the rest recorded as P5-015's wiring. |
| 10 | The two credit audit entries were inserted *inside* the worker-runs comment block, so "these are canon's names, not new ones" now sat above two names that are new. | Moved below; recorded as deliberate additions absent from EVENT-CATALOG. |

## What CI caught that neither pass did

The `{} as never` seed bug. Both reviewers read the file; pass 2 found it only by reading the **CI logs**. A test file
that cannot run is indistinguishable from a passing one when the suite is skip-gated and the local database is down —
which is the standing condition in this environment. **`skipIf` plus a cast to `never` is a blind spot no amount of
reading catches**; only an execution does.

## The pattern

Same as the last three tickets, in a new costume: **a claim asserted and not enforced**. G6 said runs were gated —
nothing gated them. G8 said releases were bounded — a CHECK cannot see another row. The CDR said account-owner-only —
the code checked a company role. Each was written in good faith and each was false, and in every case the fixtures were
shaped so the false half could not fail.

The specific lesson for money code: **the app-code bound and the database bound are different guarantees**, and writing
the app-code one while describing the database one is how a two-billion-credit mint gets a reassuring comment above it.
