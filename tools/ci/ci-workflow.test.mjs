// ACBP-P0-020 — CI workflow static safety proofs (dependency-free; asserts the committed workflow).
import { describe, test, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = resolve(REPO, '.github', 'workflows', 'ci.yml');
const src = existsSync(WORKFLOW) ? readFileSync(WORKFLOW, 'utf8') : '';

describe('CI workflow safety and completeness', () => {
  test('the workflow file exists', () => {
    expect(existsSync(WORKFLOW)).toBe(true);
  });

  test('does not use pull_request_target', () => {
    expect(src).not.toMatch(/pull_request_target/);
  });

  test('declares least-privilege permissions (contents: read) and no write scope', () => {
    expect(src).toMatch(/permissions:\s*[\r\n]+\s*contents:\s*read/);
    expect(src).not.toMatch(/:\s*write\b/);
  });

  test('has concurrency with cancel-in-progress', () => {
    expect(src).toMatch(/concurrency:/);
    expect(src).toMatch(/cancel-in-progress:\s*true/);
  });

  test('sets a job timeout', () => {
    expect(src).toMatch(/timeout-minutes:\s*\d+/);
  });

  test('installs dependencies with a frozen lockfile', () => {
    expect(src).toMatch(/pnpm install --frozen-lockfile/);
    expect(src).not.toMatch(/--no-frozen-lockfile/);
  });

  test('provides an isolated PostgreSQL 16 service with a health check', () => {
    expect(src).toMatch(/image:\s*postgres:16/);
    expect(src).toMatch(/--health-cmd/);
    expect(src).toMatch(/pg_isready/);
  });

  test('invokes the CI database preflight guard and the aggregate gate', () => {
    expect(src).toMatch(/ci:preflight/);
    expect(src).toMatch(/pnpm run check/);
  });

  test('runs the High+ dependency-advisory gate', () => {
    expect(src).toMatch(/pnpm audit --audit-level high/);
  });

  test('every third-party action is pinned to a full 40-hex commit SHA (no tag/branch/latest/short SHA)', () => {
    const useLines = src.split('\n').filter((l) => /^\s*(-\s*)?uses:\s*\S/.test(l));
    expect(useLines.length).toBeGreaterThan(0);
    for (const line of useLines) {
      const ref = (/uses:\s*(\S+)/.exec(line)?.[1] ?? '').split('@')[1] ?? '';
      expect(ref).toMatch(/^[0-9a-f]{40}$/); // full immutable commit SHA only
      expect(ref).not.toMatch(/^(latest|main|master)$/);
      expect(ref).not.toMatch(/^v\d/); // no version tags
      // The release tag must be retained in an inline comment for auditability.
      expect(line).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  test('contains no deployment / publish steps', () => {
    // Strip comments so explanatory prose can't trip the check; inspect actual YAML instructions only.
    // CRLF-safe: split on \r?\n and strip from '#' to end-of-line (no `$`, which `.` won't reach past \r).
    const code = src
      .split(/\r?\n/)
      .map((l) => l.replace(/#.*/, ''))
      .join('\n')
      .toLowerCase();
    for (const bad of ['deploy', 'render.com', 'docker push', 'peaceiris', 'aws-actions', 'npm publish', 'pnpm publish']) {
      expect(code).not.toContain(bad);
    }
  });

  test('uses no repository secrets and dumps no environment/context', () => {
    expect(src).not.toMatch(/\$\{\{\s*secrets\./); // no repo secrets referenced
    expect(src).not.toMatch(/toJSON\(\s*(secrets|github)\s*\)/);
    expect(src).not.toMatch(/(^|\s)(printenv|env)\s*(\||$)/m);
    expect(src).not.toMatch(/Get-ChildItem\s+Env:/i);
  });

  test('the run-scoped DB password is derived from non-secret run metadata (not a literal secret)', () => {
    expect(src).toMatch(/POSTGRES_PASSWORD:\s*ci-\$\{\{\s*github\.run_id\s*\}\}/);
  });
});
