// ACBP-P0-021 — local-development shared helpers (pure, testable, no dependencies).
//
// Used by the local scripts (doctor / db provisioning). Every function is side-effect-free and
// NEVER prints or returns credentials. Database URLs are validated and classified without exposing
// their values; only a redacted form (no user/password/host) is ever produced for diagnostics.
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const REPO_NAME = 'ai-company-builder-platform';

/** True if `dir` is the ACBP repository root (package.json name matches + workspace file present). */
export function isRepoRoot(dir) {
  const pkgPath = join(dir, 'package.json');
  const wsPath = join(dir, 'pnpm-workspace.yaml');
  if (!existsSync(pkgPath) || !existsSync(wsPath)) return false;
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8').replace(/^\uFEFF/, ''));
    return pkg?.name === REPO_NAME;
  } catch {
    return false;
  }
}

/** Throw a clear error unless `dir` is the ACBP repo root and is not a Halo path. */
export function assertRepoRoot(dir) {
  if (/halo-suite/i.test(dir)) {
    throw new Error(`Refusing to operate inside a Halo path: ${dir}`);
  }
  if (!isRepoRoot(dir)) {
    throw new Error(`Not the ${REPO_NAME} repository root: ${dir}`);
  }
  return dir;
}

/**
 * Validate a PostgreSQL connection URL WITHOUT revealing it. Returns structural facts only.
 * Robust to passwords containing special characters (no URL parser that chokes on them).
 * @returns {{ ok: boolean, reason?: string, scheme?: string, host?: string, database?: string }}
 */
export function validateDbUrl(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, reason: 'empty' };
  }
  const schemeMatch = /^(postgres(?:ql)?):\/\//i.exec(url);
  if (!schemeMatch) {
    return { ok: false, reason: 'not a postgres:// URL' };
  }
  const rest = url.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, '');
  const afterAt = rest.includes('@') ? rest.slice(rest.lastIndexOf('@') + 1) : rest;
  const host = (afterAt.split(/[/?:]/)[0] ?? '').toLowerCase();
  const pathPart = afterAt.includes('/') ? afterAt.slice(afterAt.indexOf('/') + 1) : '';
  const database = (pathPart.split('?')[0] ?? '').toLowerCase();
  if (host === '') return { ok: false, reason: 'missing host' };
  if (database === '') return { ok: false, reason: 'missing database name' };
  return { ok: true, scheme: (schemeMatch[1] ?? '').toLowerCase(), host, database };
}

/** Classify a DB target from structural facts (no values exposed). */
export function classifyDbTarget(url) {
  const v = validateDbUrl(url);
  if (!v.ok) return { valid: false, isLocal: false, looksProdOrStaging: false, looksHalo: false, looksTest: false };
  const host = v.host ?? '';
  const database = v.database ?? '';
  return {
    valid: true,
    isLocal: host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '',
    looksProdOrStaging: /prod|production|stag|staging/.test(host) || /prod|production|stag|staging/.test(database),
    looksHalo: /halo/.test(host) || /halo/.test(database),
    looksTest: /test|tmp|temp|ci|disposable|scratch/.test(database),
  };
}

/**
 * Assert a target is safe for DESTRUCTIVE local dev/test operations (create/drop/reset).
 * Rejects: invalid URLs, non-local hosts, prod/staging-looking targets, and any Halo target.
 * @returns the classification on success; throws Error on rejection.
 */
export function assertDisposableTarget(url) {
  const c = classifyDbTarget(url);
  if (!c.valid) throw new Error('invalid database URL (not a postgres:// URL with host and database)');
  if (c.looksHalo) throw new Error('refusing to target a Halo database');
  if (c.looksProdOrStaging) throw new Error('refusing destructive operation on a production/staging-looking database');
  if (!c.isLocal) throw new Error('refusing destructive operation on a non-local database host');
  return c;
}

/** Redacted, diagnostics-safe rendering of a DB URL — never includes user, password, host, or port. */
export function redactDbUrl(url) {
  const v = validateDbUrl(url);
  if (!v.ok) return '[invalid-or-absent]';
  return `${v.scheme}://<redacted>@<redacted>/${v.database}`;
}
