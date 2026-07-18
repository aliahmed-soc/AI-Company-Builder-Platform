# Usage and Billing Architecture

Status: Proposed. Governs USAGE-001/002, BILL-001…006, NFR-015 + the ADR-003 **per-account rollup** refinement. ADR: ADR-013. Diagram: `diagrams/10`. Commercial formula deliberately open where D-02 is unresolved.

## 1. The five distinct numbers (required separation)

These are **never** collapsed into one ambiguous figure:

| Layer | Definition | Store |
|---|---|---|
| Technical usage | Tokens, calls, tool executions, run seconds | usage events (append-only) |
| Provider cost | Estimated + reconciled provider charges for that usage | cost fields on usage events + reconciliation records |
| Billable usage | The subset/transformation of technical usage the commercial model charges for (formula = D-02) | derived views, versioned formula |
| Included entitlement | What the subscription plan includes per period | entitlement records (billing module) |
| User-visible credits | The product-facing unit founders see and spend | credit transactions (append-only ledger) |

**Credits (MVP stance):** credits are a **commercial entitlement and display abstraction over task execution** — one manual task run = one credit (mirrors verified reference behavior, TASK-004/BILL-002 evidence) — **not** a direct model-token mapping. Whether post-MVP pricing keeps task-credits, moves to usage-billing, or hybridizes is **D-02 (open)**; the ledger design supports all three without schema change (that neutrality is the architecture requirement).

## 2. Ledgers

- **Usage events** — append-only (invariant 9): every model call, tool call, and run emits events with `{company_id, account_id, task_ref, kind, quantities, estimated_cost, occurred_at}`. No UPDATE/DELETE path.
- **Credit transactions** — append-only (invariant 10): grants (plan reset, bonus, purchase), reservations (run preflight), consumptions (run completion), releases (cancel), refunds/corrections (compensating entries referencing the original txn). Balance is always derived; the two-runs-one-credit race resolves via atomic reservation (AT-025 pattern; BILL-002 acceptance).
- **Account usage rollups** — per `(account_id, period)`: derived aggregation across the account's companies (the ADR-003 owner refinement). Maintained incrementally, **rebuildable from the ledger** (it is a projection, never a source of truth). PRD note: requires the tracked USAGE-001 amendment (ADR-003 §16) — architecture implements it regardless of amendment timing since the owner decision is binding.

## 3. Controls (ADR-003 pre-beta list — where each lives)

| Control | Component |
|---|---|
| Per-company + per-account usage recording | usage ledger + rollups (above) |
| Model/model-version tracking | gateway stamps every call (ADR-011) |
| Token measurement + estimated cost | gateway → usage events |
| Hard usage limits | policy engine checks ledger-derived counters pre-call and pre-execution; overrun ≤1 increment (NFR-015) |
| Rate limits | api layer (per session/account) + gateway (per company) |
| Budget alerts | usage.limit_reached (soft thresholds) → notifications/Decision Room |
| Abuse detection | signup friction + anomaly detection on usage patterns (velocity, entropy) → automatic soft-lock + review |
| Provider timeout/failure handling | gateway (ADR-011) + FAILURE-AND-RECOVERY §1-2 |
| Secret isolation / server-side keys / no keys to clients | ADR-014, invariants 12/13 |
| Redacted logging | ADR-017 pipeline |
| Data-path disclosure | product copy obligation (Phase 7, ADR-003 §16) — architecture provides the subprocessor register (ADR-005) it must reference |

## 4. Charging rules (explicit)

| Case | Rule |
|---|---|
| Failed call, provider fault | Technical usage recorded; **not billable**; credit reservation released; documented in run detail (TASK-004 failure rule) |
| Failed call, invalid output after re-asks | Usage recorded; credit released; counts against quality metrics, not the customer |
| Retry | Usage recorded per attempt (technical truth); billable at most once per logical task (charging views dedupe on task_ref) |
| Cancelled mid-run | Metered to stop point; credit released (MVP-generous; revisit with D-02) |
| Correction/refund | Compensating credit transaction referencing the original — **never** edits (invariant 10) |
| Reconciliation | Periodic job compares provider bills ↔ estimated costs ↔ usage events; drift beyond threshold alerts (launch gate 7) |

## 5. Subscription entitlements (Phase 7 boundary)

Billing module owns subscription state + entitlements (plan contents, included credits/allowances); portal handoff to the external billing provider (BILL-004, provider = AOQ-07); webhooks signature-verified; cancellation ⇒ company pause semantics, never deletion (BILL-006). Additional-company pricing display must be **single-sourced** so every surface shows the same value (BILL-005's anti-pattern lesson).
