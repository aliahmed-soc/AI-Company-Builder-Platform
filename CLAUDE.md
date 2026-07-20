# CLAUDE.md — AI Company Builder Platform (operating rules)

Autonomous lead-engineer operating charter for this repository. Read this, then
`docs/agent/PROJECT-STATE.md`, before acting. Continue work automatically to the next safe item;
stop only at an OWNER GATE (below) or on explicit human "STOP".

## Repository isolation (load-bearing)
- Canonical root: `E:/AI-Company-Builder-Platform`. Verify with `git -C "E:\AI-Company-Builder-Platform" rev-parse --show-toplevel` before every material task (a shell hook may reset the CWD; prefer PowerShell + absolute paths).
- NEVER read, import from, or modify `E:\Halo-Suite`, `E:\Halo-Suite-V1`, `E:\Halo-Suite\halo-suite`. Stop if the root is not `E:/AI-Company-Builder-Platform`.

## Canonical source priority
1. Accepted owner decisions in the repo → 2. Accepted ADRs/CDRs → 3. Backlog → 4. PRD acceptance criteria → 5. Architecture/boundary docs → 6. Existing secure patterns → 7. Tests → 8. Provider docs. Never silently invent a requirement; on conflict prefer the most recent accepted decision, choose the safer reversible interpretation, document it, escalate only if it hits an owner gate.

## Architectural boundaries (enforced by `tools/check-boundaries.mjs`)
- `@acbp/contracts`: zero-dep, provider- and framework-neutral. No Clerk/Next types.
- `@acbp/core`: provider-neutral use cases; MAY act as the composition layer (imports `@acbp/adapters` + `@acbp/database`) but never imports a provider SDK (`@clerk/*`) directly.
- `@acbp/database`: provider-neutral; Kysely parameterized queries only; no raw SQL interpolation.
- `@acbp/adapters`: the ONLY home for `@clerk/backend`.
- `apps/web`: owns Next.js Request/Response; imports the domain only through `@acbp/core` (+ contracts/config/observability). `@clerk/nextjs` lives here only.
- No package dependency cycle.

## Security rules (never violate)
- Never log/commit/print/return: signing secrets, Clerk secret keys, session tokens, cookies, authorization/signature header values, raw webhook bodies, provider exception text, emails, personal metadata.
- Synthetic test values only; no real Clerk ids or personal emails in fixtures. No `.env*` with secrets.
- Browser-controlled claims never authorize; internal DB state is authoritative. Global identity mappings use no tenant context. No DB write before webhook signature verification. Read-through never trusts browser identity headers. Deleted identities never auto-resurrect. Raw payloads never persisted (sha256 only). All cross-boundary/HTTP errors are bounded + sanitized (`PublicErrorEnvelope`).

## Database & concurrency
- Receipt insert + user mutation atomic (one transaction). Scope conflict handling to the exact identity uniqueness constraint (`provider, provider_instance_id, provider_user_id`) via `ON CONFLICT DO NOTHING`; never a blanket 23505→duplicate. Immutable internal user id. Deterministic last-write-wins ordering `(provider_updated_at, last_event_id)`, event id only as a tie-breaker. Real-PostgreSQL integration tests for race/transaction behavior; local skip only when `ACBP_TEST_DATABASE_URL` is absent; hosted CI must run them with zero skips.

## Verification gate (run before every commit; report actual exit codes)
```
pnpm install --frozen-lockfile
pnpm typecheck && pnpm lint && pnpm check:secrets && pnpm check:boundaries && pnpm test:boundaries && pnpm test
pnpm run check
pnpm audit --audit-level high
git -C "E:\AI-Company-Builder-Platform" diff --check
```
Focused tests during development. Never claim success without inspecting exit status + hosted CI logs.

## Git / PR policy
- Never commit to `main`. One ticket → one PR (active: **ACBP-P1-003** on branch `p1-003-account-creation-and-profile`; P1-002 shipped as PR #3, merged `d1069f8`). Keep the active PR DRAFT until owner-authorized. Conventional commit messages, NO `Co-Authored-By` trailer. No force-push/history rewrite of pushed commits unless authorized. Inspect `git diff` + scope + `git diff --check` before committing; verify branch/HEAD/message before pushing; monitor CI after pushing and fix ordinary failures.

## OWNER GATES — stop and ask only for these
Real secret/credential/signing-secret/login; Clerk dashboard change; create/delete/modify a live external resource; public tunnel; production deploy/DB; destructive/irreversible op; a new architecture decision changing data ownership / authorization / tenant isolation / deletion semantics / public API / provider strategy; set ticket Done; mark PR ready; merge to main; delete branches post-merge; start a different ticket; unrecoverable blocker after reasonable diagnosis + one targeted fix; anything outside the active ticket's approved scope.

Everything else inside the active ticket (implementation, tests, refactor, docs, commits, feature-branch pushes, draft-PR updates, CI diagnosis/fixes, isolated disposable test resources) proceeds automatically.

## Completion standard
A slice is "done" only when: local gate green, independent security/scope review clean, committed with a precise message, pushed, PR body updated, and hosted CI green (integration tests run with zero skips for trust-critical DB work).
