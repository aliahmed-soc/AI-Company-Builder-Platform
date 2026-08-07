// ACBP shared library — reading a hosted CI run's FAILED tests, so a recorded measurement can be checked.
//
// WHY THIS EXISTS. Both evidence indexes say the same thing about their own weakest point, and have said it
// since ACBP-P7-007:
//
//   "NOTHING MACHINE-CHECKS THE MUTATION AGAINST THE TEST TITLE. ACBP-P7-007 marked row 19 `measured` on run
//    31113087854, in which a DIFFERENT test in the same file went red; two independent reviews caught it and
//    this checker could not."
//
// That is CDR-080 §7.11. It is mechanizable, and this is the mechanism: pull the run's failed-test list and
// assert the row's OWN `testTitle` is in it.
//
// IT IS DELIBERATELY NOT PART OF `check:static`. The two index checkers never contact GitHub, which is what lets
// them run offline, unauthenticated, and identically on every machine and in CI. Putting a network call and a
// token requirement into the build would make the whole gate unrunnable whenever GitHub is unreachable — and a
// gate that cannot run is a gate people delete. This is opt-in: `pnpm run verify:mutation-runs`.
//
// WHAT IT STILL CANNOT DO, said here so a green result is not over-read: it reads the run GitHub reports TODAY.
// A re-run replaces that log, so a row confirmed now could stop being confirmable later without anything in the
// repository changing. It also cannot tell whether the mutation described in the row is the edit that produced
// the run — only that the named test is among the failures.

/**
 * The ESC character, built rather than written.
 *
 * THE DEFECT THAT EARNED THIS LINE. The first version of the stripper matched only a real ESC byte, and that
 * byte sat RAW inside the regex literal — invisible in an editor, undetectable by typecheck and lint. On Windows
 * `gh run view --log-failed` does not emit ESC at all: it emits CARET NOTATION, a literal caret followed by a
 * bracket. So nothing was stripped, and every extracted title arrived still wrapped in colour codes.
 *
 * THE TESTS PASSED ANYWAY, WHICH IS THE PART WORTH REMEMBERING. The identical corruption had landed in the test
 * fixtures, so a regex demanding ESC was matched against fixtures that contained ESC: symmetric damage, green
 * suite, broken tool. Running it against a REAL run log is what exposed it — a different anchor, rather than a
 * rerun of the thing that produced the mistake. `check:encoding` then named the byte precisely.
 *
 * Writing it as a unicode escape re-introduced the same raw byte on the way to disk, so it is CONSTRUCTED here
 * and this file contains no escape sequence and no control character at all.
 */
const ESC = String.fromCharCode(27);

/**
 * A colour code introduced either by a real ESC, or by the caret notation `gh` emits on Windows.
 *
 * THE CARET FORM IS TWO CHARACTERS STANDING IN FOR ONE. `^[` is how the ESC byte is rendered, and the escape
 * sequence proper follows it — so a red marker arrives as `^[` + `[31m`, six characters, not five. A first fix
 * treated the bare caret as the introducer and still failed to strip anything; the unit case below caught it
 * only because it asserts on `stripAnsi` DIRECTLY. The title-level cases had passed either way, because
 * `failedTestTitles` was separately trimming stray carets — a compensating hack that hid a parser bug, so it is
 * gone.
 */
export const ansiSgr = () => new RegExp('(?:' + ESC + '|\\^\\[)\\[[0-9;]*m', 'g');

export const stripAnsi = (s) => String(s).replace(ansiSgr(), '');

/**
 * The titles vitest reported as FAILED, in order of first appearance, deduplicated.
 *
 * THE TRAP THIS AVOIDS, and the reason a substring search is wrong: vitest prints
 *
 *   stdout | packages/…/x.integration.test.ts > some suite > a test that merely logged something
 *
 * for EVERY test that wrote to stdout — passing ones included. Searching the log for a row's `testTitle` finds
 * those lines and reports a green test as red, which is the same false confirmation this tool exists to prevent,
 * merely automated. Only the multiplication-sign marker means a test failed; a check mark means it passed and a
 * down-arrow that it was skipped.
 */
export function failedTestTitles(logText) {
  const out = [];
  const seen = new Set();
  for (const raw of stripAnsi(logText).split(/\r?\n/)) {
    const m = /×\s*(.+)$/.exec(raw);
    if (m === null) continue;
    // vitest appends a duration to the title line; it is not part of the title. Nothing else is trimmed: the
    // escape stripping above is now correct for both forms, and a second cleanup here would only hide the next
    // parser bug the way it hid the last one.
    const title = m[1].replace(/\s+\d+ms\s*$/, '').trim();
    if (title === '' || seen.has(title)) continue;
    seen.add(title);
    out.push(title);
  }
  return out;
}

/**
 * @returns {{kind:'confirmed'} | {kind:'no-failures'} | {kind:'mismatch', failedTitles: string[]}}
 *
 * EXACT equality, not `includes`. A row citing a PREFIX of a real title would otherwise pass, and the whole
 * point of pinning a verbatim title is that near-misses are caught rather than rounded up.
 */
export function verifyMeasuredRow({ testTitle, failedTitles }) {
  if (failedTitles.length === 0) return { kind: 'no-failures' };
  if (failedTitles.includes(testTitle)) return { kind: 'confirmed' };
  return { kind: 'mismatch', failedTitles };
}
