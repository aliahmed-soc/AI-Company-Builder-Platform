# Owner Decision Pack — Architecture-Blocking Decisions

**Status:** **RESOLVED 2026-07-18 — all four architecture-blocking decisions (plus the D-08 residency sub-question) are Approved by owner.** Approved wording lives in `OWNER-DECISIONS.md` and ADR-001…ADR-005 (`../docs/decisions/`); the ADRs are authoritative. The analysis below is preserved as decision rationale. Sections marked "Recommendation" were inputs; sections marked "Approved by owner" record outcomes.
**Scope:** The four architecture-blocking decisions (D-01, D-03, D-04, OQ-19) analyzed in full; D-02 and D-05–D-10 classified. Companion to `MASTER-PRD-v1.md` §24–§25 and `OWNER-DECISIONS.md`.
**Date:** 2026-07-18 · **Author:** Claude (session under `.cursor/rules/model-routing.mdc`)

## Consolidated decision table

| Decision | Recommended default | Blocks architecture | Reversal cost | Owner status |
|---|---|---:|---|---|
| **D-01** Primary MVP customer | Non-technical solo founder validating a digital/SaaS idea; secondary: multi-idea entrepreneur | **Yes** | Low | ✅ **Approved by owner** (2026-07-18, ADR-001; secondary segments ordered, +SMB owners, +agencies) |
| **D-03** Infrastructure model | Hybrid direction; platform-managed defaults built first; code export preserved; no full-portability promise in MVP | **Yes** | High | ✅ **Approved by owner** (2026-07-18, ADR-002) |
| **D-04** AI key ownership | Platform-managed keys for MVP with the 10 listed controls; BYOK later | **Yes** | Medium | ✅ **Approved by owner** (2026-07-18, ADR-003; control list expanded to 16) |
| **OQ-19** Model-provider strategy | Provider-neutral internal gateway; one primary model + one fallback; no dynamic routing | **Yes** | Low (given gateway) / High (without it) | ✅ **Approved by owner** (2026-07-18, ADR-004) |
| D-02 Commercial model | Defer numbers to alpha data; structure = base + allowance + credit packs | No — blocks Phase 7 | Medium | ☐ Pending |
| D-05 First external action | Site deployment first | No — blocks post-MVP planning | Low | ☐ Pending |
| D-06 Initial approval model | Confirm PRD default (levels 1–2 MVP, full approval mechanics live) | No — Phase 6; PRD default already specified | Low | ☐ Pending |
| D-07 Ownership/export promise | Client owns outputs; EXPORT-001 at beta; EXPORT-002 as roadmap promise | No — commercial/future | Low–Medium | ☐ Pending |
| D-08 Initial market/region | No default (owner knowledge) — **but see residency flag below** | Partially — residency aspect only | High (residency), Low (rest) | ⚠️ **Residency sub-question Approved by owner** (2026-07-18, ADR-005: no strict-residency promise in beta, non-foreclosure discipline binding); market/region remainder ☐ Pending |
| D-09 Branding/name | None — owner's call | No — branding | Low | ☐ Pending |
| D-10 Existing-business path in MVP | Ship entry point + brownfield interview logic; optimize greenfield | No — Phase 2; default specified | Low | ☐ Pending |

---

# Decision 1 — D-01: Primary MVP customer

## Why it matters
The segment choice tunes the adaptive interview's tone and depth (DISC), strategy-option sophistication (STRAT-002), copy, pricing posture, success-metric targets (§21), and which second capability wave matters most. It is the cheapest blocking decision to make and the most expensive to leave vague: "everyone with an idea" produces an interview and options engine tuned for no one.

## Options

### Option A — Non-technical solo founders
People with business ideas who need help understanding, validating, planning, and executing them.

| Criterion | Assessment |
|---|---|
| Problem urgency | **High** — they cannot execute alone at all; the alternative is paying agencies or stalling |
| Willingness to pay | Moderate — prosumer budget; reference-market evidence clusters at ~$25/mo entry (PRD §8.9) |
| Onboarding complexity | **Lowest** — greenfield idea in, no integrations, no data import |
| Support burden | Higher — least self-sufficient users; expectations need managing |
| Trust requirements | High on money/public actions, low on internal work — matches an MVP with zero external actions |
| Required integrations | **None for MVP** |
| Required worker capabilities | Exactly the MVP three: research, strategy, documents |
| Time to first value | **Days** — first useful research/plan documents |
| Sales-cycle difficulty | Easy reach (self-serve), high volume, high churn risk |
| MVP scope impact | None beyond current scope — the MVP loop *is* their journey |
| Expansion potential | Natural: same user later needs website, email, social (post-MVP waves) |

- **Advantages:** perfect fit to the MVP loop; zero integration prerequisites; the trust differentiators (§11) are their exact anxieties; fastest path to learning.
- **Disadvantages:** price-sensitive; noisy segment full of tire-kickers; output quality is judged emotionally ("is my idea good?"); support-heavy; churn when ideas die (which is often — and our product honestly killing bad ideas *accelerates* that churn).
- **Risks:** conversion below viability if free-tier expectations dominate; disappointment risk if research quality wobbles (R: hallucinated advice, PRD §23).
- **PRD impact:** none — §4 already recommends this segment.
- **Architecture impact:** consumer-grade self-serve auth/onboarding; volume-oriented cost controls (NFR-015 matters more).
- **MVP impact:** none — current scope is sufficient.
- **Future flexibility:** high — every other segment is a superset of this journey.

### Option B — Technical founders
Developers who can build products but need business strategy, research, marketing, and operating assistance.

| Criterion | Assessment |
|---|---|
| Problem urgency | Medium — they can survive without us; business tasks are annoying, not blocking |
| Willingness to pay | Moderate-high, but they benchmark against doing it themselves with raw LLMs |
| Onboarding complexity | Low |
| Support burden | **Lowest** — self-sufficient |
| Trust requirements | Highest scrutiny of output *quality*; will inspect provenance and sources |
| Required integrations | None for MVP, but they'll demand export/API early |
| Required worker capabilities | MVP three, at higher rigor |
| Time to first value | Days, but their bar for "useful" is higher |
| Sales-cycle difficulty | Skeptical audience; strong word-of-mouth if won |
| MVP scope impact | Pressure to add API access and deeper research tooling |
| Expansion potential | Good — they grow into deployment/ops capabilities |

- **Advantages:** cheap to support; brutal, high-quality feedback; credibility halo if satisfied.
- **Disadvantages:** the MVP's document outputs compete with their own ChatGPT/Claude usage; weakest differentiation for this group until software generation ships (Future scope).
- **Risks:** "I could prompt this myself" churn; feature pressure pulling the roadmap toward BUILD before trust rails are proven.
- **PRD impact:** would raise STRAT-002/WORK-002 rigor bars; add API export items.
- **Architecture impact:** early public-API pressure (explicit §20 non-goal).
- **MVP impact:** scope creep risk toward §20 non-goals.
- **Future flexibility:** medium — their killer feature (app generation) is furthest away.

### Option C — Existing small-business owners
Owners with product, customers, and operations who want AI-supported growth.

| Criterion | Assessment |
|---|---|
| Problem urgency | High — real revenue at stake |
| Willingness to pay | **Highest per-seat** among self-serve segments |
| Onboarding complexity | High — real business data, existing channels, brownfield context |
| Support burden | High — real-world stakes raise every bar |
| Trust requirements | **Extreme** — "never touch my customers without me" (PRD §4) |
| Required integrations | Effectively required for credibility: email, socials, analytics — all post-MVP/future |
| Required worker capabilities | MVP three help, but they expect *operations*, not documents |
| Time to first value | Weeks — value they care about needs external channels |
| Sales-cycle difficulty | Harder reach; local/vertical channels |
| MVP scope impact | **Severe** — the integration-free MVP under-delivers for them |
| Expansion potential | Excellent LTV once integrations exist |

- **Advantages:** real money, real retention, the segment where "AI operating platform" ultimately wins.
- **Disadvantages:** the MVP (research/strategy/documents, zero external actions) is an appetizer for them; premature targeting would burn the segment on an underpowered first impression.
- **Risks:** reputation damage in a segment we'll want later.
- **PRD impact:** would force integrations into MVP, contradicting §18/§20.
- **Architecture impact:** connector framework becomes MVP-critical.
- **MVP impact:** breaks the current MVP definition.
- **Future flexibility:** high as a *second wave* target.

### Option D — Agencies and venture studios
Teams creating and operating multiple companies or client ventures.

| Criterion | Assessment |
|---|---|
| Problem urgency | Medium-high — efficiency economics |
| Willingness to pay | **Highest absolute** (multi-company, business expense) |
| Onboarding complexity | Medium — multi-company, multi-user from day one |
| Support burden | Medium — professional users, contractual expectations |
| Trust requirements | High + **compliance-shaped**: roles, client data isolation, audit exports |
| Required integrations | Client reporting, white-label pressure — not in MVP |
| Required worker capabilities | MVP three fit their research/strategy deliverables well |
| Time to first value | Days for research deliverables |
| Sales-cycle difficulty | Slower, relationship-driven |
| MVP scope impact | Forces full role matrix (§13) into MVP — currently owner+viewer only |
| Expansion potential | Strong; natural enterprise path |

- **Advantages:** best revenue per account; multi-company portfolio (PORT-002) is genuinely differentiating for them.
- **Disadvantages:** MVP ships owner+viewer only (ADMIN-003); no approval delegation (Approver role is post-MVP); client-facing exports are Phase 7. Serving them properly pulls three post-MVP items forward.
- **Risks:** contractual expectations (SLAs, DPAs) before NFR-003/011 exist.
- **PRD impact:** ADMIN-003 role expansion into MVP.
- **Architecture impact:** multi-user permission model complexity earlier.
- **MVP impact:** meaningful scope addition.
- **Future flexibility:** excellent later; expensive now.

## Recommendation
- **Recommended option:** **A — non-technical solo founders validating a digital business or SaaS idea.** Secondary future segment: **the multi-idea entrepreneur** (same product, multiple companies — already supported by PORT-002), with **existing small-business owners (C) as the second wave** once the first external capabilities ship.
- **Reason:** Option A is the only segment whose complete job-to-be-done equals the MVP loop exactly — *Idea → Interview → Understanding → Strategy options → Roadmap → Safe knowledge-work task → Useful document* is their entire early journey, with zero integrations, using precisely the three MVP workers. Every differentiator in §11 answers this segment's stated anxiety ("will it do something embarrassing or expensive without asking?"). B under-values the MVP, C and D structurally break it.
- **Stated disadvantages of the recommendation (owner should weigh):** price sensitivity caps early revenue; support burden is the highest of the four; honest validation kills ideas and therefore subscriptions; the segment's emotional attachment to ideas makes "your idea is weak" a churn event even when it's the product working correctly.
- **Important assumptions:** self-serve acquisition is viable at prosumer price points; research/document quality reaches "useful" reliably (WORK-002 rubric); the owner is not dependent on near-term revenue maximization (D/C monetize faster per account).
- **Reversal cost:** **Low.** The choice steers copy, interview tuning, and metric targets — not schema or infrastructure. Switching primary segment later is repositioning, not rework.
- **What remains possible later:** all other segments; C is explicitly staged as wave two; D unlocks when §13 roles ship.

## Owner response — ✅ Approved by owner

```text
Owner decision:
[x] Approve recommendation
[ ] Select another option
[x] Modify recommendation
[ ] Defer

Selected option: Option A — non-technical solo founders validating/planning a digital business,
                 SaaS product, or online service.
Owner notes: Secondary future segments ordered: (1) multi-idea entrepreneurs, (2) existing
             small-business owners, (3) agencies/venture studios. Do not design the MVP primarily
             for agencies, enterprises, or advanced engineering teams. Authoritative record:
             ../docs/decisions/ADR-001-primary-mvp-customer.md.
Decision date: 2026-07-18
```

> **Approved decision** = the block above and ADR-001. **Recommendation** (historical input) = the section preceding it. **Remaining future options:** segments B/C/D as later waves. **Known tension/risk:** price sensitivity, support burden, honest-validation churn — accepted knowingly (ADR-001 §10–§11).

---

# Decision 2 — D-03: Infrastructure model

## Why it matters
This is the highest-reversal-cost decision in the pack. Whether generated software runs on infrastructure we provision or the customer's accounts determines the platform's tenancy model, cost structure, abuse surface, secret architecture, and support posture. Even though software generation is post-MVP/future (BUILD/DEPLOY), the **foundations poured during architecture** (tenancy, credential vault, resource lifecycle) must anticipate the answer now.

## Options

### Option A — Fully platform-managed
The platform provisions and manages repositories, databases, hosting, domains, deployments, and operational services.

| Criterion | Assessment |
|---|---|
| Onboarding simplicity | **Best** — zero external accounts required |
| Development complexity | High but bounded — one stack, our rules |
| Operational burden | **Highest** — we run everyone's infrastructure |
| Security responsibility | Almost entirely ours |
| Portability | Weakest by default — must be engineered in (EXPORT-002) |
| Vendor lock-in | Highest perceived; mitigated only by real export |
| Support burden | High but uniform (one stack to debug) |
| Billing complexity | Simple for users (bundled), complex for us (cost attribution) |
| Failure recovery | Fully in our control — best-case recovery story |
| Customer trust | Split: convenience trusted, lock-in feared |
| MVP suitability | n/a directly (no generation in MVP) — but simplest foundation |
| Long-term suitability | Strong for the primary segment; limiting for technical/agency segments |

- **Advantages:** matches the verified reference-product behavior (managed provisioning was directly observed); simplest possible user experience for non-technical founders; full control of quality gates (BUILD-007), rollback, and health.
- **Disadvantages:** we carry hosting cost, abuse surface (generated apps can misbehave), and the lock-in narrative.
- **Risks:** orphaned-resource cost leaks (audit risk R-06 analog); abuse/compliance exposure of hosted content.
- **PRD impact:** none — BUILD/DEPLOY as written assume a managed default.
- **Architecture impact:** resource-lifecycle manager, per-company isolation, cost attribution from the start.
- **MVP impact:** none functional; foundations only.
- **Future flexibility:** can add customer-owned later (becomes Option C), at real cost.

### Option B — Customer-owned infrastructure
The customer connects their own GitHub, hosting, database, domain, and service accounts.

| Criterion | Assessment |
|---|---|
| Onboarding simplicity | **Worst** — non-technical founders must create 3–5 external accounts before value |
| Development complexity | High and unbounded — every provider quirk is ours to absorb |
| Operational burden | Lower hosting burden, higher integration-support burden |
| Security responsibility | Shared/unclear — their accounts, our automation; blast-radius questions |
| Portability | **Best** — it's theirs from day one |
| Vendor lock-in | Lowest |
| Support burden | **Highest** — heterogeneous failure modes we don't control |
| Billing complexity | Simple for us (no infra pass-through); confusing total cost for users |
| Failure recovery | Weakest — we can't fix what we don't control |
| Customer trust | Strong ownership story; weak reliability story |
| MVP suitability | Poor fit for the D-01 recommended segment |
| Long-term suitability | Necessary *option* for technical/agency/enterprise segments |

- **Advantages:** maximal alignment with principles 1/13 (ownership, portability); no hosting margin problem.
- **Disadvantages:** catastrophic onboarding friction for non-technical founders; our automation operating inside customer accounts raises the scariest permission questions (excessive-permission risk, PRD §23) precisely where we have least control.
- **Risks:** connector sprawl; support hell; unusable by the recommended primary segment.
- **PRD impact:** would rewrite BUILD/DEPLOY and INTEG requirements substantially.
- **Architecture impact:** OAuth/permission architecture becomes the core platform earlier.
- **MVP impact:** none directly, but forces connector-framework foundations now.
- **Future flexibility:** high, but you can't easily *add* a managed offering later without building Option A anyway.

### Option C — Hybrid
Platform-managed defaults; advanced users can connect or transfer to their own infrastructure.

| Criterion | Assessment |
|---|---|
| Onboarding simplicity | Same as A for the default path |
| Development complexity | **Highest eventually** — both models must work |
| Operational burden | A's burden now, plus transfer tooling later |
| Security responsibility | Clear in managed mode; contractual clarity needed for transfers |
| Portability | Strong story: managed convenience + real exit |
| Vendor lock-in | Neutralized as a narrative if transfer is real |
| Support burden | A's now; grows with transfer options |
| Billing complexity | Manageable if transfer is coarse-grained (whole-company) |
| Failure recovery | A's in managed mode |
| Customer trust | **Best combined story** — convenience without hostage-taking |
| MVP suitability | Identical to A (only the managed default exists early) |
| Long-term suitability | **Best** — serves all four segments eventually |

- **Advantages:** sequencing rather than compromise — build A's machinery first, add transfer/BYO-infra when segments demand it; the ownership principle is honored through export (BUILD-003, EXPORT-001/002) before transfer tooling exists.
- **Disadvantages:** "hybrid" is a roadmap word — undisciplined messaging could promise transfers before they exist (violating the no-fake-capability rule, PRD §6 #14/#15).
- **Risks:** scope creep if "hybrid" is interpreted as building both modes concurrently; marketing overreach.
- **PRD impact:** none now — matches D-03's recommended default in `OWNER-DECISIONS.md`.
- **Architecture impact:** same foundations as A, plus two cheap insurance policies: artifact/manifest formats designed for eventual transfer (EXPORT-002), and no architectural assumption that a company's resources are *permanently* platform-resident.
- **MVP impact:** none.
- **Future flexibility:** maximal.

## Recommendation
- **Recommended option:** **C — hybrid product direction, with platform-managed defaults implemented first.** Preserve source-code export (BUILD-003, already parity) and design artifact formats for later transfer; **do not promise complete infrastructure portability in MVP.**
- **The four layers, explicitly distinguished:**
  - **Long-term product direction:** hybrid — managed by default, transferable by choice.
  - **Actual MVP capability:** neither — MVP performs no software generation at all; the decision shapes *foundations only*.
  - **Marketing promise (allowed now):** "your code and data are exportable" (BUILD-003/EXPORT-001 scope). **Not allowed now:** "runs on your infrastructure," "one-click migration," or any transfer claim until the capability exists.
  - **Future migration support:** EXPORT-002 manifest + (later) whole-company transfer tooling; scope and timing owned by D-07.
- **Reason:** A alone maximizes lock-in perception against principles 1/13; B alone is unusable by the recommended primary segment; C sequences A's simplicity now with B's freedom later, and its MVP-era cost is nearly zero because generation itself is post-MVP.
- **Important assumptions:** D-01 lands on a non-technical-leaning segment; managed hosting unit economics are viable (feeds D-02); export is a sufficient ownership story until transfer ships.
- **Reversal cost:** **High.** Tenancy, credential, and resource-lifecycle foundations follow from this choice; flipping to customer-owned-primary after building managed foundations is a rebuild of the platform's operational core. This is the decision to get right.
- **What remains possible later:** BYO-infrastructure connectors; whole-company transfer; even a self-hosted edition — nothing is foreclosed by managed-first foundations *if* the transfer-aware design notes above are honored.

## Owner response — ✅ Approved by owner

```text
Owner decision:
[x] Approve recommendation
[ ] Select another option
[ ] Modify recommendation
[ ] Defer

Selected option: Option C — hybrid long-term direction, platform-managed defaults implemented first.
Owner notes: Export of source code, documents, and customer data is mandatory. Marketing
             prohibitions binding: no one-click migration, complete DB migration, automatic
             account transfer, provider-independent deployment, or guaranteed-portability claims.
             Authoritative record: ../docs/decisions/ADR-002-infrastructure-ownership-model.md.
Decision date: 2026-07-18
```

> **Approved decision** = the block above and ADR-002. **Recommendation** (historical input) = preceding section. **Remaining future options:** customer-owned connections, whole-company transfer, incremental portability expansion. **Known tension/risk:** the temporary managed-defaults-vs-complete-portability gap is **formally recorded** (ADR-002 §11) and accepted for MVP.

---

# Decision 3 — D-04: AI key ownership

## Why it matters
Determines who pays model providers, who absorbs cost volatility, how usage is metered and limited (NFR-015, USAGE-001), the privacy story ("whose account sees my business idea?"), and the credential architecture. It must be settled before architecture because metering, limits, and the provider gateway (OQ-19) are MVP-critical path.

## Options

### Option A — Platform-managed AI keys
The platform pays providers and charges customers via subscription/usage.

| Criterion | Assessment |
|---|---|
| Onboarding friction | **None** — sign up and go |
| Cost predictability (user) | High — they see plan/credits, not tokens |
| Gross margin | Ours to manage; AI spend is on our margin — controls are existential |
| Abuse risk | Ours — free-tier/runaway abuse hits our bill (NFR-015 hard caps) |
| Usage metering | Fully in our control — one metering point |
| Support burden | Low — no key troubleshooting |
| Provider outages | Ours to absorb and communicate (NFR-019) |
| Privacy perception | Weaker — customer content transits our provider account; must be disclosed |
| Enterprise suitability | Limited — enterprises often demand their own keys/agreements |
| Credential security | Simplest — few platform keys in our vault (NFR-018) |
| Billing complexity | Moderate — usage → credits/plans mapping (D-02) |
| MVP suitability | **Best** |

- **Advantages:** uniform model quality and safety config; single metering/limit point; onboarding untouched; consistent output quality for the segment least able to debug model differences.
- **Disadvantages:** cost risk concentrates on us; requires the full control set below *before launch*, not after.
- **Risks:** margin erosion; abuse; a provider price change repricing our unit economics overnight.
- **PRD impact:** none — NFR-015/USAGE-001 already assume platform metering.
- **Architecture impact:** metering, caps, and abuse controls in the MVP critical path.
- **MVP impact:** none beyond already-specified controls.
- **Future flexibility:** BYOK can be added later cleanly *if* the gateway abstracts key origin from day one.

### Option B — BYOK only
Customers must connect their own model-provider account and key.

| Criterion | Assessment |
|---|---|
| Onboarding friction | **Fatal for the primary segment** — non-technical founders creating provider accounts, payment methods, and API keys before first value |
| Cost predictability (user) | Poor — raw token billing confusion |
| Gross margin | Clean (no AI cost) but caps our pricing power |
| Abuse risk | Shifted to customers (their bill), new failure mode: their key gets rate-limited/suspended |
| Usage metering | Still required for product features, now against keys we don't control |
| Support burden | **High** — "your key is invalid/out of quota/wrong tier" tickets |
| Provider outages | Customer-visible chaos across heterogeneous accounts |
| Privacy perception | **Best** — their account, their data path |
| Enterprise suitability | Strong |
| Credential security | Hardest — many customer keys in our vault (INTEG-002 discipline per customer) |
| Billing complexity | Simple for us; opaque for users |
| MVP suitability | Poor |

- **Advantages:** zero AI cost exposure; strongest privacy story; enterprise-friendly.
- **Disadvantages:** onboarding friction directly contradicts the D-01 recommended segment; output quality varies with whatever model tier the customer's key can access — breaking the consistency our workers' quality bars (WORK-002 rubric) depend on.
- **Risks:** first-session abandonment; quality variance blamed on us.
- **PRD impact:** settings/onboarding requirements would grow; quality rubrics need per-model calibration.
- **Architecture impact:** customer-key vault becomes MVP-critical.
- **MVP impact:** meaningful added scope + friction.
- **Future flexibility:** adding platform keys later means absorbing cost mid-flight with no metering muscle built.

### Option C — Hybrid
Platform-managed by default; optional BYOK for advanced/enterprise users.

| Criterion | Assessment |
|---|---|
| MVP suitability | Equals A *if* BYOK is deferred; equals "build two systems" if not |
| All other criteria | A's profile at launch; B's optionality later |

- **Advantages:** the correct end-state; the only question is timing.
- **Disadvantages:** building both paths in MVP doubles credential, metering, and support surface for users who don't exist yet.
- **Risks:** premature generalization.
- **PRD/Architecture/MVP impact:** identical to A now, provided the gateway (OQ-19) treats key origin as a configuration concern.
- **Future flexibility:** maximal.

## Recommendation
- **Recommended option:** **A for MVP, C as product direction** — platform-managed AI keys with strict metering, limits, and spend alerts; optional BYOK later (matching `OWNER-DECISIONS.md` D-04 default).
- **Controls required BEFORE this can be approved for launch** (all already in the PRD; listed here as the explicit approval condition):
  1. Per-company usage ledger — USAGE-001 (MVP)
  2. Budget limits — POL-001 (MVP)
  3. Rate limits — NFR-010 baseline + POL-002 semantics at the gateway
  4. Model-call audit metadata — TOOL-002 (MVP)
  5. Cost estimation — TASK-004 preflight, USAGE-002 (preview in MVP preflight; forecast post-MVP)
  6. Hard usage caps — NFR-015 (MVP; overrun ≤1 billing increment)
  7. Abuse protection — NFR-010/NFR-015 + signup friction controls (architecture detail)
  8. Provider-failure handling — NFR-019 (MVP: queue + honest status)
  9. Secret isolation — NFR-018 (MVP: managed store, reference-only)
  10. No keys exposed to the browser — NFR-018 negative tests (MVP launch gate 12)
- **Reason:** Only A preserves the frictionless onboarding the D-01 segment requires and the output-quality consistency the workers' acceptance criteria assume; every A-specific risk already has a named PRD control. B's virtues (privacy, enterprise) matter for segments explicitly staged later.
- **Important assumptions:** unit economics close at prosumer pricing with caps (validated during alpha, feeds D-02); disclosure of the platform-key data path satisfies the target segment (see Conflicts, below).
- **Reversal cost:** **Medium.** Adding BYOK later is contained *if* the gateway abstracts key origin now (a stated OQ-19 gateway requirement). Removing platform keys entirely (→ B) later would be a pricing-model rupture — unlikely and costly.
- **What remains possible later:** BYOK tier; enterprise key agreements; per-company model selection.

## Owner response — ✅ Approved by owner

```text
Owner decision:
[x] Approve recommendation
[ ] Select another option
[x] Modify recommendation
[ ] Defer

Selected option: Option A for MVP (hybrid as long-term direction).
Owner notes: Pre-beta control list expanded to 16 items — adds per-account usage recording,
             budget alerts, abuse detection, provider timeout handling, and clear AI data-path
             disclosure to the 10 originally listed. BYOK is post-MVP and excluded from the first
             implementation unless a later approved decision changes scope. Authoritative record:
             ../docs/decisions/ADR-003-ai-key-ownership.md.
Decision date: 2026-07-18
```

> **Approved decision** = the block above and ADR-003. **Recommendation** (historical input) = preceding section. **Remaining future options:** BYOK tier, enterprise agreements, per-company model choice. **Known tension/risk:** platform-key data path requires in-product disclosure before beta (consistency review flag 2 — condition carried into ADR-003 §16).

---

# Decision 4 — OQ-19: Model-provider strategy

## Why it matters
Every worker, the interview engine, and strategy generation sit on model calls. The provider strategy decides implementation complexity, outage behavior (NFR-019), output consistency, and how portable our prompts and structured outputs are. It also decides whether D-04's "add BYOK later" stays cheap.

**Clarification up front:** "provider-neutral gateway" here means **an internal contract and abstraction layer** — one internal interface our code calls, with providers as configuration behind it. It does **not** mean building a dynamic AI-routing platform, a marketplace, or per-call price arbitrage.

## Options

### Option A — One provider, one model
| Criterion | Assessment |
|---|---|
| Implementation complexity | **Lowest** |
| Reliability | Worst — provider outage = platform outage (violates NFR-019) |
| Output consistency | Best |
| Cost control | Simple but hostage to one price list |
| Testing burden | Lowest |
| Observability | Simple |
| Prompt portability | None engineered — migration later is a rewrite |
| Structured-output compatibility | Single dialect, deeply coupled |
| Provider lock-in | **Total** — conflicts with NFR-019's "no hardwired single vendor" |
| Failure recovery | Queue-and-wait only |
| MVP suitability | Fast but fails a stated MVP NFR |

### Option B — One provider, several models
Different models for planning, extraction, generation — same vendor.

| Criterion | Assessment |
|---|---|
| Implementation complexity | Low-moderate |
| Reliability | Same single-vendor failure domain as A |
| Output consistency | Good per task type |
| Cost control | Better (cheap models for cheap work) |
| Testing burden | Moderate (per-model prompt suites) |
| Prompt portability / lock-in | Same structural lock-in as A |
| MVP suitability | Better economics than A, same NFR-019 failure |

### Option C — Provider-neutral gateway; one primary + one fallback
One internal interface; one main model for quality-bearing work; one fallback (different provider) for outages and selected workloads.

| Criterion | Assessment |
|---|---|
| Implementation complexity | Moderate — one interface + two adapters; well-trodden pattern |
| Reliability | **Meets NFR-019** — outage degrades to fallback or honest queueing |
| Output consistency | High — primary model does quality-bearing work; fallback scoped |
| Cost control | Good — model choice per task type is configuration |
| Testing burden | Moderate — golden suites against primary; smoke suites against fallback |
| Observability | Centralized at the gateway (usage, cost, latency, errors in one place) |
| Prompt portability | Engineered-in from day one |
| Structured-output compatibility | Normalized at the gateway (schema-first, provider adapters) |
| Provider lock-in | Low |
| Failure recovery | Fallback eligibility rules + queue + honest status |
| MVP suitability | **Best** — modest cost, satisfies NFR-019, keeps D-04's BYOK door open |

### Option D — Full dynamic multi-provider routing
Routing by price, quality, latency, workload, availability.

| Criterion | Assessment |
|---|---|
| Implementation complexity | **Highest** — a product in itself |
| Reliability | Theoretically best, practically a new failure surface |
| Output consistency | **Worst** — same task, different model, different voice; quality bars become moving targets |
| Cost control | Optimal in theory; opaque in practice |
| Testing burden | Explodes (N providers × M models × task types) |
| Prompt portability | Forced, at high engineering cost |
| MVP suitability | Poor — premature optimization; §20-adjacent overbuild |

## Recommendation
- **Recommended option:** **C — provider-neutral internal gateway; configure exactly one primary model and one fallback for MVP; no dynamic cost/quality routing.**
- **Minimum gateway requirements (the internal contract):**
  1. Model-call request schema (task type, prompt/messages, schema reference, budget, company context)
  2. Structured-output support (schema-validated responses, provider-dialect adapters)
  3. Timeout per call class
  4. Retry policy (bounded, idempotent-safe, per NFR-007)
  5. Fallback eligibility (which task types may fall back; quality-bearing generation may prefer queueing over fallback)
  6. Usage recording (per company/task/tool — USAGE-001)
  7. Cost recording (per call, reconciled to provider billing — NFR-015)
  8. Redacted logging (no prompts-with-secrets, no personal data — NFR-009/NFR-018)
  9. Provider error normalization (one internal error taxonomy)
  10. Model-version tracking (every artifact records the model+version that produced it)
  11. Company-level policy hooks (caps, model tier per plan — POL-001/NFR-015)
  12. No secrets returned to clients (keys never leave the server boundary — NFR-018)
- **Reason:** C is the cheapest option that satisfies NFR-019, preserves D-04's future BYOK (key origin = gateway configuration), and keeps output consistency by concentrating quality-bearing work on one primary model. A/B fail a stated NFR; D is scope §20 warns against.
- **Important assumptions:** two adapters are affordable in MVP (they are — the gateway is ~the same work as calling one provider properly); fallback quality is acceptable for its scoped workloads.
- **Reversal cost:** **Low, because the gateway is itself the hedge.** Swapping primary model/provider is configuration + regression suite. (Without the gateway — i.e., choosing A/B — later reversal is High: prompts, schemas, and error handling all rewritten. That asymmetry is the argument.)
- **What remains possible later:** additional providers/models per task type; BYOK (D-04); dynamic routing (D) if scale ever justifies it — all as gateway configuration/extension, not rewrites.

## Owner response — ✅ Approved by owner

```text
Owner decision:
[x] Approve recommendation
[ ] Select another option
[ ] Modify recommendation
[ ] Defer

Selected option: Option C — provider-neutral internal gateway; one primary model + one fallback;
                 fallback only for approved failure conditions or explicitly supported task
                 classes; no dynamic price/quality/latency routing.
Owner notes: Gateway is an internal architectural boundary, not a separate commercial product.
             No provider-specific behavior throughout product code. 13 gateway capabilities
             approved as the internal contract. Authoritative record:
             ../docs/decisions/ADR-004-model-provider-strategy.md.
Decision date: 2026-07-18
```

> **Approved decision** = the block above and ADR-004. **Recommendation** (historical input) = preceding section. **Remaining future options:** more providers/models per task type, dynamic routing if ever justified. **Known tension/risk:** none — the recorded OQ-19/NFR-019 non-conflict stands.

---

# Review of remaining decisions (D-02, D-05–D-10)

| ID | Decision | Classification | Settle now? |
|---|---|---|---|
| D-02 | Commercial model (price, credits vs usage) | **Blocks a later MVP phase** (Phase 7 billing build) | No — but note: the MVP ledger (BILL-002/USAGE-001) is deliberately mechanism-agnostic (append-only ledger supports credits, usage, or hybrid), so postponing causes no architecture rework. Decide after alpha cost data. |
| D-05 | First external action | **Blocks a later phase** (post-MVP connector wave) | No — the connector framework's *first instance* choice; framework design is generic regardless. Decide end of Phase 6. |
| D-06 | Initial approval model | **Blocks a later MVP phase** (Phase 6), default already fully specified in PRD §11.5/§18 | No — proceeding on the PRD default (levels 1–2, full mechanics) is safe; D-06 is a confirmation gate, not an open design question. |
| D-07 | Ownership/export promise strength | **Branding/commercial** + Future (EXPORT-002 scope) | No — EXPORT-001 is already committed at beta; only the *strength of the public promise* is open. Terms language needed before beta. |
| D-08 | Initial market and region | Mostly **non-blocking until beta** — **EXCEPT the data-residency aspect** | **Partially.** Flag: if the owner is likely to launch in a strict-residency jurisdiction (e.g., EU), architecture should know *now* — retrofitting data residency is expensive (High reversal). Recommended: owner answers one narrow question now — "is an EU/strict-residency launch plausible for beta?" — and defers the rest of D-08. |
| D-09 | Branding and final name | **Branding decision** | No — needed before beta only. Naming must not reference Halo Suite, Systevo, or Polsia. |
| D-10 | Existing-business path in MVP | **Blocks a later MVP phase** (Phase 2 interview build), cheap default specified | No — the PRD default (entry point + brownfield interview logic, greenfield-optimized) is low-cost; confirm during Phase 2. |

**Other decisions promoted to blocking?** None. The only new architecture-relevant item found is the **D-08 residency sub-question** flagged above — it is *not* promoted to a full blocker; it is one narrow yes/no the owner can answer alongside the four blockers.

---

# Consistency review

Each recommendation checked against the PRD's binding constraints:

| Constraint | D-01 (A) | D-03 (C) | D-04 (A→C) | OQ-19 (C) |
|---|---|---|---|---|
| MVP operating loop (§18) | ✔ exact fit | ✔ no MVP change | ✔ no friction added | ✔ powers the loop |
| MVP non-goals (§20) | ✔ | ✔ (no infra work pulled forward) | ✔ | ✔ (D would approach §20 overbuild; C avoids) |
| Better-than-Polsia requirements (§11) | ✔ segment matches the trust thesis | ✔ | ✔ | ✔ |
| Approval requirements (APPR) | ✔ | ✔ | ✔ | ✔ (gateway sits behind TOOL-003 policy gate) |
| Tenant isolation (NFR-001) | ✔ | ✔ (managed default keeps isolation in one place) | ✔ | ✔ (company context in call schema) |
| Usage accounting (USAGE-001/NFR-015) | ✔ | ✔ | ✔ required controls named | ✔ gateway is the metering point |
| Portability principles (#13, NFR-014) | ✔ | ⚠ **Tension flagged — see below** | ✔ | ✔ (prompt portability engineered) |
| Client ownership (#1) | ✔ | ⚠ same flag | ⚠ **Disclosure flag — see below** | ✔ |
| No hidden actions (#15) | ✔ | ✔ | ✔ | ✔ |

**Flagged tensions (not silently resolved — owner should see these):**

1. **D-03 vs portability/ownership principles.** Managed-first infrastructure means that at MVP+1 (when generation ships), a customer's running product lives on our infrastructure with *export* but not yet *transfer*. That is a real, temporary gap between principle 13's ideal and shipped capability. Mitigation already in the recommendation: honest marketing boundaries (no portability claims beyond export) and transfer-aware artifact design. **Residual risk:** trust-sensitive customers may read managed-only as lock-in regardless of disclosure. The owner accepts this tension by approving D-03-C, or removes it by choosing B at severe onboarding cost.
2. **D-04 vs client-ownership/privacy expectations.** Platform-managed keys route customer business content through our provider account. No PRD requirement is violated, but principle 1's *spirit* requires explicit disclosure in-product (data-path statement) and in terms. Recommendation adds this as a condition: **disclosure copy is required before D-04 approval is exercised in beta.** BYOK later restores the stronger privacy posture for those who want it.
3. **No conflict found** between OQ-19's "one primary model" and NFR-019's "no hardwired single vendor": the NFR constrains *architecture* (configurable provider), not *configuration* (one primary at a time). Recorded here to preempt misreading.

---

# Verification

| Check | Result |
|---|---|
| Decisions reviewed | 11 (D-01…D-10 + OQ-19) |
| Blocking architecture | 4 (D-01, D-03, D-04, OQ-19) + 1 narrow flag (D-08 residency sub-question) |
| Blocking later phases | 4 (D-02, D-05, D-06, D-10) |
| Non-blocking / branding / future | 3 (D-07, D-08 remainder, D-09) |
| Recommendations created | 4 full option-analyses + 7 classifications |
| Owner-response sections | 4 in this pack + consolidated response area in `OWNER-DECISIONS.md` — **all empty** |
| Conflicts found | 2 tensions flagged (D-03 portability gap; D-04 disclosure condition) + 1 non-conflict recorded (OQ-19 vs NFR-019) |
| Decisions marked approved | **None** |
| Application/architecture code created | **None** |
