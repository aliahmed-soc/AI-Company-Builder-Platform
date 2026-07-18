# ADR-001 — Primary MVP Customer

1. **Title:** Primary MVP customer segment
2. **Status:** Accepted
3. **Date:** 2026-07-18
4. **Decision owner:** Product owner
5. **Context:** The MVP loop (idea → interview → understanding → strategy options → roadmap → safe knowledge-work task → useful document) must be tuned for a specific user. Four candidate segments were analyzed in `product-specification/OWNER-DECISION-PACK.md` (Decision 1) against 11 criteria. Leaving the target as "everyone who wants to build a company" was explicitly rejected in the Master PRD §4.
6. **Decision:** The primary MVP customer is the **non-technical solo founder validating and planning a digital business, SaaS product, or online service** — a person who has an idea but may lack a complete business plan; needs help identifying the customer and problem; needs assumptions challenged; wants several strategic options; needs an actionable roadmap; cannot independently perform all research and planning; and wants AI assistance without giving up decision authority. Secondary future segments, in order: (1) entrepreneurs testing multiple business ideas, (2) existing small-business owners seeking AI-assisted growth, (3) agencies and venture studios managing several ventures. The MVP must **not** be designed primarily for agencies, enterprises, or advanced engineering teams.
7. **Alternatives considered:** Technical founders (self-sufficient but under-value the MVP's document outputs vs raw LLM use); existing small-business owners (highest trust/integration demands — the integration-free MVP under-delivers for them); agencies/venture studios (forces the full §13 role matrix into MVP). Full trade-off tables preserved in OWNER-DECISION-PACK.md Decision 1.
8. **Reasons:** This segment's complete early journey equals the MVP loop exactly, requires zero integrations, uses precisely the three MVP workers, and its stated anxieties are answered by the §11 differentiators.
9. **Positive consequences:** No MVP scope change needed; fastest time to first value; trust features validated by the most trust-sensitive self-serve segment; self-serve acquisition.
10. **Negative consequences:** Price-sensitive segment caps early revenue; highest support burden of the four options; honest idea-validation can cause churn when it works correctly.
11. **Risks:** Conversion below viability; emotional reaction to critical strategy output; research-quality wobble disproportionately damaging (PRD §23 hallucinated-advice risk).
12. **Mitigations:** WORK-002 quality rubric; UNDER-005 confidence display; §21 trust and usefulness metrics instrumented from alpha; support-burden monitoring.
13. **Reversal cost:** **Low** — repositioning (copy, interview tone, metric targets), not schema or infrastructure rework.
14. **PRD requirement IDs affected:** COMP-001 (idea mode primary), DISC-001, DISC-003, DISC-005, DISC-006 (interview tuned for non-technical founders), UNDER-001, UNDER-005, STRAT-002, STRAT-004 (option depth and plain-language rationale), ADMIN-003 (owner+viewer sufficient for MVP), NFR-004, NFR-015 (self-serve volume posture).
15. **Architecture areas affected:** Self-serve onboarding/auth flow; consumer-scale cost controls; no enterprise SSO or role-matrix work in MVP (consistent with PRD §20).
16. **Follow-up decisions:** D-02 pricing for this segment (after alpha data); D-10 existing-business path scope (Phase 2); wave-two timing for small-business owners.
17. **Review trigger:** Alpha data showing first-value completion <50% or trust score <4/5 (PRD §21) for this segment; or a strategic pivot toward B2B revenue.
