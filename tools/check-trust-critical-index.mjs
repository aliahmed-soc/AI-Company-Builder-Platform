#!/usr/bin/env node
// ACBP static check — every trust-critical negative must name evidence that still exists (ACBP-P7-007; CDR-080 §6).
//
// WHY THIS EXISTS. `docs/implementation/TEST-AND-VERIFICATION-STRATEGY.md` lists twenty mandatory negative tests
// with ticket attributions. ACBP-P7-002 proved that an attribution is not evidence: item 9 credited ACBP-P6-007
// for a company-lifecycle gate that P6-007 never built and P7-002 had to write. The ACBP-P7-007 investigation
// then found SEVEN wrong attributions, TWO negatives with no test at all, and FOUR resting on a returned value.
//
// The failure mode is always the same shape and it is never loud: a table says covered, a test title sounds like
// the claim, and nothing connects either to code that runs. This check makes that connection mechanical.
//
// It fails the build when:
//   • the canon list and the index disagree about which twenty items exist;
//   • an index statement has drifted from the canon line it pins;
//   • a cited file no longer exists, or the cited `test(...)` title is no longer in it (RENAMING A TEST BREAKS
//     THE BUILD rather than quietly breaking the claim);
//   • a row claims `measured` without a hosted CI run id — you may not claim a measurement you do not have;
//   • the number of `unmeasured` rows exceeds MAX_UNMEASURED, which may only ever ratchet DOWN.
//
// It deliberately does NOT fail merely because rows are unmeasured. Blanket-failing would push an author to
// relabel a row `not_covered` to get green, which is the opposite of what this file is for. Honesty is cheap
// here; overclaiming is what costs.
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// A scan root may be passed so the regression suite can run this against an isolated temp workspace instead of
// the real tree — the same shape as check-boundaries.mjs.
const ROOT = process.argv[2] ? resolve(process.argv[2]) : process.cwd();
const CANON = join(ROOT, 'docs', 'implementation', 'TEST-AND-VERIFICATION-STRATEGY.md');
const CANON_HEADING = '## Trust-critical negative tests';

const { TRUST_CRITICAL_INDEX, ANCHOR_CLASSES, STATUSES, MAX_UNMEASURED } = await import(
  pathToFileURL(join(ROOT, 'tools', 'trust-critical-index.mjs')).href
);

// ── 1. Parse the canonical list ──────────────────────────────────────────────────────────────────────────────
// Items are `N. <statement> *(attribution)*` and may wrap across indented continuation lines (item 6 does).
export function parseCanon(markdown) {
  const lines = markdown.split('\n');
  const start = lines.findIndex((l) => l.startsWith(CANON_HEADING));
  if (start === -1) return [];
  const items = [];
  let current = null;
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('## ')) break; // next section ends the list
    const opened = line.match(/^(\d+)\.\s+(.*)$/);
    if (opened) {
      if (current) items.push(current);
      current = { number: Number(opened[1]), text: opened[2] };
      continue;
    }
    if (current && /^\s+\S/.test(line)) current.text += ' ' + line.trim(); // continuation
    else if (current && line.trim() === '') continue;
  }
  if (current) items.push(current);
  // The statement is everything before the ` *(` that opens the attribution.
  return items.map((it) => {
    const cut = it.text.indexOf(' *(');
    return {
      number: it.number,
      statement: (cut === -1 ? it.text : it.text.slice(0, cut)).trim(),
      attribution: cut === -1 ? '' : it.text.slice(cut + 3).replace(/\)\*\s*$/, '').trim(),
    };
  });
}

const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// A test title written `'…the CALLER\'S…'` appears in source WITH the backslash, so a plain substring search for
// the human-readable title misses it. Unescape quote escapes before searching — otherwise the index is forced to
// store source-level escaping, which is unreadable and would drift the moment someone reflowed the quotes.
const unescapeQuotes = (src) => src.replace(/\\(['"`])/g, '$1');

const canonSrc = readFileSync(CANON, 'utf8');
const canon = parseCanon(canonSrc);
const problems = [];

if (canon.length === 0) {
  problems.push(`Could not parse any items under "${CANON_HEADING}" in ${CANON}. The heading or list shape changed.`);
}

// ── 2. The index and the canon must describe the same twenty ─────────────────────────────────────────────────
const canonNumbers = new Set(canon.map((c) => c.number));
const indexNumbers = new Set();
for (const row of TRUST_CRITICAL_INDEX) {
  if (indexNumbers.has(row.number)) problems.push(`Index has TWO rows numbered ${row.number}.`);
  indexNumbers.add(row.number);
}
for (const n of canonNumbers) {
  if (!indexNumbers.has(n)) problems.push(`Canon item ${n} has NO index row. An attribution with no recorded evidence is exactly what this check exists to catch.`);
}
for (const n of indexNumbers) {
  if (!canonNumbers.has(n)) problems.push(`Index row ${n} matches no canon item — the list shrank or was renumbered.`);
}

// ── 3. Per-row integrity ─────────────────────────────────────────────────────────────────────────────────────
const canonByNumber = new Map(canon.map((c) => [c.number, c]));
let unmeasured = 0;

for (const row of TRUST_CRITICAL_INDEX) {
  const at = `item ${row.number}`;
  const c = canonByNumber.get(row.number);

  if (c && norm(c.statement) !== norm(row.statement)) {
    problems.push(
      `${at}: statement drift.\n      canon: ${norm(c.statement)}\n      index: ${norm(row.statement)}`,
    );
  }
  if (!STATUSES.includes(row.status)) problems.push(`${at}: status "${row.status}" is not one of ${STATUSES.join(' | ')}.`);
  if (!ANCHOR_CLASSES.includes(row.anchor)) problems.push(`${at}: anchor "${row.anchor}" is not one of ${ANCHOR_CLASSES.join(' | ')}.`);
  if (!norm(row.doesNotProve)) problems.push(`${at}: doesNotProve is empty. Every row states the limit of its own evidence.`);

  const hasEvidence = row.status === 'measured' || row.status === 'unmeasured';

  if (hasEvidence) {
    if (!row.file) problems.push(`${at}: status "${row.status}" but no file is named.`);
    else if (!existsSync(join(ROOT, row.file))) problems.push(`${at}: cited file does not exist — ${row.file}`);
    else if (!row.testTitle) problems.push(`${at}: status "${row.status}" but no test title is named.`);
    else {
      const src = unescapeQuotes(readFileSync(join(ROOT, row.file), 'utf8'));
      if (!src.includes(row.testTitle)) {
        problems.push(
          `${at}: the cited test title is NOT in ${row.file}.\n      "${row.testTitle}"\n      A renamed or deleted test must break the build, not the claim.`,
        );
      }
    }
    if (row.anchor === 'none') problems.push(`${at}: status "${row.status}" cannot carry anchor "none".`);
    if (!norm(row.mutation)) problems.push(`${at}: no mutation is described. A control nobody tried to break is unmeasured by definition.`);
  } else {
    if (row.file || row.testTitle) problems.push(`${at}: status "${row.status}" must not cite a file or test — it claims there is none.`);
    if (row.anchor !== 'none') problems.push(`${at}: status "${row.status}" must carry anchor "none".`);
  }

  if (row.status === 'measured') {
    if (!/^\d{6,}$/.test(String(row.mutationRunId))) {
      problems.push(
        `${at}: claims "measured" without a hosted CI run id. A probe SHA is not enough — ACBP-P6-006's probe commit fe85082 is reachable from no ref today and only its run id survived.`,
      );
    }
  } else if (row.mutationRunId) {
    problems.push(`${at}: status "${row.status}" but a run id is recorded. If the mutation went red, the row is "measured".`);
  }

  if (row.status === 'unmeasured') unmeasured++;
}

if (unmeasured > MAX_UNMEASURED) {
  problems.push(
    `${unmeasured} rows are unmeasured but MAX_UNMEASURED is ${MAX_UNMEASURED}. That number is a RATCHET: it may only ever go down. A control that was measured and is no longer measured is a regression in the evidence, not a bookkeeping detail.`,
  );
}

// ── 4. Report ────────────────────────────────────────────────────────────────────────────────────────────────
if (problems.length > 0) {
  console.error('\n✖ trust-critical evidence index is out of step with the code:\n');
  for (const p of problems) console.error(`  ${p}\n`);
  console.error(`${problems.length} problem(s). See CDR-080 §6.\n`);
  process.exit(1);
}

// ── 5. NEGATIVE SELF-TEST ────────────────────────────────────────────────────────────────────────────────────
// A checker that stops matching becomes a checker that always passes — the same "guard written but never
// applied" failure this tool exists to catch, one level up. Prove the canon parser still recognises the shape
// before reporting a clean tree.
{
  const probe = [
    CANON_HEADING + ' (probe)',
    '',
    "1. Probe statement one. *(P0-000)*",
    '2. Probe statement two',
    '   continues here. *(P0-001 — **note**)*',
    '',
    '## Next section',
  ].join('\n');
  const got = parseCanon(probe);
  const ok =
    got.length === 2 &&
    got[0].number === 1 &&
    got[0].statement === 'Probe statement one.' &&
    got[1].number === 2 &&
    got[1].statement === 'Probe statement two continues here.' &&
    got[1].attribution.startsWith('P0-001');
  if (!ok) {
    console.error('✖ trust-critical index check FAILED ITS OWN SELF-TEST — the canon parser no longer recognises the list shape.');
    console.error('  A clean result from this tool would be meaningless. Fix the parser before trusting a pass.');
    console.error('  got: ' + JSON.stringify(got));
    process.exit(2);
  }
}

const measured = TRUST_CRITICAL_INDEX.filter((r) => r.status === 'measured').length;
const weak = TRUST_CRITICAL_INDEX.filter((r) => r.anchor === 'return_value_only' || r.anchor === 'pure_helper_only').length;
const none = TRUST_CRITICAL_INDEX.filter((r) => r.status === 'not_covered' || r.status === 'unprovable').length;
console.log(
  `✔ trust-critical index: ${TRUST_CRITICAL_INDEX.length} canon items pinned to live tests; ` +
    `${measured} MEASURED (red run recorded), ${unmeasured} unmeasured (ratchet ${MAX_UNMEASURED}), ${none} with no test. ` +
    `${weak} rest on a returned value or weaker. Self-test passed.`,
);
