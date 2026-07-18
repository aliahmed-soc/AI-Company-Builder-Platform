# CDR-002 — Model Evaluation Dataset and Thresholds

1. **ID:** CDR-002
2. **Title:** Evaluation dataset construction and initial thresholds for the ADR-019 ten-area gate
3. **Status:** Accepted (initial thresholds; calibration amendment after baseline run)
4. **Date:** 2026-07-18
5. **Owner:** Product owner (methodology); engineering (calibration within recorded bounds)
6. **Source ticket:** ACBP-P0-002 (IOQ-02 / AOQ-19)
7. **Context:** ADR-019 §13 mandates a pre-production evaluation gate across ten areas; thresholds must be reproducible and must choose configuration values, not rewrite architecture.
8. **Decision:** Purpose-built, **versioned** eval dataset derived from PRD journeys (J-04…J-13) and audit-derived business scenarios, containing zero real tenant data. Four-tier metric structure per area: **hard release threshold / warning threshold / comparative benchmark (primary vs fallback) / fixed human-review sample**. Initial hard gates: structured-output validity ≥98% · adaptive-question rubric ≥4/5 on ≥80% of scripted sessions · fact-vs-assumption classification ≥95% (labeled set) · contradiction detection ≥80% (seeded pairs) · strategy distinctness 100% seeded-near-duplicate rejection + ≥90% rubric-distinct triples · citation preservation ≥95% · revision consistency ≥4/5 on ≥80% · refusal correctness 100% (unsafe-request set) · latency p90 within NFR-004-derived class budgets · estimated cost within task-class budget envelope. Warning thresholds at 5-point/percentage tighter margins; all values live in versioned eval config.
9. **Scope:** Evaluation harness + configuration; gates block per TEST-AND-VERIFICATION layer map (initial areas at M2/M3; full ten at the closed-beta gate).
10. **Alternatives:** public benchmarks (poor task fit); human-only review (not reproducible).
11. **Reasons:** Only a purpose-built set tests the product's actual differentiators; versioning + pinned models (CDR-001) + fixed rubric = reproducibility.
12. **Security impact:** Refusal/safety area is a hard gate; dataset excludes tenant data by construction.
13. **Reliability impact:** Regression detection on re-pin; fallback comparative benchmark quantifies degradation for eligibility rules.
14. **Operational impact:** Eval runs budget-capped; report retained as gate evidence.
15. **Cost impact:** Bounded eval spend per run.
16. **Portability impact:** Dataset/rubric are provider-neutral.
17. **Reversal cost:** Low (config); threshold changes require CDR amendment (never silent).
18. **Requirement IDs:** NFR-019, DISC-001, DISC-003, DISC-004, STRAT-001, WORK-002, NFR-004.
19. **Governing ADRs:** ADR-019, ADR-011.
20. **Implementation tickets unblocked:** ACBP-P2-011, ACBP-P3-006, ACBP-P7-012.
21. **Review trigger:** Baseline run (calibration; tighten-only without new amendment); model re-pin; any area failure.
