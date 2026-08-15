#!/usr/bin/env node
// ACBP static check — every Cursor rule in `.cursor/rules/` must have a byte-identical copy in
// `tooling/cursor-rules/`.
//
// WHY THIS EXISTS. `.cursor/rules/model-routing.mdc` declares that `tooling/cursor-rules/model-routing.mdc`
// "must be kept byte-identical to the repository rule". Nothing enforced that. There was no checker, no
// package script, and no CI step comparing the two — the pair happened to match because it had been copied
// carefully by hand, and no evidence existed either way at any moment in between.
//
// That is the shape this repository has been burned by before: a rule whose violation nothing can detect. The
// two files are also the worst possible candidates for a manual invariant, because Cursor loads ONLY the
// `.cursor/` copy (via its `alwaysApply` frontmatter) while a human reading the portable copy in `tooling/`
// sees the other one. A silent divergence therefore means the agent and the reader are following different
// rules, and the disagreement surfaces as a mysterious behavioural argument rather than as a diff.
//
// BYTE COMPARISON, NOT TEXT COMPARISON, and it has to be: the requirement is byte-identity. Reading both files
// as UTF-8 strings and comparing them would silently forgive exactly the differences that break the copy —
// a UTF-8 BOM on one side (invisible, and `check-encoding.mjs` only rejects it at position 0 of a scanned
// file), or CRLF against LF, which `.gitattributes` normalises in the index but not necessarily in whatever
// tree a contributor hands over.
//
// The set of names is compared too, in both directions. A new rule added to `.cursor/rules/` without a
// portable copy is a divergence the moment it lands, and an orphan left in `tooling/` after a rule is renamed
// is a stale file that reads as authoritative.
//
// Exit: 0 = every pair identical, 1 = divergence (build failure), 2 = checker could not see its target.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const CURSOR_DIR = '.cursor/rules';
const PORTABLE_DIR = 'tooling/cursor-rules';

/**
 * Offset of the first differing byte, or -1 when the buffers are identical.
 * A length difference counts as a difference at the point where the shorter buffer ends.
 * @returns {number}
 */
export function firstByteDifference(a, b) {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) return i;
  }
  return a.length === b.length ? -1 : shared;
}

/** Human-locatable position of a byte offset, for an error message a reader can act on. */
export function positionOf(buf, offset) {
  const upto = buf.subarray(0, Math.min(offset, buf.length)).toString('utf8');
  const lines = upto.split('\n');
  return { line: lines.length, column: lines[lines.length - 1].length + 1 };
}

export function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

function listRules(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith('.mdc'))
    .filter((name) => statSync(join(dir, name)).isFile())
    .sort();
}

const invokedDirectly =
  typeof process.argv[1] === 'string' && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (invokedDirectly) main();

function main() {
  // ── NEGATIVE SELF-TEST ─────────────────────────────────────────────────────────────────────────────────
  // A comparator that has stopped comparing reports every pair as identical, and a clean run then reads as
  // proof of synchronisation. Checked before the real work, against both directions of failure.
  {
    const same = firstByteDifference(Buffer.from('abc'), Buffer.from('abc')) === -1;
    const oneByte = firstByteDifference(Buffer.from('abc'), Buffer.from('abd')) === 2;
    const longer = firstByteDifference(Buffer.from('abc'), Buffer.from('abcd')) === 3;
    const crlf = firstByteDifference(Buffer.from('a\r\nb'), Buffer.from('a\nb')) === 1;
    if (!(same && oneByte && longer && crlf)) {
      console.error('✖ cursor-rules-sync check FAILED ITS OWN SELF-TEST — the comparator no longer detects a difference.');
      console.error('  A clean result from this tool would be meaningless. Fix the comparator before trusting a pass.');
      process.exit(2);
    }
  }

  const cursorAbs = join(ROOT, CURSOR_DIR);
  const portableAbs = join(ROOT, PORTABLE_DIR);

  let cursorNames;
  let portableNames;
  try {
    cursorNames = listRules(cursorAbs);
    portableNames = listRules(portableAbs);
  } catch (err) {
    // A check that cannot see its target must say so rather than pass, as check-csv-shape.mjs and
    // check-approval-port.mjs already do in this repository.
    console.error(`✖ cursor-rules-sync check CANNOT SEE ITS TARGET: ${CURSOR_DIR} or ${PORTABLE_DIR} is unreadable.`);
    console.error(`  ${err instanceof Error ? err.code ?? err.message : String(err)} — no rule file was compared.`);
    process.exit(2);
  }

  if (cursorNames.length === 0) {
    console.error(`✖ cursor-rules-sync check CANNOT SEE ITS TARGET: no .mdc rule found in ${CURSOR_DIR}.`);
    console.error('  An empty rule directory is more likely a wrong root or a bad glob than a real state.');
    process.exit(2);
  }

  const problems = [];

  for (const name of cursorNames) {
    if (!portableNames.includes(name)) {
      problems.push(
        `${CURSOR_DIR}/${name} has no portable copy at ${PORTABLE_DIR}/${name}. ` +
          'Cursor loads the .cursor/ copy; without the portable one, anybody working outside Cursor reads nothing.',
      );
    }
  }

  for (const name of portableNames) {
    if (!cursorNames.includes(name)) {
      problems.push(
        `${PORTABLE_DIR}/${name} is an orphan — no ${CURSOR_DIR}/${name} exists. ` +
          'A portable copy of a rule Cursor never loads reads as authoritative and is not.',
      );
    }
  }

  let compared = 0;
  for (const name of cursorNames.filter((n) => portableNames.includes(n))) {
    const a = readFileSync(join(cursorAbs, name));
    const b = readFileSync(join(portableAbs, name));
    const offset = firstByteDifference(a, b);
    compared++;
    if (offset === -1) continue;
    const { line, column } = positionOf(a, offset);
    problems.push(
      `${name} DIVERGED at byte ${offset} (line ${line}, column ${column}): ` +
        `${CURSOR_DIR} is ${a.length} bytes (sha256 ${sha256(a).slice(0, 12)}…), ` +
        `${PORTABLE_DIR} is ${b.length} bytes (sha256 ${sha256(b).slice(0, 12)}…). ` +
        'Copy the .cursor/ file over the tooling/ one — the .cursor/ copy is the authoritative side.',
    );
  }

  if (problems.length > 0) {
    console.error('\n✖ cursor-rules-sync check FAILED — the Cursor rules and their portable copies are not identical:\n');
    for (const p of problems) console.error(`  ${p}\n`);
    console.error('Cursor loads only the .cursor/ copy, so a divergence means the agent and the reader follow different rules.\n');
    process.exit(1);
  }

  console.log(
    `✔ cursor-rules-sync check passed (${compared} rule file(s) byte-identical between ${CURSOR_DIR} and ${PORTABLE_DIR}). Comparator self-test passed.`,
  );
}
