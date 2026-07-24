# CDR-026 — Model gateway v1 (ACBP-P2-003)

**Status:** Accepted (autonomous lead, standing Phase 2 authorization) for the provider-neutral abstraction +
fake-provider scope. **Requirements:** NFR-019, USAGE-001, NFR-007, NFR-009. **Governing ADRs:** ADR-011 (gateway
contract), ADR-019 (initial model config), ADR-013 (usage/cost separation), ADR-004 (provider strategy).
**Architecture:** AI-AND-WORKER-ARCHITECTURE.md §3. **Depends on:** P0-019, P0-001 (Done). **Blocking question
IOQ-13 — RESOLVED by the owner** (§1).

The in-process, **provider-neutral** model gateway implementing the ADR-011 ModelRequest/Response contract: call
a model for a `task_class` with a per-class timeout, bounded idempotent retry, schema-first structured output
with bounded re-ask, fallback eligibility, a normalized error taxonomy + redacted logging, a company-policy
pre-check hook, server-side credential resolution, and **append-only usage-event emission with fail-closed
metering**. It is an INTERNAL `@acbp/core` + `@acbp/adapters` service (no HTTP route) called by later consumers
(P2-005 generation, P2-007 assembly, P2-008 understanding, workers).

## 0. OWNER GATE — live provider wiring is DEFERRED (not built in P2-003)

P2-003 builds the gateway **abstraction + a deterministic FAKE provider** (autonomous). **Making a real,
production model call is a hard owner gate and is NOT in this ticket's autonomous scope** — it requires three
separate owner approvals, each a CLAUDE.md gate ("real credential/login", "create/modify a live external
resource", "new paid provider"):
1. Provisioning/loading a **real OpenAI (or Anthropic) platform API key** into the vault (ADR-003; ADR-011 —
   credentials resolved server-side, never in payloads).
2. Reading the **provider account model catalog to pin the exact `gpt-5.1` dated snapshot** (CDR-001 §8 — the
   dateless alias never ships; "No provider account was accessed").
3. The **ADR-019 §13 mandatory pre-production evaluation gate** (delivered by P2-011 eval suite + P7-012), which
   must pass before any AI feature enters production.

P2-003 therefore ships with a **fake provider** as the only wired adapter; the real provider adapter(s) are
**structured** (the interface + a placeholder for the concrete OpenAI/Anthropic classes) but **not live-wired**.
CONFIGURATION.md confirms no provider credential is required to build/validate; the backlog acceptance uses a
synthetic "seeded secret". **When P2-004/P2-005 need real generation, the live wiring is surfaced as the owner
gate above.**

## 1. IOQ-13 — OWNER-RATIFIED timeout/retry values

The owner ratified the proposed class defaults (IMPLEMENTATION-OPEN-QUESTIONS.md IOQ-13, now Resolved):
**interactive timeout ≈ 30 s, generation timeout ≈ 120 s, bounded retries ≤ 2**, to be tuned from telemetry.
Recorded here (choosing config values inside accepted contracts requires a decision record — DoD). Retry uses a
**bounded exponential backoff** (NFR-007); retries are **idempotent-safe** (pure model calls) and must NOT
duplicate the usage-event side effect.

## 2. The contract (`@acbp/contracts`)

- **`TaskClass`** (drives timeout + fallback eligibility) and **`TimeoutClass`** (`interactive` ≈ 30 s /
  `generation` ≈ 120 s). Quality-bearing generation classes are fallback-INELIGIBLE (queue/surface honestly, no
  silent fallback — ADR-019(e)); extraction/classification classes are fallback-eligible.
- **`ModelRequest`**: `{ taskClass, templateRef@version, contextParts[], outputSchemaRef, budget, timeoutClass,
  companyId, correlationId, policyContext }` (per ADR-011). NOTE: `contextParts`/`templateRef` are produced by
  P2-007/P2-004 — the gateway RECEIVES them opaquely.
- **`ModelResponse`**: `{ outcome, validatedOutput?, errorCategory?, provider, model@version, tokenUsage,
  estimatedCost, fallbackUsed, latencyMs }`.
- **Normalized error taxonomy** (the ONLY thing surfaced): `timeout · rate_limited · provider_unavailable ·
  invalid_output · content_refused · budget_exceeded · internal`. Retryable = `{timeout, rate_limited,
  provider_unavailable}`; terminal = the rest. **Raw provider exception text is NEVER logged or returned**
  (CLAUDE.md).
- **`ModelProvider` adapter interface** (provider-neutral): the one method the gateway calls; concrete providers
  live only in `@acbp/adapters`.

## 3. The provider adapter (`@acbp/adapters`)

A **deterministic, controllable FAKE provider** implementing `ModelProvider` — the only adapter wired in P2-003.
It is programmable per test to return a valid output, an invalid output (drive `invalid_output` + re-ask), a
timeout, a rate-limit, a refusal, or to echo — enabling the contract + **fault-injection** + **redaction** tests
(backlog required tests) without any live call. The concrete OpenAI/Anthropic adapters are deferred (§0). Provider
names/dialects appear ONLY in `@acbp/adapters` and configuration — never in product-domain modules (AI-AND-WORKER
§3).

## 4. The gateway use case (`@acbp/core`)

`callModel(request)`: company-policy pre-check hook → resolve provider + pinned model/config (server-side) →
attempt with the class timeout → on a retryable error, bounded retry (≤2, backoff) → on a terminal invalid_output,
bounded **re-ask** (schema-first) → on exhaustion, **fallback eligibility** (queue vs fallback per task class;
record the `fallbackUsed` reason; NO silent fallback for material classes) → validate the structured output
against `outputSchemaRef` → **write the append-only usage event in its OWN short tenant transaction AFTER the
(external) model call (fail-closed: a metering-write failure throws and the output is withheld); the
`model.call_completed` log line is emitted after that write — it is not a second transactional co-write** →
return the `ModelResponse` (normalized error category on failure). The enforced per-call deadline is derived
from `taskClass` (its policy timeout class), so it cannot be under-cut by an inconsistent request `timeoutClass`. **Redacted logging:** raw prompt/response content is referenced, never inlined; the
"seeded secret" never appears in logs; provider errors are normalized before logging.

## 5. Usage metering + the audit mechanism (§ analogous to CDR-023/CDR-024)

The **append-only `usage_events` row (migration 0017) IS the durable, immutable "usage source record"** for every
model call (EVENT-CATALOG: `model.call_completed` → Usage ledger, "usage source record", ≥billing retention;
DATA-ARCHITECTURE Usage event = append-only, invariant 9, company+account attribution). It carries
`{provider, model@version, tokenUsage, estimatedCost, fallbackUsed, latencyMs, outcome, correlationId,
taskClass}` — bounded metadata, **no prompt/response content**. `estimatedCost` is the **provider-cost estimate**
(from a small per-model pricing config), NOT billable/credit mapping (the five-number separation, ADR-013 —
credits/reservation/rollup are P5-014/P6-009, deferred).

**Audit mechanism (flagged for owner visibility):** the backlog's "model.call_completed audited" is realized by
this append-only, immutable usage_events row — the durable source record of every call — **not** by a separate
`audit_events` entry. Registering model.call_completed in the closed `AUDIT_EVENTS` store AND writing usage_events
would double-record the same fact; EVENT-CATALOG frames it as a "usage source record", so P2-003 persists it as
the append-only usage event (which satisfies "audited" = durable + immutable + attributed). This mirrors the
CDR-023/CDR-024 audit-mechanism decisions; additive/reversible.

**Fail-closed + transaction shape:** the usage-event insert is the ONLY DB write in a gateway call (the model call
itself is external, non-DB), so the composition writes it in its OWN short tenant transaction (dual-keyed RLS)
AFTER the model call — never holding a connection across the external call. Fail-closed still holds trivially:
that write is atomic, and if it fails the call throws and the output is withheld (there is no other DB effect to
roll back). USAGE-001; ADR-013.

**Usage accumulation across attempts (resolves the P2-003 review MEDIUM):** ONE usage event is written per
`callModel`, and its token counts are the SUM of tokens consumed across EVERY provider call in that invocation —
each bounded re-ask and each fallback attempt that returned a response. Metering the final attempt only would
under-report a re-asked call (the discarded bad output really cost tokens). Retryable infra failures (timeout /
rate_limited / provider_unavailable) throw without returning usage, so they contribute zero. `estimated_cost` is
computed from that accumulated total. Latency is the whole-call wall-clock. (Rollups/credits remain deferred —
P5-014/P6-009.) **Money discipline:** the gateway defensively coerces the injected pricing function's result to a
non-negative integer (`Math.trunc`, non-finite → 0) before it reaches the integer micro-units column, so a
mis-implemented pricing config can never be silently rounded.

## 6. Schema — migration 0017 `usage_events`

Additive (0001–0016 untouched; no new SECURITY DEFINER — still three; no BYPASSRLS; no owner runtime). One
company-owned, dual-keyed FORCE-RLS **append-only** table (`SELECT + INSERT` grants only — no UPDATE/DELETE;
invariant 9): `id`, `account_id`, `company_id`, `kind` (`model_call`), `provider`, `model` (id@version),
`task_class`, `outcome`, `input_tokens`/`output_tokens` (integer), `estimated_cost_micros`
(integer micro-units; never a float — money discipline), `fallback_used`, `latency_ms`, `correlation_id`,
`created_at`. Dual-keyed fail-closed select/insert policies (account AND company). Cross-company reads impossible.

## 7. Slice plan

1. **Contracts** (`@acbp/contracts`): TaskClass/TimeoutClass, ModelRequest/Response, the error taxonomy +
   retryable/terminal classification, the `ModelProvider` interface, the timeout/retry config constants
   (IOQ-13 values), pure helpers (is-retryable, fallback-eligible-by-class); unit tests. + this CDR + IOQ-13
   marked Resolved.
2. **Migration 0017** `usage_events` + real-PG RLS/privilege/append-only/catalog + down/up/reapply tests.
3. **Fake provider** (`@acbp/adapters/model`) + **core `callModel`** gateway (timeout/retry/re-ask/fallback/
   normalize/redact/policy-precheck/usage-emit fail-closed) + `UsageEventRepository`; real-PG **contract +
   fault-injection + redaction** suite (the seeded secret never in logs; provider error normalized; metering
   fail-closed rolls back).
4. **Composition** wiring (a model-gateway composition, provider-neutral core + fake adapter) + broader
   integration; no HTTP route.
5. **Docs** (gateway README — realized as a Model-gateway section in the `@acbp/core` README with operational
   notes — AI-AND-WORKER, EVENT-CATALOG/DATA-ARCHITECTURE/AUDIT as needed) + reviews + finalization.

## 8. Out of scope / deferred

Live provider wiring + real key + snapshot pin + eval gate (§0 — owner-gated); prompt templates (P2-004 — the
gateway consumes `templateRef@version` opaquely); interview generation/orchestration (P2-005); context assembly +
the secret blocklist that builds `contextParts[]` (P2-007 — the gateway receives context already assembled);
usage rollups + credit ledger + reservation + limits (P5-014/P6-009/P6-010); the eval suite (P2-011);
structured-output hardening (P5-010). No `model.call_started` event (not in canon). No dynamic price/quality/
latency routing (ADR-004 — one primary + one fallback only).
