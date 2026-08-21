#!/usr/bin/env node
// Every CDR cited anywhere in this repository must have a file, and every relative link in a Markdown file must
// resolve to something that exists.
//
// WHY THIS EXISTS. `CDR-090` was written on 2026-08-14 on the branch `p8-api-006-cdr` and NO pull request ever
// tracked it. Meanwhile four documents that DID merge cited it as governing:
//
//   docs/implementation/API-BACKLOG.csv                    row ACBP-API-012, "CDR-090 1-G3"
//   docs/implementation/config-decisions/CDR-091-*.md      "Supersedes: the BLOCKED 3.1-3.5 of [CDR-090](...)"
//   docs/implementation/config-decisions/CDR-092-*.md
//   docs/implementation/config-decisions/CDR-094-*.md
//
// So for eight days `main` carried a governing ruling with no text, a backlog row pointing at it, and a relative
// Markdown link that resolved to nothing. The ruling survived only because one unmerged branch happened not to be
// deleted. A `git branch -D` would have destroyed a decision three merged documents depend on.
//
// Nothing caught it. Typecheck, lint, the secret scan, twenty-one static checks and 5,015 tests all pass over a
// document citing a document that does not exist, because no gate in this repository has ever read a citation.
//
// WHY IT SCANS SOURCE TOO, NOT JUST docs/. CDR numbers are cited from 88 distinct places in TypeScript, 27 in
// tooling scripts and 8 in TSX -- comments of the form "governed by CDR-087 5.0" are how the rules reach the code
// they govern. A comment citing a CDR that does not exist is the same defect wearing a different extension, and
// the more dangerous one, because a reader trusts it and cannot follow it.
//
// WHAT THIS CHECK IS NOT. It does not read a CDR, know whether a citation is APT, or verify that a cited section
// number exists inside the file. It answers exactly two questions: does the cited CDR have a file, and does the
// relative link point at something real. A citation that names the WRONG but existing CDR is not something this
// can catch.
//
// EXIT CODES: 0 pass - 1 a real failure - 2 the check could not see what it is meant to check (a vanished
// directory is NOT agreement -- the same rule as `check-generate-route-coverage.mjs`).
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve, relative, extname } from 'node:path';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();

const CDR_DIR = join('docs', 'implementation', 'config-decisions');

/** Extensions worth scanning for citations. A binary or lockfile mentioning `CDR-` is noise, not a citation. */
const CITATION_EXTENSIONS = new Set(['.ts', '.tsx', '.mts', '.mjs', '.js', '.md', '.csv', '.sql', '.yml', '.yaml']);

/** Floors. A walk that finds nothing and reports success is the artefact the standing rule forbids. */
const EXPECTED_MINIMUM_CDR_FILES = 50;
const EXPECTED_MINIMUM_SCANNED = 100;

/**
 * CDR numbers deliberately cited without a file.
 *
 * Kept empty on purpose. An allowlist is the escape hatch that turns a checker into decoration; a number belongs
 * here only if the citation is genuinely about a number rather than a document (for example prose reserving the
 * next id). Prefer rewording the prose so it does not look like a citation.
 */
const CITED_WITHOUT_FILE = new Set([]);

/** Link targets that are not repository paths. */
const EXTERNAL_LINK = /^(https?:|mailto:|tel:|data:|#|<)/;

/** CDR numbers cited in a source text. Three digits, not glued to a longer token. */
export function citationsIn(source) {
  const out = new Set();
  for (const m of source.matchAll(/\bCDR-(\d{3})\b/g)) out.add(m[1]);
  return out;
}

/**
 * CDR numbers that HAVE a file, read from the directory listing.
 *
 * Anchored with `^CDR-(\d{3})` so a file merely mentioning a CDR in its name cannot register as defining one, and
 * so `CDR-0901-something.md` cannot be read as defining 090.
 */
export function definedCdrNumbers(dir) {
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const m = /^CDR-(\d{3})\b/.exec(name);
    if (m) out.add(m[1]);
  }
  return out;
}

/**
 * Blank out fenced code blocks and inline code spans, preserving length and newlines.
 *
 * WHY THIS IS NOT OPTIONAL. A Markdown link inside backticks is NOT a link -- no renderer linkifies it, so its
 * target is not required to exist. Documentation that DESCRIBES a broken link (`[CDR-090](CDR-090-...md)` was
 * broken for eight days) is the obvious case, and it is exactly the case this repository needed to write down.
 * Without this, the check would forbid documenting the very defect it exists to catch.
 *
 * Replacement is space-for-character rather than deletion so offsets and line numbers stay meaningful, and so two
 * fragments either side of a code span cannot be glued into a match that was never in the source.
 */
export function withoutCode(source) {
  const blank = (m) => m.replace(/[^\n]/g, ' ');
  return source
    .replace(/```[\s\S]*?```/g, blank) // fenced
    .replace(/~~~[\s\S]*?~~~/g, blank) // fenced, alternate marker
    .replace(/`[^`\n]*`/g, blank); // inline
}

/**
 * Relative link targets in a Markdown source, as `[text](target)` and `[text](target "title")`.
 *
 * Anchors and external schemes are dropped here rather than at the call site, so a caller cannot forget. A target
 * carrying a `#fragment` keeps only the path -- this check does not resolve heading anchors. Code is stripped
 * first; see `withoutCode`.
 */
export function relativeLinksIn(source) {
  const out = new Set();
  for (const m of withoutCode(source).matchAll(/\[[^\]\n]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
    const target = m[1];
    if (EXTERNAL_LINK.test(target)) continue;
    const path = target.split('#')[0];
    if (path) out.add(path);
  }
  return out;
}

/**
 * Tracked files, via git, so ignored and generated trees are never walked.
 *
 * git's own stderr is discarded: outside a repository it prints `fatal: not a git repository`, and the caller
 * already handles that by falling back to a plain walk. Letting it through would put a red `fatal:` in the output
 * of a passing run, which trains a reader to ignore the word.
 */
function trackedFiles(root) {
  const out = execFileSync('git', ['ls-files', '-z'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 128,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return out.split('\0').filter(Boolean);
}

/** Fallback walk for a tree that is not a git repository (the tests build throwaway directories). */
function walk(root, dir = root, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.git' || entry === '.next' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(root, full, out);
    else out.push(relative(root, full).split('\\').join('/'));
  }
  return out;
}

export function check(root = ROOT) {
  const cdrDir = join(root, CDR_DIR);
  if (!existsSync(cdrDir)) {
    return { code: 2, blind: [`the config-decisions directory is not there: ${CDR_DIR}`], failures: [], citations: 0, links: 0 };
  }

  const defined = definedCdrNumbers(cdrDir);
  if (defined.size < EXPECTED_MINIMUM_CDR_FILES) {
    return {
      code: 1,
      blind: [],
      failures: [`found ${String(defined.size)} CDR file(s) in ${CDR_DIR}, expected at least ${String(EXPECTED_MINIMUM_CDR_FILES)} — the listing found almost nothing, so every citation below would pass vacuously.`],
      citations: 0,
      links: 0,
    };
  }

  let files;
  try {
    files = trackedFiles(root);
  } catch {
    files = walk(root);
  }

  const failures = [];
  let citationCount = 0;
  let linkCount = 0;
  let scanned = 0;

  // A number is reported ONCE with every citing file named, because a CDR cited from forty places is one missing
  // document, not forty failures.
  const dangling = new Map();

  for (const rel of files) {
    const ext = extname(rel).toLowerCase();
    if (!CITATION_EXTENSIONS.has(ext)) continue;
    const full = join(root, rel);
    if (!existsSync(full)) continue;
    let source;
    try {
      source = readFileSync(full, 'utf8');
    } catch {
      continue;
    }
    scanned++;

    for (const number of citationsIn(source)) {
      citationCount++;
      if (defined.has(number) || CITED_WITHOUT_FILE.has(number)) continue;
      if (!dangling.has(number)) dangling.set(number, []);
      dangling.get(number).push(rel);
    }

    if (ext !== '.md') continue;
    for (const target of relativeLinksIn(source)) {
      linkCount++;
      if (existsSync(resolve(dirname(full), target))) continue;
      failures.push(
        `${rel}\n    the link target does not exist: ${target}\n` +
          `    A relative link that resolves to nothing is silent — Markdown renders it as an ordinary link.`,
      );
    }
  }

  if (scanned < EXPECTED_MINIMUM_SCANNED) {
    return { code: 1, blind: [], failures: [`scanned ${String(scanned)} file(s), expected at least ${String(EXPECTED_MINIMUM_SCANNED)} — the walk found nothing to check.`], citations: 0, links: 0 };
  }

  for (const [number, citedBy] of [...dangling.entries()].sort()) {
    failures.push(
      `CDR-${number} is cited but has NO file in ${CDR_DIR.split('\\').join('/')}\n` +
        `    cited by: ${citedBy.slice(0, 8).join(', ')}${citedBy.length > 8 ? ` (+${String(citedBy.length - 8)} more)` : ''}\n` +
        `    Either the document was never merged (check unmerged branches BEFORE deleting any) or the citation is a typo.`,
    );
  }

  return { code: failures.length > 0 ? 1 : 0, blind: [], failures, citations: citationCount, links: linkCount, scanned, defined: defined.size };
}

/** Self-test: the extractors must actually extract, or every verdict above is vacuous. */
function selfTest() {
  const problems = [];

  const cites = citationsIn('governed by CDR-087 5.0 and CDR-090; see CDR-087 again');
  if (!cites.has('087') || !cites.has('090')) problems.push('citationsIn missed a plain citation');
  if (cites.size !== 2) problems.push('citationsIn did not de-duplicate a repeated citation');
  if (citationsIn('ACDR-0871 is not a citation').size !== 0) problems.push('citationsIn matched a glued token');

  const links = relativeLinksIn('see [a](./x.md) and [b](../y.md#frag) and [c](https://e.com) and [d](#top)');
  if (!links.has('./x.md')) problems.push('relativeLinksIn missed a plain relative link');
  if (!links.has('../y.md')) problems.push('relativeLinksIn did not strip a #fragment');
  if (links.has('https://e.com')) problems.push('relativeLinksIn reported an external URL');
  if (links.has('#top')) problems.push('relativeLinksIn reported a bare anchor');

  // A link inside code is not a link. This check must not forbid documenting a broken one.
  if (relativeLinksIn('the broken link was `[CDR-090](CDR-090-gone.md)`').size !== 0) {
    problems.push('relativeLinksIn reported a link inside an inline code span');
  }
  if (relativeLinksIn('```\n[a](./nope.md)\n```\n').size !== 0) {
    problems.push('relativeLinksIn reported a link inside a fenced code block');
  }
  if (!relativeLinksIn('`code` then [a](./x.md)').has('./x.md')) {
    problems.push('withoutCode swallowed a real link that followed a code span');
  }

  return problems;
}

if (import.meta.url.startsWith('file:') && process.argv[1] && import.meta.url.endsWith(process.argv[1].split('\\').join('/').split('/').pop())) {
  const selfProblems = selfTest();
  if (selfProblems.length > 0) {
    console.error('\u2716 doc-link check CANNOT BE TRUSTED: its own self-test failed.');
    for (const p of selfProblems) console.error(`  - ${p}`);
    process.exit(2);
  }
  const r = check();
  if (r.code === 2) {
    console.error('\u2716 doc-link check COULD NOT RUN:');
    for (const b of r.blind) console.error(`  - ${b}`);
    process.exit(2);
  }
  if (r.code === 1) {
    console.error(`\u2716 doc-link check FAILED \u2014 ${String(r.failures.length)} unresolvable reference(s):\n`);
    for (const f of r.failures) console.error(`  ${f}\n`);
    process.exit(1);
  }
  console.log(
    `\u2714 doc-link check passed (${String(r.citations)} CDR citation(s) across ${String(r.scanned)} file(s) all resolve to ${String(r.defined)} document(s); ${String(r.links)} relative Markdown link(s) all exist). Self-test passed.`,
  );
}
