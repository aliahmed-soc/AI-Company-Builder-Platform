// ACBP-P1-002 Slice 3 — the single, narrow public webhook path (apps/web).
//
// Used by the proxy to bypass interactive session authentication for EXACTLY this route (it is
// authenticated only by signature verification in the Route Handler). Kept as a pure predicate so the
// proxy exclusion is testable without the Next.js runtime.
export const CLERK_WEBHOOK_PATH = '/api/webhooks/clerk';

/** True ONLY for the exact Clerk webhook route — never any other application route. */
export function isClerkWebhookPath(pathname: string): boolean {
  return pathname === CLERK_WEBHOOK_PATH;
}
