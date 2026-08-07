// @acbp/test-support — ACBP-P3-006 / CDR-086: the area-4 eval REPORT (the backlog row's verification procedure).
//
// CDR-002 §16 keeps the eval report as gate evidence, so this renderer is DETERMINISTIC: same report in, same text
// out. It takes no clock and no environment — a run is comparable to another run only if nothing incidental varies.
// Timestamping, if wanted, belongs to whatever archives the output, not to the evidence itself.
//
// The renderer's one substantive obligation: it must NOT read as "area 4 passed". Only the model-free half is scored
// here; the rubric half is gated on ACBP-P2-011. The deferred section and the closing line state that explicitly.

import type { EvalAreaReport } from './strategy-distinctness-eval.js';

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

/**
 * The process exit code for a scored area: 0 only when the scored half passed, 1 otherwise.
 *
 * Kept as a pure function so both branches are unit-tested. An inverted or unreachable exit path would let a FAILING
 * evaluation report success, and the exit code is the only thing a CI step reads.
 */
export function evalExitCode(report: EvalAreaReport): 0 | 1 {
  return report.verdict === 'pass' ? 0 : 1;
}

/** Render the area-4 eval report as plain text. Deterministic — no clock, no locale, no environment. */
export function renderStrategyDistinctnessReport(report: EvalAreaReport): string {
  const lines: string[] = [];

  lines.push('ACBP-P3-006 — evaluation area 4: three-option strategy generation (ADR-019 §13)');
  lines.push(`dataset ${report.datasetVersion} · ${report.caseCount} seeded case(s) · model-free half only`);
  lines.push('');

  lines.push('SCORED METRICS');
  for (const m of report.metrics) {
    const warn = m.warning === null ? 'n/a' : pct(m.warning);
    lines.push(
      `  ${m.verdict.toUpperCase().padEnd(4)} ${m.metric}: observed ${pct(m.observed)} ` +
        `(${m.numerator}/${m.denominator}) · hard ${pct(m.hard)} · warning ${warn} · ${m.source}`,
    );
  }
  lines.push('');

  lines.push('CASES');
  for (const c of report.cases) {
    const mark = c.passed ? 'ok  ' : 'FAIL';
    lines.push(
      `  ${mark} ${c.id}: distinct ${c.actual.distinct}/${c.expected.distinct} · ` +
        `rejected ${c.actual.rejected}/${c.expected.rejected} · ${c.actual.result}`,
    );
  }
  lines.push('');

  lines.push('DEFERRED — declared by canon, NOT measured by this run');
  for (const d of report.deferred) {
    lines.push(`  ${d.metric}: hard ${pct(d.hard)} · ${d.source} · blocked by ${d.blockedBy}`);
    lines.push(`    ${d.reason}`);
  }
  lines.push('');

  if (report.failures.length > 0) {
    lines.push('FAILURES');
    for (const f of report.failures) lines.push(`  ${f}`);
    lines.push('');
  }

  lines.push(`VERDICT (model-free half): ${report.verdict.toUpperCase()}`);
  lines.push(
    'AREA 4 IS NOT FULLY EVALUATED — the rubric-distinct-triples half above is deferred, so this report is evidence ' +
      'for the seeded-rejection half only and does not satisfy the ADR-019 §13 gate for area 4.',
  );

  return lines.join('\n');
}
