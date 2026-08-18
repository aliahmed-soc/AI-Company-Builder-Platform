/*
 * ACBP-FE-013 — building the decision body each mode is allowed to send.
 *
 * THE FOUR MODES DO NOT MERELY REQUIRE DIFFERENT FIELDS, THEY FORBID THE OTHERS. `validateStrategyDecision`
 * is deny-by-default per mode, so a field left over in form state from a mode the founder tried first is not
 * ignored — it fails the whole submission:
 *
 *   select  → needs `selectedOrdinal` in range; FORBIDS `chosenFields` and `reasons`.
 *   edit    → needs complete `chosenFields`; `selectedOrdinal` optional; FORBIDS `reasons`.
 *   combine → needs complete `chosenFields`; FORBIDS `selectedOrdinal` ("combine names no single base") and `reasons`.
 *   reject  → needs non-blank `reasons`; FORBIDS `selectedOrdinal`, `chosenFields` AND `phaseScope`
 *             ("phase scope is meaningless for reject").
 *
 * That last one is the trap this module exists for. A form that keeps its phase-scope selector mounted while the
 * founder switches to "reject" and submits whatever it holds gets a bounded 400 with no field named, because the
 * refusal is deliberately opaque. The founder sees "the server refused this decision" and has no way to learn
 * that an invisible leftover control caused it. So the builder DROPS what each mode forbids, and the alignment
 * suite proves the drop by running each built body through the real validator.
 *
 * IT ALSO REFUSES LOCALLY WHAT THE SERVER WOULD REFUSE ANYWAY — and unlike the server, it can NAME the field. The
 * server's 400 is bounded on purpose and echoes nothing back; "Cost range is empty" is a sentence only this side
 * can produce. A local refusal returns NO request at all, so a caller cannot post a draft this module rejected.
 */
import { REASONS_MAX, STRATEGY_FIELD_MAX, STRATEGY_OPTION_FIELDS } from '@acbp/contracts';
import type { StrategyDecisionRequest, StrategyPhaseScope, StrategySelectionMode } from '@acbp/contracts';

export interface DecisionDraft {
  readonly mode: StrategySelectionMode;
  /** The option the founder picked, as the SERVER's ordinal. Null when none is picked. */
  readonly selectedOrdinal: number | null;
  /** Free-form form state. Validated here against the contract's 16 fields before it is allowed to become a body. */
  readonly chosenFields: Readonly<Record<string, string>>;
  readonly phaseScope: StrategyPhaseScope | null;
  readonly reasons: string;
}

export type BuildResult =
  | { readonly ok: true; readonly request: StrategyDecisionRequest }
  | { readonly ok: false; readonly problem: string };

/** `cost_range` → `Cost range`. Kept identical to the view's labels so a founder reads one vocabulary. */
function labelForField(field: string): string {
  return field.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
}

/**
 * Collect the 16 contract fields from form state, or name the FIRST field that fails and why.
 *
 * Naming one field rather than listing all of them is deliberate: a founder fixes them one at a time, and a list
 * of sixteen complaints on a form with sixteen boxes is noise rather than guidance.
 */
function collectFields(raw: Readonly<Record<string, string>>): { ok: true; fields: Record<string, string> } | { ok: false; problem: string } {
  const out: Record<string, string> = {};
  for (const field of STRATEGY_OPTION_FIELDS) {
    const value = raw[field] ?? '';
    if (value.trim().length === 0) return { ok: false, problem: `${labelForField(field)} is empty. Every one of the ${String(STRATEGY_OPTION_FIELDS.length)} fields needs a value — write “unknown” where you genuinely do not know, which is recorded as undetermined rather than guessed.` };
    if (value.length > STRATEGY_FIELD_MAX) return { ok: false, problem: `${labelForField(field)} is too long — ${String(value.length)} characters against a limit of ${String(STRATEGY_FIELD_MAX)}.` };
    out[field] = value;
  }
  return { ok: true, fields: out };
}

export function buildDecisionRequest(draft: DecisionDraft): BuildResult {
  // Keys are added ONLY where the mode permits them. `validateStrategyDecision` treats an explicit`undefined`
  // the same as an absent key (every guard is `!== undefined && !== null`), so this is not strictly required to
  // pass validation — but a body that carries keys the mode forbids still MISDESCRIBES what was asked for, and
  // JSON.stringify drops an explicit undefined anyway, so building the object correctly is the honest form.
  if (draft.mode === 'select') {
    if (draft.selectedOrdinal === null) return { ok: false, problem: 'Choose one option before recording a selection.' };
    return {
      ok: true,
      request: { mode: 'select', selectedOrdinal: draft.selectedOrdinal, ...(draft.phaseScope !== null ? { phaseScope: draft.phaseScope } : {}) },
    };
  }

  if (draft.mode === 'edit' || draft.mode === 'combine') {
    const collected = collectFields(draft.chosenFields);
    if (!collected.ok) return { ok: false, problem: collected.problem };
    if (draft.mode === 'edit') {
      return {
        ok: true,
        request: {
          mode: 'edit',
          chosenFields: collected.fields,
          // The base option is OPTIONAL for an edit — omitted entirely when none is picked, never sent as null.
          ...(draft.selectedOrdinal !== null ? { selectedOrdinal: draft.selectedOrdinal } : {}),
          ...(draft.phaseScope !== null ? { phaseScope: draft.phaseScope } : {}),
        },
      };
    }
    // COMBINE NAMES NO SINGLE BASE. `selectedOrdinal` is dropped here even when the form holds one.
    return {
      ok: true,
      request: { mode: 'combine', chosenFields: collected.fields, ...(draft.phaseScope !== null ? { phaseScope: draft.phaseScope } : {}) },
    };
  }

  // REJECT. Everything except `reasons` is dropped — including `phaseScope`, which the validator refuses outright.
  const reasons = draft.reasons.trim();
  if (reasons.length === 0) return { ok: false, problem: 'Say why none of these options fit. A rejection is recorded with its reasons, and those reasons are what a later generation is steered by.' };
  // MEASURED ON THE TRIMMED VALUE, because the trimmed value is what gets SENT. Bounding the raw text refused
  // input the server would have accepted — trailing whitespace counted against a limit it never reaches.
  if (reasons.length > REASONS_MAX) return { ok: false, problem: `The reasons are too long — ${String(reasons.length)} characters against a limit of ${String(REASONS_MAX)}.` };
  return { ok: true, request: { mode: 'reject', reasons } };
}
