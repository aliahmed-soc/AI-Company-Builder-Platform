# Open Questions

Companion to `MASTER-PRD-v1.md` §24 (same OQ IDs; the PRD table carries deadline/owner/evidence/method detail). Markers: **[BLOCKING]** blocks the technical-architecture phase; **[PHASE]** blocks a named later phase; **[FUTURE]** informs future capabilities only; **[RESOLVED]** decided by owner with an accepted ADR.

> **2026-07-18 update:** All four architecture-blocking questions are **resolved** (OQ-01 → ADR-001, OQ-05 → ADR-002, OQ-06 → ADR-003, OQ-19 → ADR-004); the OQ-22 residency *aspect* is resolved (ADR-005) while OQ-22's market/region choice remains open. Narrower follow-ups OQ-25…OQ-28 added below. **Zero questions now block the technical-architecture phase.** Original questions preserved for history.

## Product

- **OQ-13 [PHASE — before TASK-003]** What may one scheduled work shift include — task count, spend budget, allowed risk classes, stop conditions?
- **OQ-14** (non-blocking; MVP default documented) Exact safe-stop semantics when a company is paused mid-run. Default: finish the current tool call, halt before the next, hold the task visibly.
- **OQ-15** Which roles beyond owner + viewer ship first, and when (see PRD §13)?
- **OQ-07 [FUTURE]** How does the reference product's continuous mode actually behave? (Calibrates our levels 4–5; requires a disposable-company test.)

## Customer

- **OQ-01 [RESOLVED 2026-07-18 → `../docs/decisions/ADR-001-primary-mvp-customer.md`]** ~~[BLOCKING]~~ Who is the primary MVP customer? *(Original importance: blocked architecture.)* **Resolution:** non-technical solo founders validating/planning a digital business, SaaS product, or online service; secondary waves: multi-idea entrepreneurs, SMB owners, agencies/studios.

## Commercial

- **OQ-02 [PHASE — before Phase 7]** Our base price and inclusions (D-02).
- **OQ-04 [PHASE — before Phase 7]** Credits vs pure usage billing vs hybrid (D-02).
- **OQ-03** (non-blocking market intelligence) The reference product's true extra-company price — $20 (UI) or $25 (FAQ)? Contradiction C-02; resolvable only via purchase flow or vendor confirmation.
- **OQ-11 [FUTURE]** Customer-payment model and money-movement compliance for PAY-001.
- **OQ-23 [FUTURE]** Advertising control model — platform ad account vs client-owned accounts; fee structure.

## Approval and autonomy

- **OQ-24 [PHASE — end of Phase 6]** Which external action ships first: email, social, or deployment (D-05)?
- **OQ-10 [PHASE — before email ships]** Email autonomy boundaries: volume ceilings, consent standards, cold-outreach stance.
- **OQ-12 [PHASE — before social ships]** Social publishing autonomy defaults per autonomy level.

## Technical

- **OQ-05 [RESOLVED 2026-07-18 → `../docs/decisions/ADR-002-infrastructure-ownership-model.md`]** ~~[BLOCKING]~~ Managed vs customer-owned infrastructure for generated software (D-03). *(Original importance: blocked architecture.)* **Resolution:** hybrid direction; platform-managed defaults first; export mandatory; no MVP portability promise; marketing prohibitions binding.
- **OQ-06 [RESOLVED 2026-07-18 → `../docs/decisions/ADR-003-ai-key-ownership.md`]** ~~[BLOCKING]~~ BYO AI keys vs platform keys vs both (D-04). *(Original importance: blocked architecture.)* **Resolution:** platform-managed keys for MVP with 16 pre-beta controls; BYOK post-MVP only via a new approved decision.
- **OQ-19 [RESOLVED 2026-07-18 → `../docs/decisions/ADR-004-model-provider-strategy.md`]** ~~[BLOCKING]~~ Model-provider strategy (feeds NFR-019 design). *(Original importance: blocked architecture.)* **Resolution:** provider-neutral internal gateway; one primary + one fallback; no dynamic routing; gateway is an internal boundary, not a product.
- **OQ-16** Infrastructure-portability promise strength — export-only vs guaranteed third-party rebuildability (scopes EXPORT-002; pairs with D-07).
- **OQ-17** Git/repository ownership model for generated code — platform-owned with transfer, or customer-owned from creation (pairs with D-07).
- **OQ-09 [FUTURE]** Reference product's actual rollback behavior (calibrates BUILD-005).
- **OQ-08 [FUTURE]** Reference product's auto-retry semantics (market intelligence for TASK-010; our design ships regardless).

## Data

- **OQ-18 [PHASE — before beta]** Retention periods per data class (NFR-016).
- **OQ-20** Cross-company learning: permitted at all, and under what privacy boundary? Default until decided: **strict isolation, none**.

## Security

- (No open security questions block architecture; NFR-001/002/010/018/021 are requirements, not questions. Security-relevant unknowns about the reference product are §10 unknowables and stay that way.)

## Legal

- **OQ-22 [PHASE — before beta] — PARTIALLY RESOLVED** Initial market/region and its regulatory boundaries (D-08): privacy regime, marketing law, and any money-movement licensing implications. **Residency aspect resolved 2026-07-18 → `../docs/decisions/ADR-005-initial-data-residency.md`** (no strict-residency promise in beta; non-foreclosure + documentation obligations binding; regulated strict-residency customers out of beta scope). **Market/region selection remains open** — required before beta.

## Operations

- **OQ-21 [PHASE — before beta]** Human support model for beta: channels, hours, SLA, escalation.

## Evidence verification (research follow-ups on the reference product — all optional, none blocking)

- **OQ-03** Pricing confirmation (above).
- **OQ-07** Continuous-mode sandbox test (above).
- **OQ-08** Induced-failure retry observation (above).
- **OQ-09** Two-deploy rollback test (above).

## Follow-up questions created by the 2026-07-18 decisions (none blocking architecture)

- **OQ-25 [PHASE — architecture phase]** Which exact primary and fallback models (and versions) does the gateway configure first? *(From ADR-004 §16; decided via an implementation-facing ADR with task-type benchmarks.)*
- **OQ-26 [PHASE — architecture phase]** Which managed infrastructure providers back the platform-managed defaults? *(From ADR-002 §16; provider-abstraction rule applies.)*
- **OQ-27 [PHASE — before beta]** What are the initial usage-cap, rate-limit, and budget-alert values for platform-managed AI access? *(From ADR-003 §16; needs alpha usage data.)*
- **OQ-28 [FUTURE]** When does optional BYOK enter the roadmap, and for which tier? *(From ADR-003; requires a new approved decision to change MVP scope.)*
- *(Beta-region selection is already covered by the open remainder of OQ-22 — not duplicated here.)*

---

**Counts (updated 2026-07-18):** 28 questions total · **0 blocking architecture** (previously 4 — OQ-01, OQ-05, OQ-06, OQ-19 — all resolved via ADR-001…004) · 1 partially resolved (OQ-22, residency aspect via ADR-005) · 11 phase-blocking (incl. OQ-25/26/27) · 12 non-blocking/future (incl. OQ-28).
