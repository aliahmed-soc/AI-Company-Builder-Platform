# @acbp/contracts

Shared, transport-neutral contracts for the platform. Leaf package (no workspace dependencies;
no provider SDK, web-framework, database, or logging dependency).

- **Responsibility:** Shared types, schemas, error taxonomy, event envelope, gateway request/response, **provider-adapter contracts**
- **Allowed dependencies:** (none — leaf package)
- **Forbidden dependencies:** everything else (enforced by `pnpm run check:boundaries`)
- **Runtime:** both · **Governing ADRs:** 011, 014, 015, 017, 021, 022

## Structured error taxonomy (ACBP-P0-016; NFR-009, ADR-017)

Provider-neutral, transport-neutral errors with a hard split between the **safe public envelope**
and the **internal diagnostic report**. Source: `src/errors.ts`.

**Categories** (canonical names, per `docs/architecture/API-CONTRACTS.md`):
`validation · authn · authz · not_found · conflict · limit_exceeded · policy_blocked ·
approval_required · provider_unavailable · internal`.

**Error codes** — stable, machine-readable `DOMAIN_REASON` constants in `ErrorCodes` (unique;
never embed dynamic or sensitive values), e.g. `VALIDATION_FAILED`, `AUTHENTICATION_REQUIRED`,
`AUTHORIZATION_DENIED`, `RESOURCE_NOT_FOUND`, `RATE_LIMIT_EXCEEDED`, `POLICY_BLOCKED`,
`DEPENDENCY_UNAVAILABLE`, `INTERNAL_ERROR`.

**API surface:**
- `PlatformError` — base error. Fields: `category`, `code`, `userMessage`, `status`, `retryable`,
  `correlationId?`, `metadata` (tenant-safe, internal), `docsRef?`, `cause`.
- `toPublic(): PublicErrorEnvelope` — **only** `{category, code, message, retryable, correlationId?}`.
- `toInternal(): InternalErrorReport` — adds `internalMessage`, `status`, `metadata`, `stack`,
  `causeChain` (logs/operators only).
- `toJSON()` returns the public envelope, so `JSON.stringify(error)` is safe by default.
- `normalizeError(unknown, { correlationId? })` — wraps native `Error`, strings, objects, `null`,
  `undefined` into the **internal** category with a generic public message (raw messages/provider
  responses stay internal — the "no raw provider errors to clients" rule). Existing `PlatformError`
  passes through.
- `validationError({ fields })`, `platformError(category, options)`, `isPlatformError(x)`, `statusFor(category)`.

**Safety guarantees (test-enforced in `src/errors.test.ts`):** public output never contains internal
messages, causes, stack traces, metadata, secrets, or cross-tenant identifiers; redaction is
structural (allowlisted fields), not string-scrubbing. Provide **safe user messages** and put
diagnostics in `internalMessage`/`metadata`/`cause`; never place secrets or raw provider payloads in
`userMessage`.

## Provider-adapter contracts (ACBP-P0-019; ADR-011/014/021/022; INTEG-002, NFR-018/019)

Provider-neutral interfaces that isolate product/application code from concrete third-party providers.
Source: `src/adapters/`. **This ticket is contracts only** — there is **no provider SDK, no network
integration, and no concrete implementation** anywhere yet.

**Ownership & placement.** The *interfaces + neutral types* live here in `@acbp/contracts` (leaf,
zero-dependency, provider-neutral). Concrete *implementations* will land in `@acbp/adapters` in later
tickets. *Test doubles* (fakes) live in `@acbp/test-support` (never a production dependency). Product
code depends on these contracts, never on an implementation or a provider SDK — enforced by
`pnpm run check:boundaries` (P0-012): `core` cannot import provider SDKs, and deep cross-package
imports are blocked.

**Categories (the four canonical P0-019 interfaces):**
- **Secret** (`SecretProvider`, ADR-014/021) — resolves an opaque `SecretRef` to a redaction-safe
  `SecretValue` wrapper at a trusted boundary. **Refs only cross interfaces; values never appear in
  DTOs.** `missing · expired · unavailable · access_denied` are distinct; anything but `resolved`
  means **fail closed**.
- **Identity** (`IdentityProvider`, ADR-022) — verifies sessions and normalizes provider claims into
  `NormalizedIdentity`. **Claims never authorize**; provider org objects never become the product's
  company; internal authz/membership stay product-owned. Webhooks arrive as neutral `IdentityEvent`s;
  a provider deletion event does not itself authorize product-data deletion.
- **Storage** (`ObjectStorage`) — put/get/delete/head by an opaque `ObjectKey`. No vendor bucket/URL/SDK
  types, no public-by-default access, no presigned abstraction (deferred). Tenant ownership is the
  caller's explicit responsibility (no auto cross-tenant addressing). **P0-005 remains Blocked — no
  provider is selected.**
- **Model** (`ModelProvider`, ADR-011/019) — the provider-facing layer **beneath** the gateway.
  Product calls the gateway, never a provider. No prompts, model selection, routing, or automatic
  fallback here. `finishStatus` is platform-owned; `usage` is neutral; `providerRequestId` is a
  **diagnostic**, never a domain id.

**Conventions (all contracts):**
- *Async + cancellation + timeout* via `AdapterCallOptions { correlation?, signal?, timeoutMs? }`.
  `signal` is a structural `AbortSignalLike` so the leaf needs no DOM/node lib.
- *Errors* normalize to `PlatformError` (above). Implementations must never surface raw SDK/HTTP
  errors, provider stacks, request bodies, credentials, tokens, or raw prompts/outputs. `retryable`
  distinguishes retry-eligible failures.
- *Observability/redaction* — thread `correlation`; never place secret values or raw provider
  responses in returned metadata. Logging failure must not change adapter semantics.
- *Lifecycle* — optional `AdapterLifecycle { init?, shutdown? }` for adapters needing explicit setup.

**How a future implementation plugs in:** add a package under `@acbp/adapters` that `implements` the
contract, keeping all provider SDK types/paths/machine-identities *inside* it; map provider errors to
`PlatformError`; return only the neutral types. Swapping a provider = new implementation + config; no
product code changes. Conformance is proven by the fakes + tests in
`packages/adapters/src/*.test.ts` (behavioral) and `provider-neutrality.test.ts` (no-SDK / no-leak /
P0-005-blocked static proofs).

**Which tickets add concrete providers (later):** model → OpenAI/Anthropic gateway adapters (ADR-019);
identity → Clerk (ADR-022); secrets → Infisical (ADR-021); storage → *pending P0-005 owner decision*.

**Unresolved:** ACBP-P0-005 (object-storage provider) stays owner-Blocked; the storage contract is
deliberately vendor-neutral and selects nothing.

Dependency-boundary enforcement (import-lint): `pnpm run check:boundaries` (ACBP-P0-012).
