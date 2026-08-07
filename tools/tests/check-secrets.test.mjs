/**
 * ACBP-P7-007 — the FIRST regression suite for tools/check-secrets.mjs (CDR-080 §8 slice 6).
 *
 * The scanner shipped in ACBP-P0-013 and ran on every commit since with NO tests, while `check-boundaries`,
 * `check-reset-lists` and `check-approval-port` all had them. That asymmetry matters more here than elsewhere:
 * a boundary checker that stops working produces a wrong architecture, but a SECRET scanner that stops working
 * produces a green "0 findings" line that reads as proof the repository is clean.
 *
 * Each case builds an ISOLATED temporary workspace under the OS temp dir (never the real source tree), runs the
 * scanner against it via its root argument, asserts the exit code and rule id, and cleans up.
 *
 * Probe values are ASSEMBLED from parts for the same reason the scanner's own self-test assembles them: this
 * file lives inside a scanned root, and literal probes would make the real scan fail on this suite.
 *
 * Run: pnpm run test:boundaries   (or `pnpm test`, which includes it)
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCANNER = join(REPO_ROOT, 'tools', 'check-secrets.mjs');

const A = (n) => 'A'.repeat(n);
/** One synthetic probe per rule — assembled, never a literal. */
const PROBE = {
  'pem-private-key': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
  'openai-key': `sk${'-'}proj-${A(24)}`,
  'clerk-secret-key': `sk${'_'}live_${A(24)}`,
  'github-token': `ghp${'_'}${A(36)}`,
  'aws-access-key-id': `AKI${'A'}${A(16)}`,
  'google-api-key': `AIz${'a'}${A(35)}`,
  'slack-token': `xox${'b'}-${A(12)}`,
  'bearer-token': `Bear${'er'} ${A(24)}`,
  'generic-credential-assignment': `api${'_'}key: "${A(20)}"`,
};

function write(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** @param {{ files?: Record<string,string>, allowlist?: string, json?: boolean }} opts */
function run(opts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-secrets-'));
  try {
    write(root, 'package.json', '{"name":"probe"}\n');
    for (const [p, c] of Object.entries(opts.files ?? {})) write(root, p, c);
    if (opts.allowlist !== undefined) write(root, 'tools/secret-allowlist.txt', opts.allowlist);
    const argv = [SCANNER, root, ...(opts.json === true ? ['--json'] : [])];
    const r = spawnSync(process.execPath, argv, { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}`, stdout: r.stdout };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const flags = (label, files, rule) =>
  test(`flags: ${label}`, () => {
    const { code, out } = run({ files });
    expect(code, `expected a finding for ${label}\n${out}`).toBe(1);
    expect(out, `expected rule "${rule}" for ${label}\n${out}`).toContain(`[${rule}]`);
  });

const clean = (label, opts) =>
  test(`clean: ${label}`, () => {
    const { code, out } = run(opts);
    expect(code, `expected a clean scan for ${label}\n${out}`).toBe(0);
  });

// ---- Every pattern fires. Without these the scanner could silently stop matching and still print "0 findings".
for (const [rule, probe] of Object.entries(PROBE)) {
  flags(`${rule} in a .ts file`, { 'packages/x/src/a.ts': `const v = '${probe}';\n` }, rule);
}

// ---- THE HOLE ACBP-P7-007 CLOSED. These extensions were invisible before the allowlist→denylist change; the
// shell and PowerShell cases are real files in this repository (`tools/local/db.ps1`, `tools/local/provision.sh`).
flags('a secret in a .ps1 script', { 'tools/local/db.ps1': `$env:X = "${PROBE['clerk-secret-key']}"\n` }, 'clerk-secret-key');
flags('a secret in a .sh script', { 'tools/local/provision.sh': `export X="${PROBE['openai-key']}"\n` }, 'openai-key');
flags('a secret in a .md file', { 'packages/x/README.md': `Use ${PROBE['github-token']} here.\n` }, 'github-token');
flags('a secret in a .sql file', { 'packages/x/seed.sql': `-- ${PROBE['aws-access-key-id']}\n` }, 'aws-access-key-id');
flags('a secret in an extensionless file', { 'tools/x/Makefile': `KEY=${PROBE['aws-access-key-id']}\n` }, 'aws-access-key-id');

// ---- Scope: excluded directories and build output stay excluded.
clean('a secret under docs/ (deliberately not content-scanned)', { files: { 'docs/notes.md': `${PROBE['openai-key']}\n` } });
clean('a secret under node_modules/', { files: { 'packages/x/node_modules/dep/i.js': `${PROBE['openai-key']}\n` } });
clean('a secret under dist/', { files: { 'packages/x/dist/out.js': `${PROBE['openai-key']}\n` } });
clean('a secret in a skipped binary extension', { files: { 'packages/x/logo.png': `${PROBE['openai-key']}\n` } });

// ---- The .env prohibition.
flags('a committed .env file', { '.env': 'X=1\n' }, 'committed-env-file');
clean('.env.example is allowed', { files: { '.env.example': 'X=\n' } });

// ---- The allowlist suppresses, but only exactly what it names.
clean('an allowlisted finding is suppressed', {
  files: { 'packages/x/src/a.ts': `const v = '${PROBE['openai-key']}';\n` },
  allowlist: 'packages/x/src/a.ts|openai-key\n',
});
flags(
  'an allowlist entry for a DIFFERENT rule does not suppress this one',
  { 'packages/x/src/a.ts': `const v = '${PROBE['openai-key']}';\n` },
  'openai-key',
);
test('an allowlist entry for a different FILE does not suppress this one', () => {
  const { code, out } = run({
    files: { 'packages/x/src/a.ts': `const v = '${PROBE['openai-key']}';\n` },
    allowlist: 'packages/x/src/other.ts|openai-key\n',
  });
  expect(code, out).toBe(1);
  expect(out).toContain('[openai-key]');
});

// ---- STALE ALLOWLIST ENTRIES (new in ACBP-P7-007). A permanent silence nobody revisits is how a real
// credential eventually hides behind a reviewed decision.
test('a stale allowlist entry is itself a finding', () => {
  const { code, out } = run({ files: { 'packages/x/src/a.ts': 'const v = 1;\n' }, allowlist: 'packages/x/src/a.ts|openai-key\n' });
  expect(code, out).toBe(1);
  expect(out).toContain('[stale-allowlist-entry]');
  expect(out).toContain('suppresses nothing');
});
test('comments and blank lines in the allowlist are not treated as stale entries', () => {
  const { code, out } = run({ files: { 'packages/x/src/a.ts': 'const v = 1;\n' }, allowlist: '# a comment\n\n   \n' });
  expect(code, out).toBe(0);
});

// ---- A finding must never print the value it found.
test('the report REDACTS the matched value', () => {
  const probe = PROBE['openai-key'];
  const { out } = run({ files: { 'packages/x/src/a.ts': `const v = '${probe}';\n` } });
  expect(out).toContain('[REDACTED');
  expect(out, 'the scanner printed the secret it was reporting').not.toContain(probe);
});

// ---- --json mode, for the ACBP-P7-007 evidence bundle.
test('--json emits machine-readable findings with values still redacted', () => {
  const probe = PROBE['openai-key'];
  const { code, stdout } = run({ files: { 'packages/x/src/a.ts': `const v = '${probe}';\n` }, json: true });
  expect(code).toBe(1);
  const report = JSON.parse(stdout);
  expect(report.findings).toHaveLength(1);
  expect(report.findings[0].id).toBe('openai-key');
  expect(report.findings[0].file).toBe('packages/x/src/a.ts');
  expect(report.filesScanned).toBeGreaterThan(0);
  expect(stdout).not.toContain(probe);
});
test('--json on a clean tree exits 0 and reports zero findings', () => {
  const { code, stdout } = run({ files: { 'packages/x/src/a.ts': 'const v = 1;\n' }, json: true });
  expect(code).toBe(0);
  expect(JSON.parse(stdout).findings).toEqual([]);
});

// ---- A SCAN THAT READ NOTHING IS NOT A CLEAN SCAN. ---------------------------------------------------------
// ACBP-P7-007, SECOND REVIEW PASS. Against a root with none of the scan roots present, the scanner printed
// "✔ secret scan passed (0 findings; 0 files scanned …)" and exited 0. That green line is not harmless: this
// tool now runs as its own CI step named "launch gate 12 evidence" precisely so its output can be cited, so a
// discovery regression produced a citable, meaningless pass. The self-test proves the RULES still match and says
// nothing about whether discovery found anything to match them against.
test('reading ZERO files is an ERROR, not a clean scan — the green line is cited as gate evidence', () => {
  const root = mkdtempSync(join(tmpdir(), 'acbp-secrets-empty-'));
  try {
    const r = spawnSync(process.execPath, [SCANNER, root], { encoding: 'utf8' });
    expect(r.status, `expected a hard failure on an empty root\n${r.stdout}\n${r.stderr}`).toBe(2);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/read ZERO files/);
    expect(r.stdout, 'it must not also print a success line').not.toMatch(/secret scan passed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
