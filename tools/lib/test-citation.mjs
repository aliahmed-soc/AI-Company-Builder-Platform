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
