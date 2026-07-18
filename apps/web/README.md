# @acbp/web

**Next.js (App Router) web application (ADR-023).** Hosts the authentication boundary
(ACBP-P1-001) and is the delivery layer for the platform's web/API surface.

- **Framework:** Next.js 16 (App Router, `proxy.ts` middleware convention), React 19, TypeScript, ESM.
- **Responsibility:** HTTP host, routing, request boundary, UI; composes `@acbp/*` modules.
- **Allowed dependencies:** core, contracts, config, observability (enforced by `tools/check-boundaries.mjs`).
- **Forbidden dependencies:** database/adapters directly, test-support. `@clerk/nextjs` and `next`
  are confined to this app (the boundary checker's `web-framework-confined-to-web` rule).
- **Runtime:** api/web process (ADR-006).
- **Governing ADRs:** 006, 022, 023.

## Authentication (ACBP-P1-001)

Clerk provides identity. Integration points:

- `src/app/layout.tsx` — `ClerkProvider` + signed-in/out header (state resolved server-side via `auth()`).
- `src/app/sign-in/…`, `src/app/sign-up/…` — Clerk-hosted `<SignIn/>` / `<SignUp/>` surfaces.
- `proxy.ts` — mounts `clerkMiddleware()` (Next 16 renamed `middleware.ts` → `proxy.ts`). It protects
  nothing by default; protected routes enforce server-side.
- `src/server/auth/verified-identity.ts` — the **server-side request boundary**. Trusts only the
  server-verified session (`auth()`) plus the authoritative Backend User (`clerkClient()`), never
  browser-supplied input. Requires the primary email to be verified (fail-closed). Fetching the
  Backend User to read verification is a **temporary** P1-001 approach; internal user mapping/caching
  is **ACBP-P1-002**.
- `src/app/auth-check/route.ts` — protected Route Handler that proves the boundary (401 / 403 / 503 / 200).

### Configuration

`@clerk/nextjs` reads these automatically; validated by `@acbp/config` (`parseClerkConfig`):

| Variable | Scope | Notes |
| --- | --- | --- |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | public | client-safe (`pk_test_…`/`pk_live_…`) |
| `CLERK_SECRET_KEY` | server-only | required by the Clerk server helpers (`sk_…`) |
| `CLERK_JWT_KEY` | server-only | optional; networkless verification in the neutral adapter |
| `CLERK_AUTHORIZED_PARTIES` | server | CSV of allowed `azp` origins |
| `NEXT_PUBLIC_CLERK_SIGN_IN_URL` / `NEXT_PUBLIC_CLERK_SIGN_UP_URL` | public | optional custom routes |

Secrets come from Infisical (ADR-021) in staging/production, never from a committed file. See
`.env.example` for local development placeholders (fake values only).

## Scripts

- `pnpm --filter @acbp/web dev` — Next dev server (needs Clerk dev credentials to sign in).
- `pnpm --filter @acbp/web build` — production build (also runs Next's TypeScript check).
- `pnpm --filter @acbp/web typecheck` — `tsc --noEmit`.

> `next-env.d.ts` is Next-generated and gitignored; it is excluded from the shared `tsc` pass because
> Next 16 makes it import build-only route types. `next build` is the authoritative app typecheck.
