// ACBP shared library — citing a test from an evidence index, and the ratchet that stops evidence eroding.
//
// WHY THIS FILE EXISTS. This repository now keeps TWO machine-checked evidence indexes:
//
//   • `tools/trust-critical-index.mjs`     — the 20 trust-critical negatives (ACBP-P7-007, CDR-080)
//   • `tools/failure-scenario-index.mjs`   — the 16 failure/recovery scenarios (ACBP-P7-008, CDR-084)
//
// They pin DIFFERENT canon shapes — a numbered Markdown list versus a table — so their parsers are separate on
// purpose; forcing one parser to serve both would make a load-bearing gate fragile in service of a second
// document. But the rules about CITING A TEST and about NOT LOSING EVIDENCE are identical, and a guard that is
// copied is a guard that drifts. Those rules live here, once.
//
// Every function below was earned by a defect, and the comments say which — because the cheap version of each
// is what was written first and it was wrong.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join, extname, basename } from 'node:path';

/**
 * A test title written `'…the CALLER\'S…'` appears in source WITH the backslash, so a plain substring search for
 * the human-readable title misses it. Unescape quote escapes before searching — otherwise an index is forced to
 * store source-level escaping, which is unreadable and drifts the moment someone reflows the quotes.
 */
export const unescapeQuotes = (src) => src.replace(/\\(['"`])/g, '$1');

/** Collapse whitespace so a reflowed canon line still matches the statement it pins. */
export const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

/**
 * Classify how `title` appears in RAW (still-escaped) source `src`:
 *   'live'       attached to a test(…)/it(…) call that will actually run
 *   'skipped'    attached to a test/it call marked .skip/.todo/.fails
 *   'not-a-test' present in the file, but not as the first argument of any test/it call
 *   'absent'     not present at all
 *
 * TWO DEFECTS PAID FOR THIS FUNCTION.
 *
 * 1. The first version was `src.includes(title)`. That accepted all three non-'live' cases — confirmed by
 *    running the real checker against fixtures: `test.skip('<title>')`, a `//`-commented title with the test
 *    deleted, and a test with an emptied body ALL printed "pinned to live tests" and exited 0. Renaming a test
 *    broke the build; NEUTERING one did not, and neutering is the cheaper move for anyone chasing green.
 *
 * 2. The fix then scanned pre-unescaped text, and failed on the real index within a minute: canon item 14's
 *    title contains an apostrophe written `\'` inside a single-quoted literal, so unescaping first made the
 *    literal appear to end mid-title and a correct row reported as unattached. Hence: take RAW source, read
 *    each literal honouring backslash escapes, and unescape only what was extracted.
 */
export function liveTestCallFor(src, title) {
  if (!unescapeQuotes(src).includes(title)) return 'absent';
  const CALL = /\b(?:test|it)((?:\s*\.\s*(?:skip|only|todo|fails|concurrent|sequential|each))*)\s*\(\s*(['"`])/g;
  let found = 'not-a-test';
  for (let m = CALL.exec(src); m !== null; m = CALL.exec(src)) {
    const modifiers = m[1] ?? '';
    const quote = m[2];
    let i = m.index + m[0].length;
    let literal = '';
    let closed = false;
    for (; i < src.length; i++) {
      const ch = src[i];
      if (ch === '\\') {
        literal += src[i + 1] ?? '';
        i++;
        continue;
      }
      if (ch === quote) {
        closed = true;
        break;
      }
      if (ch === '\n' && quote !== '`') break; // unterminated single-line literal — not a title we can read
      literal += ch;
    }
    if (!closed || literal !== title) continue;
    if (/\.\s*(?:skip|todo|fails)\b/.test(modifiers)) {
      found = 'skipped';
      continue; // a live duplicate elsewhere still counts, so keep looking
    }
    return 'live';
  }
  return found;
}

/**
 * A hosted CI run id is all digits, six or more.
 *
 * WHAT THIS DOES NOT DO, stated here because a green gate is otherwise easy to over-read: it checks SHAPE, never
 * existence. Nothing contacts GitHub, so a hand-typed number passes, and nothing cross-checks that the run
 * actually reddened the test the row names. ACBP-P7-007 marked a row `measured` on a run in which a DIFFERENT
 * test went red and its checker passed it — two human reviews caught that, no tool did. What the field buys is
 * a claim that stays checkable by a person long after the probe branch is deleted: `gh run view <id>` resolves
 * when the SHA is on no ref. It is an audit trail, not an oracle. Tracked as CDR-080 §7.10 and §7.11.
 */
export const isRunId = (value) => /^\d{6,}$/.test(String(value));

/**
 * Read a `MAX_UNPROVEN`-style ceiling from the same file on origin/main, so the ceiling cannot RISE.
 *
 * WHY THIS IS NOT OPTIONAL. Before ACBP-P7-007's second review pass, the ceiling was a plain integer whose
 * docstring said "it may only ever go DOWN" — and NOTHING enforced that. An author could break a measurement
 * and raise the number in the same commit. Per this repository's own rule, a comment claiming a guarantee must
 * be able to name its enforcer; that one could not, so the word was false when written.
 *
 * @returns {{ref: string, value: number} | null} null when no baseline is readable (shallow clone, or the file
 *   is new and not yet on main) — in which case the CALLER MUST SAY SO in its output rather than pass quietly.
 *   A guard that cannot see its target reports that; it does not report clean.
 */
export function readCeilingBaseline({ cwd, file, constant }) {
  for (const ref of ['origin/main', 'main']) {
    const show = spawnSync('git', ['show', `${ref}:${file}`], { cwd, encoding: 'utf8', windowsHide: true });
    if (show.status !== 0 || !show.stdout) continue;
    const m = new RegExp(`export\\s+const\\s+${constant}\\s*=\\s*(\\d+)`).exec(show.stdout);
    if (m) return { ref, value: Number(m[1]) };
  }
  return null;
}

/**
 * Compare a live ceiling against its baseline.
 * @returns {{kind: 'unreadable'} | {kind: 'ok', note: string} | {kind: 'rose', problem: string}}
 */
export function checkCeiling({ cwd, file, constant, value, label = constant }) {
  const baseline = readCeilingBaseline({ cwd, file, constant });
  if (baseline === null) return { kind: 'unreadable' };
  if (value > baseline.value) {
    return {
      kind: 'rose',
      problem:
        `${label} rose from ${baseline.value} (${baseline.ref}) to ${value}. It is a ratchet: raising it converts ` +
        'lost evidence into a passing build, which is the one direction that must always fail. Restore the ' +
        'measurement, or record why a measurement was withdrawn and have the owner accept the new ceiling.',
    };
  }
  return { kind: 'ok', note: ` Ceiling ${value} ≤ baseline ${baseline.value} (${baseline.ref}).` };
}

// ── Is a `mutation` an EDIT, or a wish? ───────────────────────────────────────────────────────────────────────
//
// Both evidence indexes carry a `mutation` column: the exact edit that should make the cited test go red. It is
// the load-bearing half of the probe, because a row is only ever GREEN once a recorded mutation reddened its
// test in a hosted CI run.
//
// AUDITING THAT COLUMN BEFORE RUNNING IT, a third of the rows described a WISH rather than an edit — "widen the
// heartbeat grace to infinity", "skip the stop check at the step boundary", "remove the idempotency read-back",
// "drop the usage-event uniqueness constraint". None names a function, a file or a column. Nobody can apply one
// without first re-deriving what the author meant, and re-derivation is exactly where a probe quietly measures
// something other than the row it is filed under — which is how ACBP-P7-007 came to mark a row `measured` on a
// run in which a DIFFERENT test went red.
//
// So a mutation must name at least one thing that EXISTS in non-test source.
//
// WHAT THIS RULE CANNOT DO. It cannot tell a RIGHT symbol from a WRONG-but-real one. Failure-scenario row 16
// named `startRun` while its cited test drives `enqueueJob`; both are real functions in the same file, so this
// rule would have passed it and a human caught it. The rule raises the floor from "prose" to "names something
// real"; it does not reach intent. That limit is pinned as a test case, not only asserted here, so it cannot
// quietly stop being true. It sits alongside CDR-080 §7.10 and §7.11.

const SYMBOL_SHAPES = [
  /^[a-z][a-z0-9]*(?:[A-Z][A-Za-z0-9]*)+$/, //        camelCase        enqueueJob
  /^[A-Z][a-z0-9]+(?:[A-Z][A-Za-z0-9]*)+$/, //        PascalCase       StopRepository
  /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/, //               snake_case       expires_at
  /^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+$/, //               SCREAMING_SNAKE  MAX_UNPROVEN
];

/** A filename is a naming of the edit SITE, which is as good as naming the symbol. */
const SOURCE_EXTS = 'ts|tsx|mts|cts|mjs|cjs|js|jsx|sql|yml|yaml|json';
const SOURCE_FILE = new RegExp(`^[A-Za-z0-9_.-]+\\.(?:${SOURCE_EXTS})$`);

/**
 * Filenames FIRST in the alternation, so a name wins over its own tail at the same position.
 *
 * DEFECT THIS FIXES. The first version had one identifier pattern and no hyphens, and this repository names
 * files `enqueue-job.ts`, `usage-rollup-service.ts`, `gate-14.integration.test.ts`. `enqueue-job.ts` tokenised
 * as `job.ts` — which exists nowhere — so a row naming a REAL file would have been reported stale. A guard that
 * fails honest rows is a guard people delete. Whitespace still bounds the match, so a filename cannot swallow
 * the words beside it; `:388` and a possessive `'s` fall off the same way.
 */
const TOKEN = new RegExp(`[A-Za-z0-9_.-]+\\.(?:${SOURCE_EXTS})\\b|[A-Za-z_$][A-Za-z0-9_$]*(?:\\.[A-Za-z_$][A-Za-z0-9_$]*)*`, 'g');

const looksLikeSymbol = (t) => SYMBOL_SHAPES.some((re) => re.test(t));

/**
 * The tokens in `text` shaped like a code symbol or a source filename, in order of first appearance.
 *
 * Plain English words and bare acronyms are deliberately NOT symbols: if "company" or "RLS" counted, every
 * sentence in the column would pass and the rule would enforce nothing — the "guard written but never applied"
 * failure this repository has hit before.
 */
export function namedSymbols(text) {
  const out = [];
  const seen = new Set();
  const push = (t) => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  for (const [chain] of String(text).matchAll(TOKEN)) {
    if (SOURCE_FILE.test(chain)) {
      push(chain);
      continue; // the whole filename is the symbol; its segments are not
    }
    for (const seg of chain.split('.')) if (looksLikeSymbol(seg)) push(seg);
  }
  return out;
}

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.next', '.git', '.turbo', '__tests__', 'tests']);
const SOURCE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.mjs', '.cjs', '.js', '.jsx', '.sql']);
const IS_TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/**
 * Index every identifier and filename in NON-TEST source under `roots`.
 *
 * Test files are excluded on purpose: a symbol that exists only in a test is not a production control, so a
 * mutation naming one is not an edit to the thing under test.
 *
 * `files` is returned so a caller can refuse a walk that found NOTHING. An index built from zero files answers
 * `false` to every question, which would turn this guard into a build-breaker for correct rows — the same
 * shape as the empty-sweep defect ACBP-P7-007 fixed in `audit-secret-sweep`, where all-zero rows read as clean.
 */
export function buildSymbolIndex({ cwd, roots }) {
  const identifiers = new Set();
  const filenames = new Set();
  let files = 0;

  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // a root that does not exist contributes nothing; `files` records that it found nothing
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) walk(join(dir, e.name));
        continue;
      }
      if (!e.isFile()) continue;
      if (!SOURCE_EXT.has(extname(e.name)) || IS_TEST_FILE.test(e.name)) continue;
      files++;
      filenames.add(basename(e.name));
      const text = readFileSync(join(dir, e.name), 'utf8');
      for (const [id] of text.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)) identifiers.add(id);
    }
  };
  for (const r of roots) walk(join(cwd, r));

  return {
    files,
    size: identifiers.size,
    has: (token) => (token.includes('.') ? filenames.has(token) : identifiers.has(token)),
  };
}

/**
 * @returns {{kind:'ok', named: string[]} | {kind:'no-symbol'} | {kind:'unknown', candidates: string[]}}
 */
export function checkMutationNamesRealCode({ mutation, symbols }) {
  const candidates = namedSymbols(mutation);
  if (candidates.length === 0) return { kind: 'no-symbol' };
  const named = candidates.filter((c) => symbols.has(c));
  return named.length > 0 ? { kind: 'ok', named } : { kind: 'unknown', candidates };
}