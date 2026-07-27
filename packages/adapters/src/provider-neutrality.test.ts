// ACBP-P0-019 — static provider-neutrality proofs for the adapter contracts.
// Complements the workspace dependency-boundary checker (tools/check-boundaries.mjs): this focuses on
// the contract source surface and the P0-005 storage blocker. No second global checker is introduced.
import { describe, test, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CONTRACTS_ADAPTERS = resolve(REPO, 'packages', 'contracts', 'src', 'adapters');

// Provider SDKs / HTTP clients / vendor names that must never appear in the neutral contract surface.
const FORBIDDEN_SPECIFIERS = [
  '@clerk', '@infisical', 'openai', '@anthropic-ai', '@aws-sdk', '@stripe', 'stripe', 'clerk', 'infisical',
  'render', 'cloudflare', 'axios', 'node-fetch', 'got', 'undici',
];
// Field/name shapes that would leak a raw provider response or credential through a contract.
const FORBIDDEN_LEAKS = ['rawResponse', 'sdkResponse', 'httpResponse', 'providerResponse', 'accessToken', 'apiKey'];

function contractFiles(): string[] {
  // Contract SOURCE files only — test files (which legitimately import vitest) are not the surface.
  return readdirSync(CONTRACTS_ADAPTERS).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && !f.endsWith('.type-test.ts'));
}

/** Strip block + line comments so prose (e.g. "anything") cannot trip substring/pattern checks. */
function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
}

/** Read a JSON file, tolerating a leading UTF-8 BOM. */
function readJson(path: string): { dependencies?: Record<string, string>; devDependencies?: Record<string, string> } {
  return JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
}

describe('provider-neutrality of adapter contracts', () => {
  test('no provider SDK / HTTP-client import appears in any contract file', () => {
    for (const file of contractFiles()) {
      const src = readFileSync(join(CONTRACTS_ADAPTERS, file), 'utf8');
      const importLines = src.split('\n').filter((l) => /^\s*(import|export)\b.*\bfrom\b/.test(l));
      for (const line of importLines) {
        for (const bad of FORBIDDEN_SPECIFIERS) {
          expect(line.includes(`'${bad}`)).toBe(false);
          expect(line.includes(`"${bad}`)).toBe(false);
        }
      }
    }
  });

  test('contract files import only within @acbp/contracts (leaf: relative imports only)', () => {
    for (const file of contractFiles()) {
      const src = stripComments(readFileSync(join(CONTRACTS_ADAPTERS, file), 'utf8'));
      const froms = [...src.matchAll(/\bfrom\s+['"]([^'"]+)['"]/g)].map((m) => m[1] ?? '');
      for (const spec of froms) {
        expect(spec.startsWith('.')).toBe(true); // no workspace/external imports from the leaf
      }
    }
  });

  test('no raw-provider-response or credential field leaks through contract declarations', () => {
    for (const file of contractFiles()) {
      const src = stripComments(readFileSync(join(CONTRACTS_ADAPTERS, file), 'utf8'));
      for (const leak of FORBIDDEN_LEAKS) {
        expect(src.includes(leak)).toBe(false);
      }
      expect(/:\s*any\b/.test(src)).toBe(false); // no `any`-typed contract fields
    }
  });

  test('the neutral @acbp/contracts leaf declares no provider SDK dependency', () => {
    // Only the contracts leaf must be provider-SDK-free. @acbp/adapters is the IMPLEMENTATION layer
    // and legitimately depends on provider SDKs (e.g., @clerk/backend for the ACBP-P1-001 identity
    // adapter); the boundary checker still forbids core/domain from importing any provider SDK.
    const manifest = readJson(resolve(REPO, 'packages', 'contracts', 'package.json'));
    const deps = Object.keys({ ...manifest.dependencies, ...manifest.devDependencies });
    for (const dep of deps) {
      for (const bad of FORBIDDEN_SPECIFIERS) {
        expect(dep.startsWith(bad)).toBe(false);
      }
    }
  });

  test('storage decision: ACBP-P0-005 is resolved, and the contract surface stays vendor-neutral', () => {
    // ACBP-P0-005 was Blocked until 2026-07-27, when the owner selected S3-compatible storage (CDR-048). This guard
    // originally asserted `Blocked` and FAILED the moment that status changed — which is precisely what it was for:
    // it forces whoever resolves the blocker to come here and state what replaced it, rather than letting the
    // status drift while a stale assertion keeps passing.
    //
    // What replaces it is the property that actually mattered all along. "Blocked" was only ever a proxy for
    // "no vendor has leaked into the neutral contract surface", and that must hold *more* strongly now a provider
    // class is chosen, not less — the temptation to reach for an SDK arrives exactly when the decision is made.
    // The FORBIDDEN_SPECIFIERS sweep above (which includes `@aws-sdk` and `cloudflare`) is that check, and it
    // covers the storage contract like every other.
    const csv = readFileSync(resolve(REPO, 'docs', 'implementation', 'BACKLOG.csv'), 'utf8');
    const row = csv.split('\n').find((l) => l.startsWith('ACBP-P0-005,'));
    expect(row).toBeDefined();
    expect(row?.trimEnd().endsWith(',Done')).toBe(true);
  });
});
