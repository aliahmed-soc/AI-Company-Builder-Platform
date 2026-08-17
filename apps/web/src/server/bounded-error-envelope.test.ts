// ACBP-P1-014 — regression tests for the bounded-error wrappers (Class R restoration).
//
// The accepted platform invariant is that EVERY cross-boundary/HTTP error is bounded and sanitized. The
// P1-012/P1-013 routes already wrapped their handlers; the older company and account routes did not, so a
// thrown PlatformError (e.g. a malformed `companyId` reaching the resolver's uuid cast, SQLSTATE 22P02)
// escaped the handler and the framework produced its own error outside our envelope contract.
//
// These tests pin the restoration at the mapper level (fast, no database) and, together with the
// source guard below, prevent a route from silently regressing to the unwrapped form.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { respondToCompaniesRequest } from './companies/companies-http.js';
import { respondToMembersRequest } from './members/members-http.js';
import { respondToProfileRequest } from './accounts/profile-http.js';

const here = dirname(fileURLToPath(import.meta.url));
const apiRoot = join(here, '..', 'app', 'api');

describe('bounded HTTP error envelope — ACBP-P1-014 Class R restoration', () => {
  test('a thrown error becomes the bounded generic 500 envelope, not a framework error', async () => {
    const boom = (): Promise<never> => Promise.reject(new Error('boom: select * from companies where id = 1'));
    const responses = [await respondToCompaniesRequest(boom), await respondToMembersRequest(boom), await respondToProfileRequest(boom)];
    for (const res of responses) {
      expect(res.status).toBe(500);
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'internal_error' });
      // The thrown message — which can carry SQL — never reaches the client.
      expect(text).not.toContain('select');
      expect(text).not.toContain('boom');
    }
  });

  test('successful and denial outcomes are untouched by the wrapper', async () => {
    const ok = await respondToCompaniesRequest(() => Promise.resolve({ status: 'company', company: { companyId: 'co_1', status: 'active', displayStatus: 'active', name: 'A', description: null, profileVersion: 1, role: 'owner' } }));
    expect(ok.status).toBe(200);
    const denied = await respondToCompaniesRequest(() => Promise.resolve({ status: 'forbidden' }));
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: 'forbidden' });
    const unauth = await respondToMembersRequest(() => Promise.resolve({ status: 'unauthenticated' }));
    expect(unauth.status).toBe(401);
  });

  test('SOURCE GUARD: every API route maps its result through a wrapper or its own try/catch', () => {
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (entry.name !== 'route.ts') continue;
        const code = readFileSync(full, 'utf8').replace(/\r\n?/g, '\n');
        const mapsDirectly = /return to(Companies|Members|Profile)Response\(await /.test(code);
        const hasTryCatch = /try\s*\{/.test(code);
        if (mapsDirectly && !hasTryCatch) offenders.push(full);
      }
    };
    walk(apiRoot);
    expect(offenders, 'these routes can let a thrown error escape the bounded envelope').toEqual([]);
  });
});
