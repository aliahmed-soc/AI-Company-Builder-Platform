# ADR-011 — Model Gateway Contract

1. **Title:** Internal model-gateway contract implementing accepted ADR-004
2. **Status:** Accepted with amendment (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`; strategy already accepted via ADR-004)
3. **Date:** 2026-07-18
4. **Context:** ADR-004 (accepted) mandates a provider-neutral internal gateway, one primary + one fallback model, no dynamic routing, 13 gateway capabilities.
5. **Decision proposal:** A single in-process module with stable request/response types: request `{task_class, template_ref@version, context_parts[], output_schema_ref, budget, timeout_class, company_id, correlation_id, policy_context}`; response `{outcome, validated_output?, error_category?, provider, model@version, token_usage, estimated_cost, fallback_used, latency_ms}`. Provider dialects live only in gateway adapters. Schema-first structured outputs with bounded re-ask; per-class timeouts; bounded idempotent retries; fallback eligibility per task class (quality-bearing generation prefers queueing per NFR-019); every call meters usage+cost to company and account; redacted logging (raw content by reference in restricted storage); normalized error taxonomy (`timeout · rate_limited · provider_unavailable · invalid_output · content_refused · budget_exceeded · internal`); model-version stamped on calls and derived artifacts; company-policy pre-check (caps/tier); credentials resolved server-side at call time — never in payloads, never to clients.
6. **Requirement IDs:** NFR-019, NFR-007, NFR-009, NFR-015, NFR-018, USAGE-001, TOOL-002.
7. **Alternatives:** Direct provider SDK use across modules (dialect leakage, per-call metering drift); external AI-gateway product (third party in the data path against ADR-003/005 disclosure posture); building routing logic (excluded by ADR-004).
8. **Benefits:** One metering, redaction, and failover point; BYOK-later is a config change (ADR-003); model swap = config + regression suite.
9. **Costs:** Two adapters + golden/smoke suites.
10. **Risks:** Abstraction leaks; fallback quality drift (mitigate: eligibility rules + fallback-rate metric).
11. **Security implications:** Single credential-resolution point; invariants 12/13 enforced here.
12. **Operational implications:** Gateway metrics power provider-health dashboards (NFR-019 status).
13. **Reversal cost:** Low — the gateway is the hedge (ADR-004 §13).
14. **Scale trigger:** Per ADR-004 review triggers only.
15. **Open questions:** AOQ-01 (exact primary/fallback models — separate implementation-facing ADR).
16. **Owner approval:**

```text
Owner decision:
[ ] Accept   [x] Accept with changes   [ ] Reject   [ ] Defer
Notes: AMENDMENT — the gateway contract stays configuration-free; initial model configuration (primary GPT-5.1, fallback Claude Sonnet 4) is recorded separately in ADR-019 with the evaluation gate, non-silent-fallback rule, and pinned-snapshot follow-up. No provider names in product-domain modules.
Date: 2026-07-18
```
