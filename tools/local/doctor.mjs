// ACBP-P0-021 — local-development doctor (read-only diagnostics; never mutates; never prints secrets).
// Run: `pnpm local:doctor` (or `node tools/local/doctor.mjs`). Cross-platform (Node built-ins only).
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import net from 'node:net';
import { isRepoRoot, redactDbUrl, validateDbUrl } from './lib.mjs';

function tryVersion(commandLine) {
  try {
    // Static command strings only (no user input); passing the whole line to the shell avoids the
    // DEP0190 warning that fires when args are combined with `shell: true`.
    const r = spawnSync(commandLine, { encoding: 'utf8', shell: true });
    if (r.status === 0 && typeof r.stdout === 'string') return r.stdout.trim().split('\n')[0].trim();
    return null;
  } catch {
    return null;
  }
}

function portOpen(host, port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let done = false;
    const finish = (open) => {
      if (done) return;
      done = true;
      socket.destroy();
      resolve(open);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** Collect diagnostics as structured items — pure of side effects beyond read-only probes. */
export async function collectChecks(cwd = process.cwd(), env = process.env) {
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  const pnpmVersion = tryVersion('pnpm --version');
  const gitVersion = tryVersion('git --version');
  const wslList = process.platform === 'win32' ? tryVersion('wsl --list --quiet') : null;

  const dbUrl = env.DATABASE_URL;
  const testDbUrl = env.ACBP_TEST_DATABASE_URL;

  const items = [
    { name: 'repository root', required: true, ok: isRepoRoot(cwd), detail: cwd },
    { name: 'node >= 22', required: true, ok: nodeMajor >= 22, detail: `v${process.versions.node}` },
    { name: 'pnpm >= 11', required: true, ok: pnpmVersion !== null && Number(pnpmVersion.split('.')[0]) >= 11, detail: pnpmVersion ?? 'not found' },
    { name: 'git', required: true, ok: gitVersion !== null, detail: gitVersion ?? 'not found' },
    { name: 'dependencies installed', required: true, ok: existsSync(join(cwd, 'node_modules')), detail: 'node_modules' },
    { name: 'WSL (optional, Windows)', required: false, ok: process.platform !== 'win32' || wslList !== null, detail: process.platform === 'win32' ? (wslList ? 'available' : 'not available') : 'n/a' },
    { name: 'DATABASE_URL present', required: false, ok: typeof dbUrl === 'string' && dbUrl !== '', detail: dbUrl ? `${validateDbUrl(dbUrl).ok ? 'valid' : 'INVALID'} ${redactDbUrl(dbUrl)}` : 'unset (fine for unit tests)' },
    { name: 'ACBP_TEST_DATABASE_URL present', required: false, ok: typeof testDbUrl === 'string' && testDbUrl !== '', detail: testDbUrl ? `${validateDbUrl(testDbUrl).ok ? 'valid' : 'INVALID'} ${redactDbUrl(testDbUrl)}` : 'unset (integration tests will skip)' },
  ];

  // Informational: is a Postgres port reachable locally?
  const pgReachable = await portOpen('127.0.0.1', 5432);
  items.push({ name: 'postgres 127.0.0.1:5432 reachable', required: false, ok: pgReachable, detail: pgReachable ? 'reachable' : 'not reachable (start local DB to run integration tests)' });

  return items;
}

async function main() {
  const items = await collectChecks();
  let requiredFailed = 0;
  for (const it of items) {
    const mark = it.ok ? 'OK ' : it.required ? 'FAIL' : 'warn';
    if (!it.ok && it.required) requiredFailed += 1;
    console.log(`  [${mark}] ${it.name}: ${it.detail}`);
  }
  if (requiredFailed > 0) {
    console.error(`\n${requiredFailed} required check(s) failed. See docs/LOCAL-DEVELOPMENT.md → Troubleshooting.`);
    process.exitCode = 1;
  } else {
    console.log('\nAll required checks passed. Optional items above are informational.');
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
