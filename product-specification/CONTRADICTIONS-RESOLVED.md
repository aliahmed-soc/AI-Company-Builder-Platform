# Contradictions — Identified and Resolved

Companion to `MASTER-PRD-v1.md` §7. Resolution follows the source hierarchy: owner instruction > directly observed authenticated behavior > directly observed task execution > screenshots/UI records > current first-party documentation > corrected audit review > audit conclusions > generated-company artifacts > third-party sources > assumptions.

---

## C-01 — Task execution: tested vs not tested

- **Topic:** Whether task execution was ever verified in the reference product.
- **Claim A:** Task execution was not completed during the audit. — **Source A:** `raw-audit/01-executive-summary.md` (coverage notes); `raw-audit/09-claim-verification.md` claim 3 ("no task was executed in audit").
- **Claim B:** A low-risk research task was run end to end: start, two research phases, report writing, completion, a persisted report document, and a credit balance reduced to 1. — **Source B:** `raw-audit/24-runtime-billing-quality-validation.md` §1; corroborated by `CHATGPT-HANDOFF.md` and `polsia-audit-review.md` correction 1.
- **Selected conclusion:** Claim B. One manual low-risk execution is **directly observed**.
- **Reason:** Claim B is later, more specific, and sits higher in the hierarchy (directly observed task execution). The earlier files simply predate the run and were not updated.
- **Remaining uncertainty:** One run proves the execution path exists — not reliability, retries, cancellation, recurring execution, or external side effects.
- **PRD impact:** TASK-004, TASK-005, USAGE-001 are classed *directly observed*; reliability-dependent capabilities stay in PRD §9.

## C-02 — Additional-company price: $20 vs $25 — **UNRESOLVED**

- **Topic:** Monthly price for each additional company in the reference product.
- **Claim A:** +$20/month each. — **Source A:** New-company/upgrade sheet UI (`raw-audit/07-billing-and-pricing.md`; `evidence/pricing.csv` row `extra_company`).
- **Claim B:** $25/month each. — **Source B:** In-app FAQ (`raw-audit/24-runtime-billing-quality-validation.md` §2).
- **Selected conclusion:** **None. Deliberately unresolved.** Both are first-party sources of comparable authority observed the same day; no purchase was executed to establish the billing truth.
- **Reason:** The evidence rules forbid choosing without sufficient evidence; a purchase or vendor confirmation is the only decisive test (OQ-03).
- **Remaining uncertainty:** Complete — either value (or a recent price change) could be correct.
- **PRD impact:** BILL-005 carries the unresolved flag; our own pricing is owner decision D-02; the derived requirement is *price-display consistency across all surfaces* (the reference product's inconsistency is the anti-pattern to avoid).

## C-03 — Per-action approval vs prior authorization

- **Topic:** How the reference product authorizes consequential actions.
- **Claim A:** Irreversible actions require approval (suggesting a per-action approval system). — **Source A:** In-app FAQ (`raw-audit/05-approval-matrix.md`, direct approval evidence).
- **Claim B:** Observed onboarding performed code generation, deployment, and an email send with **no visible approval prompt**; autonomous planning added tasks without approval; a research task ran after simple user initiation. — **Source B:** `raw-audit/05-approval-matrix.md` matrix rows; `raw-audit/03-onboarding-flow.md`; `polsia-audit-review.md` correction 4.
- **Selected conclusion:** Some reference-product actions run under prior/implicit authorization (subscription, connected services, enabled capabilities); a fine-grained approval system (inbox, payload binding, expiry, revocation) was **not demonstrated** and must not be claimed as parity.
- **Reason:** Direct observation (hierarchy rank 2) outweighs FAQ generality (rank 5); the two are compatible if "approval" means coarse consent, which observation supports.
- **Remaining uncertainty:** Approval behavior for payments, deletion, ads, and campaigns was never exercised (55% review confidence).
- **PRD impact:** The advanced approval model (APPR-001…010) is classified entirely as **our improvement layer**; PRD §9 and §11.5 keep the boundary explicit.

## C-04 — Fixed agents vs capability areas

- **Topic:** Whether the reference product runs a defined set of discrete AI agents.
- **Claim A:** Distinct agents exist per function (implied by role-like labels: research, engineering, marketing…). — **Source A:** UI activity labels (`raw-audit/04-task-and-agent-system.md`, visible roles).
- **Claim B:** "The UI does not name independent agents… labels are capabilities, not proof of separate backend services"; agent architecture confidence 35%. — **Source B:** Same file's own caveat; `polsia-audit-review.md` confidence table.
- **Selected conclusion:** Claim B. The reference product demonstrates **capability areas**, not a known agent architecture.
- **Reason:** The stronger source explicitly disclaims the inference; internal architecture is out of evidentiary reach (§10).
- **Remaining uncertainty:** Actual worker/agent design is unknown and stays unknown.
- **PRD impact:** Our worker model (WORK-001…006) is our own design; §8.5 states domain labels ≠ backend agents; §10 lists agent count/lifecycle as unknowable.

## C-05 — Generated-company features vs platform capabilities

- **Topic:** Whether follower monitoring, sentiment detection, narrative reports, Slack delivery, and account-monitoring dashboards are native platform features.
- **Claim A:** They are platform capabilities (they appeared in roadmaps/site and even as draft parity requirements PRD-011/PRD-012 in `raw-audit/11`). — **Source A:** Test company's public site and roadmap; `raw-audit/11-product-requirements-document.md` PRD-011/012.
- **Claim B:** They are features of the disposable test company's *generated product* (a social-listening app) and prove only that the platform can generate applications containing them. — **Source B:** `polsia-audit-review.md` correction 2.
- **Selected conclusion:** Claim B. Excluded from parity entirely.
- **Reason:** Hierarchy rank 8 (generated-company artifacts) cannot establish platform capability; the corrected review (rank 6) explicitly demotes them.
- **Remaining uncertainty:** The platform *might* also natively offer some of these; no evidence either way.
- **PRD impact:** No requirement in this PRD treats these as parity; event monitoring/report delivery appear only as possible future capabilities of our own design.

## C-06 — Generated code export vs platform internal architecture

- **Topic:** Whether the exported generated project reveals the reference product's own architecture.
- **Claim A:** The export (framework, ORM setup, deploy config) is a blueprint of the platform. — **Source A:** Naïve reading of `raw-audit/22-exported-code-verification.md`.
- **Claim B:** The export verifies one generated *customer application*; the platform's dashboard frontend, task engine, schema, orchestration, authorization, billing, and queues remain unknown. — **Source B:** `polsia-audit-review.md` correction 3; `raw-audit/24` boundaries.
- **Selected conclusion:** Claim B.
- **Reason:** Category error — generated output ≠ generator internals; explicit boundary statements control.
- **Remaining uncertainty:** All platform internals (§10).
- **PRD impact:** Export evidence supports only BUILD-002/003 and quality-gate rationale (BUILD-007); §10 hard-lists the unknowables.

## C-07 — $49 public historical pricing vs $25 authenticated pricing

- **Topic:** The reference product's current base subscription price.
- **Claim A:** Subscription starts at $49/month (historical/public claim given to the audit as a verification target). — **Source A:** Audit brief claim 30 (`raw-audit/09-claim-verification.md`).
- **Claim B:** $25/month, shown identically in the live upgrade sheet and current FAQ. — **Source B:** `raw-audit/07-billing-and-pricing.md`; `evidence/pricing.csv`.
- **Selected conclusion:** Claim B — $25/month is the current observed price; the $49 figure is contradicted (stale or wrong).
- **Reason:** Direct same-day observation from two consistent first-party surfaces (ranks 2 and 5) versus an unsourced historical figure (rank 9).
- **Remaining uncertainty:** Whether $49 was ever real (pricing history is irrelevant to our product).
- **PRD impact:** §8.9 records $25 as reference evidence only; our pricing is D-02.

## C-08 — Code export vs complete infrastructure portability

- **Topic:** Whether users of the reference product can take their whole business elsewhere.
- **Claim A:** Code download implies full portability. — **Source A:** Download Code control + FAQ (`raw-audit/09-claim-verification.md` claim 17, 99%).
- **Claim B:** Ownership terms were not found (claim 18, <50%); database/data export, hosting migration, domain transfer, and repository handover were never verified; self-hosting is described as future. — **Source B:** `raw-audit/09` claim 18; `raw-audit/19-competitive-gaps.md` (portability row); review's partially-verified list.
- **Selected conclusion:** Code export is verified parity; **complete portability is not** and must not be claimed as reference-product behavior.
- **Reason:** One verified artifact type cannot be generalized to all asset classes; absence of ownership terms is itself a finding.
- **Remaining uncertainty:** Reference product's data-export and transfer behavior.
- **PRD impact:** BUILD-003 is parity; EXPORT-001/EXPORT-002 (full data portability + manifest) are **our improvements**; ownership language in our terms is D-07.
