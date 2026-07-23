// ACBP-P1-013 §11 — NO-IMPERSONATION boundary guard (always runs; no database needed). The admin path must stay
// structurally impersonation-free: no impersonation-shaped identifier may be introduced, no membership may be
// created from the admin path, and no tenant-member identity may be assumed. This is a SOURCE test so the
// regression fails at unit-test time on any machine, not only on hosted CI. Scans EVERY production file of the
// admin path (core + database primitive + the whole apps/web admin layer + its route — review finding 4.2:
// the original two-file scan left the web layer, which holds the full tenant runtime, unguarded).
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..', '..');

/** All PRODUCTION (non-test) sources of the P1-013 admin path, discovered — a new helper file is auto-included. */
function adminPathSources(): ReadonlyArray<readonly [string, string]> {
  const dirs = [
    join(here), // packages/core/src/admin
    join(repoRoot, 'apps', 'web', 'src', 'server', 'admin'),
    join(repoRoot, 'apps', 'web', 'src', 'app', 'api', 'admin', 'accounts', '[accountId]', 'companies', '[companyId]', 'read'),
  ];
  const files: Array<readonly [string, string]> = [[join(repoRoot, 'packages', 'database', 'src', 'admin-access.ts'), 'database primitive']];
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.ts') && !name.endsWith('.test.ts')) files.push([join(dir, name), name]);
    }
  }
  return files;
}

/** Strip // and /* *\/ comments so prose DESCRIBING a prohibition never trips the code scan. */
function codeOf(path: string): string {
  return readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.replace(/\/\/.*$/, ''))
    .join('\n')
    .replace(/\/\*[\s\S]*?\*\//g, '');
}

describe('admin path no-impersonation boundary — ACBP-P1-013/CDR-019', () => {
  const sources = adminPathSources();

  test('the scan actually covers the admin path (route + web layer + core + primitive)', () => {
    const labels = sources.map(([p]) => p.replace(/\\/g, '/'));
    expect(labels.some((p) => p.endsWith('packages/database/src/admin-access.ts'))).toBe(true);
    expect(labels.some((p) => p.endsWith('core/src/admin/admin-service.ts'))).toBe(true);
    expect(labels.some((p) => p.endsWith('server/admin/admin-request.ts'))).toBe(true);
    expect(labels.some((p) => p.endsWith('server/admin/admin-http.ts'))).toBe(true);
    expect(labels.some((p) => p.endsWith('read/route.ts'))).toBe(true);
  });

  test.each(adminPathSources())('%s → contains no impersonation-shaped identifier', (path) => {
    const code = codeOf(path);
    for (const forbidden of [/impersonat/i, /actAsUser/i, /assumedUserId/i, /delegatedSession/i, /onBehalfOf/i]) {
      expect(forbidden.test(code), `${String(forbidden)} must not appear in ${path}`).toBe(false);
    }
  });

  test.each(adminPathSources())('%s → never writes a membership, touches member/profile tables, or mints a session', (path) => {
    const code = codeOf(path);
    // No membership/profile table reference in ANY form — Kysely call or raw SQL (quoted-name match, so
    // 'memberships' cannot be hidden inside 'company_memberships' or vice versa; both are individually banned).
    expect(/['"`](memberships|company_memberships|company_profiles|account_profiles)['"`]/.test(code), `tenant member/profile table referenced by ${path}`).toBe(false);
    expect(/insert\s+into\s+(public\.)?(memberships|company_memberships|company_profiles|account_profiles)/i.test(code), `raw membership/profile INSERT in ${path}`).toBe(false);
    expect(/createSession|signToken|mintToken/i.test(code)).toBe(false);
  });

  test.each(adminPathSources())('%s → never invokes ordinary tenant use cases or generic scope runners', (path) => {
    const code = codeOf(path);
    for (const forbidden of ['runInCompanyScope', 'runInAccountScope', 'withTenantTransaction', 'withAccountTransaction', 'elevateToCompanyScope', 'ensurePersonalAccount', 'CompanyRepository', 'MembershipRepository', 'getCompanyPortfolio', 'resolveCompanyContext', 'runAsTenant', 'setArbitraryTenant', 'crossTenantQuery', 'ownerConnection']) {
      // The database primitive itself is the ONE place allowed to mint its internal scope; even it may not
      // use the generic runners above (it uses withTransaction + createTenantScope for the audit write only).
      expect(code.includes(forbidden), `${forbidden} must not appear in ${path}`).toBe(false);
    }
  });

  test('the admin service consumes ONLY the purpose-specific primitive', () => {
    const src = readFileSync(join(here, 'admin-service.ts'), 'utf8');
    expect(src.includes('executeAdminCompanyRead')).toBe(true);
    expect(src.includes('createTenantScope')).toBe(false);
  });
});
