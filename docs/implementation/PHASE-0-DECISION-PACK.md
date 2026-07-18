# Phase 0 Decision Pack

**Date:** 2026-07-18 · **Status:** Executed — 9 of 10 decision tickets resolved; 1 blocked pending owner selection.
**Owner approval recorded:** roadmap, milestone plan, first wave, and 101-ticket backlog approved 2026-07-18, with the conditional DoR split review on ACBP-P5-001/P5-003/P6-001/P6-007 (recorded in IMPLEMENTATION-ROADMAP-v1.md §Document control and in those tickets' DoR fields).
**Records:** configuration decisions → `config-decisions/CDR-001…009`. **No new ADRs were needed** — none of the ten decisions materially alters or extends accepted architecture; all select configurations inside ADR-008/019/020/021/022 boundaries. Verification of exact model identifiers used public provider documentation only (no provider accounts accessed).

Outcome legend: per task Part 2 (Approved / Approved with conditions / Deferred / Rejected / Still requires owner decision).

---

## ACBP-P0-001 — Decide pinned primary and fallback model identifiers

**Identity:** Source IOQ-01/AOQ-18 · Blocks Phase 2 · Dependents: P2-003/005/008, P3-001 · Reqs: NFR-019 · ADRs: ADR-019.
**Decision needed:** exact API identifiers for the two accepted families (GPT-5.1 primary, Claude Sonnet 4 fallback), pinned or versioned where supported.

| Option | Key trade-offs (security/reliability/DX/ops/lock-in/cost/portability/testing/reversal) |
|---|---|
| A. Dateless aliases only (`gpt-5.1` + family alias) | Simplest DX; **reliability risk:** alias drift changes behavior silently — violates ADR-019 §8a pin requirement; reversal trivial but reproducibility broken |
| B. Dated/pinned snapshots for both | Reproducible evals; deprecation risk documented; slight ops burden tracking snapshot lifecycle; reversal = config change (Low) |
| C. Defer both pins to gateway implementation | Unblocks nothing (P2-003 stays pending); no benefit over B-with-safeguard |

**Public verification performed (docs only):** OpenAI publishes GPT-5.1 as an API model with snapshot support ([model page](https://platform.openai.com/docs/models/gpt-5.1)); Anthropic's model-ID docs list the Sonnet 4 family with **`claude-sonnet-4-6`** as a canonical dateless ID that maps to a single fixed snapshot ([model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions)). Both families support structured outputs and tool calling per their docs; context/output limits documented on the model pages. Exact **dated** GPT-5.1 snapshot strings are account-catalog data and were **not** guessed.

**Recommendation → Option B via CDR-001:** primary **`gpt-5.1`** with the **dated snapshot read from the account catalog and pinned at gateway implementation (P2-003), before any production call**; fallback **`claude-sonnet-4-6`** (already pinned-by-ID per Anthropic's versioning semantics). Assumptions: account access to both at implementation. Risks: GPT-5.1 snapshot deprecation (trigger below). Safeguards: pin-before-production is a P2-003 acceptance criterion; both-model prompt/schema tests (ADR-019); structured-output smoke test on both at gateway bring-up. Review trigger: deprecation notice, eval regression, ADR-019 triggers. Record: **CDR** (configuration, not architecture).
**Owner outcome:** **Approved with conditions** — follows directly from accepted ADR-019 (families owner-selected); only the pin mechanics were open; dated-primary-pin condition binding. Ticket → **DONE**.

## ACBP-P0-002 — Decide model evaluation dataset and thresholds

**Identity:** IOQ-02/AOQ-19 · Blocks P2-011/P3-006/P7-012 · Reqs: NFR-019, DISC-001, STRAT-001 · ADRs: ADR-019.
**Decision needed:** reproducible eval dataset construction + measurable gates for the 10 ADR-019 areas.

| Option | Trade-offs |
|---|---|
| A. Public benchmarks | Reproducible but poor fit — none test adaptive founder interviews or 16-field option distinctness |
| B. Purpose-built dataset from PRD journeys + audit-derived scenarios, thresholds calibrated from a recorded baseline run | Fits exactly; reproducible (versioned dataset + pinned models + fixed rubric); initial authoring cost M; reversal Low |
| C. Human-review only | Not reproducible; violates the ticket boundary |

**Recommendation → Option B via CDR-002.** Metric structure per area: **hard release threshold** (blocks beta gate), **warning threshold** (investigate), **comparative benchmark** (primary vs fallback per area), **human-review sample** (fixed-size stratified sample per release run). Initial hard gates (calibrated after baseline, never loosened silently): structured-output validity ≥98%; adaptive-question quality rubric ≥4/5 on ≥80% of scripted sessions; fact-vs-assumption classification ≥95% on labeled set; contradiction detection ≥80% seeded-pair catch; strategy distinctness: 100% rejection of seeded near-duplicates + ≥90% rubric-distinct triples; citation preservation ≥95%; revision consistency rubric ≥4/5 on ≥80%; refusal correctness 100% on the unsafe-request set; latency p90 within NFR-004-derived class budgets; cost within per-task-class budget envelope. Safeguard: thresholds live in the versioned eval config; changes require CDR amendment. Review trigger: baseline run (may tighten), model re-pin, eval-area failure.
**Owner outcome:** **Approved with conditions** (calibration step explicit; thresholds recorded, reproducible). Ticket → **DONE**.

## ACBP-P0-003 — Decide Render production region

**Identity:** IOQ-03/AOQ-20 · Blocks staging setup + P7-006 · Reqs: NFR-011 · ADRs: ADR-020, ADR-005.
**Decision needed:** one production region for beta with ADR-005 documentation duties.

| Option | Trade-offs |
|---|---|
| A. US-East-class region (Virginia/Ohio) | Lowest latency to both model providers' US endpoints; mainstream backup support; no residency implication (none promised); reversal = documented migration (Medium-High) |
| B. US-West-class (Oregon) | Comparable; marginally different provider latency; no advantage identified |
| C. EU region (Frankfurt) | Only justified if D-08 lands on EU market — would still not constitute a residency promise (ADR-005) |
| D. Wait for D-08 remainder | Blocks staging creation and P7-006 — cost exceeds benefit given ADR-005 explicitly permits a non-promising default |

**Recommendation → Option A via CDR-003:** default **US-East-class Render region**, selected for model-provider connectivity, chosen concretely from Render's current region list at staging creation (Virginia preferred, Ohio acceptable). Data-location + subprocessor register updated at provisioning. **Explicitly not a residency guarantee.** Review trigger: **D-08 remainder decision** — if the owner selects a market where another region is clearly better, migrate before beta (cheapest moment).
**Owner outcome:** **Approved with conditions** — interim default inside accepted ADR-005/020 boundaries; reversible; no product/commercial change; D-08 review trigger binding. Ticket → **DONE**.

## ACBP-P0-004 — Decide Render service plans

**Identity:** IOQ-04/AOQ-21 · Blocks P7-006 sizing · Reqs: NFR-003/017 · ADRs: ADR-020.
**Decision needed:** plan selection criteria + provisional tiers for api, worker, PostgreSQL, staging + production.

| Option | Trade-offs |
|---|---|
| A. Name exact current SKUs now | Render's plan lineup changes; naming SKUs from memory risks staleness — violates verify-or-pending discipline |
| B. Binding selection criteria + provisional tier class, exact SKU confirmed against the live catalog at provisioning | Honest; reversal trivial (upgrades are online); tiny deferral cost |
| C. Oversize for safety | Burns cost with zero evidence |

**Recommendation → Option B via CDR-004.** Binding criteria: production api + worker on the smallest **paid, always-on** instance class with autoscaling headroom; production PostgreSQL on the smallest tier providing **automated daily backups + point-in-time recovery + ≥50 usable connections** (job runner + RLS session model sized within pool limits); staging = smallest paid tiers, prod-shaped; **restore drill (P7-006) validates NFR-017 on the chosen plan before beta**. Exact SKUs recorded as a CDR-004 addendum at provisioning. Review triggers: ADR-008 capacity triggers; NFR-003 misses; connection pressure.
**Owner outcome:** **Approved with conditions.** Ticket → **DONE**.

## ACBP-P0-005 — Decide object-storage provider

**Identity:** IOQ-05/AOQ-03 · Blocks P5-011, P7-001 (latest safe point: before P5-011) · Reqs: NFR-014 · ADRs: ADR-016.
**Decision needed:** which S3-compatible provider holds artifact content.

| Option | Trade-offs |
|---|---|
| A. Cloudflare R2 | S3-compatible; zero egress fees (export-friendly — aligns with EXPORT-001 economics); new vendor/subprocessor; strong DX; reversal Low (S3 contract) |
| B. AWS S3 | Most mature; egress costs penalize exports; heavier account surface for one service; reversal Low |
| C. Backblaze B2 | Cheapest storage; smaller ecosystem; reversal Low |

**Recommendation:** **Option A (Cloudflare R2)** — export-aligned economics and the portable S3 contract already required by ADR-016. **However:** this adds a **new external vendor/subprocessor and commercial relationship**, and the owner explicitly kept this selection separate at the 2026-07-18 architecture review. Under the decision boundaries (no new commercial commitment without owner), this is **not** eligible for a self-approved configuration default.
**Owner outcome:** **Still requires owner decision.** Ticket → **BLOCKED** (analysis complete; recommendation ready; one selection needed before P5-011). No CDR issued.

## ACBP-P0-006 — Decide Infisical machine-identity method

**Identity:** IOQ-06/AOQ-22 · Blocks P0-015/P0-019 · Reqs: NFR-018, INTEG-002 · ADRs: ADR-021.
**Decision needed:** machine-auth mechanism per process/environment (web, worker, local dev, CI, staging, production).

| Option | Trade-offs |
|---|---|
| A. One shared machine identity | Violates least privilege (rejected in IOQ-06 already) |
| B. Per-process **machine identities (Universal-Auth-class client credentials)** per environment; local dev = personal dev identities on the dev scope; CI = dedicated short-lived identity scoped to test paths | Least privilege; rotation/revocation native; bootstrap = identity credentials in the minimal env-var set; reversal Low |
| C. OIDC-federated identities for CI/Render where supported | Best (no static credential) — adopt **where supported** as an enhancement inside B |

**Recommendation → B (+C where supported) via CDR-005.** Required: separate dev/test/staging/prod scopes; api identity reads api paths only, worker identity reads worker paths only (gateway keys live on worker paths; billing keys on api paths — per ADR-014 per-component grants); rotation via dual validity; revocation tested; **no long-lived secret in code**; outage behavior per ADR-021 §13 (fail closed + bounded cache grace); bootstrap documented in config README at P0-015. Review trigger: Infisical auth-method catalog changes; any credential incident.
**Owner outcome:** **Approved** (pure implementation of accepted ADR-021 §18 recommendation). Ticket → **DONE**.

## ACBP-P0-007 — Decide Clerk social-login methods

**Identity:** IOQ-07/AOQ-23 · Blocks P1-001 UI · Reqs: ACC-001 · ADRs: ADR-022, ADR-001.
**Decision needed:** initial sign-in methods for non-technical solo founders.

| Option | Trade-offs |
|---|---|
| A. Email/password only | Lowest surface; more friction for the segment |
| B. **Email/password + Google** | Covers the dominant consumer identity for the segment; one social provider = minimal review surface; reversal trivial (additive) |
| C. Broad social set (Google/Apple/Microsoft/LinkedIn) | Config + test surface without evidence of need |

**Recommendation → B via CDR-006.** Email verification **required** before autonomous features regardless of method (ACC-001 acceptance). More providers post-beta, driven by signup-abandonment data. Safeguard: social identities still flow through internal user mapping (ADR-022) — no authorization implications. Review trigger: beta signup funnel data.
**Owner outcome:** **Approved with conditions** (reversible, additive, no security weakening). Ticket → **DONE**.

## ACBP-P0-008 — Decide Clerk webhook sync and replay strategy

**Identity:** IOQ-08/AOQ-24 · Blocks P1-002 · Reqs: ACC-002, NFR-002 · ADRs: ADR-022.
**Decision needed:** events consumed, verification, idempotency, ordering, replay, reconciliation, deletion sync.

| Option | Trade-offs |
|---|---|
| A. Webhooks as ordered event stream (apply deltas) | Breaks under out-of-order delivery — rejected |
| B. **Webhooks as convergence triggers: signature-verified, event-id-deduped, full-object upsert guarded by source `updated_at`; nightly reconciliation sweep; replay-safe by construction** | Correct under duplication + reordering; slightly more fetch traffic; testing straightforward (replay harness); reversal Low |
| C. Poll-only sync | Latency + waste; no advantage |

**Recommendation → B via CDR-007.** Consumed events: user created/updated/deleted, organization + membership created/updated/deleted, session-revocation class events. Signature verification mandatory (reject unsigned/invalid). Idempotency: processed-event-id table. Out-of-order: last-write-wins on provider `updated_at`, never on arrival order. Replay: full redelivery converges (test-enforced, trust-critical). Reconciliation: nightly diff of Clerk state vs internal mappings with drift alert. **Deletion sync:** Clerk deletion events **initiate** the internal ACC-005-governed flow — platform retention rules govern; IdP state never silently deletes platform data. Review trigger: drift incidents; Clerk webhook contract changes.
**Owner outcome:** **Approved** (implements accepted ADR-022 §13). Ticket → **DONE**.

## ACBP-P0-009 — Decide interim usage caps and rate limits

**Identity:** IOQ-09 (part) · Blocks P6-010 values; structure used from P2 · Reqs: NFR-015, POL-001 · ADRs: ADR-003, ADR-013.
**Decision needed:** interim technical values only — **not pricing** (D-02 untouched).

| Option | Trade-offs |
|---|---|
| A. No caps until alpha data | Violates ADR-003 pre-beta control list; unbounded cost risk |
| B. **Conservative interim caps with named revisit trigger** | Safe; may occasionally block heavy legitimate use in alpha (acceptable; visible + overridable by operator) |
| C. Generous caps | Weakens the control's purpose |

**Recommendation → B via CDR-008.** Separated per the required taxonomy — technical request limits (per-session API rate ceiling); model-call limits (per-company per-day call + token ceilings); worker-execution limits (concurrent runs per company: low single digits; per-run budget from IOQ-12 at P5-004); commercial entitlements (**explicitly not set — D-02**); abuse thresholds (velocity/entropy anomaly → soft-lock + review); hard cost caps (per-company daily + monthly platform-spend ceilings, ≤1 increment overrun per NFR-015); warning thresholds (75% of any hard cap → `usage.limit_reached` soft alert). Interim numeric values recorded in CDR-008 as configuration with a **mandatory revisit at first alpha telemetry review**. Review trigger: alpha data; any cost anomaly.
**Owner outcome:** **Approved with conditions** (interim, technical, revisit-bound; no pricing decided). Ticket → **DONE**.

## ACBP-P0-010 — Decide retention and backup/recovery objectives

**Identity:** IOQ-10 · Blocks P7-001/002/005/006 · Reqs: NFR-016/017/008 · ADRs: ADR-015, ADR-020, ADR-005.
**Decision needed:** implementation defaults for retention per data class + RPO/RTO/backup/restore-test cadence + deletion exceptions.

| Option | Trade-offs |
|---|---|
| A. Wait for full legal review | Blocks four P7 tickets; legal review is a beta-gate item anyway |
| B. **Conservative implementation defaults now, legal review before closed-beta gate confirms/adjusts** | Unblocks work; defaults chosen to be tighten-able; explicitly no compliance claim |
| C. Minimal retention everywhere | Conflicts with audit/billing needs |

**Recommendation → B via CDR-009.** Defaults: application records — life of account + 30-day post-deletion staged purge; audit events — ≥ product-data retention (retain 7 years-class default pending legal); activity events — with company data; model-call metadata — ≥ billing retention; **prompt/response content — 90-day default in restricted storage, then purge (references remain)**; generated documents — user-owned, life of company + export path; failed-workflow diagnostics — 90 days; usage events — ≥ billing retention (7-year-class default); backups — **RPO ≤24h confirmed, RTO ≤4h confirmed (NFR-017)**, daily automated backups + PITR where plan supports, restore test pre-beta then quarterly; deletion exceptions — legal/security holds override purge with visible flag (per COMP-007/ACC-005 design). **No legal-compliance promise is made; legal review is a closed-beta gate condition.** Review trigger: legal review; D-08 remainder; incident.
**Owner outcome:** **Approved with conditions.** Ticket → **DONE**.

---

## Outcome summary

| Ticket | Outcome | Record | Ticket status |
|---|---|---|---|
| ACBP-P0-001 | Approved with conditions | CDR-001 | DONE |
| ACBP-P0-002 | Approved with conditions | CDR-002 | DONE |
| ACBP-P0-003 | Approved with conditions | CDR-003 | DONE |
| ACBP-P0-004 | Approved with conditions | CDR-004 | DONE |
| ACBP-P0-005 | **Still requires owner decision** | — (analysis above; recommendation: Cloudflare R2) | **BLOCKED** |
| ACBP-P0-006 | Approved | CDR-005 | DONE |
| ACBP-P0-007 | Approved with conditions | CDR-006 | DONE |
| ACBP-P0-008 | Approved | CDR-007 | DONE |
| ACBP-P0-009 | Approved with conditions | CDR-008 | DONE |
| ACBP-P0-010 | Approved with conditions | CDR-009 | DONE |

Sources for public model-identifier verification: [OpenAI GPT-5.1 model page](https://platform.openai.com/docs/models/gpt-5.1) · [Anthropic model IDs and versioning](https://platform.claude.com/docs/en/about-claude/models/model-ids-and-versions).
