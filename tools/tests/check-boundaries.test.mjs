/**
 * ACBP-P0-013 — Permanent regression suite for tools/check-boundaries.mjs.
 * ACBP-P0-014 — migrated onto the shared Vitest runner (single test framework).
 *
 * Each case builds an ISOLATED temporary workspace under the OS temp dir (never the real
 * source tree), runs the checker against it via its scan-root argument, asserts the exit
 * code and the expected stable rule id, and always cleans up.
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
const CHECKER = join(REPO_ROOT, 'tools', 'check-boundaries.mjs');
const PACKAGES = ['contracts', 'domain', 'core', 'database', 'gateway', 'adapters', 'observability', 'config', 'test-support'];
const APPS = ['web', 'worker'];

function write(root, relPath, content) {
  const abs = join(root, relPath);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
}

/** Create a full empty workspace, overlay the given fixture files, run the checker, clean up. */
function run(files) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-boundaries-'));
  try {
    for (const p of PACKAGES) write(root, `packages/${p}/src/index.ts`, 'export {};\n');
    for (const a of APPS) write(root, `apps/${a}/src/index.ts`, 'export {};\n');
    for (const [p, c] of Object.entries(files)) write(root, p, c);
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    return { code: r.status, out: `${r.stdout}\n${r.stderr}` };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const forbidden = (label, files, rule) =>
  test(`forbidden: ${label}`, () => {
    const { code, out } = run(files);
    expect(code, `expected non-zero exit for ${label}\n${out}`).toBe(1);
    expect(out, `expected rule "${rule}" for ${label}\n${out}`).toMatch(new RegExp(rule));
  });

const allowed = (label, files) =>
  test(`allowed: ${label}`, () => {
    const { code, out } = run(files);
    expect(code, `expected clean exit for ${label}\n${out}`).toBe(0);
  });

// ---- Forbidden cases -----------------------------------------------------------------
forbidden('domain -> adapters', { 'packages/domain/src/f.ts': "import '@acbp/adapters';\nexport {};\n" }, 'domain-no-outward');
forbidden('domain -> npm/provider SDK', { 'packages/domain/src/f.ts': "import 'openai';\nexport {};\n" }, 'domain-no-npm');
forbidden('core -> provider SDK', { 'packages/core/src/f.ts': "import 'openai';\nexport {};\n" }, 'core-no-provider-sdk');
forbidden('web -> database', { 'apps/web/src/f.ts': "import '@acbp/database';\nexport {};\n" }, 'web-no-outward');
forbidden('worker -> adapters direct', { 'apps/worker/src/f.ts': "import '@acbp/adapters';\nexport {};\n" }, 'worker-no-outward');
forbidden('production package -> test-support', { 'packages/core/src/f.ts': "import '@acbp/test-support';\nexport {};\n" }, 'no-prod-to-test-support');
forbidden('package -> app entry point', { 'packages/contracts/src/f.ts': "import '../../../apps/web/src/index';\nexport {};\n" }, 'packages-no-import-apps');
forbidden('cross-package deep import', { 'apps/web/src/f.ts': "import '@acbp/core/src/tasks';\nexport {};\n" }, 'no-cross-package-deep-import');
forbidden('circular package dependency', {
  'packages/core/src/f.ts': "import '@acbp/database';\nexport {};\n",
  'packages/database/src/g.ts': "import '@acbp/core';\nexport {};\n",
}, 'no-circular');

// ---- Web-framework confinement (ADR-023 / ACBP-P1-001) -------------------------------
forbidden('adapters -> @clerk/nextjs', { 'packages/adapters/src/f.ts': "import '@clerk/nextjs/server';\nexport {};\n" }, 'web-framework-confined-to-web');
forbidden('core -> next runtime', { 'packages/core/src/f.ts': "import 'next/server';\nexport {};\n" }, 'web-framework-confined-to-web');
forbidden('config -> @clerk/nextjs', { 'packages/config/src/f.ts': "import '@clerk/nextjs';\nexport {};\n" }, 'web-framework-confined-to-web');
forbidden('worker -> next', { 'apps/worker/src/f.ts': "import 'next';\nexport {};\n" }, 'web-framework-confined-to-web');

// ---- Allowed cases -------------------------------------------------------------------
allowed('adapters -> @clerk/backend (framework-neutral SDK, not @clerk/nextjs)', { 'packages/adapters/src/f.ts': "import '@clerk/backend';\nexport {};\n" });
allowed('web -> next runtime', { 'apps/web/src/f.ts': "import 'next/server';\nexport {};\n" });
allowed('web -> @clerk/nextjs', { 'apps/web/src/f.ts': "import '@clerk/nextjs';\nexport {};\n" });
allowed('domain -> contracts', { 'packages/domain/src/f.ts': "import '@acbp/contracts';\nexport {};\n" });
allowed('core -> domain', { 'packages/core/src/f.ts': "import '@acbp/domain';\nexport {};\n" });
allowed('gateway -> adapters', { 'packages/gateway/src/f.ts': "import '@acbp/adapters';\nexport {};\n" });
allowed('web -> public core entry', { 'apps/web/src/f.ts': "import '@acbp/core';\nexport {};\n" });
allowed('test file -> test-support', { 'packages/core/src/f.test.ts': "import '@acbp/test-support';\nexport {};\n" });

// ---- Import-syntax coverage (all forms of a forbidden domain -> adapters import) ------
forbidden('syntax: static import', { 'packages/domain/src/f.ts': "import x from '@acbp/adapters';\nexport {};\n" }, 'domain-no-outward');
forbidden('syntax: import type', { 'packages/domain/src/f.ts': "import type { A } from '@acbp/adapters';\nexport {};\n" }, 'domain-no-outward');
forbidden('syntax: export { } from', { 'packages/domain/src/f.ts': "export { a } from '@acbp/adapters';\n" }, 'domain-no-outward');
forbidden('syntax: export * from', { 'packages/domain/src/f.ts': "export * from '@acbp/adapters';\n" }, 'domain-no-outward');
forbidden('syntax: dynamic import()', { 'packages/domain/src/f.ts': "export const p = import('@acbp/adapters');\n" }, 'domain-no-outward');
forbidden('syntax: require()', { 'packages/domain/src/f.ts': "const a = require('@acbp/adapters');\nexport {};\n" }, 'domain-no-outward');

// ---- Comment handling (commented-out forbidden imports must NOT be flagged) -----------
allowed('comments: line + block commented imports ignored', {
  'packages/domain/src/f.ts': "// import '@acbp/adapters';\n/* import '@acbp/adapters'; */\nexport {};\n",
});

// ---- Bypass coverage -----------------------------------------------------------------
forbidden('bypass: relative path', { 'packages/domain/src/f.ts': "import '../../adapters/src/index';\nexport {};\n" }, 'domain-no-outward');
forbidden('bypass: @acbp alias', { 'packages/domain/src/f.ts': "import '@acbp/adapters';\nexport {};\n" }, 'domain-no-outward');
forbidden('bypass: deep subpath', { 'packages/domain/src/f.ts': "import '@acbp/adapters/dist/secret';\nexport {};\n" }, 'no-cross-package-deep-import');
forbidden('bypass: filesystem traversal', { 'packages/domain/src/f.ts': "import '../../../packages/adapters/src/index';\nexport {};\n" }, 'domain-no-outward');
forbidden('bypass: deep relative into another package', { 'apps/web/src/f.ts': "import '../../../packages/core/src/tasks/index';\nexport {};\n" }, 'no-cross-package-deep-import');
