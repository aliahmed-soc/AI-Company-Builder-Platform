import type { NextConfig } from 'next';

// ACBP-P1-001 — minimal Next.js App Router config (ADR-023). No image optimization (sharp build is
// skipped in pnpm-workspace.yaml). The web layer is a delivery boundary only; product/domain logic
// lives in @acbp/* packages.
//
// typedRoutes is disabled deliberately: when on, `next build` injects `import "./.next/types/
// routes.d.ts"` into next-env.d.ts, and that generated file only exists after a build — which would
// break the workspace's build-independent `tsc --noEmit` typecheck in CI. Off keeps typechecking
// hermetic (Link hrefs fall back to plain strings).
const nextConfig: NextConfig = {
  typedRoutes: false,
  // ACBP-P7-015 — Next's default is `poweredByHeader: true` (next/dist/server/config-shared.js), and
  // next/dist/server/send-payload.js sets `X-Powered-By: Next.js` on every HTML document response. That is
  // framework-version disclosure on exactly the surfaces this ticket is about, and this is the ONLY place it can
  // be turned off: the header is added when the payload is sent, long after middleware has returned, so
  // src/proxy.ts cannot delete it.
  //
  // HONESTLY LABELLED: unlike every other header in this ticket, this ONE setting is not covered by a response
  // assertion, for the same reason CDR-083 §2.2 rejects next.config.ts as the home for the rest — CI never runs
  // `next build` or `next start`, so nothing here can observe a served response. It is a one-line removal of a
  // disclosure with no failure mode, which is worth doing anyway; it is not evidence, and CDR-083 §6.3 says so.
  poweredByHeader: false,
  // The web app consumes @acbp/* workspace packages as TypeScript SOURCE (each package's `main` is
  // src/index.ts). Next/Turbopack otherwise treats these pnpm-linked node_modules packages as
  // pre-compiled JS and does not apply TypeScript resolution to their internal `.js`-suffixed ESM
  // re-exports (NodeNext style), so runtime value-imports (e.g. the Clerk webhook route → @acbp/core)
  // fail with "Can't resolve './adapters/index.js'". Listing them here makes Next transpile + resolve
  // their TS source. (P1-001 only imported @acbp/contracts as an erased type, so this never surfaced.)
  transpilePackages: ['@acbp/contracts', '@acbp/config', '@acbp/observability', '@acbp/database', '@acbp/adapters', '@acbp/core'],
  // The web app is pinned to the webpack builder (scripts pass --webpack). Next 16 defaults to
  // Turbopack, but Turbopack cannot resolve our workspace packages' barrels that re-export files which
  // import OTHER workspace packages (e.g. observability/src/index.ts → redact.ts → @acbp/config): it
  // reports "module has no exports at all". Webpack + the extensionAlias below resolves the whole graph
  // deterministically, including the NodeNext-style `.js` specifiers that point at `.ts` sources.
  webpack: (config: { resolve: { extensionAlias?: Record<string, readonly string[]> } }) => {
    config.resolve.extensionAlias = {
      ...(config.resolve.extensionAlias ?? {}),
      '.js': ['.ts', '.tsx', '.js', '.jsx'],
      '.mjs': ['.mts', '.mjs'],
      '.cjs': ['.cts', '.cjs'],
    };
    return config;
  },
};

export default nextConfig;
