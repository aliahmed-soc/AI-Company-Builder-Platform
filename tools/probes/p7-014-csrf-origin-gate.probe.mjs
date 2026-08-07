#!/usr/bin/env node
// ACBP-P7-014 — mutation probe for the CSRF origin gate (CDR-081 §6.1). `pnpm run probe:csrf-origin-gate`.
//
// Each entry neutralises ONE control WITHOUT touching a test, runs the suite that is supposed to notice,
// and reverts. A SURVIVOR means the control is unmeasured — a green suite that would stay green with the
// protection deleted.
//
// WHY THIS FILE IS COMMITTED RATHER THAN RUN AND DESCRIBED. ACBP-P6-006's probe was a branch whose commit
// (`fe85082`) is reachable from no ref today; ACBP-P7-002's was not preserved at all, so CDR-079 records a
// figure ("8 of 17 went red") that nobody can re-derive, and `P7-002-REVIEW-COVERAGE.md` §2.1 instructs the
// next ticket to do better. A run id decays into a number in a document; a script re-derives the claim on
// demand, on any checkout, forever.
//
// ⚠️ IT EDITS TRACKED SOURCE FILES IN PLACE and restores them in a `finally`. It is deliberately NOT part
// of `check` or `test`. If it is interrupted, `git diff` shows exactly what to revert.
//
// THE STRICTNESS OF THE KILL TEST IS LOAD-BEARING, and it was earned. The first version shelled out to
// `npx`, which `execFileSync` cannot spawn without a shell on Windows: every mutation exited 1 with no
// output and the probe reported SEVEN KILLS having never run a single test. A red exit code is not
// evidence — a probe that dies before the assertions reports the same 1 as a probe that fails them. So a
// kill now requires the "Tests N failed | M passed" tally to show failures, and the report prints the NAMES
// of the tests that went red so a reader can check they are the ones the mutation should have broken. This
// is CDR-080 §8.3's lesson ("a mutation that does not reach the assertion proves nothing") arriving through
// a third door.
import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const SAME_ORIGIN = 'apps/web/src/server/http/same-origin.ts';
const PROXY = 'apps/web/src/proxy.ts';

const MUTATIONS = [
  {
    id: 'M1 no_provenance -> allow',
    what: 'CDR-081 §1.1 row 10: absence of provenance stops being a denial.',
    file: SAME_ORIGIN,
    from: `if (origin === null) return { kind: 'deny', reason: 'no_provenance' };`,
    to: `if (origin === null) return { kind: 'allow', reason: 'origin_allowed' };`,
    suites: ['apps/web/src/server/http/same-origin.test.ts', 'apps/web/src/proxy.test.ts'],
  },
  {
    id: 'M2 same-site -> allow',
    what: 'CDR-081 §1.1 row 4: a sibling subdomain becomes same-origin.',
    file: SAME_ORIGIN,
    from: `        return { kind: 'deny', reason: 'sec_fetch_same_site' };`,
    to: `        return { kind: 'allow', reason: 'sec_fetch_same_origin' };`,
    suites: ['apps/web/src/server/http/same-origin.test.ts', 'apps/web/src/proxy.test.ts'],
  },
  {
    id: 'M3 unrecognised -> allow',
    what: 'CDR-081 §1.1 row 7: the closed vocabulary opens, so any future token is a bypass.',
    file: SAME_ORIGIN,
    from: `        return { kind: 'deny', reason: 'sec_fetch_unrecognised' };`,
    to: `        return { kind: 'allow', reason: 'sec_fetch_same_origin' };`,
    suites: ['apps/web/src/server/http/same-origin.test.ts'],
  },
  {
    id: 'M4 empty allowlist -> allow everything',
    what: 'CDR-081 §1.2: a missing APP_PUBLIC_URL degrades toward ACCEPTING instead of refusing.',
    file: SAME_ORIGIN,
    from: `  return allowedOrigins.includes(origin)`,
    to: `  return allowedOrigins.length === 0 || allowedOrigins.includes(origin)`,
    suites: ['apps/web/src/server/http/same-origin.test.ts'],
  },
  {
    id: 'M5 origin compared by prefix',
    what: 'The classic bad comparison: https://app.example.test.evil.test would match.',
    file: SAME_ORIGIN,
    from: `  return allowedOrigins.includes(origin)`,
    to: `  return allowedOrigins.some((a) => origin.startsWith(a))`,
    suites: ['apps/web/src/server/http/same-origin.test.ts'],
  },
  {
    id: 'M6 gate decides, proxy ignores it',
    what: 'CDR-081 §2: the deny verdict stops being returned — the gate runs and does nothing.',
    file: PROXY,
    from: `  if (verdict.kind === 'deny') return NextResponse.json({ error: 'forbidden' }, { status: 403 });`,
    to: `  void verdict;`,
    suites: ['apps/web/src/proxy.test.ts'],
    checker: true,
  },
  {
    id: 'M7 webhook bypass removed',
    what: 'CDR-081 §2 step 1: Clerk sends no provenance, so identity ingestion would break.',
    file: PROXY,
    from: `  if (isClerkWebhookPath(new URL(request.url).pathname)) return undefined;`,
    to: `  void isClerkWebhookPath;`,
    suites: ['apps/web/src/proxy.test.ts'],
    checker: true,
  },
];

function run(cmd, args) {
  try {
    return { code: 0, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const results = [];
for (const m of MUTATIONS) {
  const original = readFileSync(m.file, 'utf8');
  if (!original.includes(m.from)) {
    results.push({ id: m.id, verdict: 'PROBE INVALID — anchor text not found', detail: m.from });
    continue;
  }
  writeFileSync(m.file, original.replace(m.from, m.to), 'utf8');
  try {
    // node + vitest's own entry, NOT `npx`: execFileSync without a shell cannot spawn npx on Windows, and
    // the ENOENT surfaces as exit 1 with no output — which the first version of this probe read as SEVEN
    // kills. A probe that never ran the tests reporting a clean sweep is the exact false confirmation
    // CDR-080 §8.3 is about, reproduced here by a different mechanism. The tally check below is what
    // caught it, so the strictness is load-bearing rather than fussy.
    const r = run(process.execPath, ['node_modules/vitest/vitest.mjs', 'run', ...m.suites]);
    // "Tests  N failed | M passed" is the line that proves the suite RAN and its ASSERTIONS failed. A red
    // exit code alone does not: a probe that breaks the build before the tests execute reports the same 1,
    // and reading it as a kill is the false confirmation CDR-080 §8.3 names.
    const tally = /Tests\s+(\d+) failed \| (\d+) passed/.exec(r.out);
    const names = [...r.out.matchAll(/^\s*(?:×|FAIL)\s+(.+?)(?:\s+\d+ms)?$/gm)].map((x) => x[1].trim());
    let checker = null;
    if (m.checker) checker = run(process.execPath, ['tools/check-csrf-origin-gate.mjs']).code;
    const assertionsFailed = tally !== null && Number(tally[1]) > 0;
    results.push({
      id: m.id,
      what: m.what,
      suiteExit: r.code,
      failedTests: tally ? Number(tally[1]) : null,
      passedTests: tally ? Number(tally[2]) : null,
      firstFailures: names.filter((n) => !/\.test\.(ts|mjs)$/.test(n)).slice(0, 3),
      checkerExit: checker,
      // A kill requires ASSERTIONS to have failed (or, for the two wiring mutations, the static checker to
      // have fired). A bare non-zero exit is not accepted as evidence.
      verdict: assertionsFailed || checker === 1 ? 'KILLED' : 'SURVIVED (or the probe never reached the tests)',
    });
  } finally {
    writeFileSync(m.file, original, 'utf8');
  }
}

console.log('\n=== ACBP-P7-014 mutation probe ===\n');
for (const r of results) {
  console.log(
    `${r.verdict === 'KILLED' ? '✔ KILLED  ' : '✖ ' + r.verdict} ${r.id}\n            ${r.what ?? r.detail}\n` +
      `            tests: ${r.failedTests} failed / ${r.passedTests} passed (exit ${r.suiteExit})` +
      (r.checkerExit === null || r.checkerExit === undefined ? '' : ` | static checker exit=${r.checkerExit}`) +
      (r.firstFailures?.length ? `\n            red: ${r.firstFailures.join(' | ')}` : ''),
  );
}
const survivors = results.filter((r) => r.verdict !== 'KILLED');
console.log(`\n${results.length - survivors.length}/${results.length} killed, ${survivors.length} survivor(s).\n`);
process.exit(survivors.length === 0 ? 0 : 1);
