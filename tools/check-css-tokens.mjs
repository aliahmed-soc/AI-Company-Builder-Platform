#!/usr/bin/env node
// Every `var(--token)` in the app's stylesheets must resolve to something (ACBP-FE-008/009 review finding (b)).
//
// WHY THIS EXISTS. An adversarial review found four declarations in `console.css` referencing `var(--danger)` and
// `var(--primary)`. Those custom properties are defined NOWHERE — the real names are `--c-danger` and
// `--c-primary`, which every other rule in the file uses. CSS fails silently: an unresolvable `var()` makes the
// declaration invalid at computed-value time, so `border-left: 3px solid var(--danger)` does not merely lose its
// colour, it loses the BORDER — `border-left-style` unsets to `none`, because it is a shorthand. A confidence bar
// rendered nothing and two `data-kind` tints collapsed to the same near-white, while the comments directly above
// them asserted the opposite.
//
// It shipped because nothing in this repository looks at CSS. Typecheck, lint, the secret scan and 4,930 tests all
// pass over a stylesheet whose colours do not exist; jsdom applies no stylesheet at all, so the rendered tests
// could not have caught it either. A one-character typo in a token name is invisible to every other gate.
//
// ⚠️ WHAT THIS CHECK IS NOT. It does not validate CSS, check contrast, or know what a token SHOULD be. It answers
// exactly one question: is every token that is used also defined somewhere the browser will see. A reference that
// resolves to the wrong-but-defined token is not something this can catch.
//
// EXIT CODES: 0 pass · 1 a real failure · 2 the check could not see what it is meant to check (a vanished
// directory is NOT agreement — the same rule as `check-generate-route-coverage.mjs`).
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

/** The floor. A walk that finds no stylesheets and reports success is the artefact the standing rule forbids. */
const EXPECTED_MINIMUM_FILES = 1;

/**
 * Tokens a browser or framework supplies that no file in this repository defines.
 *
 * Kept deliberately tiny and explicit. An allowlist is the escape hatch that turns a checker into decoration, so
 * every entry must be a token something OUTSIDE this repository sets.
 */
const EXTERNALLY_DEFINED = new Set([]);

export function listFiles(dir, extensions, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) listFiles(full, extensions, out);
    else if (extensions.some((e) => entry.endsWith(e))) out.push(full);
  }
  return out;
}

/**
 * Custom properties DEFINED in a stylesheet: `--name:` in a declaration position.
 *
 * The negative lookbehind is the whole correctness of this function. Matching `--danger\s*:` as a plain substring
 * ALSO matches `--c-danger:`, because the first is a suffix of the second — which is precisely the false positive
 * that let the original bug through a manual check. Definitions must not be preceded by a name character.
 */
export function definitionsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/(?<![-\w])(--[a-zA-Z][\w-]*)\s*:/g)) out.add(m[1]);
  return out;
}

/**
 * Custom properties SET FROM TSX, as inline style objects: `'--i': 1` or `"--ico-bg": x`.
 *
 * These are real definitions the browser sees, and a checker that ignored them would report every
 * component-supplied token as missing — noise that gets a checker switched off.
 */
export function tsxDefinitionsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/['"](--[a-zA-Z][\w-]*)['"]\s*:/g)) out.add(m[1]);
  return out;
}

/**
 * References: `var(--name)` and `var(--name, fallback)`.
 *
 * A reference WITH a fallback is reported separately and never fails. `var(--ico-bg, var(--c-primary-soft))` is a
 * deliberate optional token — the fallback is the author saying "this may be unset". Failing those would punish
 * the one pattern that is already safe.
 */
export function referencesIn(source) {
  const required = new Set();
  const optional = new Set();
  for (const m of source.matchAll(/var\(\s*(--[a-zA-Z][\w-]*)\s*(,)?/g)) {
    (m[2] === undefined ? required : optional).add(m[1]);
  }
  return { required, optional };
}

/** Self-test: the extractors must actually extract, or every verdict below is vacuous. */
function selfTest() {
  const problems = [];

  const defs = definitionsIn(':root { --c-danger: red; --c-primary: blue; }');
  if (!defs.has('--c-danger') || !defs.has('--c-primary')) problems.push('definitionsIn missed a plain definition');

  // THE REGRESSION THIS CHECK WAS BORN FROM. `--danger` must NOT be considered defined by `--c-danger:`.
  const suffix = definitionsIn(':root { --c-danger: red; }');
  if (suffix.has('--danger')) problems.push('definitionsIn treated --c-danger as defining --danger (the substring bug this check exists for)');

  const refs = referencesIn('a { color: var(--c-danger); background: var(--ico-bg, var(--c-primary-soft)); }');
  if (!refs.required.has('--c-danger')) problems.push('referencesIn missed a required reference');
  if (!refs.optional.has('--ico-bg')) problems.push('referencesIn did not treat a fallback reference as optional');
  if (refs.required.has('--ico-bg')) problems.push('referencesIn reported a fallback reference as required');
  if (!refs.required.has('--c-primary-soft')) problems.push('referencesIn missed a var() nested inside a fallback');

  const tsx = tsxDefinitionsIn("style={{ '--i': 1 } as React.CSSProperties}");
  if (!tsx.has('--i')) problems.push('tsxDefinitionsIn missed an inline style definition');

  return problems;
}

export function check(root = ROOT) {
  const appDir = join(root, 'apps', 'web', 'src');
  const rel = (f) => relative(root, f).split('\\').join('/');
  if (!existsSync(appDir)) return { code: 2, blind: [`the app source directory is not there: ${rel(appDir)}`], failures: [], checked: 0 };

  const cssFiles = listFiles(appDir, ['.css']);
  if (cssFiles.length < EXPECTED_MINIMUM_FILES) {
    // A vanished stylesheet is not agreement.
    return { code: 1, blind: [], failures: [`found ${String(cssFiles.length)} stylesheet(s), expected at least ${String(EXPECTED_MINIMUM_FILES)} — the walk found nothing to check.`], checked: 0 };
  }

  const defined = new Set(EXTERNALLY_DEFINED);
  for (const f of cssFiles) for (const d of definitionsIn(readFileSync(f, 'utf8'))) defined.add(d);
  // Components set custom properties inline; those are definitions too.
  for (const f of listFiles(appDir, ['.tsx'])) for (const d of tsxDefinitionsIn(readFileSync(f, 'utf8'))) defined.add(d);

  const failures = [];
  let referenceCount = 0;
  for (const f of cssFiles) {
    const source = readFileSync(f, 'utf8');
    const lines = source.split('\n');
    const { required } = referencesIn(source);
    referenceCount += required.size;
    for (const token of required) {
      if (defined.has(token)) continue;
      // Name the LINE, because a token used in ten places is one typo, not ten.
      const at = lines.findIndex((l) => new RegExp(`var\\(\\s*${token.replace(/[-]/g, '\\-')}\\s*\\)`).test(l));
      const near = [...defined].filter((d) => d.endsWith(token.slice(2)) || token.endsWith(d.slice(2)));
      failures.push(
        `${rel(f)}${at === -1 ? '' : `:${String(at + 1)}`}\n    var(${token}) resolves to nothing, so the whole declaration is invalid at computed-value time.\n` +
          `    A shorthand (border, background) loses more than its colour — it unsets the property.` +
          (near.length > 0 ? `\n    Did you mean: ${near.join(', ')}?` : ''),
      );
    }
  }

  return { code: failures.length > 0 ? 1 : 0, blind: [], failures, checked: referenceCount, files: cssFiles.length };
}

if (import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('\\').join('/').split('/').pop())) {
  const selfProblems = selfTest();
  if (selfProblems.length > 0) {
    console.error('\u2716 css-token check CANNOT BE TRUSTED: its own self-test failed.');
    for (const p of selfProblems) console.error(`  - ${p}`);
    process.exit(2);
  }
  const r = check();
  if (r.code === 2) {
    console.error('\u2716 css-token check COULD NOT RUN:');
    for (const b of r.blind) console.error(`  - ${b}`);
    process.exit(2);
  }
  if (r.code === 1) {
    console.error(`\u2716 css-token check FAILED \u2014 ${String(r.failures.length)} unresolvable custom propert(ies):\n`);
    for (const f of r.failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(`\u2714 css-token check passed (${String(r.checked)} required var() reference(s) across ${String(r.files)} stylesheet(s) all resolve). Self-test passed.`);
}
