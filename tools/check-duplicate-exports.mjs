#!/usr/bin/env node
// ACBP static check — no exported class name is defined in more than one package (ACBP-P7-008; CDR-084 §4).
//
// WHY THIS EXISTS. Two classes named `FakeModelProvider` existed in this repository at once:
//
//   • `@acbp/adapters`     — injects five normalized failures, can `hang` to drive a real deadline, and takes a
//                            script consumed one-per-call. The fault-injection rig the test suites rely on.
//   • `@acbp/test-support` — always returns `finishStatus: 'completed'`. Cannot fail at all.
//
// Both were legitimate; they do different jobs. The problem was the NAME. An investigation looking for the
// fault-injection rig found the second one, concluded the rig did not exist, and that false finding was written
// into CDR-084 and its pull request before slice 1 read the imports and caught it. The cost was nearly a whole
// slice spent rebuilding something better than what would have been built.
//
// A name that means two different things depending on the import path is a trap, and the trap is invisible in
// review: both files look correct in isolation. It is only visible from above, which is what this check is.
//
// SCOPE, stated so a reader knows what a green line means: exported classes in `packages/*/src`, excluding test
// files. A class defined inside a `.test.ts` is local to that file and cannot be imported under the wrong name,
// so it is not this defect. Duplicates WITHIN one package are also allowed — the trap is two import paths, one
// name.
import { readdirSync, statSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const PACKAGES = join(ROOT, 'packages');
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.next', '.turbo', 'coverage']);
const IS_TEST = /\.(test|spec)\.(ts|mts|tsx)$/;
const IS_SOURCE = /\.(ts|mts)$/;

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) walk(p, out);
    else if (IS_SOURCE.test(name) && !IS_TEST.test(name)) out.push(p);
  }
  return out;
}

/** @returns {Map<string, {pkg: string, file: string}[]>} exported class name → where it is defined */
export function exportedClassesByName(packagesDir) {
  const byName = new Map();
  if (!existsSync(packagesDir)) return byName;
  for (const pkgName of readdirSync(packagesDir)) {
    if (SKIP_DIRS.has(pkgName)) continue;
    const srcDir = join(packagesDir, pkgName, 'src');
    try {
      if (!statSync(srcDir).isDirectory()) continue;
    } catch {
      continue; // no src/ — not a source package
    }
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, 'utf8');
      // `export class X`, `export abstract class X`. Deliberately NOT `export { X }` re-exports: a barrel
      // re-exporting one definition under two paths is not two definitions.
      const re = /^\s*export\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gm;
      for (let m = re.exec(src); m !== null; m = re.exec(src)) {
        const name = m[1];
        if (!byName.has(name)) byName.set(name, []);
        byName.get(name).push({ pkg: pkgName, file: file.replace(/\\/g, '/').replace(`${packagesDir.replace(/\\/g, '/')}/`, '') });
      }
    }
  }
  return byName;
}

/** @returns {{name: string, hits: {pkg: string, file: string}[]}[]} names defined in >1 package */
export function crossPackageDuplicates(byName) {
  const out = [];
  for (const [name, hits] of byName) {
    if (new Set(hits.map((h) => h.pkg)).size > 1) out.push({ name, hits });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();

function main() {
  const byName = exportedClassesByName(PACKAGES);

  // A check that cannot see its target must say so rather than pass — the house rule from check-approval-port.
  if (byName.size === 0) {
    console.error('✖ duplicate-export check CANNOT SEE ITS TARGET: no exported classes found under packages/*/src.');
    console.error('  Either the layout changed or the walk is broken. A clean result would be meaningless.');
    process.exit(2);
  }

  // ── NEGATIVE SELF-TEST ─────────────────────────────────────────────────────────────────────────────────────
  {
    const probe = new Map([
      ['Same', [{ pkg: 'a', file: 'a/x.ts' }, { pkg: 'b', file: 'b/y.ts' }]],
      ['SamePkgTwice', [{ pkg: 'a', file: 'a/x.ts' }, { pkg: 'a', file: 'a/z.ts' }]],
      ['Unique', [{ pkg: 'a', file: 'a/x.ts' }]],
    ]);
    const got = crossPackageDuplicates(probe).map((d) => d.name);
    if (got.length !== 1 || got[0] !== 'Same') {
      console.error('✖ duplicate-export check FAILED ITS OWN SELF-TEST — it no longer distinguishes a cross-package duplicate.');
      console.error(`  expected ['Same'], got ${JSON.stringify(got)}`);
      process.exit(2);
    }
  }

  const dupes = crossPackageDuplicates(byName);
  if (dupes.length > 0) {
    console.error('\n✖ duplicate-export check: the same exported class name is defined in more than one package.\n');
    for (const { name, hits } of dupes) {
      console.error(`  ${name}`);
      for (const h of hits) console.error(`    ${h.pkg.padEnd(16)} ${h.file}`);
      console.error(
        '    Two import paths, one name. Whoever reaches for it gets whichever their editor suggested, and the\n' +
          '    difference is invisible in review. Rename the one whose behaviour is narrower so the name says so.\n',
      );
    }
    console.error(`${dupes.length} duplicate name(s). See CDR-084 §4.\n`);
    process.exit(1);
  }

  console.log(
    `✔ duplicate-export check passed (${byName.size} exported class(es) across packages/*/src; no name defined in two packages). Self-test passed.`,
  );
}
