// Regression suite for `tools/check-css-tokens.mjs`.
//
// A guard that has never been watched to fail is not a guard. The case this checker was born from is pinned first:
// `var(--danger)` where the defined token is `--c-danger`. That shipped through typecheck, lint, a secret scan and
// 4,930 passing tests, because nothing in this repository reads CSS and jsdom applies no stylesheet.
//
// `check()` takes a root, so every case builds a throwaway tree rather than mutating the repository.
import { describe, test, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { check, definitionsIn, tsxDefinitionsIn, referencesIn } from '../check-css-tokens.mjs';

const SCRIPT = join(process.cwd(), 'tools', 'check-css-tokens.mjs');

let root;

function build({ css = {}, tsx = {} } = {}) {
  const dir = join(root, 'apps', 'web', 'src', 'app');
  mkdirSync(dir, { recursive: true });
  const files = Object.keys(css).length > 0 ? css : { 'app.css': ':root { --c-primary: blue; }\n.a { color: var(--c-primary); }\n' };
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body, 'utf8');
  for (const [name, body] of Object.entries(tsx)) writeFileSync(join(dir, name), body, 'utf8');
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'acbp-csstok-'));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('the extractors themselves', () => {
  test('THE SUBSTRING BUG: --c-danger does NOT define --danger', () => {
    // This is the exact false positive that let the original defect past a manual check — a grep for `--danger:`
    // matches `--c-danger:`, because the first name is a suffix of the second.
    const defs = definitionsIn(':root { --c-danger: red; }');
    expect(defs.has('--c-danger')).toBe(true);
    expect(defs.has('--danger')).toBe(false);
  });

  test('a reference WITH a fallback is optional; one without is required', () => {
    const r = referencesIn('a { background: var(--ico-bg, var(--c-primary-soft)); color: var(--c-danger); }');
    expect(r.optional.has('--ico-bg')).toBe(true);
    expect(r.required.has('--ico-bg')).toBe(false);
    // A var() nested INSIDE a fallback is itself required — it has no fallback of its own.
    expect(r.required.has('--c-primary-soft')).toBe(true);
    expect(r.required.has('--c-danger')).toBe(true);
  });

  test('inline style objects in TSX count as definitions', () => {
    expect(tsxDefinitionsIn("style={{ '--i': 2 } as React.CSSProperties}").has('--i')).toBe(true);
    expect(tsxDefinitionsIn('style={{ "--ico-bg": tone }}').has('--ico-bg')).toBe(true);
  });
});

describe('the defect this checker was born from', () => {
  test('var(--danger) where the token is --c-danger FAILS, and says which line', () => {
    build({ css: { 'console.css': ':root { --c-danger: red; }\n.cs-warning { border-left: 3px solid var(--danger); }\n' } });
    const r = check(root);
    expect(r.code).toBe(1);
    const text = r.failures.join('\n');
    expect(text).toContain('var(--danger) resolves to nothing');
    expect(text).toContain('console.css:2');
  });

  test('and it suggests the token that was probably meant', () => {
    build({ css: { 'console.css': ':root { --c-primary: blue; }\n.b { background: var(--primary); }\n' } });
    expect(check(root).failures.join('\n')).toContain('Did you mean: --c-primary?');
  });

  test('the correctly-named reference passes', () => {
    build({ css: { 'console.css': ':root { --c-danger: red; }\n.cs-warning { border-left: 3px solid var(--c-danger); }\n' } });
    expect(check(root).code).toBe(0);
  });
});

describe('what must NOT be reported, or the checker gets switched off', () => {
  test('a token defined in ANOTHER stylesheet resolves', () => {
    // The real repository defines its palette in globals.css and consumes it in console.css.
    build({ css: { 'globals.css': ':root { --c-primary: blue; }\n', 'console.css': '.a { color: var(--c-primary); }\n' } });
    expect(check(root).code).toBe(0);
  });

  test('a token supplied inline by a COMPONENT resolves', () => {
    build({ css: { 'console.css': '.cs-rise { animation-delay: calc(var(--i) * 60ms); }\n' }, tsx: { 'screen.tsx': "<div style={{ '--i': 2 } as React.CSSProperties} />" } });
    expect(check(root).code).toBe(0);
  });

  test('an undefined token WITH a fallback is deliberate and does not fail', () => {
    build({ css: { 'console.css': ':root { --c-primary-soft: #123; }\n.cs-ico { background: var(--ico-bg, var(--c-primary-soft)); }\n' } });
    expect(check(root).code).toBe(0);
  });
});

describe('the ways this check could quietly stop checking', () => {
  test('a missing app directory exits 2, NOT 0 — a vanished target is not agreement', () => {
    const r = check(join(root, 'nope'));
    expect(r.code).toBe(2);
    expect(r.blind.join('\n')).toContain('app source directory');
  });

  test('finding ZERO stylesheets FAILS rather than passing on an empty walk', () => {
    // The precise artefact the standing rule forbids: a checker that inspects nothing and reports success.
    mkdirSync(join(root, 'apps', 'web', 'src'), { recursive: true });
    const r = check(root);
    expect(r.code).toBe(1);
    expect(r.failures.join('\n')).toContain('found 0 stylesheet(s)');
  });

  test('the exit-code contract is asserted by RUNNING the script, not by reading check()', () => {
    // Every other case here imports check() and inspects r.code. Nothing would notice process.exit(1) becoming
    // process.exit(0).
    build({ css: { 'console.css': ':root { --c-danger: red; }\n.a { color: var(--danger); }\n' } });
    expect(spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' }).status).toBe(1);
    build({ css: { 'console.css': ':root { --c-danger: red; }\n.a { color: var(--c-danger); }\n' } });
    expect(spawnSync(process.execPath, [SCRIPT, root], { encoding: 'utf8' }).status).toBe(0);
  });
});

describe('the repository itself', () => {
  test('passes its own check', () => {
    const r = check(process.cwd());
    expect(r.failures).toEqual([]);
    expect(r.code).toBe(0);
    // The floor: if this ever reads zero references the check has stopped checking.
    expect(r.checked).toBeGreaterThan(10);
  });
});
