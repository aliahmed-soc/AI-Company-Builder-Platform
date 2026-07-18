#!/usr/bin/env node
/**
 * ACBP-P0-013 — Lightweight local secret scanner (NFR-018).
 *
 * Detects representative committed-credential patterns and forbids committed .env files.
 * This is a fast pre-commit / CI gate, NOT a replacement for a full production secret scanner.
 *
 * Scope (implementation + root config): apps/, packages/, tools/, and root config files.
 * Deliberately NOT scanned for content: docs/, product-specification/, evidence/, tooling/
 * (architectural prose and redacted research contain the words "secret"/"token" and example
 * patterns; the precise regexes below would not match them, but they are excluded to keep the
 * gate noise-free). The .env prohibition is enforced repository-wide.
 *
 * Findings never print the full secret value. Reviewed exceptions go in tools/secret-allowlist.txt.
 *
 * Exit: 0 = clean, 1 = finding(s), 2 = scanner error.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = resolve(process.argv[2] ?? process.env.ACBP_SECRET_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const CONTENT_SCAN_DIRS = ['apps', 'packages', 'tools', '.github'];
const ROOT_CONFIG_FILES = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.json', 'eslint.config.mjs'];
const TEXT_EXTS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.yaml', '.yml', '.txt'];
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const ENV_SCAN_SKIP = new Set(['node_modules', '.git']);

const PATTERNS = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: 'openai-key', re: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: 'clerk-secret-key', re: /\bsk_(?:live|test)_[A-Za-z0-9]{20,}\b/ },
  { id: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: 'aws-access-key-id', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'bearer-token', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}={0,2}/ },
  {
    id: 'generic-credential-assignment',
    re: /(?:api[_-]?key|client[_-]?secret|access[_-]?key|["']?secret["']?|["']?token["']?|password|passwd)\s*[:=]\s*["'][^"'\s]{16,}["']/i,
  },
];

function loadAllowlist() {
  const f = join(ROOT, 'tools', 'secret-allowlist.txt');
  if (!existsSync(f)) return new Set();
  return new Set(
    readFileSync(f, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}
const ALLOW = loadAllowlist();

function redact(s) {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length <= 6 ? '[REDACTED]' : `${t.slice(0, 4)}…[REDACTED ${t.length} chars]`;
}

function walk(dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

// A git-ignored file can never be committed, so it is out of scope for the "no committed .env"
// rule (e.g., the P0-021 local-dev `.env.local`). Only NON-ignored .env files are a real risk.
function isGitIgnored(abs) {
  try {
    return spawnSync('git', ['check-ignore', '--quiet', abs], { cwd: ROOT }).status === 0;
  } catch {
    return false; // git unavailable -> fail safe (treat as not ignored, i.e., still flag)
  }
}

// Repository-wide .env walk (filenames only; no content).
function walkAll(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (ENV_SCAN_SKIP.has(name)) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walkAll(p));
    else out.push(p);
  }
  return out;
}

const findings = [];

// 1) Content scan of implementation + root config
const contentFiles = [
  ...CONTENT_SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
  ...ROOT_CONFIG_FILES.map((f) => join(ROOT, f)).filter((p) => existsSync(p)),
];
for (const fileAbs of contentFiles) {
  if (!TEXT_EXTS.some((e) => fileAbs.endsWith(e))) continue;
  const rel = relative(ROOT, fileAbs).replace(/\\/g, '/');
  const lines = readFileSync(fileAbs, 'utf8').split('\n');
  lines.forEach((ln, i) => {
    for (const { id, re } of PATTERNS) {
      const m = re.exec(ln);
      if (m && !ALLOW.has(`${rel}|${id}`)) {
        findings.push({ id, file: rel, line: i + 1, redacted: redact(m[0]) });
      }
    }
  });
}

// 2) Repository-wide committed-.env prohibition (.env.example allowed)
for (const fileAbs of walkAll(ROOT)) {
  const name = basename(fileAbs);
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example' && !isGitIgnored(fileAbs)) {
    const rel = relative(ROOT, fileAbs).replace(/\\/g, '/');
    if (!ALLOW.has(`${rel}|committed-env-file`)) {
      findings.push({ id: 'committed-env-file', file: rel, line: 0, redacted: '(committed .env file — move values to the secret manager; commit .env.example only)' });
    }
  }
}

// ---- Report ----
if (findings.length === 0) {
  console.log('✔ secret scan passed (0 findings; scanned apps/, packages/, tools/, .github/, root config; .env prohibition repo-wide).');
  process.exit(0);
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
console.error(`✖ secret scan FAILED — ${findings.length} finding(s) (values redacted):\n`);
for (const f of findings) {
  console.error(`  [${f.id}] ${f.file}:${f.line}  ${f.redacted}`);
}
console.error('\nIf a finding is a reviewed false positive, add "<path>|<rule-id>" to tools/secret-allowlist.txt.');
process.exit(1);
