# @acbp/contracts

Shared, transport-neutral contracts for the platform. Leaf package (no workspace dependencies;
no provider SDK, web-framework, database, or logging dependency).

- **Responsibility:** Shared types, schemas, error taxonomy, event envelope, gateway request/response
- **Allowed dependencies:** (none — leaf package)
- **Forbidden dependencies:** everything else (enforced by `pnpm run check:boundaries`)
- **Runtime:** both · **Governing ADRs:** 011, 015, 017

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

Dependency-boundary enforcement (import-lint): `pnpm run check:boundaries` (ACBP-P0-012).
