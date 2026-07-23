// ACBP-P1-013 §11 — NO-IMPERSONATION boundary guard (always runs; no database needed). The admin path must stay
// structurally impersonation-free: no impersonation-shaped identifier may be introduced, no membership may be
// created from the admin path, and no tenant-member identity may be assumed. This is a SOURCE test so the
// regression fails at unit-test time on any machine, not only on hosted CI.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const ADMIN_PATH_SOURCES: ReadonlyArray<readonly [string, string]> = [
  ['@acbp/core admin service', join(here, 'admin-service.ts')],
  ['@acbp/database admin primitive', join(here, '..', '..', '..', 'database', 'src', 'admin-access.ts')],
];

describe('admin path no-impersonation boundary — ACBP-P1-013/CDR-019', () => {
  test.each(ADMIN_PATH_SOURCES)('%s contains no impersonation-shaped identifier', (_label, path) => {
    const src = readFileSync(path, 'utf8');
    // Forbidden identifiers (owner-enumerated). NOTE: comments may DESCRIBE the prohibition using the word
    // "impersonation" — only code lines (comment-stripped) are scanned.
    const code = src
      .split('\n')
      .map((line) => line.replace(/\/\/.*$/, ''))
      .join('\n')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    for (const forbidden of [/impersonat/i, /actAsUser/i, /assumedUserId/i, /delegatedSession/i]) {
      expect(forbidden.test(code), `${String(forbidden)} must not appear in ${path}`).toBe(false);
    }
  });

  test.each(ADMIN_PATH_SOURCES)('%s never creates a membership or touches member/profile tables', (_label, path) => {
    const src = readFileSync(path, 'utf8');
    // No membership insert (no admin-created membership), no membership/profile table reference at all,
    // and no session/token minting primitives.
    expect(/insertInto\((['"`])(memberships|company_memberships)\1\)/.test(src)).toBe(false);
    for (const table of ['company_memberships', 'company_profiles', 'account_profiles']) {
      expect(src.includes(table), `${table} must not be referenced by ${path}`).toBe(false);
    }
    expect(/createSession|signToken|mintToken/i.test(src)).toBe(false);
  });

  test('the admin service consumes ONLY the purpose-specific primitive (no generic scope/tenant helper import)', () => {
    const src = readFileSync(join(here, 'admin-service.ts'), 'utf8');
    // The one database entry point for the admin path:
    expect(src.includes('executeAdminCompanyRead')).toBe(true);
    // Never a generic tenant-scope runner or repository from the admin path:
    for (const forbidden of ['runInCompanyScope', 'runInAccountScope', 'withTenantTransaction', 'withAccountTransaction', 'elevateToCompanyScope', 'createTenantScope', 'CompanyRepository', 'MembershipRepository']) {
      expect(src.includes(forbidden), `${forbidden} must not be imported by the admin service`).toBe(false);
    }
  });
});
