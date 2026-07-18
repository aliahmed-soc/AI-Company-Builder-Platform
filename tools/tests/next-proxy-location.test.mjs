// ACBP-P1-001 — regression guard for the Next.js proxy (middleware) file location.
//
// Next.js resolves the proxy/middleware file relative to the project structure: when the app uses a
// `src/` directory (src/app), the proxy file MUST be at src/proxy.ts. If it sits at the project root
// (apps/web/proxy.ts) instead, Next.js ignores it, clerkMiddleware() never runs, and the server
// helper auth() throws a 500 at request time — which a production build does NOT catch. This test
// locks the correct location so the bug cannot silently reappear.
import { describe, test, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WEB = resolve(REPO, 'apps', 'web');
const usesSrcApp = existsSync(resolve(WEB, 'src', 'app'));

describe('Next.js proxy (middleware) file location — apps/web', () => {
  test('apps/web uses a src/ directory (src/app present)', () => {
    expect(usesSrcApp).toBe(true);
  });

  test('the proxy file is at src/proxy.ts (co-located with src/app)', () => {
    if (!usesSrcApp) return; // rule only applies to a src/ layout
    expect(existsSync(resolve(WEB, 'src', 'proxy.ts'))).toBe(true);
  });

  test('the proxy file is NOT at the project root (root proxy.ts is ignored, disabling clerkMiddleware)', () => {
    if (!usesSrcApp) return;
    expect(existsSync(resolve(WEB, 'proxy.ts'))).toBe(false);
  });
});
