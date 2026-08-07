/**
 * ACBP-P7-008 — regression suite for tools/lib/test-citation.mjs.
 *
 * These behaviours were EXTRACTED from `check-trust-critical-index.mjs` so that it and
 * `check-failure-scenario-index.mjs` cannot drift apart. Before the extraction they were covered only
 * indirectly, through one checker's end-to-end suite. That is not enough for shared code: a change here now
 * moves two gates at once, so each behaviour is pinned directly, at the unit.
 *
 * Every case below corresponds to a defect that actually happened. The comments say which.
 */
import { test, expect } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import {
  liveTestCallFor,
  unescapeQuotes,
  norm,
  isRunId,
  readCeilingBaseline,
  checkCeiling,
  namedSymbols,
  buildSymbolIndex,
  checkMutationNamesRealCode,
} from '../lib/test-citation.mjs';

// ── liveTestCallFor ───────────────────────────────────────────────────────────────────────────────────────────
// DEFECT 1: the original check was `src.includes(title)`. Running the real checker against these three fixtures
// printed "pinned to live tests" and exited 0 for all of them. Renaming a test broke the build; NEUTERING one
// did not — and neutering is the cheaper move for anyone chasing green.

test('a live test( call is LIVE', () => {
  expect(liveTestCallFor(`test('the claim', () => {});`, 'the claim')).toBe('live');
});

test('an it( call is LIVE too', () => {
  expect(liveTestCallFor(`it('the claim', () => {});`, 'the claim')).toBe('live');
});

test('DEFECT: test.skip is SKIPPED, not live — a skipped test is not evidence', () => {
  expect(liveTestCallFor(`test.skip('the claim', () => {});`, 'the claim')).toBe('skipped');
});

test('DEFECT: .todo and .fails are skipped too', () => {
  expect(liveTestCallFor(`test.todo('the claim');`, 'the claim')).toBe('skipped');
  expect(liveTestCallFor(`test.fails('the claim', () => {});`, 'the claim')).toBe('skipped');
});

test('DEFECT: a title surviving only in a COMMENT is not attached to a test', () => {
  expect(liveTestCallFor(`// the claim\ntest('something else', () => {});`, 'the claim')).toBe('not-a-test');
});

test('a title that is nowhere is ABSENT — distinct from present-but-unattached', () => {
  expect(liveTestCallFor(`test('other', () => {});`, 'the claim')).toBe('absent');
});

test('a LIVE duplicate beats a skipped one — the evidence exists somewhere', () => {
  const src = `test.skip('the claim', () => {});\ntest('the claim', () => {});`;
  expect(liveTestCallFor(src, 'the claim')).toBe('live');
});

test('.only and .concurrent still run, so they are LIVE', () => {
  expect(liveTestCallFor(`test.only('the claim', () => {});`, 'the claim')).toBe('live');
  expect(liveTestCallFor(`test.concurrent('the claim', () => {});`, 'the claim')).toBe('live');
});

// DEFECT 2: the fix for defect 1 scanned PRE-UNESCAPED source, and failed on the real index within a minute —
// canon item 14's title contains an apostrophe written `\'`, so unescaping first made the literal appear to end
// mid-title and a correct row reported as unattached.
test("DEFECT: a title containing an ESCAPED APOSTROPHE resolves", () => {
  const src = `test('the CALLER\\'S row is refused', () => {});`;
  expect(liveTestCallFor(src, "the CALLER'S row is refused")).toBe('live');
});

test('double-quoted and template-literal titles resolve', () => {
  expect(liveTestCallFor(`test("the claim", () => {});`, 'the claim')).toBe('live');
  expect(liveTestCallFor('test(`the claim`, () => {});', 'the claim')).toBe('live');
});

test('a title that is a PREFIX of a real one does not match — the comparison is exact', () => {
  expect(liveTestCallFor(`test('the claim goes further', () => {});`, 'the claim')).toBe('not-a-test');
});

test('an unterminated single-line literal is not mistaken for a title', () => {
  expect(liveTestCallFor(`test('the claim\nmore', () => {});`, 'the claim')).toBe('not-a-test');
});

// ── unescapeQuotes / norm ─────────────────────────────────────────────────────────────────────────────────────

test('unescapeQuotes removes backslashes before quote characters only', () => {
  expect(unescapeQuotes(String.raw`a\'b\"c\`d\ne`)).toBe(String.raw`a'b"c` + '`' + String.raw`d\ne`);
});

test('norm collapses whitespace so a REFLOWED canon line still matches', () => {
  expect(norm('  a   b \n  c ')).toBe('a b c');
});

// ── isRunId ───────────────────────────────────────────────────────────────────────────────────────────────────

test('a run id is all digits, six or more', () => {
  expect(isRunId('31113087854')).toBe(true);
  expect(isRunId('123456')).toBe(true);
});

test('a SHA is rejected because it is not entirely digits — not because of its length', () => {
  expect(isRunId('fe85082')).toBe(false);
  expect(isRunId('c17b2df')).toBe(false);
});

test('too short, empty, and non-strings are rejected', () => {
  expect(isRunId('12345')).toBe(false);
  expect(isRunId('')).toBe(false);
  expect(isRunId(undefined)).toBe(false);
  expect(isRunId('123456 ')).toBe(false);
});

test('DOCUMENTED LIMIT: a fabricated but well-formed id passes — this checks shape, never existence', () => {
  // Recorded as a test rather than only a comment, so nobody reads the gate as proof the run happened.
  // CDR-080 §7.10. `gh run view <id>` is what actually resolves it, and that is a human step.
  expect(isRunId('000000')).toBe(true);
});

// ── the ceiling ratchet ───────────────────────────────────────────────────────────────────────────────────────
// Before ACBP-P7-007's second review pass this was a plain integer whose docstring claimed "it may only ever go
// DOWN" while nothing enforced it. These cases pin the enforcement against a real git repository.

function inTempRepo(run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-ceiling-'));
  try {
    const git = (...args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
    git('init', '-q');
    git('config', 'user.email', 'probe@example.test');
    git('config', 'user.name', 'probe');
    const write = (value) => writeFileSync(join(root, 'idx.mjs'), `export const MAX_UNPROVEN = ${value};\n`);
    write(18);
    git('add', '-A');
    git('commit', '-q', '-m', 'baseline');
    git('branch', '-M', 'main');
    return run({ root, write, git });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the baseline is read from main when origin/main is absent', () => {
  inTempRepo(({ root }) => {
    const b = readCeilingBaseline({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN' });
    expect(b).toEqual({ ref: 'main', value: 18 });
  });
});

test('an EQUAL ceiling is fine, and the note names the baseline', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 18 });
    expect(r.kind).toBe('ok');
    expect(r.note).toContain('18');
    expect(r.note).toContain('main');
  });
});

test('a LOWER ceiling is fine — lowering it is the work', () => {
  inTempRepo(({ root }) => {
    expect(checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 17 }).kind).toBe('ok');
  });
});

test('THE RULE: a RAISED ceiling is refused, and the message says why', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN', value: 19 });
    expect(r.kind).toBe('rose');
    expect(r.problem).toContain('rose from 18');
    expect(r.problem).toContain('19');
  });
});

test('an UNREADABLE baseline is reported as such — never silently as ok', () => {
  inTempRepo(({ root }) => {
    const r = checkCeiling({ cwd: root, file: 'not-on-main.mjs', constant: 'MAX_UNPROVEN', value: 999 });
    expect(r.kind).toBe('unreadable');
  });
});

test('a repository with no git history yields an unreadable baseline rather than throwing', () => {
  const root = mkdtempSync(join(tmpdir(), 'acbp-nogit-'));
  try {
    writeFileSync(join(root, 'idx.mjs'), 'export const MAX_UNPROVEN = 3;\n');
    expect(readCeilingBaseline({ cwd: root, file: 'idx.mjs', constant: 'MAX_UNPROVEN' })).toBeNull();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


// ── namedSymbols / buildSymbolIndex / checkMutationNamesRealCode ──────────────────────────────────────────────
// DEFECT 4, and the one that produced this code. ACBP-P7-008 slice 6 is the mutation probe: for each row the
// `mutation` column is meant to be the EXACT EDIT someone applies to make the cited test go red. Auditing the
// column before running it, a third of the rows turned out to describe a WISH rather than an edit — "widen the
// heartbeat grace to infinity", "skip the stop check at the step boundary", "remove the idempotency read-back".
// None of those name a function, a file or a column, so no one can apply them without first re-deriving the
// author's intent, and re-derivation is where a probe quietly measures something else. Two rows named a symbol
// in the WRONG file, which is the same failure ACBP-P7-007 hit when a row was marked `measured` on a run in
// which a different test went red.
//
// So: a mutation must name at least one thing that EXISTS in non-test source. What the rule cannot do is stated
// where it is implemented and repeated here, because a green gate is otherwise easy to over-read — it cannot
// tell a RIGHT symbol from a WRONG-but-real one.

test('a camelCase identifier is a named symbol', () => {
  expect(namedSymbols('Delete the tenancy refusal in enqueueJob.')).toEqual(['enqueueJob']);
});

test('snake_case and SCREAMING_SNAKE are named symbols — a column name is a real target', () => {
  expect(namedSymbols('Drop the expires_at conjunct.')).toEqual(['expires_at']);
  expect(namedSymbols('Raise MAX_UNPROVEN by one.')).toEqual(['MAX_UNPROVEN']);
});

test('a source filename is a named symbol — naming the file is naming the edit site', () => {
  expect(namedSymbols('Revert logger.ts to emit the message verbatim.')).toEqual(['logger.ts']);
});

test('THE POINT: prose naming nothing yields NO symbols', () => {
  expect(namedSymbols('Widen the heartbeat grace to infinity so a silent worker is never reclaimed.')).toEqual([]);
  expect(namedSymbols('Skip the stop check at the step boundary so a stopped run continues.')).toEqual([]);
});

test('plain English words and short acronyms are NOT symbols — otherwise every sentence passes', () => {
  expect(namedSymbols('Remove the application tenant predicate from the company read and rely on RLS alone.')).toEqual([]);
});

test('a possessive and a line suffix do not corrupt the token', () => {
  expect(namedSymbols("verifyAndConsume's conditional UPDATE (dispatcher.ts:388)")).toEqual(['verifyAndConsume', 'dispatcher.ts']);
});

test('backticks are stripped, and a symbol is reported once however often it appears', () => {
  expect(namedSymbols('Drop `evaluateStops` — yes, evaluateStops.')).toEqual(['evaluateStops']);
});

test('a dotted chain that is not a source file is not a symbol unless a segment is', () => {
  expect(namedSymbols('emit fields.message verbatim')).toEqual([]);
  expect(namedSymbols('emit fields.errorCategory verbatim')).toEqual(['errorCategory']);
});

function inTempSource(run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-symbols-'));
  try {
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'service.ts'), 'export function enqueueJob() { return expires_at; }\n');
    writeFileSync(join(root, 'src', 'service.test.ts'), 'export function onlyInATest() {}\n');
    return run({ root });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the index finds identifiers and filenames in non-test source', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    expect(idx.has('enqueueJob')).toBe(true);
    expect(idx.has('expires_at')).toBe(true);
    expect(idx.has('service.ts')).toBe(true);
    expect(idx.files).toBe(1);
  });
});

test('THE POINT: a symbol that exists ONLY in a test file is not production code', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    expect(idx.has('onlyInATest')).toBe(false);
    expect(idx.has('service.test.ts')).toBe(false);
  });
});

test('a walk that finds NO files reports zero rather than an index that answers false to everything', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['does-not-exist'] });
    expect(idx.files).toBe(0);
  });
});

test('a mutation naming a real symbol is ok, and says which', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    const r = checkMutationNamesRealCode({ mutation: 'Delete the refusal in enqueueJob.', symbols: idx });
    expect(r.kind).toBe('ok');
    expect(r.named).toEqual(['enqueueJob']);
  });
});

test('a mutation naming NOTHING is refused as a wish, not an edit', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    expect(checkMutationNamesRealCode({ mutation: 'Widen the grace to infinity.', symbols: idx }).kind).toBe('no-symbol');
  });
});

test('a mutation naming only symbols that do NOT exist is refused, and the candidates are printed', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    const r = checkMutationNamesRealCode({ mutation: 'Delete the refusal in enqueueeJob.', symbols: idx });
    expect(r.kind).toBe('unknown');
    expect(r.candidates).toEqual(['enqueueeJob']);
  });
});

test('ONE real symbol is enough — a mutation may mention other things in passing', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    expect(checkMutationNamesRealCode({ mutation: 'In enqueueJob, bypass someHelperThatIsGone.', symbols: idx }).kind).toBe('ok');
  });
});

test('THE LIMIT, PINNED: a real symbol in the WRONG place still passes — the rule cannot see intent', () => {
  inTempSource(({ root }) => {
    const idx = buildSymbolIndex({ cwd: root, roots: ['src'] });
    // `enqueueJob` exists, so a mutation aimed at entirely the wrong control is accepted. This case exists so the
    // limit is recorded as behaviour rather than only as a sentence in a comment that could go stale.
    expect(checkMutationNamesRealCode({ mutation: 'Change enqueueJob so the SUN rises in the west.', symbols: idx }).kind).toBe('ok');
  });
});
// DEFECT 5, found reviewing my own slice-6 diff before writing the docs that describe it. The tokeniser did not
// admit hyphens, and this repository names files `enqueue-job.ts`, `usage-rollup-service.ts`,
// `gate-14.integration.test.ts`. So `enqueue-job.ts` tokenised as `job.ts` — which exists nowhere — and a
// CORRECT row naming a real file would have been reported as stale. A guard that fails honest rows is a guard
// people delete.

test('DEFECT: a HYPHENATED filename is one token, not its last segment', () => {
  expect(namedSymbols('Delete the gate from enqueue-job.ts')).toEqual(['enqueue-job.ts']);
  expect(namedSymbols('see usage-rollup-service.ts')).toEqual(['usage-rollup-service.ts']);
});

test('a dotted multi-part test filename survives whole', () => {
  expect(namedSymbols('gate-14.integration.test.ts')).toEqual(['gate-14.integration.test.ts']);
});

test('filenames do not swallow the words around them', () => {
  expect(namedSymbols('the file thing.ts and the guard doThing')).toEqual(['thing.ts', 'doThing']);
});