# @acbp/observability

Provider-neutral logging, correlation, and redaction (ACBP-P0-017; NFR-009, NFR-018, ADR-017).

- **Allowed dependencies:** `@acbp/contracts`, `@acbp/config` (enforced by `pnpm run check:boundaries`)
- **Forbidden:** product-domain modules, provider SDKs, database, app entry points, test-support in prod
- **Runtime:** both · **Governing ADRs:** 017, 014 (secret handling), 015 (audit references)

## Correlation model

`CorrelationContext` (defined in `@acbp/contracts`) links logs, tasks, tool/model calls, and safe
error responses. Identifiers: `correlationId` (required, UUID v4), and optional `requestId`,
`taskId`, `taskRunId`, `workerRunId`, `toolCallId`, `modelCallId`, plus **sensitive** identity
`accountId`, `companyId`, `actorId`.

- **Explicit passing, no global state.** Loggers are immutable instances that carry their own
  context. There is **no `AsyncLocalStorage`/global mutable context**, so concurrent operations
  cannot leak identifiers into each other (proven by a concurrency test). ALS is deferred to the
  web/queue-integration tickets, where request/job lifecycles justify it; explicit passing fully
  satisfies this ticket and keeps test isolation trivial.
- IDs are **server-generated** (`newCorrelationId()` → `crypto.randomUUID`), **validated**
  (`isCorrelationId`), and **immutable within a trace**. Child operations use
  `deriveChildContext(parent, overrides)` / `logger.child(overrides)`, which inherit the trace +
  tenant/actor identity and may set **only operation-scoped IDs** (`requestId`, `taskId`,
  `taskRunId`, `workerRunId`, `toolCallId`, `modelCallId`). `correlationId`/`accountId`/`companyId`/
  `actorId` cannot be overridden on a child.

## Logger interface

`createLogger(options)` → `Logger` with `debug|info|warn|error(event, fields?)`, `child(overrides)`,
`withComponent(name)`. `LogFields = { message?, metadata?, error? }`. A `LogRecord` carries
`timestamp, level, component, event, message?, context?, metadata?, error?, env?`.

- **Levels & filtering:** `minLevel` (default `info`); `debug` is dropped unless `minLevel: 'debug'`.
- **Adapters:** `consoleAdapter` (structured single-line JSON); `createTestLogger()` (in-memory,
  fixed clock, deterministic capture). A production/vendor adapter can replace them later without
  changing call sites — **no hosted observability SDK is bundled** (that is a later ticket).
- **Pipeline never blocks user work:** emission (redaction + adapter) is wrapped so logging never
  throws to the caller, even if an adapter throws or metadata is malformed.

## Redaction (trust-critical)

Every record is **redacted before emission**. `redact(value)` is recursive and **non-mutating**,
handles **circular** structures, and **never throws**. It replaces with `[REDACTED]`:

- `@acbp/config` **`Secret`** wrapper instances (explicit sensitive marker — not just key names).
- **Sensitive object keys** (case-insensitive): password, passwd, secret, token, authorization,
  cookie, apiKey/api_key, clientSecret, privateKey, refreshToken, accessToken/accessKey, credential, bearer.
- **Sensitive substrings in strings:** `sensitiveKey=value` / `sensitiveKey: value` assignments
  (covers URL query params), `Bearer <token>`, and known credential formats (`sk-…`, `sk_live/test_…`,
  `gh[pousr]_…`, PEM private-key blocks).
- Nested objects, arrays, and `Error` **messages, stacks, and causes**.

**Limitation (documented):** pattern-based redaction cannot catch a secret embedded in arbitrary
free text after a *non-sensitive* token (e.g., `foo=<secret>`). Therefore **never** put secrets,
full prompts, full model outputs, raw provider responses, tokens, or credentials into log messages
or `userMessage` — pass diagnostics as structured fields with sensitive keys, or wrap in `Secret`.

## Structured-error integration (P0-016)

Logging an `error` normalizes it via `@acbp/contracts` `normalizeError` and logs the **safe**
`code`/`category`/`retryable` plus the **redacted** internal diagnostics (`internalMessage`,
`causeChain`, `stack`). Public error envelopes (`PlatformError.toPublic()`) remain separate and
carry a safe `correlationId` but **no tenant identifiers** (proven by tests).

## Safe vs unsafe metadata

- **Safe (log freely):** correlation IDs, opaque tenant/actor IDs (server logs are access-controlled),
  error code/category, durations, counts, component/event names.
- **Unsafe (never log raw):** secrets/tokens/credentials, full prompts or model outputs, raw provider
  responses, DB connection strings, request bodies with PII, `Authorization`/`Cookie` header values.

## Adding a sensitive key

Add the pattern to `SENSITIVE_KEY_RE` (and `SENSITIVE_ASSIGN_RE` if it appears in free text/URLs) in
`src/redact.ts`, and add a redaction test. Prefer wrapping known secrets in `Secret` at the source.

## Tests

`src/redact.test.ts` + `src/logger.test.ts` (24 cases): correlation generation/validation/
propagation/child-override/concurrency; recursive/case-insensitive/nested/array/Secret/Error/stack/
Authorization/Cookie/URL redaction; non-mutation; circular safety; level filtering; error
integration; deterministic capture; JSON validity; non-throwing pipeline; public-error correlation +
tenant safety. Run: `pnpm run test:observability` (or `pnpm test`).
