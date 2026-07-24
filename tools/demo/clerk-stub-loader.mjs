// ACBP-P1-015 — the module-resolution hook the Slice A demo installs.
//
// It does exactly two things, both of which the CI suite gets from vitest and a plain `tsx` process does not:
//
//   1. Substitutes `@clerk/nextjs/server`. This is the SAME seam the CI suite uses via `vi.mock`: only the
//      provider SDK's edge is replaced, so the production authentication boundary (`resolveVerifiedIdentity`)
//      still executes in full — including the verified-primary-email rule (ACC-001). Nothing else is stubbed;
//      every layer below is production code.
//   2. Resolves the `@/…` path alias that `apps/web` route modules import through. It is declared in
//      `apps/web/tsconfig.json` (and mirrored in `vitest.config.ts`), neither of which a root-level `tsx`
//      process reads — without this, importing a real route handler fails with ERR_MODULE_NOT_FOUND.
//
// Dev/CI only. Never loaded by the application or by a production build: nothing under `apps/` or `packages/`
// references it, and it is installed only by `register()` inside tools/demo/slice-a.mjs.
import { existsSync } from 'node:fs';

const WEB_SRC = new URL('../../apps/web/src/', import.meta.url);

/** Resolve an extensionless alias target the way the TS resolver would, without guessing. */
function resolveAliasTarget(subpath) {
  const bare = subpath.replace(/\.js$/, '');
  for (const candidate of [subpath, `${bare}.ts`, `${bare}.tsx`, `${bare}/index.ts`]) {
    const url = new URL(candidate, WEB_SRC);
    if (existsSync(url)) return url.href;
  }
  return null;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@clerk/nextjs/server') {
    return { url: new URL('./clerk-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  if (specifier.startsWith('@/')) {
    const url = resolveAliasTarget(specifier.slice(2));
    // Fall through rather than throw when nothing matches, so a genuine missing-module error still names the
    // real specifier instead of being masked by this hook.
    if (url !== null) return nextResolve(url, context);
  }
  return nextResolve(specifier, context);
}
