// THE EVIDENCE STANDARD'S OWN FOUNDATION, made self-checking.
//
// Every completion claim in this repository rests on one sentence: "hosted CI green with ZERO SKIPS on the exact
// SHA". That sentence is only worth anything because `tools/ci/preflight.mjs` fails the run when
// `ACBP_TEST_DATABASE_URL` is absent in CI, which is what stops 122 real-PostgreSQL suites from skipping quietly
// and reporting a green build over tests that never executed.
//
// ⚠️ WHAT THIS PINS, AND WHY IT IS NOT PARANOIA. That chain is currently correct BY COINCIDENCE OF FOUR SEPARATE
// STRING LITERALS: three independent `hasTestDatabase` definitions, plus the preflight. Nothing connects them.
// If any one were edited to read a different variable, the preflight would keep passing while that package's
// suites skipped — a green run over unexecuted tests, which is precisely the artefact the preflight exists to
// prevent and the exact failure mode `AGENTS.md` §3 opens with ("a suite skipped by a broken precondition, read
// as nothing broke").
//
// This repository has already been bitten by duplicated guards drifting: `tools/lib/test-citation.mjs` exists
// because two index checkers made the same claims from two copies. Same shape, higher stakes.
import { describe, test, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const ENV_VAR = 'ACBP_TEST_DATABASE_URL';

/** Every file that defines `hasTestDatabase`, found rather than listed — a hard-coded list would rot. */
function definitionFiles() {
  const out = execSync('git grep -l "export const hasTestDatabase" -- packages', { encoding: 'utf8' }).trim();
  return out === '' ? [] : out.split('\n').map((l) => l.trim()).filter(Boolean);
}

describe('the skip contract is single-valued', () => {
  test('there are definitions to check at all — an empty list would pass every assertion below vacuously', () => {
    const files = definitionFiles();
    expect(files.length, 'no hasTestDatabase definition found; the search or the name moved').toBeGreaterThanOrEqual(3);
  });

  test.each(definitionFiles())('%s keys its skip on the same env var the preflight guards', (file) => {
    const src = readFileSync(file, 'utf8');
    // The definition and the variable it reads must sit together. Asserting only that the file mentions the var
    // somewhere would pass on a file that mentioned it in a comment and read a different one in code.
    const line = src.split('\n').findIndex((l) => l.includes('export const hasTestDatabase'));
    expect(line).toBeGreaterThan(0);
    const window = src.split('\n').slice(Math.max(0, line - 4), line + 1).join('\n');
    expect(window, `${file} defines hasTestDatabase without reading ${ENV_VAR} directly above it`).toContain(ENV_VAR);
  });

  test('the preflight guards THAT variable, not a differently-named one', () => {
    const src = readFileSync('tools/ci/preflight.mjs', 'utf8');
    expect(src).toContain(ENV_VAR);
    // And it must actually fail on absence rather than warn: a preflight that logged and exited 0 would leave
    // every skip in place while looking like it had checked something.
    expect(src).toMatch(/process\.exit\(1\)/);
  });

  test('the preflight only stands down when CI is NOT true — it cannot be waved off by another variable', () => {
    const src = readFileSync('tools/ci/preflight.mjs', 'utf8');
    // The local no-op is deliberate and documented. What must not appear is a second escape hatch: a SKIP_*,
    // FORCE_*, or ALLOW_* switch that turns the guard off inside CI, which would make every zero-skip claim
    // conditional on an env var nobody reads in the evidence.
    const escapes = [...src.matchAll(/process\.env(?:\.|\[['"])([A-Z0-9_]+)/g)].map((m) => m[1]);
    expect(escapes.sort()).toEqual(['ACBP_TEST_DATABASE_URL', 'CI']);
  });
});

describe('every skip in the real-PostgreSQL suites keys on that one condition', () => {
  test('there is exactly ONE skip predicate across the repository', () => {
    // 122 uses of `skipIf(!hasTestDatabase)` today. A SECOND predicate would mean some suites skip for a reason
    // the preflight does not guard — and the run would still say "0 skipped" while those never ran.
    const out = execSync('git grep -ohE "skipIf\\([^)]*\\)" -- packages apps', { encoding: 'utf8' }).trim();
    const predicates = [...new Set(out.split('\n').map((l) => l.trim()).filter(Boolean))];

    expect(predicates.length, `more than one skip predicate is in use:\n${predicates.join('\n')}`).toBe(1);
    expect(predicates[0]).toBe('skipIf(!hasTestDatabase)');
  });

  test('and it is used widely enough that this test is measuring something', () => {
    const count = execSync('git grep -c "skipIf(!hasTestDatabase)" -- packages apps', { encoding: 'utf8' })
      .trim()
      .split('\n')
      .reduce((n, l) => n + Number(l.split(':').pop() ?? 0), 0);
    expect(count, 'the skip predicate all but vanished — did the suites move, or stop being conditional?').toBeGreaterThan(50);
  });
});
