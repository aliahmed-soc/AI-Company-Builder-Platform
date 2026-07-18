# ADR-023 — Web Application Framework

1. **Title:** Next.js (App Router) as the `apps/web` framework
2. **Status:** Accepted
3. **Date:** 2026-07-18
4. **Owner:** Product owner
5. **Context:** `REPOSITORY-SCAFFOLD-SPEC.md` deferred the web-framework choice ("Type-safe React framework … at scaffold"), and P0-011 created `apps/web` as an empty stub. ACBP-P1-001 (Clerk authentication) requires a real web request boundary and a sign-in surface, which cannot be built without this decision — P1-001 was returned PARTIAL pending it. ADR-006 mandates a modular monolith with two process types (api/web + worker) from one codebase; ADR-022 selects Clerk as the identity provider.
6. **Decision:** **Next.js with the App Router** owns `apps/web`. **TypeScript and ESM remain required.** **React Server Components and Route Handlers may be used.** Clerk's Next.js framework glue (`@clerk/nextjs`) may live **only** at the web boundary (`apps/web`). The provider-neutral identity contracts stay in `@acbp/contracts`; the framework-neutral verification adapter stays in `@acbp/adapters` (`@clerk/backend`). Product and domain logic remain **outside** the Next.js application layer (in `@acbp/core`/`@acbp/domain`/other packages), which the web app calls; the Next.js layer is a delivery boundary, not a home for business rules.
7. **Scope:** Web/API delivery framework for `apps/web` only. Verified versions at decision time: **Next.js 16.2.10, React 19.2.7, @clerk/nextjs 7.5.20** (Next 16 uses `proxy.ts` for middleware). Exact version pins are managed in `apps/web/package.json` under the repository's dependency-range policy.
8. **Explicit boundaries (unchanged / not decided here):**
   - **Internal authorization remains product-owned** — Clerk claims never authorize.
   - **Clerk Organizations do NOT become the product's company model** (ADR-007 tenancy is separate).
   - **No** company, membership, role, permission, tenant-isolation, RLS, or authorization behavior is selected or implemented by this ADR (or by P1-001).
   - Next.js types must not leak into `@acbp/contracts`, `domain`, `core`, `database`, `gateway`, or `adapters`; `@clerk/nextjs` must not be imported outside `apps/web`; `@clerk/backend` remains confined to `@acbp/adapters`.
   - No Pages Router; no UI component system, state manager, CSS framework, database client, or API framework is adopted here.
9. **Alternatives considered:** Remix/React Router (comparable App-Router-class SSR; owner selected Next.js for Clerk + Render ergonomics and ecosystem maturity); a separate SPA + standalone API framework (more moving parts than ADR-006's single-codebase model); plain Node HTTP server (loses SSR/routing/RSC and the first-class Clerk integration). Excluded by PRD/ADR-006: Kubernetes-per-service, microservice-per-surface.
10. **Positive consequences:** Unblocks the ACBP-P1-001 request boundary + sign-in surface; one codebase → api/web + worker (ADR-006); first-class Clerk App Router integration; RSC/Route Handlers for server-side verification.
11. **Negative consequences:** Adds a substantial framework dependency (Next/React) and a build step to a previously backend-only monorepo; Next.js major upgrades must be watched against `@clerk/nextjs` peer ranges.
12. **Security implications:** Server-side session verification happens at the web boundary (Route Handlers / `proxy.ts` middleware); public config uses the `NEXT_PUBLIC_` convention and must never carry server secrets. No change to ADR-014/021 secret posture.
13. **Reversal cost:** Medium — the web boundary is replaceable because business logic stays in provider-/framework-neutral packages; a framework swap re-implements only `apps/web`.
14. **Requirement IDs:** NFR-002/004 (request handling), ACC-001/002 (via P1-001), plus ADR-006 topology.
15. **Governing architecture ADRs:** ADR-006 (application architecture style), ADR-022 (authentication provider).
16. **Follow-up work:** ACBP-P1-001 implements the Clerk request boundary + sign-in surface on this framework; internal user mapping + webhooks are ACBP-P1-002; company/membership/tenant/authorization are later Phase-1 tickets. This ADR resolves the web-framework deferral recorded in `REPOSITORY-SCAFFOLD-SPEC.md` and encountered during P1-001.
