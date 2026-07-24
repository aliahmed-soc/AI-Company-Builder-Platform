// ACBP-P1-015 — module-resolution hook that substitutes `@clerk/nextjs/server` for the Slice A demo.
//
// This is the SAME seam the CI suite uses via `vi.mock`: only the provider SDK's edge is replaced, so the
// production authentication boundary (`resolveVerifiedIdentity`) still executes in full — including the
// verified-primary-email rule (ACC-001). Nothing else is stubbed; every layer below is production code.
//
// Dev/CI only. Never loaded by the application or by a production build.
export async function resolve(specifier, context, nextResolve) {
  if (specifier === '@clerk/nextjs/server') {
    return { url: new URL('./clerk-stub.mjs', import.meta.url).href, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
