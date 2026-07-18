# CDR-001 — Pinned Model Identifiers

1. **ID:** CDR-001
2. **Title:** Initial pinned model identifiers for the model gateway
3. **Status:** Accepted (with binding pin-before-production condition)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (per approved Phase 0 decision sprint; families pre-accepted in ADR-019)
6. **Source ticket:** ACBP-P0-001 (IOQ-01 / AOQ-18)
7. **Context:** ADR-019 accepted the families (GPT-5.1 primary, Claude Sonnet 4 fallback) and required exact identifiers/snapshots resolved before implementation. Public-documentation verification confirmed GPT-5.1 as a live API model with snapshot support and `claude-sonnet-4-6` as the Sonnet-4-family canonical pinned ID. No provider account was accessed.
8. **Decision:** Primary = **`gpt-5.1`**, with the **exact dated snapshot read from the account model catalog and pinned in gateway configuration at ACBP-P2-003, before any production model call** (dateless alias never ships to production). Fallback = **`claude-sonnet-4-6`** (pinned-by-ID per Anthropic versioning semantics).
9. **Scope:** Gateway configuration slots only; ADR-011 contract untouched; no provider names outside gateway/config.
10. **Alternatives:** dateless aliases in production (rejected — silent drift breaks eval reproducibility); deferring both pins (rejected — blocks Phase 2 needlessly).
11. **Reasons:** Reproducibility (ADR-019 §8a); the fallback is already snapshot-stable by ID; the primary's dated pin is account-catalog data that cannot be honestly guessed.
12. **Security impact:** Both providers documented in the subprocessor register with processing locations (ADR-005); data-path disclosure names both (ADR-003 §16).
13. **Reliability impact:** Two failure domains preserved; fallback eligibility per ADR-011/019 (no silent fallback for material decisions).
14. **Operational impact:** Snapshot-lifecycle watch (deprecation notices) added to ops cadence.
15. **Cost impact:** Recorded per call (usage events); no commercial commitment made.
16. **Portability impact:** Swap = config + regression suite (ADR-011 §13).
17. **Reversal cost:** Low.
18. **Requirement IDs:** NFR-019, USAGE-001, TOOL-002.
19. **Governing ADRs:** ADR-004, ADR-011, ADR-019, ADR-003, ADR-005.
20. **Implementation tickets unblocked:** ACBP-P2-003, ACBP-P2-005, ACBP-P2-008, ACBP-P3-001 (via P2-003 chain), ACBP-P2-011 (with CDR-002).
21. **Review trigger:** Provider deprecation notice; eval regression below CDR-002 thresholds; ADR-019 triggers (cost >25%, repeated fallback failure, stronger model at threshold).
