/*
 * ACBP-FE-013 — building the decision body, checked against the REAL validator.
 *
 * THIS IS A CONTRACT-ALIGNMENT SUITE, NOT A MOCK. Every case runs the request this screen would actually send
 * through `validateStrategyDecision` — the same function the server calls — so a body this screen builds wrongly
 * fails HERE rather than as an unexplained 400 in front of a founder. Asserting against my own reading of the
 * rules would only prove I read them the way I wrote them.
 *
 * THE RULE THAT MOTIVATED THE MODULE: the four modes do not merely require different fields, they FORBID the
 * others. `reject` with a phase scope is refused outright — "phase scope is meaningless for reject" — so a form
 * that leaves its phase selector mounted and submits whatever it holds produces a 400 whose cause is invisible.
 * The builder drops what each mode forbids, and the tests below prove the drop by validating the built body.
 */
import { describe, expect, it } from 'vitest';
import { STRATEGY_OPTION_FIELDS, validateStrategyDecision } from '@acbp/contracts';
import { buildDecisionRequest, type DecisionDraft } from './decision-request';

const OPTION_COUNT = 3;

function completeFields(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const f of STRATEGY_OPTION_FIELDS) out[f] = `${f} value`;
  return out;
}

function draft(over: Partial<DecisionDraft> = {}): DecisionDraft {
  return { mode: 'select', selectedOrdinal: 0, chosenFields: completeFields(), phaseScope: null, reasons: '', ...over };
}

describe('every mode this screen offers builds a body the real validator accepts', () => {
  it('select', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: 1 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('select with a phase scope', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: 1, phaseScope: 'first_phase' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = validateStrategyDecision(built.request, OPTION_COUNT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.mode === 'select' ? parsed.value.phaseScope : null).toBe('first_phase');
  });

  it('edit, with a base option', () => {
    const built = buildDecisionRequest(draft({ mode: 'edit', selectedOrdinal: 2 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('edit, with no base option', () => {
    const built = buildDecisionRequest(draft({ mode: 'edit', selectedOrdinal: null }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('combine', () => {
    const built = buildDecisionRequest(draft({ mode: 'combine', selectedOrdinal: null }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('reject', () => {
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: 'None of these fit the constraint on delivery time.' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });
});

describe('each mode drops what it forbids — proven by validating the built body', () => {
  it('reject DROPS a phase scope the form still held', () => {
    // The trap. `validateStrategyDecision` refuses a reject carrying any phase scope. If the builder forwarded
    // the form's value, this body would fail the real validator right here.
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: 'No fit.', phaseScope: 'whole_plan' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.phaseScope ?? null).toBeNull();
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('reject DROPS a selected ordinal the form still held', () => {
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: 'No fit.', selectedOrdinal: 1 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('combine DROPS a selected ordinal, which it is not allowed to name', () => {
    const built = buildDecisionRequest(draft({ mode: 'combine', selectedOrdinal: 1 }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('select DROPS the edited fields the form still held', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: 0, chosenFields: completeFields() }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('select DROPS reasons the form still held from a previous reject attempt', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: 0, reasons: 'left over' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });

  it('edit DROPS reasons the form still held', () => {
    const built = buildDecisionRequest(draft({ mode: 'edit', selectedOrdinal: null, reasons: 'left over' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(validateStrategyDecision(built.request, OPTION_COUNT).ok).toBe(true);
  });
});

describe('the builder refuses locally what the server would refuse anyway, and says why', () => {
  it('select with no option chosen', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: null }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem.toLowerCase()).toContain('option');
  });

  it('reject with blank reasons', () => {
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: '   ' }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem.toLowerCase()).toContain('reason');
  });

  it('edit with a blank field NAMES the field rather than saying "invalid"', () => {
    const fields = completeFields();
    fields['cost_range'] = '   ';
    const built = buildDecisionRequest(draft({ mode: 'edit', selectedOrdinal: 0, chosenFields: fields }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem).toContain('Cost range');
  });

  it('combine with an over-long field names it too', () => {
    const fields = completeFields();
    fields['risks'] = 'x'.repeat(2001);
    const built = buildDecisionRequest(draft({ mode: 'combine', selectedOrdinal: null, chosenFields: fields }));
    expect(built.ok).toBe(false);
    if (built.ok) return;
    expect(built.problem).toContain('Risks');
  });

  it('reject with over-long reasons is refused before the round trip', () => {
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: 'x'.repeat(4001) }));
    expect(built.ok).toBe(false);
  });
});

describe('a locally-refused draft is never sent', () => {
  it('every refusal returns no request at all, so a caller cannot post it by mistake', () => {
    const bad = [
      draft({ mode: 'select', selectedOrdinal: null }),
      draft({ mode: 'reject', reasons: '' }),
      draft({ mode: 'edit', selectedOrdinal: 0, chosenFields: { ...completeFields(), scope: '' } }),
    ];
    for (const d of bad) {
      const built = buildDecisionRequest(d);
      expect(built.ok).toBe(false);
      expect('request' in built).toBe(false);
    }
  });
});

describe('each mode FORWARDS what it is allowed to carry', () => {
  /*
   * The suite above proves the builder DROPS what each mode forbids. Dropping everything would also pass all
   * of it — `validateStrategyDecision` accepts a `select` with no phase scope and an `edit` with no base —
   * so without these the builder could silently discard the founder's phase scope and base option and the
   * whole file would stay green. A review found exactly that gap.
   */
  it('select forwards the phase scope it was given', () => {
    const built = buildDecisionRequest(draft({ mode: 'select', selectedOrdinal: 1, phaseScope: 'whole_plan' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.phaseScope).toBe('whole_plan');
  });

  it('edit forwards BOTH the base option and the phase scope', () => {
    const built = buildDecisionRequest(draft({ mode: 'edit', selectedOrdinal: 2, phaseScope: 'first_phase' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.selectedOrdinal).toBe(2);
    expect(built.request.phaseScope).toBe('first_phase');
    const parsed = validateStrategyDecision(built.request, OPTION_COUNT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.mode !== 'edit') return;
    expect(parsed.value.selectedOrdinal).toBe(2);
    expect(parsed.value.phaseScope).toBe('first_phase');
  });

  it('combine forwards the phase scope', () => {
    const built = buildDecisionRequest(draft({ mode: 'combine', selectedOrdinal: null, phaseScope: 'whole_plan' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.phaseScope).toBe('whole_plan');
  });

  it('edit and combine forward the authored field CONTENT, not just a valid shape', () => {
    const fields = completeFields();
    fields['customer'] = 'Cairo gyms with 200-800 members';
    const built = buildDecisionRequest(draft({ mode: 'combine', selectedOrdinal: null, chosenFields: fields }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const parsed = validateStrategyDecision(built.request, OPTION_COUNT);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok || parsed.value.mode !== 'combine') return;
    expect(parsed.value.chosenFields.customer).toBe('Cairo gyms with 200-800 members');
  });

  it('reject forwards the reasons, trimmed', () => {
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: '  none of these reach the pilot customer  ' }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.reasons).toBe('none of these reach the pilot customer');
  });

  it('accepts reasons that are over-long ONLY in untrimmed whitespace', () => {
    // The bound is measured on what is SENT. Counting the raw text refused input the server would accept.
    const body = 'x'.repeat(4000);
    const built = buildDecisionRequest(draft({ mode: 'reject', reasons: `   ${body}   ` }));
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(built.request.reasons).toHaveLength(4000);
  });
});