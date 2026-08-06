/**
 * ACBP-P7-007 — regression suite for tools/check-csv-shape.mjs (CDR-080 §6).
 *
 * The checker exists because a shifted CSV row is invisible in review and answers the reader's question wrong.
 * Every failure mode gets a case, and so does every shape that must NOT be flagged — a checker that rejects
 * legitimate quoting would be turned off within a week.
 */
import { test, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { malformedRows, parseCsv } from '../check-csv-shape.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHECKER = join(REPO_ROOT, 'tools', 'check-csv-shape.mjs');

// ---- The unit the checker is built on -----------------------------------------------------------------------

test('an unquoted comma shifts the row, and that is what gets caught', () => {
  const bad = malformedRows('a,b,c\n1,2,3\n4,oops, five,6\n');
  expect(bad).toHaveLength(1);
  expect(bad[0].got).toBe(4);
  expect(bad[0].want).toBe(3);
});

test('THE REAL DEFECT: a coverage value containing a comma, written unquoted', () => {
  // Verbatim shape of the ACBP-P7-007 defect in both traceability matrices.
  const header = 'Requirement ID,Verification approach,Coverage status,Gap or question';
  const shifted = `${header}\nNFR-021,Injection corpus,Partially covered - boundary only, no quarantine (MVP),the note\n`;
  expect(malformedRows(shifted)).toHaveLength(1);
  const fixed = `${header}\nNFR-021,Injection corpus,"Partially covered - boundary only, no quarantine (MVP)",the note\n`;
  expect(malformedRows(fixed)).toHaveLength(0);
  // …and the value lands where it belongs, which is the part that actually matters to a reader.
  const row = parseCsv(fixed)[1];
  expect(row[2]).toBe('Partially covered - boundary only, no quarantine (MVP)');
  expect(row[3]).toBe('the note');
});

test('a row with too FEW fields is caught as well as too many', () => {
  expect(malformedRows('a,b,c\n1,2\n')).toHaveLength(1);
});

// ---- Shapes that must NOT be flagged ------------------------------------------------------------------------

test('quoted commas, quoted newlines and doubled quotes are all legitimate', () => {
  expect(malformedRows('a,b,c\n"x, y",2,3\n')).toHaveLength(0);
  expect(malformedRows('a,b\n1,"two\nlines"\n')).toHaveLength(0);
  expect(malformedRows('a,b\n1,"he said ""hi"""\n')).toHaveLength(0);
});

test('a trailing newline is not a phantom short row', () => {
  expect(malformedRows('a,b\n1,2\n')).toHaveLength(0);
});

test('empty trailing fields are preserved, not trimmed away', () => {
  expect(parseCsv('a,b,c\n1,2,\n')[1]).toEqual(['1', '2', '']);
  expect(malformedRows('a,b,c\n1,2,\n')).toHaveLength(0);
});

// ---- End to end, against an isolated git repository ---------------------------------------------------------

function inTempRepo(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'acbp-csv-shape-'));
  try {
    spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
    for (const [rel, content] of Object.entries(files)) {
      const abs = join(root, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, content);
    }
    spawnSync('git', ['-C', root, 'add', '-A'], { encoding: 'utf8' });
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    return run({ code: r.status, out: `${r.stdout}\n${r.stderr}` });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('the checker fails a tracked CSV whose row shifted, and names the file, line and row id', () => {
  inTempRepo({ 'docs/x.csv': 'id,status,note\nNFR-021,partly, unquoted,note\n' }, ({ code, out }) => {
    expect(code, out).toBe(1);
    expect(out).toContain('docs/x.csv:2');
    expect(out).toContain('NFR-021');
    expect(out).toMatch(/4 fields, header has 3/);
  });
});

test('the checker passes a well-formed tracked CSV', () => {
  inTempRepo({ 'docs/x.csv': 'id,status,note\nNFR-021,"partly, quoted",note\n' }, ({ code, out }) => {
    expect(code, out).toBe(0);
    expect(out).toContain('csv-shape check passed');
  });
});

test('an UNTRACKED malformed CSV is not the checker’s business — it reads git, not the disk', () => {
  const root = mkdtempSync(join(tmpdir(), 'acbp-csv-shape-untracked-'));
  try {
    spawnSync('git', ['-C', root, 'init', '-q'], { encoding: 'utf8' });
    writeFileSync(join(root, 'tracked.csv'), 'a,b\n1,2\n');
    spawnSync('git', ['-C', root, 'add', 'tracked.csv'], { encoding: 'utf8' });
    writeFileSync(join(root, 'scratch.csv'), 'a,b\n1,2,3\n'); // malformed, never added
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the checker refuses to pass where it cannot see git — a blind check must not report clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'acbp-csv-shape-nogit-'));
  try {
    writeFileSync(join(root, 'x.csv'), 'a,b\n1,2,3\n');
    const r = spawnSync(process.execPath, [CHECKER, root], { encoding: 'utf8' });
    expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(2);
    expect(`${r.stdout}\n${r.stderr}`).toMatch(/CANNOT SEE ITS TARGET/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('THE REPOSITORY ITSELF is well-formed — this is the case that would have caught the defect', () => {
  const r = spawnSync(process.execPath, [CHECKER, REPO_ROOT], { encoding: 'utf8' });
  expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
});
