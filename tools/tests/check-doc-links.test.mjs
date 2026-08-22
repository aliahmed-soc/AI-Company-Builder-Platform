// Regression suite for `tools/check-doc-links.mjs`.
//
// The case this checker was born from is pinned first: `CDR-090` existed only on the unmerged branch
// `p8-api-006-cdr` while TEN files on `main` cited it — including five production sources that lean on
// `CDR-090 §1-G3` for startup-visible gateway failure. It survived typecheck, lint, twenty-one static checks and
// 5,015 tests for eight days, because no gate in this repository had ever read a citation.
//
// `check()` takes a root, so every case builds a throwaway tree rather than mutating the repository. The trees are
// not git repositories, which also exercises the non-git walk fallback.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, citationsIn, definedCdrNumbers, relativeLinksIn, withoutCode } from '../check-doc-links.mjs';

let root;

const CDR_DIR = join('docs', 'implementation', 'config-decisions');

/**
 * Build a tree that clears both floors: 50+ CDR files and 100+ scanned files.
 *
 * The floors exist so a walk that finds nothing cannot report success, which means every fixture has to clear them
 * or it would fail for the wrong reason — and a test that passes for the wrong reason proves nothing.
 */
function build({ cdrNumbers = null, files = {} } = {}) {
  const cdrDir = join(root, CDR_DIR);
  mkdirSync(cdrDir, { recursive: true });
  const numbers = cdrNumbers ?? Array.from({ length: 60 }, (_, i) => String(i + 1).padStart(3, '0'));
  for (const n of numbers) writeFileSync(join(cdrDir, `CDR-${n}-something.md`), `# CDR-${n}\n`, 'utf8');

  const filler = join(root, 'packages', 'filler');
  mkdirSync(filler, { recursive: true });
  for (let i = 0; i < 120; i++) writeFileSync(join(filler, `f${String(i)}.ts`), '// governed by CDR-001\n', 'utf8');

  for (const [name, body] of Object.entries(files)) {
    const full = join(root, name);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, body, 'utf8');
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acbp-doclinks-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the extractors themselves', () => {
  test('citationsIn finds citations, de-duplicates, and ignores glued tokens', () => {
    const c = citationsIn('governed by CDR-087 §5.0 and CDR-090; see CDR-087 again');
    expect([...c].sort()).toEqual(['087', '090']);
    // A longer token that merely contains the shape is not a citation. Without the word boundaries this would
    // report `087`, which is the substring-match failure this repository keeps rediscovering.
    expect(citationsIn('ACDR-0871 and XCDR-0904').size).toBe(0);
  });

  test('definedCdrNumbers is anchored, so a longer number cannot define a shorter one', () => {
    const dir = join(root, CDR_DIR);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'CDR-0901-unrelated.md'), 'x', 'utf8');
    const defined = definedCdrNumbers(dir);
    // `CDR-0901-…` must NOT register as defining CDR-090. `\b` after three digits is what stops it.
    expect(defined.has('090')).toBe(false);
  });

  test('relativeLinksIn strips fragments and ignores external schemes', () => {
    const links = relativeLinksIn('[a](./x.md) [b](../y.md#frag) [c](https://e.com) [d](#top) [e](mailto:a@b.c)');
    expect([...links].sort()).toEqual(['../y.md', './x.md']);
  });

  test('relativeLinksIn handles a link carrying a title attribute', () => {
    expect([...relativeLinksIn('[a](./x.md "the title")')]).toEqual(['./x.md']);
  });

  test('A LINK INSIDE CODE IS NOT A LINK — the check must not forbid documenting a broken one', () => {
    // Found by the check failing on this repository's own run-log entry about CDR-090, which quotes the broken
    // link as inline code. No renderer linkifies a code span, so its target is not required to exist. A checker
    // that forbade writing this down would make the defect it exists to catch undocumentable.
    expect(relativeLinksIn('the broken link was `[CDR-090](CDR-090-gone.md)`').size).toBe(0);
    expect(relativeLinksIn('```md\n[a](./nope.md)\n```\n').size).toBe(0);
    expect(relativeLinksIn('~~~\n[a](./nope.md)\n~~~\n').size).toBe(0);
  });

  test('stripping code does not swallow the real links around it', () => {
    // The other half. A stripper that blanked too much would satisfy the test above while disabling the check.
    const links = relativeLinksIn('`x` [a](./a.md) `y` [b](./b.md)\n```\n[c](./c.md)\n```\n[d](./d.md)');
    expect([...links].sort()).toEqual(['./a.md', './b.md', './d.md']);
  });

  test('withoutCode preserves line count, so offsets stay meaningful', () => {
    expect(withoutCode('a\n```\nx\ny\n```\nb').split('\n').length).toBe(6);
  });
});

describe('THE CASE THIS EXISTS FOR — a cited CDR with no file', () => {
  test('fails, and names every citing file', () => {
    build({
      // 090 deliberately absent — exactly `main` between 2026-08-14 and 2026-08-22.
      cdrNumbers: Array.from({ length: 60 }, (_, i) => String(i + 1).padStart(3, '0')).filter((n) => n !== '090'),
      files: {
        'docs/implementation/API-BACKLOG.csv': 'id,notes\nACBP-API-012,"CDR-090 §1-G3"\n',
        'packages/config/src/index.ts': '// startup-visible per CDR-090 §1-G3\n',
      },
    });

    const r = check(root);

    expect(r.code).toBe(1);
    const text = r.failures.join('\n');
    expect(text).toContain('CDR-090 is cited but has NO file');
    // Both citing files must be named. A failure that says "somewhere" cannot be acted on.
    expect(text).toContain('docs/implementation/API-BACKLOG.csv');
    expect(text).toContain('packages/config/src/index.ts');
  });

  test('reports one failure per missing DOCUMENT, not one per citation', () => {
    build({
      cdrNumbers: Array.from({ length: 60 }, (_, i) => String(i + 1).padStart(3, '0')).filter((n) => n !== '090'),
      files: {
        'docs/a.md': 'CDR-090\n',
        'docs/b.md': 'CDR-090\n',
        'docs/c.md': 'CDR-090\n',
        'packages/d.ts': '// CDR-090\n',
      },
    });

    const r = check(root);

    // Four citing files, one missing document => one failure. Forty failures for one absent file is noise that
    // gets a checker switched off.
    expect(r.code).toBe(1);
    expect(r.failures.length).toBe(1);
  });

  test('a citation in PRODUCTION SOURCE counts — scanning only docs/ would have missed five files', () => {
    build({
      cdrNumbers: Array.from({ length: 60 }, (_, i) => String(i + 1).padStart(3, '0')).filter((n) => n !== '090'),
      files: { 'packages/core/src/composition/anthropic-gateway.ts': '// This is the file CDR-090 §1 found missing\n' },
    });

    const r = check(root);

    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('anthropic-gateway.ts');
  });
});

describe('the relative-link half', () => {
  test('fails on a Markdown link whose target does not exist', () => {
    build({ files: { 'docs/x.md': 'see [the ruling](./CDR-090-metered-generation-routes.md)\n' } });

    const r = check(root);

    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('the link target does not exist: ./CDR-090-metered-generation-routes.md');
  });

  test('accepts a link that resolves, including one reaching across packages', () => {
    build({
      files: {
        'packages/core/src/tenancy/adversarial/README.md': '[h](../../../../test-support/src/tenancy/two-tenant-harness.ts)\n',
        'packages/test-support/src/tenancy/two-tenant-harness.ts': 'export const x = 1;\n',
      },
    });

    expect(check(root).code).toBe(0);
  });

  test('does not read links inside NON-Markdown files', () => {
    // A TypeScript file containing `[x](./nope.md)` in a comment is not a broken document link, and failing it
    // would punish ordinary prose in code.
    build({ files: { 'packages/a.ts': '// see [x](./nope.md)\n' } });

    expect(check(root).code).toBe(0);
  });
});

describe('it refuses to pass vacuously', () => {
  test('a missing config-decisions directory is code 2, not agreement', () => {
    mkdirSync(join(root, 'docs'), { recursive: true });

    const r = check(root);

    expect(r.code).toBe(2);
    expect(r.blind.join('')).toContain('config-decisions');
  });

  test('a config-decisions directory with almost no CDRs FAILS rather than passing every citation', () => {
    // Without the floor, a tree where the documents vanished would report "all citations resolve" — over nothing.
    build({ cdrNumbers: ['001', '002'] });

    const r = check(root);

    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toMatch(/expected at least/);
  });

  test('the happy path really does scan a substantial number of files', () => {
    build({});

    const r = check(root);

    expect(r.code).toBe(0);
    // Pins that the pass above is not over an empty walk.
    expect(r.scanned).toBeGreaterThan(100);
    expect(r.citations).toBeGreaterThan(100);
  });
});
