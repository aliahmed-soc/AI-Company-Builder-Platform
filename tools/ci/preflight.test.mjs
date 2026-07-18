// ACBP-P0-020 — CI database-preflight guard negative proofs. Fake values only.
import { describe, test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const PREFLIGHT = resolve(dirname(fileURLToPath(import.meta.url)), 'preflight.mjs');
const PW = 'pw-zz20';

function runPreflight({ ci, url }) {
  const env = { ...process.env };
  delete env.CI;
  delete env.ACBP_TEST_DATABASE_URL;
  if (ci !== undefined) env.CI = ci;
  if (url !== undefined) env.ACBP_TEST_DATABASE_URL = url;
  const r = spawnSync(process.execPath, [PREFLIGHT], { env, encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

describe('CI database preflight guard', () => {
  test('CI=true with a missing database URL fails (non-zero)', () => {
    const r = runPreflight({ ci: 'true' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/requires a valid ACBP_TEST_DATABASE_URL/);
  });

  test('CI=true with a malformed URL fails without revealing the value', () => {
    const r = runPreflight({ ci: 'true', url: 'not-a-url' });
    expect(r.status).toBe(1);
    expect(r.out).not.toContain('not-a-url');
  });

  test('CI=true with a valid URL passes and never prints credentials', () => {
    const r = runPreflight({ ci: 'true', url: `postgresql://acbp_ci:${PW}@127.0.0.1:5432/acbp_ci_test` });
    expect(r.status).toBe(0);
    expect(r.out).not.toContain(PW);
    expect(r.out).toContain('acbp_ci_test');
  });

  test('local mode (CI unset) is a no-op even without a database URL', () => {
    const r = runPreflight({});
    expect(r.status).toBe(0);
    expect(r.out).toMatch(/local mode/);
  });
});
