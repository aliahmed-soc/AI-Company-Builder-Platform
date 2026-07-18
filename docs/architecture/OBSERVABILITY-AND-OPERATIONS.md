# Observability and Operations

Status: Proposed. Governs NFR-008/009, ADR-017. Diagram: `diagrams/11`.

## 1. Telemetry model

- **Correlation IDs:** generated/accepted at the API edge; propagated through jobs, worker runs, tool calls, model calls, events, and audit records. A single task ID resolves to a complete end-to-end trace (NFR-009 acceptance).
- **Tenant-safe logs:** structured JSON; tenant identifiers as opaque IDs only; cross-tenant log queries are role-controlled; the redaction pipeline (below) runs before persistence.
- **Metrics:** counters/histograms per module, tenant-aggregated (never per-tenant-content).
- **Traces:** OpenTelemetry-style spans across api → job → worker → gateway → storage.
- **Redaction pipeline:** logs must never contain provider keys, access tokens, full secret values, unredacted sensitive prompts, or cross-tenant identifiers without controlled access. Enforced by: serializer denylists, a log-pipeline secret scanner, prompt logging by reference (raw content in restricted storage), and CI scans (NFR-018 — zero-findings gate).

## 2. Required operational metrics

Task queue depth · task success/failure rate · task latency (queue-to-complete, p50/p90) · worker availability (heartbeats) · model-call latency (per class) · model-call error rate (per normalized category) · model fallback rate · estimated model cost (per company/account/day vs caps) · usage-limit blocks · approval wait time (request→decision) · policy blocks (per rule) · duplicate-action prevention count · audit-write failures (page-level alert — see FAILURE §14) · emergency-stop activations.

## 3. Dashboards, alerting, runbooks

| Surface | Contents |
|---|---|
| Task-run dashboard | Live runs, states, latencies, failure categories, dead-letter queue |
| Queue health | Depth, pickup lag, oldest job age; alert thresholds |
| Model-provider health | Error rates, latency, fallback rate per provider; feeds NFR-019 status banner |
| Cost monitoring | Estimated spend vs caps per company/account; reconciliation drift (ADR-013 §4) |
| Error monitoring | Error-tracker integration; new-error alerting; release regression views |
| Audit monitoring | Audit write latency/failures; integrity check results |
| Alerting | Page: audit-write failure, isolation-test failure in prod probes, stop-system failure, provider hard-down, cost-cap anomaly. Notify: fallback-rate spike, queue-lag, reconciliation drift |
| Runbooks (pre-beta set) | Provider outage; job-store recovery; DB restore drill (NFR-017); secret rotation/leak response; emergency-stop + resume review; billing webhook failure; support data-access (reason-captured) |
| Support diagnostics | Correlation-ID lookup tool; tenant-scoped run traces; export of a task's support bundle (TASK-006) — all access audited |
| Administrative actions | Via the admin surface only (SECURITY §3): reason capture, audit, no silent impersonation |
| Incident response | Severity taxonomy, on-call (beta), tenant notification policy, post-incident review reconstructing from audit trail |
