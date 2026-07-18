# Owner Decision Worksheet

Decisions that belong to the owner. Nothing below is assumed in `MASTER-PRD-v1.md`; recommendations are labeled and non-binding. Record decisions in the **Owner decision** field; each recorded decision should become a decision record in `docs/decisions/`.

---

## D-01 — Primary MVP customer

- **Question:** Which segment does the MVP serve first?
- **Recommended default:** Solo non-technical founder validating one serious idea (PRD §4 rationale).
- **Alternatives:** Technical founder; multi-idea entrepreneur; existing small-business owner; agency/studio.
- **Benefits (default):** MVP slice is complete standalone value; most underserved; forces trust features first; cleanest onboarding copy.
- **Risks (default):** Lower willingness to pay than agencies; higher support expectations; churn if outputs disappoint.
- **PRD impact:** Interview tone and depth (DISC), option complexity (STRAT-002), J-03 priority (D-10), success-metric targets (§21).
- **Architecture impact:** Low direct; influences load profile and pricing-model assumptions.
- **Required by:** Architecture start (blocks OQ-01).
- **Owner decision:** ✅ **APPROVED — 2026-07-18.** Selected: recommendation (Option A). Approved wording: primary MVP customer is the **non-technical solo founder validating and planning a digital business, SaaS product, or online service** — has an idea but may lack a complete plan; needs help identifying customer and problem; needs assumptions challenged; wants several strategic options; needs an actionable roadmap; cannot independently perform all research and planning; wants AI assistance without giving up decision authority. Secondary future segments in order: (1) entrepreneurs testing multiple ideas, (2) existing small-business owners, (3) agencies/venture studios. Do not design the MVP primarily for agencies, enterprises, or advanced engineering teams. Record: `../docs/decisions/ADR-001-primary-mvp-customer.md`.

## D-02 — MVP commercial model

- **Question:** Price, inclusions, and mechanism (credits vs usage vs hybrid) for our subscription.
- **Recommended default:** Defer final numbers until alpha instrumentation exists; adopt the *structure* the evidence supports (base subscription + included task allowance + purchasable credit packs) as a working hypothesis; run beta pricing as an experiment.
- **Alternatives:** Pure usage-based billing; flat all-inclusive tiers; free tier + paid execution.
- **Benefits (default):** Structure is market-validated by reference evidence; avoids committing numbers without cost data.
- **Risks (default):** Credit systems confuse some users; anchoring too close to the reference product invites comparison.
- **PRD impact:** BILL-001/003/005, USAGE-002 details; §21 cost-per-task target.
- **Architecture impact:** Billing/ledger design in Phase 7; metering hooks earlier (USAGE-001 is MVP regardless).
- **Required by:** Phase 7 build (blocks OQ-02/OQ-04).
- **Owner decision:** _[pending]_

## D-03 — Infrastructure provisioning scope

- **Question:** When software generation ships, does the platform provision and manage hosting/database for generated products, or deploy into customer-owned infrastructure?
- **Recommended default:** Managed platform infrastructure first (matches verified reference behavior; drastically simpler onboarding), with EXPORT-002 portability as the counterweight.
- **Alternatives:** Customer-owned infra only; hybrid (managed default + bring-your-own option).
- **Benefits (default):** Simplest UX; full control of quality gates and rollback.
- **Risks (default):** Operating cost and abuse surface; stronger lock-in perception (mitigated by D-07).
- **PRD impact:** BUILD/DEPLOY requirement details; EXPORT-002 importance rises.
- **Architecture impact:** Major — hosting, isolation, and cost architecture.
- **Required by:** Architecture start (blocks OQ-05) — the decision shapes foundations even though the capability is post-MVP.
- **Owner decision:** ✅ **APPROVED — 2026-07-18.** Selected: recommendation (Option C, hybrid direction / managed defaults first). Approved wording: platform manages the default execution environment and may manage generated-project hosting; users never required to configure hosting/databases/dev infrastructure during onboarding; generated source code, documents, and customer-owned data must be exportable; avoid unnecessary obstacles to future transfer; use provider abstractions where practically valuable; **full infrastructure portability is not an MVP promise.** Marketing must NOT claim: one-click cloud migration, complete database migration, automatic account transfer, provider-independent deployments, or guaranteed production portability. Long-term: customer-owned infrastructure connections, incremental portability expansion, ownership principles preserved. The temporary tension between managed defaults and complete portability is **recorded** (ADR-002 §11). Record: `../docs/decisions/ADR-002-infrastructure-ownership-model.md`.

## D-04 — AI key ownership

- **Question:** Platform-supplied AI keys, customer BYOK, or both?
- **Recommended default:** Platform keys for MVP (uniform quality, metering, and safety controls), with BYOK as a designed-for future option (provider abstraction required by NFR-019 anyway).
- **Alternatives:** BYOK-only (cost passes through, but uneven quality/safety); both at launch.
- **Benefits (default):** Consistent output quality; single metering point; simpler abuse control.
- **Risks (default):** AI cost on our margin; power users may demand BYOK sooner.
- **PRD impact:** USAGE/NFR-015 metering semantics; settings surface.
- **Architecture impact:** Provider abstraction layer; secret handling for future BYOK.
- **Required by:** Architecture start (blocks OQ-06).
- **Owner decision:** ✅ **APPROVED — 2026-07-18.** Selected: recommendation (Option A for MVP, hybrid direction). Approved wording: platform-managed model-provider access for MVP; no customer AI keys required at onboarding. Before beta the system must include: per-company usage recording, **per-account usage recording**, model + model-version tracking, token-equivalent usage measurement, estimated provider cost, hard usage limits, rate limits, budget alerts, abuse detection, provider timeout handling, provider failure normalization, secret isolation, server-side credential use, no provider keys exposed to browsers/clients, redacted logging, and clear disclosure of the AI-provider data path. **Optional BYOK is post-MVP** and excluded from the first implementation unless a later approved decision changes scope. Record: `../docs/decisions/ADR-003-ai-key-ownership.md`.

## D-05 — First external action

- **Question:** Which external capability ships first after MVP: outbound email, social publishing, or site deployment?
- **Recommended default:** Site deployment (BUILD-001/DEPLOY-001): highest verified reference parity, no third-party recipient (lowest abuse/compliance risk), and the most visible customer value.
- **Alternatives:** Email first (strong founder demand, higher compliance load); social first (public but low-volume).
- **Benefits (default):** Exercises approvals/receipts/rollback on a reversible-ish action with no human recipients.
- **Risks (default):** Delays outreach value some segments want most.
- **PRD impact:** Phase ordering after MVP; EMAIL/SOCIAL/DEPLOY sequencing.
- **Architecture impact:** Connector framework's first concrete instance.
- **Required by:** End of Phase 6 (blocks OQ-24).
- **Owner decision:** _[pending]_

## D-06 — Initial approval model

- **Question:** Confirm the MVP approval posture: autonomy levels 1–2 only, full approval mechanics (payload binding, expiry, revocation) live from MVP.
- **Recommended default:** As specified (PRD §11.5/§18).
- **Alternatives:** Stricter (level 1 only); looser (enable level 3 categories in MVP — not recommended before external actions exist).
- **Benefits (default):** Approval machinery is battle-tested on safe internal actions before anything external exists.
- **Risks (default):** Slight friction for internal-only actions at level 1.
- **PRD impact:** APPR-008 scope; §12 defaults.
- **Architecture impact:** Approval service is MVP-critical path.
- **Required by:** Phase 6 build.
- **Owner decision:** _[pending]_

## D-07 — Code ownership and export promise

- **Question:** How strong is our ownership/portability commitment — export-only, or guaranteed third-party rebuildability (EXPORT-002 manifest), and who owns generated IP?
- **Recommended default:** Client owns all generated outputs; commit to EXPORT-001 at beta and EXPORT-002 (verified rebuildability) as a stated roadmap promise. The reference product's *absence* of visible ownership terms (claim 18, <50%) is our differentiation opening.
- **Alternatives:** Export without rebuild guarantee; licensed-use model (not recommended — violates principle 1).
- **Benefits (default):** Trust differentiator; aligns with principles 1/13.
- **Risks (default):** Rebuild guarantees create support obligations.
- **PRD impact:** EXPORT-001/002, terms-of-service content.
- **Architecture impact:** Artifact formats, manifest tooling.
- **Required by:** Before BUILD/EXPORT-002 work; terms language before beta.
- **Owner decision:** _[pending]_

## D-08 — Initial market and region

- **Question:** Which market/region does beta launch in (determines privacy regime, marketing rules, money rules, language priorities)?
- **Recommended default:** None offered — this is owner/market knowledge; note the evidence snapshot came from an Africa/Cairo-timezone audit but that implies nothing about our market.
- **Alternatives:** n/a.
- **PRD impact:** NFR-011/016 specifics; §21 targets; localization scope.
- **Architecture impact:** Data residency, compliance controls.
- **Required by:** Before beta (blocks OQ-22).
- **Owner decision:** ⚠️ **PARTIALLY RESOLVED — 2026-07-18.** The **data-residency sub-question is APPROVED**: the initial beta does not promise strict EU, national, or customer-selected data residency; architecture must not unnecessarily prevent future regional deployment; data locations, model-provider processing locations, and subprocessors must be documented; no customer may be told data remains in a specific country unless guaranteed; strict residency is post-MVP unless a design partner requires it; highly regulated strict-residency customers are not beta targets. Record: `../docs/decisions/ADR-005-initial-data-residency.md`. **The remainder of D-08 (initial market/region selection) stays pending** — required before beta.

## D-09 — Branding and final product name

- **Question:** Final product name and brand (replaces the temporary "AI Company Builder Platform").
- **Recommended default:** None — owner's call; naming must not reference Halo Suite, Systevo, or Polsia.
- **PRD impact:** Cosmetic (name fields); positioning language.
- **Architecture impact:** None structural; domains/identifiers.
- **Required by:** Before beta.
- **Owner decision:** _[pending]_

## D-10 — Existing-business path in MVP

- **Question:** Is J-03 (add existing company) in MVP scope, or idea-mode only?
- **Recommended default:** Ship the *entry point* and brownfield interview adaptation in MVP (COMP-001 already requires the mode), but market to and optimize for the greenfield path first (per D-01 default).
- **Alternatives:** Idea-mode only (defer existing-business entirely); full brownfield focus.
- **Benefits (default):** Existing-business input is mostly interview logic (facts instead of assumptions), cheap to include and valuable for segment 3.
- **Risks (default):** Brownfield expectations (integrations, real data) exceed MVP capability — copy must set boundaries.
- **PRD impact:** COMP-001 acceptance scope; J-03; DISC prompts.
- **Architecture impact:** Minimal.
- **Required by:** Phase 2 build.
- **Owner decision:** _[pending]_

---

---

# OWNER RESPONSE AREA

> **This section is reserved for the owner.** Nothing above or below is approved until the owner
> fills in the relevant block. Full option analysis for the four architecture-blocking decisions
> (D-01, D-03, D-04, OQ-19) is in `OWNER-DECISION-PACK.md`. Each recorded decision should also
> become a decision record in `../docs/decisions/`.

## Architecture-blocking decisions

### D-01 — Primary MVP customer — ✅ APPROVED

```text
Owner decision:
[x] Approve recommendation (non-technical solo founder; secondary: multi-idea entrepreneur)
[ ] Select another option
[x] Modify recommendation
[ ] Defer

Selected option: Option A — non-technical solo founders validating/planning a digital business,
                 SaaS product, or online service.
Owner notes: Modification: secondary future segments ordered as (1) multi-idea entrepreneurs,
             (2) existing small-business owners, (3) agencies/venture studios. MVP must not be
             designed primarily for agencies, enterprises, or advanced engineering teams.
             Full approved wording: see D-01 body above and ADR-001.
Decision date: 2026-07-18
```

### D-03 — Infrastructure model — ✅ APPROVED

```text
Owner decision:
[x] Approve recommendation (hybrid direction; managed defaults first; export preserved; no MVP portability promise)
[ ] Select another option
[ ] Modify recommendation
[ ] Defer

Selected option: Option C — hybrid long-term direction, platform-managed defaults first.
Owner notes: Marketing prohibitions explicit (no one-click migration / DB migration / account
             transfer / provider-independent deploys / guaranteed portability claims).
             Managed-vs-portability tension recorded in ADR-002 §11.
Decision date: 2026-07-18
```

### D-04 — AI key ownership — ✅ APPROVED

```text
Owner decision:
[x] Approve recommendation (platform-managed keys for MVP with the named controls; BYOK later)
[ ] Select another option
[x] Modify recommendation
[ ] Defer

Selected option: Option A for MVP (hybrid as product direction).
Owner notes: Control list expanded to 16 items, adding per-account usage recording, budget
             alerts, abuse detection, provider timeout handling, and data-path disclosure.
             BYOK explicitly excluded from first implementation absent a new approved decision.
             Full list: see D-04 body above and ADR-003.
Decision date: 2026-07-18
```

### OQ-19 — Model-provider strategy — ✅ APPROVED

```text
Owner decision:
[x] Approve recommendation (provider-neutral gateway; one primary + one fallback; no dynamic routing)
[ ] Select another option
[ ] Modify recommendation
[ ] Defer

Selected option: Option C — provider-neutral internal gateway; one primary model, one fallback;
                 fallback only for approved failure conditions or supported task classes.
Owner notes: Gateway is an internal architectural boundary, not a commercial product. 13 gateway
             requirements approved (see ADR-004 §6). No provider-specific behavior in product code.
Decision date: 2026-07-18
```

### D-08 (narrow sub-question) — Data residency — ✅ APPROVED

```text
Is an EU / strict-data-residency launch plausible for beta?
[ ] Yes — architecture must design for residency now
[x] No — defer residency to a future region expansion
[ ] Unsure — treat as Yes for safety

Owner notes: Beta makes no strict-residency promises; architecture must not unnecessarily
             foreclose regional deployment; data locations, provider processing locations, and
             subprocessors must be documented; no unsupported country claims to customers;
             regulated strict-residency customers out of beta scope. See ADR-005.
             D-08 remainder (market/region selection) REMAINS PENDING.
Decision date: 2026-07-18
```

## Non-blocking decisions (respond when ready)

```text
D-02 (commercial model):        [ ] Approve default   [ ] Other: ______________   Date: ______
D-05 (first external action):   [ ] Approve default   [ ] Other: ______________   Date: ______
D-06 (approval model):          [ ] Approve default   [ ] Other: ______________   Date: ______
D-07 (ownership promise):       [ ] Approve default   [ ] Other: ______________   Date: ______
D-08 (market/region, rest):     [ ] Approve default   [ ] Other: ______________   Date: ______
D-09 (branding/name):           [ ] Decided: ________________________________     Date: ______
D-10 (existing-business path):  [ ] Approve default   [ ] Other: ______________   Date: ______
```
