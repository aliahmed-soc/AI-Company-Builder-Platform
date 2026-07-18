# Master PRD v1 — AI Company Builder Platform

## 1. Document control

| Field | Value |
|---|---|
| Document title | Master PRD v1 — AI Company Builder Platform |
| Product name | AI Company Builder Platform (temporary working name; final name is owner decision D-09) |
| Version | 1.2.0-draft |
| Status | **Draft for owner review — architecture-blocking decisions resolved** |
| Owner | _[Owner — pending assignment]_ |
| Author / model | Claude (Anthropic frontier model, Claude Code session; authored under `.cursor/rules/model-routing.mdc`) |
| Creation date | 2026-07-18 |
| Last updated | 2026-07-18 |
| Evidence snapshot date | 2026-07-18 (Polsia audit observation date, Africa/Cairo) |
| Approval state | **Document not fully approved** — the PRD as a whole still awaits explicit owner approval; the owner's latest instruction governs. **Approved by owner (2026-07-18):** the five architecture-blocking decisions — D-01, D-03, D-04, OQ-19, and the D-08 residency sub-question — recorded as accepted ADR-001…ADR-005 in `../docs/decisions/`. Technical architecture may begin from those ADRs plus these draft requirements. |
| Source locations | `docs/research/polsia/polsia-audit-review.md`; `docs/research/polsia/raw-audit/` (25 documents, 14 diagrams, 16 evidence CSVs, 6 redacted screenshots); `product-specification/SOURCE-CLASSIFICATION.md` |
| Companion artifacts | `REQUIREMENTS.csv` (canonical requirement registry — full attributes for every ID in §15/§16); `EVIDENCE-CROSSWALK.csv`; `CONTRADICTIONS-RESOLVED.md`; `OPEN-QUESTIONS.md`; `OWNER-DECISIONS.md` |

### Change log

| Version | Date | Author | Summary |
|---|---|---|---|
| 1.0.0-draft | 2026-07-18 | Claude (session above) | Initial Master PRD consolidating the corrected Polsia research; supersedes the raw audit's draft PRDs (`raw-audit/10`, `raw-audit/11`) as product source, with traceability preserved via `EVIDENCE-CROSSWALK.csv`. |
| 1.1.0-draft | 2026-07-18 | Claude (session above), on owner decisions | Applied the owner-approved architecture-blocking decisions (ADR-001…ADR-005): D-01 primary customer decided (§4, §25); D-03 infrastructure direction + MVP boundary + export promise (§25.1); D-04 platform-managed AI keys with expanded pre-beta controls (§25.1); OQ-19 model gateway (§25.1); D-08 residency position (§25.1). §24 blocking questions marked resolved. No other requirements modified. |
| 1.2.0-draft | 2026-07-18 | Claude (session above), on owner architecture review | **USAGE-001 amendment (controlled):** added account-level usage rollups (immutable company-level events, deterministic account aggregation, reconciliation, no double counting, compensating corrections, company-move/deactivation tests) to the requirement text and acceptance criteria in `REQUIREMENTS.csv`. Classification: **clarification of the approved D-04/ADR-003 decision** ("per-account usage recording" was owner-approved 2026-07-18), not a new product capability — this aligns requirement text with an already-approved control. Requirement ID preserved. Also recorded: architecture ADR-006…018 accepted by owner (5 with amendment); provider ADR-019…022 accepted (models GPT-5.1/Claude Sonnet 4, Render, Infisical, Clerk). PRD document status unchanged: not fully owner-approved. |

---

## 2. Executive summary

**What the product is.** An AI company-building and operating platform: a client brings an idea (or an existing business), the platform deeply understands it through an adaptive interview, presents genuinely distinct strategic options, generates an execution plan, and assigns work to specialized AI workers that perform authorized tasks — while the client retains visibility, control, ownership, and decision authority at every step.

**Who it serves.** Founders and small-business operators who want an AI team to do real work — research, strategy, documents, and eventually software, marketing, and operations — without surrendering control of decisions, money, or data. The recommended primary MVP segment is the **solo non-technical founder validating one serious idea** (§4; owner decision D-01).

**What problem it solves.** Turning an unclear idea into an operating business requires skills most founders don't have, money they can't spend on staff, and judgment calls no AI should make unilaterally. Existing autonomous-company products (reference: Polsia) demonstrate demand but expose a trust gap: broad capability claims, thin visible control. This product's thesis is **auditable autonomy** — the AI team moves fast, and every meaningful action is inspectable, previewable, reversible where possible, and honest about uncertainty.

**Parity baseline (verified Polsia capabilities we match).** Company portfolio and creation modes; provisioned company workspace with visible progress; autonomous planning; a six-state task machine with scheduled and credit-metered manual execution (one full manual run was directly observed end-to-end); generated documents; activity feed; credit ledger and subscription surfaces; pause/deactivate controls; and (post-MVP) generated public website, code export, secrets, versions, and deployment surfaces. Full inventory in §8; evidence per requirement in `EVIDENCE-CROSSWALK.csv`.

**How this product is different.** Polsia's observed weaknesses become our requirements: an adaptive founder interview instead of an opaque intake; an editable business-understanding document separating facts from assumptions; three-plus genuinely distinct strategy options instead of a single AI plan; a Decision Room; payload-bound, expiring, revocable approvals; configurable policies and autonomy levels; transparent, editable memory; task failure detail; and a full emergency-stop hierarchy (§11).

**What the first release must prove.** One complete trustworthy slice: account → company → adaptive interview → confirmed understanding → three strategy options → selection → roadmap and tasks → approval of a safe internal task → execution → useful document → recorded activity and usage → revision (§18).

**Explicitly not being built yet.** Full Polsia capability parity, paid advertising execution, mass outreach, autonomous financial commitments, automatic production deployment, and everything in §20.

---

## 3. Product vision

**Long-term vision.** A client can hand the platform a business idea and, over weeks, watch a controlled AI organization research it, propose strategy, build digital assets, operate approved channels, and report honestly — with the client as chief executive of an AI team, not the audience of a black box.

**MVP vision.** The most trustworthy AI business-discovery and planning product available: the interview, understanding, options, plan, and first executed research/document tasks are so transparent and controllable that a skeptical founder is comfortable letting the AI team run.

**Core customer promise (working language, not final brand copy).** *Your AI team does the work. You control the decisions.*

**Product boundaries.** The platform performs knowledge work and (later phases) authorized external actions on connected channels. It does not make legal commitments, hire humans, hold regulated funds without a compliant provider structure, or take irreversible actions without explicit authorization — regardless of autonomy level (§12, §20).

**Relationship to Polsia.** Polsia is a **reference product**: audited from the outside on 2026-07-18 to establish what a market-proven autonomous-company product visibly does. This product is **not a clone of Polsia's code, branding, prompts, or proprietary implementation** — none of which were accessed or are known (§10). Parity requirements derive only from externally observed behavior and Polsia's own public/first-party statements; every internal design in this document is our own.

---

## 4. Target users

| Segment | Goals | Pain points | Technical ability | Desired autonomy | Budget sensitivity | Trust concerns | Success criteria |
|---|---|---|---|---|---|---|---|
| **Solo non-technical founder** | Turn an idea into a validated, launched business | Can't code, can't afford staff, doesn't know what they don't know | Low | High for research/drafts; low for money/public actions | High (≤ ~$50/mo tolerance based on reference-market pricing evidence) | "Will it do something embarrassing or expensive without asking?" | Confirmed understanding, credible strategy choice, first useful outputs in days |
| **Technical founder** | Offload research/strategy/ops to focus on product | Time, not skill; distrusts hand-wavy AI output | High | Medium; wants inspectable reasoning and exportable artifacts | Medium | "Is the output real work or filler? Can I get my data out?" | Research/docs good enough to act on; clean exports |
| **Existing small-business owner** | Grow or systematize an existing business | Operations eat all time; marketing is guesswork | Low–medium | Medium; strict limits on customer-facing actions | High | "It must never contact my customers without me" | Time saved weekly; zero unauthorized actions |
| **Agency / studio launching client ventures** | Spin up and operate multiple ventures efficiently | Parallel workload, client reporting overhead | Medium–high | Medium; needs roles and client-safe views | Low–medium | "Client data isolation; who approved what" | Multi-company portfolio with clean audit trails |
| **Entrepreneur validating several ideas** | Cheaply test many directions, kill losers fast | Validation is slow and unstructured | Medium | High for research; phase-limited commitment | Medium | "Don't let sunk-cost automation keep dead ideas alive" | Fast compare/kill decisions across companies |
| **Operator managing an early-stage business** | Keep a young company's operations moving | Founder attention is elsewhere; needs guardrails | Medium | Medium within policies | Medium | "Clear boundaries and an emergency stop" | Tasks done in policy, exceptions escalated |

**DECIDED — primary MVP customer (D-01 approved 2026-07-18, ADR-001): the non-technical solo founder validating and planning a digital business, SaaS product, or online service.** The first product experience is optimized for a person who has an idea but may not have a complete business plan; needs help identifying the customer and problem; needs assumptions challenged; wants several strategic options; needs an actionable roadmap; cannot independently perform all research and planning; and wants AI assistance without giving up decision authority. Rationale preserved: the MVP slice (§18) is complete standalone value for this segment without any external integration, and their trust requirements force the differentiators first.

**Secondary future segments (approved order):** (1) entrepreneurs testing multiple business ideas, (2) existing small-business owners seeking AI-assisted growth, (3) agencies and venture studios managing several ventures. The MVP must **not** be designed primarily for agencies, enterprises, or advanced engineering teams.

The target customer is deliberately *not* "everyone who wants to build a company."

---

## 5. Jobs to be done

1. **Turn an unclear idea into a structured opportunity** — from a paragraph of intent to a confirmed, structured business understanding (DISC, UNDER).
2. **Challenge weak assumptions** — detect vagueness and contradictions; make every assumption explicit and testable (DISC-003/004, UNDER-004).
3. **Compare strategic directions** — genuinely distinct options with costs, risks, and validation paths (STRAT).
4. **Create an actionable roadmap** — goals, milestones, and tasks that trace to the chosen strategy (ROAD, PLAN).
5. **Complete knowledge-work tasks** — research, analysis, and documents produced by AI workers with provenance (WORK, TASK-005).
6. **Build digital products** — generated websites and applications with quality gates and export (BUILD; post-MVP/future).
7. **Operate selected business functions** — email, social, ads, support, payments under policy and approval (EMAIL/SOCIAL/ADS/SUPPORT/PAY; future).
8. **Keep the owner informed** — activity feed, Decision Room, notifications, usage visibility (ACT, DEC, ADMIN-004).
9. **Prevent unauthorized actions** — server-authoritative approvals, policies, and emergency stops (APPR, POL, ADMIN-001).
10. **Learn from outcomes** — decision records, outcome memory, and planning that visibly uses both (STRAT-006, MEM, PLAN-004).

---

## 6. Product principles

| # | Principle | Why it matters | Product implication | Failure example |
|---|---|---|---|---|
| 1 | **Client ownership** | The business, its data, and its outputs belong to the client | Export everything (EXPORT-001/002); ownership stated in terms | Client cancels and discovers their business plan is locked in |
| 2 | **Informed autonomy** | Autonomy is only legitimate when granted knowingly | Autonomy levels with plain-language consequences (APPR-008) | User enables "full auto" without understanding it can email people |
| 3 | **Better questions before execution** | Bad inputs make confident garbage | Adaptive interview precedes any planning (DISC) | AI builds a roadmap for "everyone" as a target market |
| 4 | **Real strategic options** | One AI opinion is a guess; comparable options are a decision | ≥3 distinct options with a similarity check (STRAT-001) | Three "options" that are the same plan with different titles |
| 5 | **Explicit assumptions** | Hidden assumptions become silent failures | Typed assumption items with lifecycle (UNDER-004, MEM-001) | A pricing assumption drives months of work and was never true |
| 6 | **Client authority over important decisions** | The client is the executive | Decision Room; nothing important decided silently (DEC-001) | The AI "decides" to reposition the product overnight |
| 7 | **Server-authoritative authorization** | UI checks are decoration; security lives server-side | Every gate enforced at execution layer (APPR-009, NFR-002) | A crafted API call bypasses the approval screen |
| 8 | **Least-privilege tools** | Capability should match assignment | Per-worker tool allowlists (WORK-005) | A research worker can somehow send email |
| 9 | **Full activity transparency** | Trust requires a complete record | Activity feed + append-only audit (ACT-001/002) | Work happened "somewhere" with no trace |
| 10 | **Proposed vs executed separation** | Plans are not results | Data-level distinction, receipts for external effects (ACT-003, TOOL-002) | A draft email shown as "sent" |
| 11 | **Reversible where possible** | Mistakes should be cheap | Risk classes prefer reversible paths; rollback where applicable (§12, BUILD-005) | An unrecoverable bulk deletion from a misunderstanding |
| 12 | **Reliable audit history** | Accountability needs immutability | Append-only audit with actor/time/context (NFR-008) | An incident with no reconstructable timeline |
| 13 | **Portable outputs** | Lock-in is a betrayal of principle 1 | Open formats, manifests (NFR-014, EXPORT-002) | Exports that only re-import into us |
| 14 | **No fake metrics** | Fabricated numbers destroy trust permanently | Zero vs unknown distinction; source+timestamp on metrics (PORT-004, TASK-005) | A dashboard showing invented "visitors" |
| 15 | **No hidden external actions** | Every outward action is visible before and after | Previews + receipts for all external effects (APPR-010, TOOL-002) | A tweet the owner learns about from a friend |
| 16 | **No AI self-authorization** | The model must not grant itself permission | Policy gate outside the model (TOOL-003) | A prompt-injected "the user said it's fine" |
| 17 | **Safety beyond model judgment** | Models err; structure must hold | Structural enforcement: allowlists, gates, idempotency (WORK-005, NFR-006) | Safety that is one clever prompt away from failing |
| 18 | **Capability existence ≠ capability quality** | A visible button proves nothing about reliability | Track visible/documented/executed/repeated separately (§7) | Shipping a feature list where half the features are façades |

---

## 7. Evidence methodology

**Evidence classes and confidence bands** (used consistently in this document, `REQUIREMENTS.csv`, and `EVIDENCE-CROSSWALK.csv`):

| Class | Definition | Confidence band |
|---|---|---|
| **Directly observed** | Visible and reproduced inside the authenticated reference application | 95–99% |
| **First-party documented** | Stated by current Polsia-owned documentation (in-app FAQ, official pages) | 85–95% |
| **Partially verified** | Some evidence exists; complete behavior was not reproduced | 65–85% |
| **Inferred** | Reasonable interpretation of evidence, not directly proven | ≤60% |
| **Unknown** | Not externally verifiable; **never** presented as a parity requirement | — |
| **Improvement (own design)** | Our requirement; justified by rationale, not Polsia evidence | n/a |

**Source hierarchy** (conflicts resolve upward): (1) owner's latest explicit instructions → (2) directly observed authenticated behavior → (3) directly observed task execution → (4) screenshots and recorded UI evidence → (5) current first-party Polsia documentation → (6) the corrected audit review → (7) audit reports and derived conclusions → (8) generated disposable-company artifacts → (9) third-party sources → (10) assumptions.

**Contradiction handling.** Every meaningful contradiction is logged in `CONTRADICTIONS-RESOLVED.md` with both claims, both sources, the selected conclusion (or deliberate non-resolution), and remaining uncertainty. Two rules are absolute for this document: the later **observed task execution** supersedes earlier "not tested" wording (C-01), and the **extra-company price stays unresolved** because two first-party sources disagree (C-02).

**Platform capability vs generated-company capability.** The reference audit's test company (a social-listening product, "Vigilix") had features — follower monitoring, sentiment detection, narrative reports, Slack delivery — that prove only that Polsia can *generate applications containing such features*. They are **not** native platform capabilities and are excluded from parity (C-05). Likewise the exported generated application proves generated-software quality, not Polsia's internal architecture (C-06).

**Verified behavior vs implementation recommendation.** The raw audit mixes observations with the auditor's recommended designs (e.g., approval tokens, outbox patterns). Recommendations are treated as *our* candidate designs — they appear here only as Improvement requirements, never as parity evidence.

**Existence vs reliability.** A capability observed once (class: directly observed) is proven to *exist*, not to be reliable. Reliability claims require repeated execution evidence, which the audit does not provide for most capabilities; §9 tracks this gap per capability.

---

## 8. Polsia parity baseline

Requirement IDs below are canonical; full attributes (user value, dependencies, acceptance criteria, failure behavior) are in `REQUIREMENTS.csv`. Evidence per requirement is in `EVIDENCE-CROSSWALK.csv`.

### 8.1 Accounts and portfolio

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| ACC-001 | Account registration | Partially verified | 75 | MVP |
| ACC-002 | Authentication and server-managed sessions | Directly observed | 95 | MVP |
| ACC-003 | Profile settings (name, email, content language) | Directly observed | 97 | MVP |
| ACC-004 | Account deactivation stopping all autonomous work | Directly observed | 95 | Post-MVP |
| PORT-001 | Company portfolio view | Directly observed | 97 | MVP |
| PORT-002 | Multiple companies per account | Directly observed | 97 | MVP |
| PORT-003 | Company switching without context bleed | Directly observed | 95 | MVP |
| PORT-004 | Portfolio summary metrics with source/freshness | Partially verified | 75 | Post-MVP |
| COMP-005 | Company settings (rename, etc.) | Directly observed | 97 | MVP |
| COMP-006 | Company pause (stops autonomous work, keeps data) | Directly observed | 97 | MVP |
| COMP-008 | Company operating-status indicator | Directly observed | 95 | MVP |
| BILL-001 | Subscription state gating paid features | Directly observed | 95 | Post-MVP |

### 8.2 Company creation

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| COMP-001 | Three creation modes: own idea / platform-suggested / existing business | First-party documented | 85 | MVP (idea mode fully functional) |
| COMP-002 | Workspace provisioning (profile, mission, research, roadmap, documents, activity) | Directly observed | 95 | MVP |
| COMP-003 | Ordered, timestamped provisioning progress stream | Directly observed | 97 | MVP |
| COMP-004 | Editable company profile and brief | Directly observed | 95 | MVP |
| COMP-007 | Two-step confirmed company deletion with export offer | Directly observed | 95 | Post-MVP |
| BUILD-001 | Generated public website | Directly observed | 97 | Post-MVP |

The reference product's observed provisioning also covered email identity, codebase, database, hosting, and sandbox setup — in this product those land post-MVP/future under BUILD/DEPLOY/EMAIL (§19), a deliberate sequencing decision, not an evidence gap.

### 8.3 Planning

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| PLAN-001 | Autonomous planning generating prioritized tasks | Directly observed | 95 | MVP |
| PLAN-002 | User-steered planning via chat surface | Partially verified | 80 | MVP |
| PLAN-003 | Recurring scheduled planning cycles | First-party documented | 85 | Post-MVP |
| ROAD-001 | Generated goals, roadmap, milestones, initial tasks | Directly observed | 95 | MVP |

### 8.4 Tasks

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| TASK-001 | Six-state task machine (To Do, Recurring, In Progress, Completed, Rejected, Failed) | Directly observed | 97 | MVP |
| TASK-002 | Task detail (type, created, description, state-appropriate controls) | Directly observed | 97 | MVP |
| TASK-003 | Scheduled autonomous work windows with monthly allowance | Directly observed | 95 | Post-MVP |
| TASK-004 | Manual run with credit preflight; consumes one task credit | Directly observed | 95 | MVP |
| TASK-005 | Persistent result artifacts linked from task and library | Directly observed | 97 | MVP |
| TASK-007 | Cancel queued / safe-stop running tasks | Partially verified | 70 | MVP |
| TASK-008 | Repeat and delete controls | Directly observed | 97 | MVP |
| ACT-004 | Credit/usage ledger visibility | Directly observed | 97 | MVP |
| ACT-005 | Failures as first-class visible events | Partially verified | 75 | MVP |

**The observed execution:** a low-risk research task (competitive audit of five products) was run end-to-end in the reference product on 2026-07-18 — start, two research phases, report writing, completion, a persisted report document, and a decremented credit balance were all directly observed (`raw-audit/24`, §1). This single run anchors TASK-004/TASK-005/USAGE-001 as **directly observed**. It does not establish reliability, retries, cancellation, or recurring execution (C-01; §9).

### 8.5 Capability domains

Evidence-backed domains in the reference product (not all required for MVP): research, strategy/planning, engineering and website generation, application generation (one verified sample), marketing/social (publishing observed), email (identity + welcome send observed), advertising (surface + FAQ only), support (FAQ only), payments (surface + FAQ only), and general operations (queue, credits, pause, settings). Domain-level labels in the reference UI are **capabilities, not proof of separate backend agents** (C-04).

### 8.6 Software generation

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| BUILD-001 | Website generation | Directly observed | 97 | Post-MVP |
| BUILD-002 | Working application generation | Partially verified | 80 | Future |
| BUILD-003 | Complete source-code export | Directly observed | 95 | Post-MVP |
| BUILD-004 | Masked secrets management (hidden values, redeploy to apply) | Directly observed | 97 | Future |
| BUILD-005 | Deployment versioning and rollback | Partially verified | 75 | Future |
| BUILD-006 | Custom domains | Partially verified | 75 | Future |
| DEPLOY-001 | Managed hosted deployment with health status | Directly observed | 95 | Future |

Generated-project quality evidence: one exported project built, passed its 57 tests, and reached zero production-dependency vulnerabilities **after** third-party remediation of lint/key/audit issues (`raw-audit/22`, `raw-audit/23`, `raw-audit/24` §3) — hence our quality-gate requirement BUILD-007 (improvement).

### 8.7 Integrations

| Status | Integrations (reference product) |
|---|---|
| Verified (observed active) | One social platform (X/Twitter: connected account, public post, posting controls); platform-provided company email (welcome send observed); billing portal handoff (Stripe-branded, not opened) |
| Partially verified | Hosting and database providers (named in FAQ, secrets UI corroborates; 85%) |
| Documented-only | Slack delivery, LinkedIn pages, analytics/CRM connectors (roadmap/task labels; not connected) |
| Unknown | OAuth scopes, revocation behavior, account ownership boundaries, everything else |

**Rule: vendor names observed in the reference product are evidence of *its* choices, not requirements for ours.** Our requirements are provider-neutral (BILL-004 "a hosted billing portal", not "Stripe"); vendor selection belongs to the architecture phase.

### 8.8 Activity and transparency

ACT-001 (activity feed — directly observed, 97), ACT-004 (ledger — directly observed, 97), ACT-005 (failure visibility — partially verified, 75; the observed failed task showed **no error detail**, which is why TASK-006 exists as an improvement). Deployment info, email/social/ads/payment surfaces observed as dashboard sections (§8.5).

### 8.9 Billing

| ID | Requirement | Class | Conf. | MVP |
|---|---|---|---|---|
| BILL-001 | Monthly subscription incl. one company, scheduled-work allowance, task credits | Directly observed | 95 | Post-MVP |
| BILL-002 | Task credits with append-only ledger (grants/spends/refunds, expirable/permanent, reset) | Directly observed | 97 | MVP |
| BILL-003 | Additional credit-tier purchase | Directly observed | 95 | Post-MVP |
| BILL-004 | Hosted billing portal (provider-neutral) | Directly observed | 95 | Post-MVP |
| BILL-005 | **Additional-company pricing — UNRESOLVED** | Partially verified | 70 | Post-MVP |
| BILL-006 | Cancellation pauses rather than deletes | First-party documented | 85 | Post-MVP |

Reference-product observed values (evidence, **not our pricing**): $25/month base with one company, 30 scheduled shifts, 5 task credits, $5/month AI allowance; credit tiers from 15/$19 to 1000/$999; extra company shown as **+$20/month (UI) vs $25/month (FAQ)** — contradiction C-02, deliberately unresolved. Revenue-share evidence: FAQ states a 20% platform fee on generated revenue and on managed ad spend (first-party documented, 85%; no transaction executed). A historical "$49/month" claim is contradicted by direct observation (C-07). Our pricing is owner decision D-02.

### 8.10 Ownership and portability

Code download: directly observed (95%+, menu entry + FAQ). **Ownership terms: not found** in inspected surfaces (<50% — the audit could not locate export license/ownership statements), so client ownership is stated here as our commitment (EXPORT-001/002, principle 1), not as verified reference behavior. Company deactivation and pause observed; resource transfer (e.g., repository handover) and cross-provider portability unverified (§9). What remains unknown about the reference product's portability is listed in §10.

---

## 9. Partially verified Polsia capabilities

These exist as visible surfaces or first-party claims but were not fully exercised. None may be treated as reliable-parity without further evidence.

| Capability | Existing evidence | Missing evidence | Conf. | Parity importance | MVP decision | Future verification method |
|---|---|---|---|---|---|---|
| God Mode / continuous execution | Button + product copy observed | Any activation run | 60% | High | Excluded; our continuous mode is a designed feature (APPR-008 L4-5), Future | Sandbox activation in a disposable company |
| Automatic retries | Failed tab + Repeat control | Any observed auto-retry | <50% | Medium | Our retry design ships regardless (TASK-010, NFR-007) | Induce a transient failure; watch behavior |
| Automatic rollback | Versions dialog text explains rollback | No versions existed to roll back | 75% | Medium | Future (BUILD-005) | Deploy twice in a test company; roll back |
| OAuth integrations | Roadmap/task labels; one active social connection | Connection wizard, scopes, revocation | 70% | High | Post-MVP (INTEG-001/003 are our design) | Connect a disposable account end-to-end |
| Automated email follow-up | Company email + welcome send + FAQ | Any follow-up sequence | 85% (send) / <50% (follow-up) | Medium | Future (EMAIL-002) | Monitored outbound sequence in sandbox |
| Social execution | Posting controls + one public post | Approval flow around publishing | 95% (exists) | Medium | Future (SOCIAL-001) | Approved publish in sandbox |
| Advertising execution | Ads surface + FAQ (budgets, 20% fee) | Any campaign | 85% (documented) | Low for MVP | Future (ADS-001) | Capped sandbox campaign |
| Customer payments | Payments dialog + portal button + FAQ | Any transaction | 85% (documented) | Low for MVP | Future (PAY-001) | Test-mode payment |
| Refunds | One refund ledger entry observed | Refund action flow | 70% | Low | Future | Execute a refund in sandbox |
| Team roles | Company-scoped invite form observed | Roles, permissions, revocation | 75% | Medium | MVP ships owner+viewer only (ADMIN-003) | Invite flow in test account |
| GitHub/repository transfer | Seed-repo activity labels | Any repo link or transfer | 70% | Low | Future | Request transfer under user authorization |
| Infrastructure portability | Code export observed | Deploy independence, data export | 70% | Medium | Our EXPORT-002 is the answer, Future | Rebuild exported project on third-party infra (partially done: build+tests passed locally) |
| Continuous unattended operation | Night-shift markers + FAQ cycle description | Multi-day observed operation | 85% (documented) | High | Post-MVP (TASK-003/PLAN-003) | Multi-day disposable-company observation |
| Memory visibility | None found | Any memory UI | <50% | High (as a gap) | Our MEM-001..004 differentiator, MVP | n/a — Polsia gap, our feature |
| Failure recovery | Failed tab visible; no detail shown | Error reasons, recovery paths | 75% | High (as a gap) | Our TASK-006, MVP | Trigger failure; inspect surfaces |
| Customer-support automation | FAQ claim only | Any support workflow | 70% | Low | Future (SUPPORT-001) | Sandbox inquiry handling |

---

## 10. Unknown Polsia internals

The following **cannot be treated as known** and must never appear as evidence, requirement, or architecture input: private backend architecture and source code; prompts; model assignments and routing; agent count and lifecycle; internal database schema; queue system; retry algorithms; policy enforcement implementation; approval enforcement implementation; secret-vault design; memory architecture; infrastructure topology; and tenant-isolation implementation. The audit's own boundary statements (`raw-audit/24` "Remaining audit boundaries", review §"confidence" rows at 25–35%) are controlling. Anything in this PRD that resembles an internal design is **our** design, justified on its own merits.

---

## 11. Better-than-Polsia requirements

These are this product's mandatory differentiators. All are class *Improvement (own design)*; none are Polsia parity (the audit specifically could not verify equivalents — see §9 rows for memory, previews, options, and approvals).

### 11.1 Adaptive founder interview (DISC-001 … DISC-008 — all MVP)

Small question batches (≤3) generated from previous answers; context-aware follow-ups; vague-answer detection with concrete examples; contradiction detection; "I don't know" with AI-suggested labeled assumptions; per-question "why we ask"; progressive resumable sessions; and revision of any earlier answer with dependency re-evaluation. No long forced forms, no repetition.

### 11.2 Business-understanding review (UNDER-001 … UNDER-005 — all MVP)

An editable understanding document containing: business idea, problem, target customer, user, buyer, proposed solution, market, geography, language, business model, pricing assumptions, existing resources, budget, timeline, founder involvement, risk tolerance, constraints — every item classified as confirmed fact, preference, constraint, AI assumption, research finding, or open question, with confidence. Users can approve, edit, reject, request evidence, request more research, or mark items for future validation. Execution planning is blocked until the understanding is approved.

### 11.3 Strategy options (STRAT-001 … STRAT-006 — all MVP)

Important decisions present ≥3 genuinely distinct options (different customer, offer, or model — a similarity check rejects cosmetic variants). Each option carries the full 16-field content standard (description, customer, offer, business model, scope, benefits, risks, cost range, effort, time to validate, time to launch, required resources, key assumptions, validation method, success metrics, confidence) plus an optional AI recommendation with rationale. Users select, edit, combine, reject, request another, or approve only one phase. Every decision produces an immutable decision record.

### 11.4 Decision Room (DEC-001 — MVP)

One surface with ten queues: needs your decision; recommended next actions; questions from the AI team; options under consideration; approved and queued; executing; results; blocked work; failed work; recent decisions.

### 11.5 Approval system (APPR-001 … APPR-010)

Five configurable operating levels: (1) recommend only, (2) draft and approve, (3) approve by category, (4) operate within limits, (5) advanced autonomy. **MVP implements levels 1–2 only**; levels 3–5 are defined product surface shipped later — all five are *not* required in the first MVP implementation. Every approval-capable action supports, where relevant: exact action, reason, expected result, recipient/destination, data used, cost, risk, reversibility, preview, alternatives, edit, approve, reject, schedule, limited-batch approval, expiration, payload binding (content-hash; edits invalidate), revocation, and an audit record. Enforcement is server-authoritative (APPR-009).

### 11.6 Policies (POL-001 … POL-007)

Configurable: spending limits (MVP); message/publishing volume limits; approved channels and recipients; working hours; deployment restrictions; discount limits; deletion restrictions; data-sharing restrictions; required approvers; forbidden actions with automatic escalation (MVP). Every evaluation is recorded (POL-006, MVP).

### 11.7 Transparent memory (MEM-001 … MEM-004 — all MVP)

Typed memory: facts, preferences, constraints, assumptions, research findings, decisions, outcomes, corrections. All items visible, editable, deletable, source-linked, company-specific, and auditable. Memory can never silently override an explicit client instruction — conflicts surface as questions.

### 11.8 Emergency control (ADMIN-001, ADMIN-002 — MVP)

Stop scopes: pause/cancel task; pause worker; disable capability; revoke integration; pause company; stop external actions only; account-level emergency stop. Resuming requires explicit review of held work; nothing auto-fires on reactivation; expired approvals are not resurrected.

---

## 12. Action-risk model

| Class | Examples | Default approval (by autonomy level 1→5) | Required role | Logging | Notification | Reversibility expectation | Idempotency | Policy evaluation | Emergency-stop behavior |
|---|---|---|---|---|---|---|---|---|---|
| **Informational** | Research, analysis, summaries, recommendations | L1: propose only. L2+: execute without approval | Operator+ (or worker) | Task run + tool calls | Digest | Fully reversible (discard) | Not required (no external effect) | Standard gate | Halts on company/account stop |
| **Internal & reversible** | Drafts, plans, internal documents, unpublished assets | L1: propose. L2: execute; results reviewable | Operator+ | Task run + artifact provenance | Digest | Reversible (versioned artifacts) | Not required | Standard gate | Halts on company/account stop |
| **External** | Email sends, social posts, deployments, CRM updates, customer communication | L1–2: explicit per-action approval. L3: category pre-authorization possible. L4: within limits | Approver+ | Full tool-call record **+ provider receipt** | Immediate (configurable routing, not silenceable to zero) | Often irreversible in effect; preview mandatory (APPR-010) | **Required** (NFR-006) | Standard + destination/volume policies | Halts on external-actions stop and all broader stops |
| **Sensitive / irreversible** | Spending, refunds, deletion, legal commitments, large campaigns, ownership changes, production credentials, pricing changes | Explicit per-action approval at **every** level; L5 never removes this | Owner (or designated required approver, POL-007) | Full record + receipt + decision record | Immediate, multi-channel | Presumed irreversible; alternatives shown before approval | **Required** | Strictest; forbidden-list checked first | Halts on every stop scope; held items require review to resume |

Classification is a property of the **tool** (APPR-001, TOOL-001); unclassified tools default to sensitive/irreversible.

---

## 13. User roles

MVP ships **account owner** and **viewer** only (ADMIN-003); the rest are defined now to keep the model stable, delivered post-MVP/future.

| Role | Scope | Allowed actions | Approval authority | Data access | Billing access | Integration access | Export access | Deletion access | Availability |
|---|---|---|---|---|---|---|---|---|---|
| **Account owner** | Whole account | Everything | All classes incl. sensitive | All companies | Full | Connect/revoke | Full | Full (with safeguards) | MVP |
| **Viewer** | Assigned company | Read-only | None | Assigned company, read | None | View status only | None | None | MVP |
| **Company owner** | One company | All company operations | All classes within company | Company | Company charges view | Connect/revoke (company) | Company | Company (safeguards) | Post-MVP |
| **Administrator** | Account config | Settings, roles, policies | External class | Config + companies | View | Manage | Company | None | Post-MVP |
| **Operator** | Assigned company | Run/steer tasks within policy | None (requests only) | Company operational data | None | Use (not manage) | None | None | Post-MVP |
| **Approver** | Assigned company/categories | Decide approval requests | Per assigned categories | Request contexts | None | None | None | None | Post-MVP |
| **Billing administrator** | Account billing | Subscription, credits, invoices | Spending class only | Billing data only | Full | None | Billing exports | None | Future |

All role enforcement is server-side (NFR-002); invites are company-scoped (observed parity, ADMIN-003).

---

## 14. Core user journeys

Format per journey: **Actor · Preconditions · Trigger → Main flow → Alternatives / Failure → Permissions · Data · Audit · Usage · Acceptance.** IDs J-01…J-22.

**J-01 Register.** Actor: visitor. Pre: none. Trigger: sign-up. Flow: email + password (or provider) → verification → empty portfolio with creation prompt. Alt: existing email → sign-in redirect. Fail: verification undeliverable → resend with support path. Perms: none. Data: user record. Audit: account-created. Usage: none. Accept: verified account reaches portfolio in <2 min typical; unverified accounts cannot start companies (ACC-001/002).

**J-02 Create first company.** Actor: owner. Pre: J-01. Trigger: "New company". Flow: choose mode (idea / suggested / existing) → enter brief → workspace provisioned with visible progress stream → interview begins. Alt: abandon → resumable draft. Fail: provisioning step fails → visible reason + retry, no orphan (COMP-002/003). Perms: owner. Data: company, profile, activity events. Audit: company-created, provisioning steps. Usage: none (MVP). Accept: reach interview start with all provisioning steps green or explicitly failed.

**J-03 Add existing company.** Actor: owner. Pre: J-01. Trigger: "New company" → existing-business mode. Flow: describe current business, assets, constraints → interview adapts to brownfield context (validation focus, not greenfield ideation). Alt/Fail/other: as J-02. Accept: understanding document reflects existing-business facts as facts, not assumptions (COMP-001, UNDER-002). *(In-MVP status is owner decision D-10.)*

**J-04 Complete founder interview.** Actor: owner. Pre: J-02. Trigger: automatic after provisioning. Flow: batches of ≤3 questions → follow-ups build on answers → vague answers get example-backed clarification → "I don't know" yields suggested assumptions → progress honest → completion produces draft understanding. Alt: pause anytime, resume exactly (DISC-007). Fail: generation failure → static fallback bank, marked non-adaptive (DISC-001). Perms: owner. Data: interview session/Q/A, memory items. Audit: session events. Usage: metered AI usage (internal). Accept: DISC-001…008 acceptance criteria; no screen >3 questions; session resumable.

**J-05 Review understanding.** Actor: owner. Pre: J-04. Trigger: draft ready. Flow: structured document; every item classed (fact/preference/constraint/assumption/research/open); per-item approve/edit/reject/request-evidence/request-research; overall approve unlocks strategy. Alt: bulk-approve facts. Fail: unresolved Must-fields block approval with explanation. Audit: item decisions + overall approval. Accept: UNDER-001…005; planning blocked until approval.

**J-06 Correct assumption.** Actor: owner. Pre: J-05. Trigger: spot a wrong AI assumption. Flow: edit or reject item → dependent items flagged stale → re-evaluation proposes updates → owner confirms. Fail: re-evaluation failure marks visible staleness, never silent (DISC-008, UNDER-004). Audit: correction memory item (MEM-001). Accept: no dependent item silently stale.

**J-07 Compare strategies.** Actor: owner. Pre: J-05 approved. Trigger: automatic generation. Flow: ≥3 distinct options, 16-field standard, side-by-side comparison, optional AI recommendation with rationale. Alt: request another option. Fail: <3 viable options → honest statement of why (STRAT-001). Accept: options differ on customer/offer/model; similarity check passes.

**J-08 Select or combine strategy.** Actor: owner. Pre: J-07. Trigger: choose. Flow: select / edit / combine → re-rendered for confirmation → immutable decision record links understanding version + options considered + rationale (STRAT-003/006). Alt: phase-limited approval (STRAT-005). Fail: record-write failure blocks transition. Accept: decision recorded before any planning.

**J-09 Generate roadmap.** Actor: system (owner reviews). Pre: J-08. Flow: goals → roadmap → milestones → initial tasks traceable to milestones (ROAD-001). Fail: partial generation labeled partial; retry available. Accept: every initial task traces to a milestone; roadmap versioned (ROAD-002).

**J-10 Review tasks.** Actor: owner. Pre: J-09. Flow: task board (six states) → detail per task (type, description, worker, expected output, cost estimate) → adjust priorities or reject tasks. Audit: task-state events. Accept: TASK-001/002; rejected tasks record reason.

**J-11 Execute internal research task.** Actor: owner (initiates), research worker (executes). Pre: J-10, credits available. Trigger: run task. Flow: preflight (credit cost + side-effect class: informational) → policy gate pass → worker executes with visible progress → report artifact persisted → credit decremented atomically → activity + ledger events (TASK-004/005, USAGE-001; mirrors the directly observed reference-product run). Alt: insufficient credits → blocked with resolution path. Fail: failure produces TASK-006 detail; credit handling per documented rule. Accept: artifact linked; ledger reconciles; zero external side effects.

**J-12 Review output.** Actor: owner. Pre: J-11. Flow: open artifact from task or library → provenance visible (worker, inputs, time, sources) → rate usefulness (metric input). Accept: TASK-005 provenance complete; unsourced claims labeled.

**J-13 Request revision.** Actor: owner. Pre: J-12. Trigger: revision request with guidance. Flow: new linked task created (lineage to original) → re-execution → both versions retained. Accept: revision lineage visible; original never overwritten silently.

**J-14 Approve external action.** *(Post-MVP journey; MVP has no external actions.)* Actor: approver/owner. Pre: worker proposes an external-class action. Flow: approval request with full APPR-002 content + preview → approve → payload-hash-bound approval → execution → receipt stored → result in Decision Room. Alt: edit-then-approve rebinds hash; schedule; limited batch. Fail: hash mismatch/expiry/revocation → execution rejected server-side (APPR-004/005/006/009). Accept: negative tests prove unapproved/modified/expired paths fail closed.

**J-15 Reject action.** Actor: approver/owner. Pre: pending approval. Flow: reject with optional reason → proposer notified → task moves to Rejected with reason → planning learns (memory outcome item). Accept: rejected action can never execute; reason retained.

**J-16 Pause operations.** Actor: owner. Pre: active company. Trigger: pause (company scope) or emergency stop (any scope). Flow: new tool calls halt at scope within seconds → in-flight reach safe-stop → held work listed (ADMIN-001). Accept: post-pause zero new tool calls at scope (test-verified); truthful status.

**J-17 Resume operations.** Actor: owner. Pre: J-16. Flow: resume → held-work review list → confirm/discard each → schedules restore (ADMIN-002). Accept: nothing executes on resume without review; expired approvals not resurrected.

**J-18 Review usage.** Actor: owner. Pre: any activity. Flow: ledger (ACT-004) + usage views (USAGE-001) → per-task attribution → forecast (post-MVP USAGE-002). Accept: balance equals ledger sum; every run attributable.

**J-19 Export assets.** *(Post-MVP.)* Actor: owner. Flow: select scopes (documents/memory/decisions/activity/config) → archive with manifest → download (EXPORT-001). Fail: partial export enumerates missing items. Accept: export matches in-product data; zero secret values.

**J-20 Deactivate company.** *(Post-MVP.)* Actor: owner. Flow: pause-with-intent → public artifacts offline → data retained → reactivation path documented (COMP-006/ACC-004 semantics). Accept: no autonomous work after; truthful public-site status.

**J-21 Cancel subscription.** *(Post-MVP.)* Actor: owner. Flow: portal cancellation → companies pause, data preserved (BILL-006) → export offered → reactivation possible. Accept: no deletion by cancellation; states truthful.

**J-22 Delete account.** *(Post-MVP.)* Actor: owner. Flow: export offer → two-step confirmation → cooling-off → purge per retention (ACC-005). Fail: legal hold blocks with explanation. Accept: post-purge no personal data in active systems; audit trace (redacted) retained.

---

## 15. Functional requirements

The **canonical registry is `REQUIREMENTS.csv`** — one row per requirement with all attributes (ID, title, requirement, user value, evidence/rationale, evidence class, confidence, parity/improvement, priority, MVP status, dependencies, acceptance criteria, failure behavior, open questions). The tables in §8 and §11 list every functional ID with its class, confidence, and MVP status. Summary of the ID space:

| Category | IDs | Count | Parity / Improvement |
|---|---|---|---|
| Accounts | ACC-001…005 | 5 | 4 P / 1 I |
| Portfolio | PORT-001…004 | 4 | 4 P |
| Company | COMP-001…008 | 8 | 8 P |
| Discovery | DISC-001…008 | 8 | 8 I |
| Understanding | UNDER-001…005 | 5 | 5 I |
| Strategy | STRAT-001…006 | 6 | 6 I |
| Decision Room | DEC-001 | 1 | 1 I |
| Planning | PLAN-001…004 | 4 | 3 P / 1 I |
| Roadmap | ROAD-001…002 | 2 | 1 P / 1 I |
| Tasks | TASK-001…010 | 10 | 7 P / 3 I |
| Workers | WORK-001…006 | 6 | 6 I |
| Tools | TOOL-001…003 | 3 | 3 I |
| Approvals | APPR-001…010 | 10 | 10 I |
| Policies | POL-001…007 | 7 | 7 I |
| Memory | MEM-001…004 | 4 | 4 I |
| Activity | ACT-001…005 | 5 | 3 P / 2 I |
| Build | BUILD-001…007 | 7 | 6 P / 1 I |
| Deploy | DEPLOY-001…002 | 2 | 1 P / 1 I |
| Email | EMAIL-001…002 | 2 | 1 P / 1 I |
| Social | SOCIAL-001 | 1 | 1 P |
| Ads | ADS-001 | 1 | 1 P |
| Support | SUPPORT-001 | 1 | 1 P |
| Payments | PAY-001 | 1 | 1 P |
| Billing | BILL-001…006 | 6 | 6 P |
| Usage | USAGE-001…002 | 2 | 1 P / 1 I |
| Export | EXPORT-001…002 | 2 | 2 I |
| Admin | ADMIN-001…004 | 4 | 1 P / 3 I |
| Integrations | INTEG-001…003 | 3 | 3 I |
| **Functional total** | | **120** | **50 P / 70 I** |
| Non-functional (§16) | NFR-001…021 | 21 | 21 I |
| **Grand total** | | **141** | **50 P / 91 I** |

MVP status distribution: **98 MVP** (84 functional + 14 NFR), **28 Post-MVP**, **15 Future**. No requirement ID is duplicated; the CSV is the tie-breaker if any presentation drifts.

---

## 16. Non-functional requirements

All measurable/testable; full attributes in `REQUIREMENTS.csv` (NFR-001…021).

| ID | Area | Requirement (measurable core) | MVP |
|---|---|---|---|
| NFR-001 | Tenant isolation | 100% pass on adversarial cross-company test suite; denials leak no existence info | MVP |
| NFR-002 | Authorization | Server-side only; negative authz test per privileged endpoint | MVP |
| NFR-003 | Availability | 99.5% monthly (beta) for dashboard + Decision Room, measured and reported | Post-MVP |
| NFR-004 | Performance | Dashboard FMC <2.5s p75 warm; interview question gen <10s p90; long work async with progress | MVP |
| NFR-005 | Reliability | All workflows checkpoint-resumable; kill-and-resume tests pass; no orphaned resources | MVP |
| NFR-006 | Idempotency | Zero duplicate external effects in replay test suite; keys on every external write | MVP |
| NFR-007 | Retry handling | Bounded exponential backoff per class; dead-letters surfaced in Decision Room | MVP |
| NFR-008 | Auditability | 100% of registry action types produce immutable audit records ≤5s; range export works | MVP |
| NFR-009 | Observability | Structured redacted logs, metrics, traces; any task ID resolves to full trace | MVP |
| NFR-010 | Security | ASVS-aligned controls; dependency + static scanning gate CI; pen review pre-beta, high+ findings closed | MVP |
| NFR-011 | Privacy | Encryption in transit/at rest; data map + retention schedule pre-beta; deletion SLA; zero personal data in logs | Post-MVP |
| NFR-012 | Accessibility | WCAG 2.1 AA on core flows; automated checks in CI + manual audit of 5 core journeys | Post-MVP |
| NFR-013 | Maintainability | CI lint/typecheck/test gates on every merge; module ownership docs | MVP |
| NFR-014 | Portability | Documented open export format for every artifact type | Post-MVP |
| NFR-015 | Cost control | Hard per-task/per-company AI-spend caps; overrun ≤1 billing increment; reconciles with provider bills | MVP |
| NFR-016 | Data retention | Documented, enforced, logged retention per data class; visible exceptions | Post-MVP |
| NFR-017 | Backup/recovery | RPO ≤24h, RTO ≤4h (beta); restore drill pre-beta and quarterly | Post-MVP |
| NFR-018 | Secret handling | Managed store, reference-only; zero findings from CI + log-pipeline secret scanning; negative API tests | MVP |
| NFR-019 | Model-provider failure | Outage → queue + honest status; provider failover by configuration; no hardwired single vendor | MVP |
| NFR-020 | Integration failure | Per-connection fault isolation (fault-injection verified); health status within one cycle | Post-MVP |
| NFR-021 | Prompt-injection defense | External content is data, not instructions; injection corpus yields zero unauthorized tool executions | MVP |

---

## 17. Conceptual data requirements

Product concepts, **not** a physical schema (that belongs to architecture). Availability: M = required for MVP, P = post-MVP, F = future.

| Concept | M/P/F | Concept | M/P/F | Concept | M/P/F |
|---|---|---|---|---|---|
| User | M | Strategy option | M | Policy | M |
| Account | M | Decision | M | Policy evaluation | M |
| Membership | M | Goal | M | Approval | M |
| Company | M | Roadmap | M | Integration | P |
| Company profile | M | Milestone | M | Credential reference | M |
| Interview session | M | Task | M | Generated document | M |
| Interview question | M | Task run | M | Deployment | F |
| Interview answer | M | Worker | M | Usage event | M |
| Fact | M | Worker capability | M | Credit transaction | M |
| Preference | M | Tool | M | Activity event | M |
| Constraint | M | Tool call | M | Notification | P |
| Assumption | M | Research finding | M | Memory item | M |

(Fact/Preference/Constraint/Assumption/Research finding/Decision are realized as typed **Memory items** per MEM-001; they are listed separately because they carry distinct lifecycle rules.)

---

## 18. MVP definition

**The first product slice must prove, end to end:**

Create account → create company → complete adaptive interview → confirm business understanding → compare three strategic options → select one option → generate roadmap and tasks → approve a safe internal task → execute the task → produce a useful document → record activity and usage → allow revision.

**Initial workers (WORK-002/003/004):** research worker, strategy worker, document worker. All informational/internal-reversible risk classes only — **the MVP performs zero external actions.**

**Initial task types:** market research; competitor research; customer-segment analysis; business-model comparison; business-plan generation; landing-page copy; internal product requirements.

**MVP requirement set:** the 98 rows marked MVP in `REQUIREMENTS.csv` (84 functional + 14 NFR). The MVP approval system implements autonomy levels 1–2 only (APPR-008); the full approval architecture (payload binding, expiry, revocation) ships in MVP because the *revision/approval* loop of internal tasks exercises it safely before any external action ever exists.

---

## 19. MVP phases

No calendar estimates — none are honest without team and capacity data (owner decision context).

- **Phase 0 — Engineering foundation.** Repository standards, environments, CI, testing strategy, logging, error monitoring, migration strategy. (NFR-009/010/013 groundwork.)
- **Phase 1 — Accounts and companies.** Authentication, account, company, portfolio, switching, tenant isolation, settings. (ACC-001..003, PORT-001..003, COMP-004/005/006/008, NFR-001/002.)
- **Phase 2 — Discovery.** Adaptive interview, follow-ups, understanding document, assumption review, corrections. (DISC-001..008, UNDER-001..005, MEM-001..004.)
- **Phase 3 — Strategy.** Options, comparison, recommendation, selection, decision history. (STRAT-001..006, DEC-001 first queues.)
- **Phase 4 — Planning.** Goals, roadmap, milestones, tasks, statuses, dependencies where needed. (ROAD-001/002, PLAN-001/002/004, TASK-001/002.)
- **Phase 5 — Safe worker execution.** Research/strategy/document workers, queue, tool registry, task execution, usage metering, generated documents, activity feed. (WORK-001..006, TOOL-001..003, TASK-004..010, USAGE-001, ACT-001..005, BILL-002.)
- **Phase 6 — Approvals and policies.** Risk classification, approval inbox, previews, approval decisions, basic policies, emergency stop. (APPR-001..010, POL-001/005/006, ADMIN-001/002, DEC-001 complete.)
- **Phase 7 — Beta readiness.** Billing, notifications, export, deletion, monitoring, support, security review, operational runbooks. (BILL-001/003/004/006, ADMIN-004, EXPORT-001, ACC-004/005, COMP-007, NFR-003/011/012/016/017.)

---

## 20. Explicit MVP non-goals

Full Polsia capability parity · paid-ad execution · mass email outreach · automated refunds · autonomous financial commitments · automatic production deployment · hiring · legal commitments · native mobile application · human marketplace · industry packs · enterprise SSO · Kubernetes · Kafka · multi-region architecture · microservice-per-agent design · digital twin · fully autonomous company operation. Additionally: website/app generation and hosting (post-MVP/future by sequencing, §8.2/8.6), and any external-channel action of any kind.

---

## 21. Success metrics

| Metric | Definition | Initial target (beta) |
|---|---|---|
| Onboarding completion | % of created companies reaching approved understanding | ≥60% |
| Time to confirmed understanding | Median creation → understanding approval | ≤48h (founder-paced; instrument, then tune) |
| Assumptions corrected | Mean corrected/rejected AI assumptions per company pre-approval | >0 (proves review is real; watch distribution) |
| Strategy-option selection | % selecting/combining an option (vs abandoning) | ≥70% |
| Task completion | % of started task runs reaching Completed | ≥90% |
| Task failure | % of runs Failed with actionable detail shown | 100% of failures have TASK-006 detail |
| Revision frequency | Mean revisions per delivered document | Instrument (quality signal, no target yet) |
| Output usefulness | Owner rating ≥4/5 on delivered documents | ≥70% of rated outputs |
| Approval response | Median time pending-approval → decision | Instrument; alert >72h |
| Cost per completed task | Platform AI spend / completed task | Within unit-economics model (D-02) |
| Duplicate-action rate | Duplicate external effects per 1,000 external actions | 0 (MVP: no external actions; gate for Phase 6+) |
| Audit completeness | % of registry action types producing audit records | 100% |
| Emergency-stop reliability | % of stop tests halting new tool calls in-scope ≤5s | 100% |
| Tenant-isolation success | Adversarial isolation suite pass rate | 100% |
| User trust score | Post-onboarding survey: "I understand and control what the AI does" | ≥4/5 median |
| First-value completion | % of accounts receiving ≥1 useful document ≤7 days from signup | ≥50% |

---

## 22. Launch gates

The MVP cannot launch until every gate passes with recorded evidence:

1. Tenant-isolation tests pass (NFR-001) — including adversarial ID substitution.
2. Cross-company access is blocked and audited (NFR-001, MEM-003).
3. Unapproved actions cannot execute — server-side negative tests (APPR-009).
4. Modified approved payloads require reapproval — hash-invalidation test (APPR-004).
5. Duplicate jobs do not duplicate actions — replay suite zero-duplicates (NFR-006).
6. Failed tasks show understandable errors (TASK-006).
7. Usage and credits are correct — ledger reconciliation (BILL-002, USAGE-001).
8. Users can pause all activity — every stop scope verified (ADMIN-001).
9. Assumptions are visible and editable (UNDER-002/004, MEM-002).
10. Proposed and executed actions are clearly distinct (ACT-003).
11. Important events create audit records — completeness check (NFR-008).
12. Secrets do not appear in logs or browser responses — scanning + negative tests (NFR-018).
13. External actions use idempotency where required (NFR-006; vacuously true in MVP, test rig ready for Phase 6+).
14. Deactivation blocks new autonomous work (COMP-006, ACC-004).
15. Deleted or revoked integrations cannot be used (INTEG-003; test rig ready pre-integrations).

---

## 23. Risks

P = probability, I = impact (L/M/H). Owners are placeholders pending team assignment.

| Risk | P | I | Detection | Prevention | Mitigation | MVP requirement | Owner |
|---|---|---|---|---|---|---|---|
| Hallucinated business advice | H | H | Usefulness ratings; spot audits; source-check sampling | Source-linked research (WORK-002); confidence labels (UNDER-005) | Correction flow (J-06); outcome memory | TASK-005 provenance; MEM-003 | _[AI lead]_ |
| Weak research quality | M | H | Output rubric scores; revision rate | Curated research tooling; citation requirements | Revision loop (J-13); worker iteration | WORK-002 acceptance | _[AI lead]_ |
| Prompt injection via researched content | H | H | Injection test corpus; anomaly detection on tool calls | External content treated as data (NFR-021); tool firewall | Quarantine + task flag | NFR-021 | _[Security]_ |
| Excessive permissions | M | H | Allowlist audit; tool-call reviews | Least-privilege allowlists (WORK-005) | Capability disable (WORK-006) | WORK-005 server enforcement | _[Security]_ |
| Cross-tenant exposure | L | H | Adversarial suite in CI; audit anomalies | Company-scoped everything (NFR-001) | Incident runbook; disclosure policy | Gate 1/2 | _[Security]_ |
| Duplicate external actions | M | H | Replay tests; receipt reconciliation | Idempotency keys (NFR-006); TASK-009 | Duplicate suppression + incident | Gate 5 (rig in MVP) | _[Platform]_ |
| Uncontrolled AI cost | M | H | Spend dashboards vs caps | Hard caps (NFR-015, POL-001) | Task halt at cap; alerts | NFR-015 | _[Platform]_ |
| Misleading autonomy perception | M | H | Trust-score survey; support themes | Plain-language levels (APPR-008); ACT-003 | Copy review; onboarding education | ACT-003 | _[Product]_ |
| Poor generated code (future) | M | H | Quality gates results | BUILD-007 gates | Block deploy; regenerate | n/a (future) | _[Eng]_ |
| Failed deployment (future) | M | M | Health checks | DEPLOY-002 preview+approval | Rollback (BUILD-005) | n/a (future) | _[Eng]_ |
| Credential leakage | M | H | Secret scanning (CI, logs) | Reference-only vault (NFR-018, INTEG-002) | Rotation runbook | NFR-018 | _[Security]_ |
| Email abuse (future) | M | H | Volume/complaint monitoring | POL-002/003; EMAIL-002 consent checks | Channel suspension | n/a (future; policies land MVP) | _[Product]_ |
| Advertising violations (future) | L | H | Platform policy checks pre-approval | ADS-001 caps + approval | Campaign stop | n/a (future) | _[Legal]_ |
| Payment disputes (future) | L | H | Dispute rate monitoring | PAY-001 compliance-first design | Provider dispute flow | n/a (future) | _[Legal]_ |
| Vendor lock-in (ours to providers) | M | M | Architecture review | NFR-019 provider-neutral config | Abstraction layers | NFR-019 | _[Architecture]_ |
| Model-provider outage | M | M | Provider health monitoring | NFR-019 queue + failover | Honest status; drain on recovery | NFR-019 | _[Platform]_ |
| Queue/workflow failure | M | H | Dead-letter monitoring; heartbeats | NFR-005 checkpointing | Resume; manual recovery surface | NFR-005/007 | _[Platform]_ |
| Incorrect usage accounting | M | H | Ledger reconciliation jobs | Append-only ledger (BILL-002); atomic spend (TASK-004) | Correction entries, never edits | Gate 7 | _[Platform]_ |
| Approval bypass | L | H | Negative-path tests in CI; audit review | Server-authoritative gate (APPR-009, TOOL-003) | Incident + fix before any external capability | Gate 3/4 | _[Security]_ |
| User misunderstanding of AI limits | H | M | Support themes; trust survey | §7 honesty surfaced in product (ACT-003, UNDER-005) | Docs, onboarding, in-product explanations | Trust metric | _[Product]_ |
| Compliance risk (privacy/marketing/money) | M | H | Legal review checkpoints per phase | NFR-011/016; phase-gated external capabilities | Restrict affected markets/features (D-08) | NFR-011 pre-beta | _[Legal]_ |

---

## 24. Open questions

Ranked; full grouping in `OPEN-QUESTIONS.md`. **Blocking** = blocks the next phase (technical architecture) or a named phase.

| # | Question | Why it matters | Blocking? | Decision deadline | Owner | Evidence needed | Recommended method |
|---|---|---|---|---|---|---|---|
| OQ-01 | Primary MVP customer segment? | Shapes interview tone, option depth, pricing | ~~Blocking~~ **RESOLVED 2026-07-18 → ADR-001** | — | Owner | — | Decided: non-technical solo founder (§4) |
| OQ-05 | Managed vs customer-owned infrastructure for generated software? | Changes platform architecture fundamentally | ~~Blocking~~ **RESOLVED 2026-07-18 → ADR-002** | — | Owner | — | Decided: hybrid direction, managed defaults first, export mandatory, no MVP portability promise |
| OQ-06 | Do users bring their own AI keys (BYOK), platform keys, or both? | Cost model, trust posture, provider abstraction | ~~Blocking~~ **RESOLVED 2026-07-18 → ADR-003** | — | Owner | — | Decided: platform-managed keys + 16 pre-beta controls; BYOK post-MVP |
| OQ-19 | Model-provider strategy (multi-provider from day one vs single + abstraction)? | NFR-019 design depth | ~~Blocking~~ **RESOLVED 2026-07-18 → ADR-004** | — | Owner | — | Decided: provider-neutral gateway, one primary + one fallback, no dynamic routing |
| OQ-02 | Our base subscription price and inclusions? | Revenue model; unit economics | Blocks Phase 7 | Before Phase 7 build | _[Owner]_ | Cost-per-task data from alpha | Decide D-02 after alpha instrumentation |
| OQ-04 | Credits vs pure usage billing vs hybrid? | Billing architecture in Phase 7 | Blocks Phase 7 | Before Phase 7 build | _[Owner]_ | Alpha usage distribution | Decide D-02 |
| OQ-24 | Which external action ships first (email vs social vs deploy)? | Orders Phase 6+ integration work | Blocks post-MVP planning | End of Phase 6 | _[Owner]_ | Segment demand data | Decide D-05 |
| OQ-13 | What may one scheduled work shift include (budget, task count, stop rules)? | TASK-003 design | Blocks Phase 6+ scheduling | Before TASK-003 build | _[Owner + Product]_ | None (product definition) | Product spec addendum |
| OQ-14 | Exact safe-stop semantics for pause during in-flight run? | COMP-006/TASK-007 edge behavior | Non-blocking (MVP default: complete current tool call, then halt) | Phase 5 | _[Product]_ | None | Documented in architecture |
| OQ-18 | Data-retention periods per class? | NFR-016; legal exposure | Blocks Phase 7 | Before beta | _[Owner + Legal]_ | Jurisdiction requirements | Legal review |
| OQ-22 | Initial market/region and regulatory boundaries? | Privacy regime, marketing rules, money rules | Blocks Phase 7 | Before beta | _[Owner]_ | Target-market analysis | Decide D-08 |
| OQ-10 | Email autonomy boundaries (volumes, consent standards)? | EMAIL-002 policy defaults | Blocks email capability | Before email ships | _[Owner + Legal]_ | Deliverability/compliance review | Policy spec |
| OQ-12 | Social publishing autonomy defaults? | SOCIAL-001 approval defaults | Blocks social capability | Before social ships | _[Owner]_ | Segment trust data | Policy spec |
| OQ-16 | Infrastructure-portability promise strength (export-only vs guaranteed rebuild)? | EXPORT-002 scope; marketing claims | Non-blocking | Before EXPORT-002 | _[Owner]_ | Portability test results | Decide D-07 |
| OQ-17 | Git/repository ownership model for generated code? | BUILD/EXPORT design | Non-blocking | Before BUILD-002 | _[Owner]_ | None | Decide with D-07 |
| OQ-15 | Team-role depth beyond owner+viewer — which roles when? | ADMIN-003 sequencing | Non-blocking | Phase 7 planning | _[Owner]_ | Early-customer org shapes | Prioritize from §13 |
| OQ-11 | Customer-payment model and money-movement compliance? | PAY-001 feasibility | Non-blocking (future) | Before PAY-001 | _[Owner + Legal]_ | Regulatory analysis | Legal opinion |
| OQ-23 | Advertising control model (our account vs client accounts)? | ADS-001 design; fee model | Non-blocking (future) | Before ADS-001 | _[Owner]_ | Platform policy review | Product spec |
| OQ-20 | Cross-company learning: any, and under what privacy boundary? | Memory architecture; privacy promises | Non-blocking (default: none) | Before any cross-company feature | _[Owner]_ | Privacy analysis | Decide explicitly; default is strict isolation |
| OQ-21 | Human support model for beta (channels, SLAs)? | Phase 7 operations | Non-blocking | Before beta | _[Owner]_ | Support-volume estimate | Ops plan |
| OQ-03 | Reference product's real extra-company price ($20 vs $25)? | Market intelligence only — our price is D-02 | Non-blocking | n/a | _[Research]_ | Purchase-flow or support confirmation | C-02 verification (optional) |
| OQ-07 | Reference continuous-mode actual behavior? | Calibrates our L4-5 design | Non-blocking | Before L4-5 design | _[Research]_ | Sandbox activation | Disposable-company test |
| OQ-08 | Reference auto-retry semantics? | Market intelligence for TASK-010 | Non-blocking | n/a | _[Research]_ | Induced-failure observation | Disposable-company test |
| OQ-09 | Reference rollback behavior? | Calibrates BUILD-005 | Non-blocking | Before BUILD-005 | _[Research]_ | Two-deploy rollback test | Disposable-company test |

Blocking-for-architecture count: **0** — all four former blockers (OQ-01, OQ-05, OQ-06, OQ-19) resolved 2026-07-18 via ADR-001…ADR-004; the OQ-22 residency aspect resolved via ADR-005. Narrow follow-ups OQ-25…OQ-28 added in `OPEN-QUESTIONS.md` (architecture-phase and pre-beta, none blocking). Phase-blocking remainder unchanged.

---

## 25. Owner decisions

Worksheet with alternatives and impacts: `OWNER-DECISIONS.md`; accepted records: `../docs/decisions/ADR-001…005`.

| ID | Decision | Needed by | Status |
|---|---|---|---|
| D-01 | Primary MVP customer segment | Architecture start | ✅ **Approved 2026-07-18 (ADR-001)** |
| D-02 | MVP commercial model (price, inclusions, credits vs usage) | Phase 7 build | Pending |
| D-03 | Does the MVP-era platform provision infrastructure (hosting/DB) for generated software? | Architecture start | ✅ **Approved 2026-07-18 (ADR-002)** |
| D-04 | Do users bring their own AI keys? | Architecture start | ✅ **Approved 2026-07-18 (ADR-003)** |
| D-05 | First supported external action | End of Phase 6 | Pending |
| D-06 | Initial approval model confirmation (levels 1–2 MVP as specified, or stricter/looser) | Phase 6 build | Pending (PRD default stands) |
| D-07 | Code ownership and export promise (strength of portability commitment) | Before BUILD/EXPORT-002 | Pending |
| D-08 | Initial market and region | Before beta | ⚠️ **Residency sub-question approved 2026-07-18 (ADR-005)**; market/region selection pending |
| D-09 | Branding and final product name | Before beta | Pending |
| D-10 | Is the existing-business path (J-03) in MVP? | Phase 2 build | Pending |

### 25.1 Approved decisions in force (2026-07-18)

- **Primary customer (ADR-001):** non-technical solo founder validating a digital/SaaS idea; secondary waves: multi-idea entrepreneurs → SMB owners → agencies/studios; MVP not designed primarily for agencies, enterprises, or engineering teams (§4 updated).
- **Infrastructure direction & MVP boundary (ADR-002):** hybrid long-term; platform-managed defaults first; no user infrastructure configuration in onboarding; **source code, generated documents, and customer data must be exportable** (BUILD-003, EXPORT-001); transfer-aware design, provider abstractions where practical; **full portability is not an MVP promise**, and marketing must not claim migration/transfer/provider-independence capabilities that do not exist. Managed-vs-portability tension recorded (ADR-002 §11).
- **AI access (ADR-003):** platform-managed provider keys; no customer AI keys at onboarding; 16 pre-beta controls binding (usage recording per company **and per account**, model/version tracking, token measurement, cost estimation, hard limits, rate limits, budget alerts, abuse detection, timeout handling, failure normalization, secret isolation, server-side credential use, no keys to clients, redacted logging, data-path disclosure); **BYOK post-MVP only via a new approved decision**. Note: the per-account usage rollup amendment to USAGE-001 was executed 2026-07-18 as a controlled clarification (change log 1.2.0-draft).
- **Model gateway (ADR-004):** provider-neutral internal gateway (internal boundary, not a product); one primary + one fallback model; fallback only for approved failure conditions or supported task classes; **no dynamic price/quality/latency routing**; 13 gateway capabilities form the internal contract; no provider-specific behavior in product code.
- **Data residency (ADR-005):** beta makes **no strict-residency promises**; non-foreclosure of future regional deployment; data locations, provider processing locations, and subprocessors documented; no unsupported country claims; regulated strict-residency customers out of beta scope.

All other decisions remain open; where a recommendation exists it is labeled as such.

---

*End of Master PRD v1 (draft). This document supersedes `raw-audit/10-product-requirements.md` and `raw-audit/11-product-requirements-document.md` as the product source once approved; those files remain preserved as evidence with traceability via `EVIDENCE-CROSSWALK.csv`.*
