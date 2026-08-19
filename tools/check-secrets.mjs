#!/usr/bin/env node
/**
 * ACBP-P0-013 — Lightweight local secret scanner (NFR-018). Hardened by ACBP-P7-007 (CDR-080 §8 slice 6).
 *
 * Detects representative committed-credential patterns and forbids committed .env files.
 * This is a fast pre-commit / CI gate, NOT a replacement for a full production secret scanner — and it is a
 * SOURCE scanner, so it structurally cannot prove trust-critical #15 or #16, which are runtime properties.
 * "Zero findings" here is evidence about the repository, not about the running product.
 *
 * Scope (implementation + root config): apps/, packages/, tools/, .github/, and root config files.
 * Deliberately NOT scanned for content: docs/, product-specification/, evidence/, tooling/
 * (architectural prose and redacted research contain the words "secret"/"token" and example
 * patterns; the precise regexes below would not match them, but they are excluded to keep the
 * gate noise-free). The .env prohibition is enforced repository-wide.
 *
 * ACBP-P7-007 CHANGED THE FILE-SELECTION RULE FROM AN ALLOWLIST TO A DENYLIST, and that is the point of the
 * change rather than a detail of it. The old rule scanned an allowlist of 11 extensions, so ANY other file
 * inside a scanned root was invisible: 16 existed, including `tools/local/db.ps1` and `tools/local/provision.sh`
 * — shell and PowerShell being exactly where a connection string gets pasted. A new extension was silently
 * unscanned by default. Now every file is scanned unless its extension is known-binary or known-build, so the
 * default is COVERED and adding an exclusion is a visible edit.
 *
 * Findings never print the full secret value. Reviewed exceptions go in tools/secret-allowlist.txt — and an
 * entry there that no longer suppresses anything is itself a finding (STALE-ALLOWLIST), because a permanent
 * silence nobody revisits is how a real credential eventually hides behind a reviewed decision.
 *
 * Usage:  node tools/check-secrets.mjs [root] [--json]
 * Exit:   0 = clean, 1 = finding(s), 2 = scanner error / failed self-test.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, resolve, relative, dirname, basename, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const JSON_MODE = args.includes('--json');
const rootArg = args.find((a) => !a.startsWith('--'));
const ROOT = resolve(rootArg ?? process.env.ACBP_SECRET_ROOT ?? resolve(dirname(fileURLToPath(import.meta.url)), '..'));

const CONTENT_SCAN_DIRS = ['apps', 'packages', 'tools', '.github'];
const ROOT_CONFIG_FILES = ['package.json', 'pnpm-workspace.yaml', 'tsconfig.base.json', 'tsconfig.json', 'eslint.config.mjs'];

/**
 * Extensions NEVER content-scanned: binary formats and build products. Everything else IS scanned.
 * A file type absent from this list is covered — the inverse of the pre-P7-007 rule.
 */
const SKIP_EXTS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.avif', '.bmp',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pdf', '.zip', '.gz', '.tgz', '.br', '.7z', '.rar',
  '.mp4', '.webm', '.mp3', '.wav',
  '.tsbuildinfo', '.map', '.wasm', '.node', '.exe', '.dll', '.so', '.dylib',
]);
/** A file larger than this is not credential-shaped source; skipping bounds the gate's runtime. */
const MAX_SCAN_BYTES = 2_000_000;

// Build output (gitignored, never committed) is out of scope. `.next` is the Next.js build directory
// (ACBP-P1-001); it inlines public config (e.g. NEXT_PUBLIC_* placeholders) into client bundles.
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.next']);
// The repo-wide `.env` walk skips these DIRECTORY NAMES at any depth.
//
// `.claude` is here because of ACBP-P7-007's second review pass. The agent tooling creates git worktrees under
// `.claude/worktrees/`, each a full checkout of ANOTHER branch nested inside this one, and this walk visited all
// of them: 4,672 files, of which 3,604 were under `.claude/`. A `.env` committed on a sibling branch would have
// been reported as a finding against THIS branch, naming a path that is not in this branch's tree — a false
// positive nobody could act on. (The content scan never had this problem: it iterates an explicit root list.)
//
// This also corrects a claim: the ledger said ESLint was the only tool in the gate that walks from the
// repository root. It was not. This walk does too, in the very file the same slice hardened.
const ENV_SCAN_SKIP = new Set(['node_modules', '.git', '.next', '.claude']);

const PATTERNS = [
  { id: 'pem-private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  /**
   * Anthropic (ACBP-API-011, 2026-08-19). Listed BEFORE `openai-key` and carved out of it below.
   *
   * A real `sk-ant-…` key already matched `openai-key`, because `sk-` followed by 20+ of `[A-Za-z0-9_-]` covers
   * `ant-api03-…` too. So the gate would have FAILED on one — correctly — while naming the wrong vendor, and an
   * operator triaging "openai-key in your repo" for an Anthropic credential wastes the minutes that matter most.
   * A finding has to name the thing to revoke.
   */
  { id: 'anthropic-key', re: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  // The negative lookahead hands `sk-ant-…` to the rule above rather than double-reporting one line as two
  // findings. Every other `sk-…` shape is still caught here exactly as before.
  { id: 'openai-key', re: /\bsk-(?!ant-)(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
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

const ALLOWLIST_FILE = join(ROOT, 'tools', 'secret-allowlist.txt');
function loadAllowlist() {
  if (!existsSync(ALLOWLIST_FILE)) return new Set();
  return new Set(
    readFileSync(ALLOWLIST_FILE, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#')),
  );
}
const ALLOW = loadAllowlist();
/** Entries that actually suppressed something this run — the rest are stale. */
const ALLOW_USED = new Set();

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

/** True when the file should be read and pattern-matched. */
function isScannable(fileAbs) {
  if (SKIP_EXTS.has(extname(fileAbs).toLowerCase())) return false;
  try {
    if (statSync(fileAbs).size > MAX_SCAN_BYTES) return false;
  } catch {
    return false;
  }
  return true;
}

/**
 * Every FILE sitting at the repository root that git would actually commit (ACBP-API-011, 2026-08-19).
 *
 * ⚠️ THIS REPLACES A FIVE-NAME ALLOWLIST, AND THE GAP IT LEFT WAS REACHED IN PRACTICE. `ROOT_CONFIG_FILES` named
 * `package.json`, `pnpm-workspace.yaml`, two tsconfigs and the eslint config. The content scan otherwise covered
 * `apps/ packages/ tools/ .github/` — so a root-level file with any OTHER name was scanned by nothing at all.
 *
 * A real Anthropic API key was pasted into `API Key.txt` at this repository's root while wiring the model
 * provider. It was untracked, un-ignored, and therefore one `git add -A` from being committed and pushed — and
 * this gate, the one control whose entire job is to catch that, reported `✔ secret scan passed` while the file
 * sat beside the files it was reading. It was not committed, but nothing here is why.
 *
 * The rule is now "the root is covered by default", matching the ACBP-P7-007 fix one level up: that slice
 * replaced a known-extensions allowlist with "scan everything unless the extension is known-binary", after a
 * newly-added extension turned out to be silently unscanned. Same defect, same shape, one directory higher.
 *
 * GIT-IGNORED FILES ARE SKIPPED, on the reasoning `isGitIgnored` already documents for the `.env` walk: a file
 * git will not commit is not a repository leak. That is what keeps `.env` and a now-ignored `API Key.txt` out of
 * the report while still covering everything a real commit would sweep in. It also means an ignore rule and this
 * scan are complements, not substitutes — the ignore rule protects the names somebody predicted, this covers the
 * ones nobody did.
 */
function rootLevelFiles() {
  const out = [];
  for (const name of readdirSync(ROOT)) {
    const p = join(ROOT, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    // Ignored AND untracked — see `isOutOfCommitScope`. Using the ignore rule alone here would skip a root file
    // that was tracked before a later `.gitignore` rule matched it, and such a file is still committed.
    if (isOutOfCommitScope(p)) continue;
    out.push(p);
  }
  return out;
}

/**
 * Every path git currently TRACKS, as absolute paths. Read once — `git ls-files` per file would be ~900 spawns.
 *
 * Needed because "git-ignored" and "not committed" are NOT the same thing: a file that was tracked BEFORE a
 * `.gitignore` rule matched it stays tracked and still ships in every commit, while `git check-ignore` happily
 * reports it as ignored. Skipping on the ignore rule alone would therefore hide a real committed credential —
 * so a file is out of scope only when it is ignored AND untracked.
 */
function trackedPaths() {
  const out = new Set();
  try {
    const res = spawnSync('git', ['ls-files', '-z'], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (res.status !== 0 || typeof res.stdout !== 'string') return out;
    for (const rel of res.stdout.split('\0')) {
      if (rel !== '') out.add(join(ROOT, rel));
    }
  } catch {
    /* git unavailable — the caller falls back to scanning everything, which is the safe direction */
  }
  return out;
}
const TRACKED = trackedPaths();

/**
 * Is this file outside the "could be committed" set? (ACBP-API-011 follow-up, 2026-08-19.)
 *
 * The `.env` walk has applied this reasoning since P0-021 — *"A git-ignored file can never be committed, so it is
 * out of scope"* — but the CONTENT scan never did, because until now nothing git-ignored lived inside `apps/`,
 * `packages/`, `tools/` or `.github/`. Wiring `apps/web/.env.local` and Clerk's keyless `apps/web/.clerk/` cache
 * put two real, correctly-ignored credential files inside a scanned root, and the gate went red on files git will
 * never publish. A gate that fires on something the developer cannot fix by any action except deleting their local
 * config is a gate people learn to bypass, which is how a real finding later gets waved through.
 *
 * FAIL-OPEN IS DELIBERATE HERE AND BOUNDED: if git is unavailable, `TRACKED` is empty and `isGitIgnored` returns
 * false, so every file is scanned — noisier, never quieter.
 */
function isOutOfCommitScope(fileAbs) {
  if (TRACKED.has(fileAbs)) return false;
  return isGitIgnored(fileAbs);
}

const findings = [];
let scannedCount = 0;

// 1) Content scan of implementation + EVERY committable root-level file
const contentFiles = [
  ...new Set([
    ...CONTENT_SCAN_DIRS.flatMap((d) => walk(join(ROOT, d))),
    ...rootLevelFiles(),
    // Kept as an unconditional floor rather than deleted: if one of these were ever ignored, or `rootLevelFiles`
    // regressed, the five files most likely to carry a pasted credential would still be read. A guard that can
    // quietly narrow itself is the failure this whole function exists to correct.
    ...ROOT_CONFIG_FILES.map((f) => join(ROOT, f)).filter((p) => existsSync(p)),
  ]),
];
for (const fileAbs of contentFiles) {
  if (isOutOfCommitScope(fileAbs)) continue;
  if (!isScannable(fileAbs)) continue;
  const rel = relative(ROOT, fileAbs).replace(/\\/g, '/');
  let text;
  try {
    text = readFileSync(fileAbs, 'utf8');
  } catch {
    continue;
  }
  // A NUL byte means binary content that slipped past the extension check — reading it as text would produce
  // meaningless matches, so skip it rather than emit noise a reviewer would learn to ignore.
  if (text.includes('\u0000')) continue;
  scannedCount += 1;
  const lines = text.split('\n');
  lines.forEach((ln, i) => {
    for (const { id, re } of PATTERNS) {
      const m = re.exec(ln);
      if (!m) continue;
      const key = `${rel}|${id}`;
      if (ALLOW.has(key)) {
        ALLOW_USED.add(key);
        continue;
      }
      findings.push({ id, file: rel, line: i + 1, redacted: redact(m[0]) });
    }
  });
}

// 2) Repository-wide committed-.env prohibition (.env.example allowed)
for (const fileAbs of walkAll(ROOT)) {
  const name = basename(fileAbs);
  if (/^\.env(\..+)?$/.test(name) && name !== '.env.example' && !isGitIgnored(fileAbs)) {
    const rel = relative(ROOT, fileAbs).replace(/\\/g, '/');
    const key = `${rel}|committed-env-file`;
    if (ALLOW.has(key)) {
      ALLOW_USED.add(key);
      continue;
    }
    findings.push({ id: 'committed-env-file', file: rel, line: 0, redacted: '(committed .env file — move values to the secret manager; commit .env.example only)' });
  }
}

// 3) STALE ALLOWLIST ENTRIES (ACBP-P7-007). An entry that suppressed nothing is a permanent silence nobody
// revisits — and the file it points at may since have been deleted, renamed, or fixed. Every one of the seven
// pre-existing entries silences a rule for a WHOLE FILE FOREVER, so the set must be kept honest by the gate
// rather than by memory.
const stale = [...ALLOW].filter((e) => !ALLOW_USED.has(e));
for (const entry of stale) {
  findings.push({ id: 'stale-allowlist-entry', file: 'tools/secret-allowlist.txt', line: 0, redacted: `("${entry}" suppresses nothing — remove it)` });
}

// 4) NEGATIVE SELF-TEST. A scanner that stops matching becomes a scanner that always passes, which reads as a
// clean repository. Prove each pattern still fires on a synthetic value before reporting a clean tree.
{
  // The probes are ASSEMBLED rather than written as literals, and that is not cosmetic: this file is inside a
  // scanned root, so literal probes make the scanner fail on itself. Allowlisting `tools/check-secrets.mjs`
  // would be the wrong fix — it would blind the gate to a real credential pasted into the gate. Assembling
  // keeps every byte of the probe visible to a reader while matching no pattern at rest.
  //
  // This was found the hard way: an earlier revision embedded a literal NUL in the binary-content guard, which
  // made the scanner SKIP ITS OWN FILE and hid these probes by accident. Replacing the NUL with `\\u0000`
  // restored self-coverage and immediately produced nine findings — the tool had been invisible to itself.
  const A = (n) => 'A'.repeat(n);
  const probes = {
    'pem-private-key': `-----BEGIN RSA ${'PRIVATE'} KEY-----`,
    'anthropic-key': `sk${'-'}ant-api03-${A(24)}`,
    'openai-key': `sk${'-'}proj-${A(24)}`,
    'clerk-secret-key': `sk${'_'}live_${A(24)}`,
    'github-token': `ghp${'_'}${A(36)}`,
    'aws-access-key-id': `AKI${'A'}${A(16)}`,
    'google-api-key': `AIz${'a'}${A(35)}`,
    'slack-token': `xox${'b'}-${A(12)}`,
    'bearer-token': `Bear${'er'} ${A(24)}`,
    'generic-credential-assignment': `api${'_'}key: "${A(20)}"`,
  };
  const dead = PATTERNS.filter(({ id, re }) => !re.test(probes[id] ?? '')).map((p) => p.id);
  if (dead.length > 0) {
    console.error(`✖ secret scan FAILED ITS OWN SELF-TEST — these patterns no longer match a known value: ${dead.join(', ')}`);
    console.error('  A clean result from this tool would be meaningless. Fix the patterns before trusting a pass.');
    process.exit(2);
  }
}

// ---- Report ----
// A SCAN THAT READ NOTHING IS NOT A CLEAN SCAN. Without this the tool printed
// "✔ secret scan passed (0 findings; 0 files scanned …)" and exited 0 against a tree whose roots had moved or
// been renamed — a citable, meaningless green. That matters more here than in a normal checker: `check:secrets`
// is its own named CI step precisely so its output can be pasted into a launch-gate-12 review, so a vacuous
// pass is a vacuous piece of evidence. The self-test proves the RULES still match; it says nothing about
// whether discovery found any files to apply them to, which is the failure this catches.
if (scannedCount === 0) {
  console.error('✖ secret scan read ZERO files — discovery is broken, not the tree.');
  console.error(`  Roots searched under ${ROOT}: apps/, packages/, tools/, .github/, root config.`);
  console.error('  A scan that read nothing cannot be evidence of anything. Fix the walk before trusting a pass.');
  process.exit(2);
}
if (JSON_MODE) {
  // Machine-readable evidence for the ACBP-P7-007 bundle. Values stay redacted here too.
  console.log(JSON.stringify({ root: relative(process.cwd(), ROOT) || '.', filesScanned: scannedCount, allowlistEntries: ALLOW.size, allowlistUsed: ALLOW_USED.size, findings }, null, 2));
  process.exit(findings.length === 0 ? 0 : 1);
}
if (findings.length === 0) {
  console.log(
    `✔ secret scan passed (0 findings; ${scannedCount} files scanned in apps/, packages/, tools/, .github/, every committable root file; ` +
      `.env prohibition repo-wide; ${ALLOW.size} allowlist entr${ALLOW.size === 1 ? 'y' : 'ies'}, all still in use. Self-test passed).`,
  );
  process.exit(0);
}
findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.id.localeCompare(b.id));
console.error(`✖ secret scan FAILED — ${findings.length} finding(s) (values redacted):\n`);
for (const f of findings) {
  console.error(`  [${f.id}] ${f.file}:${f.line}  ${f.redacted}`);
}
console.error('\nIf a finding is a reviewed false positive, add "<path>|<rule-id>" to tools/secret-allowlist.txt.');
console.error('A stale-allowlist-entry finding means the opposite: remove the line, because it no longer suppresses anything.');
process.exit(1);
