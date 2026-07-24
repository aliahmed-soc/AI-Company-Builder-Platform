# @acbp/core

**Scaffold stub (ACBP-P0-011) — no product functionality yet.**

- **Responsibility:** Application modules; orchestrates domain + database + gateway/adapters via contracts
- **Allowed dependencies:** domain, contracts, database, gateway (via interface), adapters (via interface), observability
- **Forbidden dependencies:** provider SDKs directly; UI
- **Runtime:** both
- **Governing ADRs:** 006-017

Dependency-boundary enforcement (import-lint) is added by **ACBP-P0-012**, per
`docs/implementation/REPOSITORY-SCAFFOLD-SPEC.md` (Required dependency rules).

## Model gateway (ACBP-P2-003; ADR-011, ADR-019; CDR-026)

The provider-neutral in-process seam every product module uses to run a model call. Product code speaks the
`ModelGatewayRequest`/`ModelGatewayResult` contract (`@acbp/contracts`) and NEVER touches a provider dialect.

- **`callModel(deps, request)`** (`src/model/model-gateway.ts`) — the pure use case: company-policy pre-check,
  per-class timeout (the enforced deadline is derived from `taskClass`, not a caller field), bounded idempotent
  retry (≤2) + schema-first bounded re-ask (≤1), fallback eligibility by task class (quality-bearing
  **generation never silently falls back** — ADR-019), a normalized seven-value error taxonomy (raw provider
  text is never logged or returned), model-version stamping, redacted logging, and append-only usage metering.
  Providers and the usage sink are **injected** — the use case imports no provider SDK and no DB module.
- **`createModelGateway(client, cfg)`** (`src/composition/model-gateway.ts`) — binds `callModel` to the concrete
  DB usage sink. Each call meters one append-only `usage_events` row under the request's company scope
  (dual-keyed FORCE RLS), written in its own short tenant transaction **after** the external model call.
- **Deferred owner gate:** live provider wiring (real key + `gpt-5.1` snapshot pin + ADR-019 §13 eval gate) is
  NOT built — a deterministic fake provider is the only wired adapter (CDR-026 §0).

### Operational notes

- **Fail-closed metering.** If the usage-event write fails, `callModel` throws and the model output is
  **withheld** (never returned as success) — no un-metered output is ever surfaced. Operationally this presents
  as a rejected call plus a redacted **`model.metering_failed`** error log (provider/model/taskClass/outcome/
  latency/correlationId only — never prompt/response content or the raw DB error). A spike in this log is a
  metering/DB-write incident, not a model incident.
- **`model.validator_unwired`** (error log) means a request referenced an output schema but the gateway was
  built without a validator; the call is refused with a normalized `internal` error before any provider call.
  This is a wiring/deploy defect to fix, not a runtime condition.
- **`usage_events`** is append-only (SELECT+INSERT only; no UPDATE/DELETE) and billing-retention durable — a
  correction is a new row, never an in-place edit. It carries bounded metadata only; there is no content column.
