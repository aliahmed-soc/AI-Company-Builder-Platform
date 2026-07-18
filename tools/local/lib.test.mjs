// ACBP-P0-021 — local-development helper tests. Fake local values only (never real secrets).
import { describe, test, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { assertDisposableTarget, assertRepoRoot, classifyDbTarget, isRepoRoot, redactDbUrl, validateDbUrl } from './lib.mjs';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PW = 'pw-zz09'; // short fake password sentinel
const localUrl = (db = 'acbp_dev') => `postgresql://acbp:${PW}@127.0.0.1:5432/${db}`;

describe('repository-root guard', () => {
  test('recognizes the real repo root and rejects a wrong directory', () => {
    expect(isRepoRoot(REPO)).toBe(true);
    expect(isRepoRoot(resolve(REPO, 'packages'))).toBe(false);
    expect(() => assertRepoRoot(resolve(REPO, 'packages'))).toThrow();
    expect(assertRepoRoot(REPO)).toBe(REPO);
  });

  test('rejects any Halo path outright', () => {
    expect(() => assertRepoRoot('E:\\Halo-Suite\\halo-suite')).toThrow(/Halo/i);
  });
});

describe('database URL validation (never reveals the value)', () => {
  test('accepts a valid postgres URL and returns only structural facts', () => {
    const v = validateDbUrl(localUrl());
    expect(v.ok).toBe(true);
    expect(v.host).toBe('127.0.0.1');
    expect(v.database).toBe('acbp_dev');
    expect(JSON.stringify(v)).not.toContain(PW); // the password is never in the result
  });

  test('rejects malformed / non-postgres / empty URLs safely', () => {
    expect(validateDbUrl('not-a-url').ok).toBe(false);
    expect(validateDbUrl('mysql://h/db').ok).toBe(false);
    expect(validateDbUrl('').ok).toBe(false);
    expect(validateDbUrl('postgresql://host-only').ok).toBe(false); // no database
    expect(validateDbUrl(undefined).ok).toBe(false);
  });

  test('validation is deterministic (idempotent)', () => {
    expect(validateDbUrl(localUrl())).toEqual(validateDbUrl(localUrl()));
  });
});

describe('destructive-target safety', () => {
  test('accepts a local test/dev target', () => {
    expect(() => assertDisposableTarget(localUrl('acbp_test'))).not.toThrow();
    expect(classifyDbTarget(localUrl('acbp_test')).isLocal).toBe(true);
  });

  test('rejects production / staging targets', () => {
    expect(() => assertDisposableTarget(`postgresql://u:${PW}@127.0.0.1:5432/acbp_production`)).toThrow(/production|staging/i);
    expect(() => assertDisposableTarget(`postgresql://u:${PW}@db.prod.example.com:5432/app`)).toThrow();
  });

  test('rejects Halo targets', () => {
    expect(() => assertDisposableTarget(`postgresql://u:${PW}@127.0.0.1:5432/halo_suite`)).toThrow(/Halo/i);
  });

  test('rejects non-local hosts', () => {
    expect(() => assertDisposableTarget(`postgresql://u:${PW}@10.0.0.5:5432/acbp_test`)).toThrow(/non-local/i);
  });
});

describe('redaction', () => {
  test('redactDbUrl never exposes credentials or host but keeps the db name', () => {
    const red = redactDbUrl(localUrl('acbp_dev'));
    expect(red).not.toContain(PW);
    expect(red).not.toContain('127.0.0.1');
    expect(red).not.toContain('acbp:');
    expect(red).toContain('acbp_dev');
  });

  test('redactDbUrl on an invalid URL returns a safe placeholder', () => {
    expect(redactDbUrl('garbage')).toBe('[invalid-or-absent]');
  });
});
