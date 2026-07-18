# ADR-017 — Observability and Error Handling

1. **Title:** Correlation-ID-threaded structured telemetry with mandatory redaction pipeline and normalized user-facing errors
2. **Status:** Accepted (owner review 2026-07-18 — `docs/architecture/ARCHITECTURE-OWNER-REVIEW.md`)
3. **Date:** 2026-07-18
4. **Context:** NFR-009 requires end-to-end traceability with secret-free telemetry; TASK-006 requires actionable user-facing failure detail; ADR-011 forbids raw provider errors reaching users.
5. **Decision proposal:** Correlation IDs accepted/generated at the API edge and propagated through jobs, runs, tool calls, model calls, events, audit records — one task ID resolves a full trace. Structured JSON logs through a redaction pipeline (serializer denylists + secret scanner; prompts logged by reference into restricted storage). OpenTelemetry-style traces; module metrics per the required list (OBSERVABILITY §2); error-tracking SaaS integration. Error handling: internal taxonomy everywhere; user-facing envelope `{category, user_message, correlation_id, retryable}`; provider errors normalized at the gateway; failure detail surfaces per TASK-006 (category, human summary, attempts, retry safety, support-bundle reference). Alert tiers: page (audit-write failure, stop-system failure, provider hard-down, isolation-probe failure, cost anomaly) vs notify (fallback spike, queue lag, reconciliation drift).
6. **Requirement IDs:** NFR-009, NFR-018, TASK-006, TASK-010, ACT-005, NFR-019.
7. **Alternatives:** Unstructured logging (unqueryable, redaction-unsafe); full third-party APM lock-in (acceptable but keep OTel-compatible exports); logging raw prompts inline (violates NFR-018 posture).
8. **Benefits:** Debuggability without privacy leaks; support diagnostics keyed by correlation ID; honest user errors.
9. **Costs:** Redaction pipeline engineering; telemetry spend.
10. **Risks:** Redaction gaps (CI scanners + log-pipeline scanners as double net); alert fatigue (tiering discipline).
11. **Security implications:** Telemetry is a leak surface — treated as such by design.
12. **Operational implications:** Dashboards/runbooks per OBSERVABILITY-AND-OPERATIONS.md.
13. **Reversal cost:** Low.
14. **Scale trigger:** Sampling policies at volume.
15. **Open questions:** AOQ-11 (support tooling scope for beta).
16. **Owner approval:**

```text
Owner decision:
[x] Accept   [ ] Accept with changes   [ ] Reject   [ ] Defer
Notes: Accepted. Render's native log/metric surfaces complement but do not replace the structured redacted pipeline.
Date: 2026-07-18
```
