/**
 * ACBP-P7-008 follow-up — regression suite for tools/lib/run-evidence.mjs.
 *
 * WHAT THIS CLOSES. CDR-080 §7.11 records that NOTHING machine-checks a recorded `mutationRunId` against the
 * `testTitle` the row claims it reddened — the gap that let ACBP-P7-007 mark row 19 `measured` on a run in which
 * a DIFFERENT test in the same file went red. Two human reviews caught that; no tool could.
 *
 * THE FIXTURES BUILD THEIR ESCAPES RATHER THAN CONTAINING THEM, and that is the whole lesson of this suite's own
 * first version. It shipped green while the tool was broken: a raw ESC byte had landed in BOTH the regex and the
 * fixtures, so a matcher demanding ESC met fixtures containing ESC and agreed with itself. Real logs use neither
 * — on Windows `gh` emits CARET NOTATION — and nothing was stripped. Symmetric corruption, passing suite, broken
 * tool. Both forms are now covered explicitly, and the source contains no control character.
 *
 * No network here. Every case runs against fixture text shaped like the real logs.
 */
import { test, expect } from 'vitest';
import { stripAnsi, failedTestTitles, verifyMeasuredRow } from '../lib/run-evidence.mjs';

const ESC = String.fromCharCode(27);

/** A line as `gh run view --log-failed` emits it: job, step, timestamp, then the vitest line. */
const ghLine = (body) => `verify\tAggregate gate (typecheck, lint, unit, real-PostgreSQL integration)\t2026-08-07T02:08:28.0140042Z ${body}`;

/** `esc` picks the form: a real ESC byte, or the caret notation Windows `gh` actually produces. */
const RED = (title, { esc = ESC, ms = 233 } = {}) =>
  ghLine(`${esc}[31m     ${esc}[31m×${esc}[31m ${title}${esc}[39m${esc}[32m ${ms}${esc}[2mms${esc}[22m${esc}[39m`);
const GREEN = (title, { esc = ESC } = {}) => ghLine(`     ${esc}[32m✓${esc}[39m ${title}${esc}[32m 240${esc}[2mms${esc}[22m${esc}[39m`);
const STDOUT = (file, describe, title, { esc = ESC } = {}) =>
  ghLine(`${esc}[90mstdout${esc}[2m | ${file}${esc}[2m > ${esc}[22m${esc}[2m${describe}${esc}[2m > ${esc}[22m${esc}[2m${title}`);

// ── stripAnsi: BOTH escape forms ───────────────────────────────────────────────────────────────────────────────

test('strips a real ESC colour code', () => {
  expect(stripAnsi(`${ESC}[31m×${ESC}[39m hello`)).toBe('× hello');
});

test('THE DEFECT: strips CARET NOTATION too, which is what Windows `gh` actually emits', () => {
  // The first version matched only ESC. Real logs contain '^' + '[' as two ordinary printable characters, so
  // nothing was stripped and every title came back wrapped in codes.
  expect(stripAnsi('^[[31m×^[[39m hello')).toBe('× hello');
});

test('text with no escapes is returned unchanged', () => {
  expect(stripAnsi('a plain title, untouched')).toBe('a plain title, untouched');
});

// ── failedTestTitles ───────────────────────────────────────────────────────────────────────────────────────────

// The caret stand-in is TWO characters, `^` then `[`, because that is what renders the single ESC byte. A first
// version of this loop passed `'^'` alone and produced five-character codes no real log contains — the fixture
// was wrong, not the tool, and the tool had already been proved correct against real run logs. A fixture that
// does not mirror reality byte for byte is how the original defect survived a green suite in the first place.
for (const [label, esc] of [['ESC', ESC], ['caret notation', '^[']]) {
  test(`a failure line yields its title, without the duration (${label})`, () => {
    expect(failedTestTitles(RED('a paused company CANNOT enqueue a job, and NO jobs row is created', { esc }))).toEqual([
      'a paused company CANNOT enqueue a job, and NO jobs row is created',
    ]);
  });

  test(`a passing line is NOT a failure (${label})`, () => {
    expect(failedTestTitles(GREEN('CONTROL: the SAME approval, unexpired, authorizes', { esc }))).toEqual([]);
  });

  test(`THE TRAP: a stdout line mentioning a title is NOT a failure (${label})`, () => {
    // vitest prints one of these for every test that logged anything, PASSING included. A loose substring search
    // for a row's testTitle finds these and reports a green test as red.
    const log = STDOUT('packages/core/src/x.integration.test.ts', 'some suite', 'a test that merely logged', { esc });
    expect(failedTestTitles(log)).toEqual([]);
  });
}

test('red and green interleaved: only the red titles come back, in order', () => {
  const log = [
    GREEN('COVERS + gate 8 — a task stop halts its call, MEASURED under 5s'),
    RED('a REAL account-wide stop refuses the call'),
    GREEN("MISSES — another ACCOUNT's account-wide stop does not halt this one"),
    RED('COVERS + gate 8 — a account_wide stop halts its call, MEASURED under 5s'),
  ].join('\n');
  expect(failedTestTitles(log)).toEqual([
    'a REAL account-wide stop refuses the call',
    'COVERS + gate 8 — a account_wide stop halts its call, MEASURED under 5s',
  ]);
});

test('a title repeated across retries is reported once', () => {
  expect(failedTestTitles([RED('flaky thing'), RED('flaky thing')].join('\n'))).toEqual(['flaky thing']);
});

test('a title containing an em-dash, quotes and a comma survives intact', () => {
  const t = 'an EXPIRED approval cannot execute — the call is denied, and the denial is "RECORDED"';
  expect(failedTestTitles(RED(t))).toEqual([t]);
});

test('a line with no duration suffix still yields its title', () => {
  expect(failedTestTitles(ghLine(`${ESC}[31m     ×${ESC}[39m a test with no timing`))).toEqual(['a test with no timing']);
});

test('an empty or step-only log yields nothing rather than throwing', () => {
  expect(failedTestTitles('')).toEqual([]);
  expect(failedTestTitles(ghLine('$ pnpm run check'))).toEqual([]);
});

// ── verifyMeasuredRow ──────────────────────────────────────────────────────────────────────────────────────────

test('the row is CONFIRMED when its own title is among the failures', () => {
  expect(verifyMeasuredRow({ testTitle: 'the claim', failedTitles: ['something else', 'the claim'] }).kind).toBe('confirmed');
});

test('THE DEFECT THIS EXISTS FOR: a run that reddened a DIFFERENT test is NOT confirmation', () => {
  // ACBP-P7-007 row 19, exactly: the recorded run went red, but on another test in the same file.
  const r = verifyMeasuredRow({ testTitle: 'a material decision that fails, fails HONESTLY', failedTitles: ['a different test entirely'] });
  expect(r.kind).toBe('mismatch');
  expect(r.failedTitles).toEqual(['a different test entirely']);
});

test('a run with NO failures at all cannot confirm anything', () => {
  expect(verifyMeasuredRow({ testTitle: 'the claim', failedTitles: [] }).kind).toBe('no-failures');
});

test('matching is EXACT, so a row citing a prefix of a real title does not pass', () => {
  expect(verifyMeasuredRow({ testTitle: 'the claim', failedTitles: ['the claim goes further'] }).kind).toBe('mismatch');
});
