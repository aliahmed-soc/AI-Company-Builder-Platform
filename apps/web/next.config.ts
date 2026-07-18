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
};

export default nextConfig;
