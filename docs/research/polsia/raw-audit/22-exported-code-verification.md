# Exported code verification

## Method

The authenticated dashboard’s **Download Code** flow produced a local project archive. It was extracted into a temporary inspection directory and checked without uploading or modifying the Polsia account. The archive is treated as a generated-company application artifact, not as Polsia’s private control-plane source.

## Verified frontend implementation

- Framework: Next.js `16.2.6`, React `19.2.7`, TypeScript `5.5.4`.
- UI: Tailwind 4, shadcn/Radix primitives, `next-themes`, React Hook Form, Zod, Sonner.
- Routes: `/`, `/example`, `/health`, metadata routes (`robots.txt`, `sitemap.xml`, manifest, icon, OpenGraph image), plus an example API route.
- Home page is a user-owned generated landing page with features, three-step process, CTA, theme support, custom brand tokens, and mailto CTAs.
- Client data-plane example uses `apiFetch` and shared Zod contracts; loading, empty, field-validation, and toast error states are present.

## Verified backend/application implementation

- `src/app/api/example/route.ts` implements a sample `GET` and `POST` route with Zod request/response validation and structured 400/500 errors.
- `src/app/health/route.ts` returns `{ status: "healthy" }` for deployment readiness.
- `src/lib/api-client.ts` is the only client data transport; it calls `/api/*`, parses JSON, and can validate responses with Zod. A bearer-token seam is commented but not implemented; the example relies on same-origin transport.
- `src/lib/db.ts` contains a server-only Prisma singleton.
- `prisma/schema/_base.prisma` contains only the PostgreSQL datasource and Prisma generator; no application models were exported.
- The archive contains no database server, Dockerfile, compose file, Procfile, real env files, or populated application migrations.
- `polsia.toml` specifies Node runtime, `npm install --include=dev && npm run build`, Prisma `db push` at start, `/health` readiness, `PORT`, and a provisioned `DATABASE_URL`; scheduled jobs are append-only `[[crons]]` blocks.

## Verified security/platform requirements

- Production CSP uses a per-request nonce and `strict-dynamic`; production `script-src` excludes `unsafe-inline` and `unsafe-eval`.
- `style-src 'unsafe-inline'` is deliberately allowed for Radix/shadcn runtime styles.
- HSTS, `nosniff`, X-Frame-Options, strict referrer policy, permissions policy, COOP, CORP, `frame-ancestors 'none'`, `object-src 'none'`, and same-origin form action are configured.
- Environment validation requires a valid `DATABASE_URL`; `NEXT_PUBLIC_*` variables are the only client-exposed env surface.
- Ownership rules distinguish framework-owned, shared, and user-owned paths; auth and dashboard modules are expected to supply the real auth surface rather than being hand-rolled.

## Local verification results

| Check | Result | Notes |
|---|---|---|
| Dependency install | passed | `npm ci --ignore-scripts` completed; npm reported one high-severity dependency advisory. |
| Prisma client generation | passed | `npm run db:generate` completed. |
| Typecheck | passed | `npm run typecheck` passed after Prisma generation. |
| Unit tests | passed | 57 tests across 5 files passed. |
| Production build | passed | `npm run build` passed with a dummy local `DATABASE_URL`; no database connection was required. |
| Biome lint | failed | 5 findings in generated setup page: import order, two missing SVG titles, array-index key, and formatting. |
| Secret scan | passed | No `.env` files or high-confidence secret patterns found in the archive. |

## What this verifies—and what it does not

This verifies the generated app’s frontend structure, example backend conventions, deployment manifest, security headers, ownership model, and build/test posture. It does **not** verify Polsia’s private task engine, real authentication implementation, API handlers behind the dashboard route inventory, database schema, queues, agents, provider credentials, or control-plane authorization. Those remain inaccessible without a first-party source repository, documented staging API, or operator-provided backend access.
