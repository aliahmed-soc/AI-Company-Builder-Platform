// ACBP-P1-002 Slice 3 — proxy webhook-exclusion predicate tests (apps/web). Pure; no Next runtime.
import { describe, test, expect } from 'vitest';
import { isClerkWebhookPath, CLERK_WEBHOOK_PATH } from './route-path.js';

describe('isClerkWebhookPath', () => {
  test('matches ONLY the exact webhook route (session proxy is bypassed there)', () => {
    expect(isClerkWebhookPath(CLERK_WEBHOOK_PATH)).toBe(true);
    expect(isClerkWebhookPath('/api/webhooks/clerk')).toBe(true);
  });

  test('does not match other (protected) routes', () => {
    for (const p of ['/auth-check', '/api/other', '/', '/api/webhooks', '/api/webhooks/clerkx', '/api/webhooks/clerk/extra', '/sign-in']) {
      expect(isClerkWebhookPath(p)).toBe(false);
    }
  });
});
