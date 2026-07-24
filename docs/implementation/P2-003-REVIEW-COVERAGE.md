# ACBP-P2-003 — independent review coverage

An independent security + scope reviewer examined the complete diff (`main...HEAD`) of the model gateway v1
(contracts → migration 0017 → core gateway + fake provider → composition) against ADR-011, CDR-026, and the
CLAUDE.md rules, alongside the pre-existing contracts it depends on (`model-provider.ts`, `errors.ts`,
`withTenantTransaction`) and the real-PG test evidence.

## Security + scope review — CLEAN (no CRITICAL/HIGH)

All eight reviewed invariants **PASS**, with explicit verdicts:

- **Secrets/redaction:** provider errors are collapsed to the seven-value taxonomy (`classifyProviderError`)
  before anything is logged; raw provider text is caught in `singleCall` and never logged; logs carry only
  `redactedMeta` (provider/model/taskClass/outcome/errorCategory/fallbackUsed/latencyMs/correlationId) — no
  prompt/response content; `usage_events` has no content column. Redaction tests plant a context canary + an
  internal marker and prove neither reaches logs.
- **Architectural boundaries:** `@acbp/core/model` imports only `@acbp/contracts` + `@acbp/observability` (no
  provider SDK, no `@acbp/database`); the fake provider imports only `@acbp/contracts`; the composition is the
  sole importer of `@acbp/database`; no cycle; no provider SDK/dependency added anywhere.
- **Tenancy/RLS:** `usage_events` is dual-keyed FORCE RLS, SELECT+INSERT only — no UPDATE/DELETE grant, no UPDATE
  policy (append-only, invariant 9); the composition writes under the request's company scope; the real-PG
  catalog test asserts exactly `[INSERT, SELECT]` policies+grants and the SECURITY DEFINER allowlist stays at
  three.
- **Fail-closed metering, no silent fallback, money discipline, bounded concurrency, scope** — all confirmed
  correct (retry ≤2 + re-ask ≤1 use separate bounded counters → no unbounded loop; `Promise.race` reactions
  attached to both inputs → no unhandled rejection; generation task class never touches the fallback; no live
  provider SDK/credential/network call/HTTP route added; migration additive; synthetic fixtures only).

## Finding dispositions

| # | Severity | Finding | Disposition |
|---|---|---|---|
| MED-1 | Medium (metering accuracy) | The gateway metered only the FINAL attempt's tokens; a bounded re-ask (or a response-returning failure) consumed additional tokens that went uncounted — a latent under-report once live providers land. | **FIXED (code).** `singleCall` now surfaces per-call `providerUsage` whenever the provider returned a response; `runProvider` ACCUMULATES tokens across every attempt (re-asks) and `callModel` sums primary + fallback consumption into the ONE usage event. Retryable infra failures throw without usage → contribute zero. New/updated unit assertions: a re-asked call (success and invalid_output) meters the SUM of both attempts, not the last try. Recorded in CDR-026 §5. |
| LOW-1 | Low (money discipline) | `estimatedCostMicros` was passed straight from the injected pricing function to the `integer` column; a float would be silently rounded by Postgres rather than rejected. | **FIXED (code).** The gateway coerces the pricing result at the seam: `Number.isFinite(raw) ? Math.max(0, Math.trunc(raw)) : 0`. A mis-implemented pricing config can no longer silently violate "never a float." Recorded in CDR-026 §5. |
| LOW-2 | Low (doc precision) | CDR-026 said the usage event is written "in the SAME transaction as the gateway work," but the composition opens its own short transaction AFTER the external model call. | **FIXED (doc).** CDR-026 §5 now states the usage insert is the ONLY DB write in a gateway call, written in its own short tenant transaction after the external call; fail-closed holds trivially (atomic single write; failure → throw + output withheld). The composition comment already noted this. |
| LOW-3 | Low / informational | On a metering-write failure, `normalizeError` retains the raw DB error text INTERNALLY (`internalMessage`/`cause`) of a `category:'internal'` PlatformError; the public envelope is generic. | **Retained (safe by construction).** The gateway never logs it; `toPublic()/toJSON()` are structurally allowlisted. Noted the standing dependency that upstream handlers must not log `.toInternal()`/`.message` for this error — the established platform logging discipline (P0-016/ADR-017). |

## Residuals

None actionable outstanding. The one metering-accuracy fix (usage accumulation) + the money-discipline guard are
applied with tests; the two documentation refinements are made; the retained LOW is a documented, platform-wide
redaction guarantee. The reviewer confirmed the change is scope-clean — the provider-neutral abstraction + a
deterministic fake provider only — with the live-provider path correctly deferred as an owner gate (CDR-026 §0).
